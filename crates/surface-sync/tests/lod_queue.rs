use anyhow::Result;
use rusqlite::{Connection, params};
use std::collections::BTreeSet;
use surface_core::lod::{MAX_TILE_BYTES, TileKey, WORLD_LIMIT};
use surface_sync::lod_queue::{self as queue, ChangedChunk, LeafCursor};

fn install(db: &mut Connection) {
    let tx = db.transaction().unwrap();
    queue::install(&tx).unwrap();
    tx.commit().unwrap();
}

fn database() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    install(&mut db);
    db
}

fn change(cx: i32, cz: i32, revision: u64, now_ms: u64) -> ChangedChunk {
    ChangedChunk {
        cx,
        cz,
        sha256: format!("{revision:064x}"),
        bytes: 123,
        observation_revision: revision,
        now_ms,
    }
}

fn pin_count(db: &Connection) -> usize {
    let mut count = 0;
    queue::visit_references(db, |_, reference| {
        reference.object_ref().validate(MAX_TILE_BYTES)?;
        count += 1;
        Ok(())
    })
    .unwrap();
    count
}

#[test]
fn schema_and_observation_enqueue_roll_back_with_the_caller_transaction() {
    let mut db = Connection::open_in_memory().unwrap();
    {
        let tx = db.transaction().unwrap();
        queue::install(&tx).unwrap();
        queue::enqueue(&tx, &change(0, 0, 1, 100)).unwrap();
        tx.rollback().unwrap();
    }
    assert!(queue::stats(&db, 100).is_err());
    install(&mut db);
    install(&mut db);
    db.execute("CREATE TABLE observations (revision INTEGER)", [])
        .unwrap();
    {
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO observations VALUES(1)", [])
            .unwrap();
        queue::enqueue(&tx, &change(-1, -1, 1, 100)).unwrap();
    }
    assert_eq!(queue::stats(&db, 200).unwrap().pending_chunks, 0);
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM observations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let tx = db.transaction().unwrap();
    tx.execute("INSERT INTO observations VALUES(2)", [])
        .unwrap();
    queue::enqueue(&tx, &change(-1, -1, 2, 200)).unwrap();
    tx.commit().unwrap();
    assert_eq!(pin_count(&db), 1);
    assert_eq!(
        queue::stats(&db, 250).unwrap().oldest_pending_age_ms,
        Some(50)
    );
}

#[test]
fn coalescing_keeps_newest_reference_and_first_dirty_age() {
    let mut db = database();
    let tx = db.transaction().unwrap();
    assert!(queue::enqueue(&tx, &change(8, 0, 1, 100)).unwrap());
    assert!(queue::enqueue(&tx, &change(0, 0, 2, 200)).unwrap());
    assert!(queue::enqueue(&tx, &change(9, 0, 3, 300)).unwrap());
    assert!(queue::enqueue(&tx, &change(8, 0, 5, 500)).unwrap());
    assert!(!queue::enqueue(&tx, &change(8, 0, 4, 600)).unwrap());
    assert!(!queue::enqueue(&tx, &change(8, 0, 5, 700)).unwrap());
    let mut conflict = change(8, 0, 5, 800);
    conflict.sha256 = "f".repeat(64);
    assert!(queue::enqueue(&tx, &conflict).is_err());
    conflict = change(8, 0, 5, 800);
    conflict.bytes += 1;
    assert!(queue::enqueue(&tx, &conflict).is_err());
    let stats = queue::stats(&tx, 900).unwrap();
    assert_eq!(stats.pending_chunks, 3);
    assert_eq!(stats.pending_leaves, 2);
    assert_eq!(stats.oldest_pending_ms, Some(100));
    assert_eq!(stats.oldest_pending_age_ms, Some(800));
    assert_eq!(stats.min_observation_revision, Some(2));
    assert_eq!(stats.max_observation_revision, Some(5));
    assert_eq!(
        queue::stats(&tx, 50).unwrap().oldest_pending_age_ms,
        Some(0)
    );
    let batch = queue::freeze(&tx, 5, r#"{"snapshot":"one"}"#, 1000)
        .unwrap()
        .unwrap();
    tx.commit().unwrap();
    let leaves = queue::leaf_page(&db, batch.id, None, 64).unwrap();
    assert_eq!(
        leaves.iter().map(|l| l.key.x).collect::<Vec<_>>(),
        vec![1, 0]
    );
    assert_eq!(leaves[0].first_enqueued_ms, 100);
    let refs = queue::changed_refs(&db, batch.id, leaves[0].key).unwrap();
    assert_eq!(refs.len(), 2);
    assert_eq!(refs[0].observation_revision, 5);
    assert_eq!(refs[0].sha256, change(8, 0, 5, 0).sha256);
    assert_eq!(
        (refs[0].first_enqueued_ms, refs[0].last_enqueued_ms),
        (100, 500)
    );
}

#[test]
fn frozen_batch_survives_restart_and_new_edits_are_not_lost_on_completion() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("queue.sqlite");
    let mut db = Connection::open(&path).unwrap();
    install(&mut db);
    let context = " {\"snapshot\":\"objects/source.json\",\"revision\":7} ";
    let tx = db.transaction().unwrap();
    queue::enqueue(&tx, &change(-1, -1, 7, 100)).unwrap();
    let frozen = queue::freeze(&tx, 9, context, 200).unwrap().unwrap();
    tx.commit().unwrap();
    drop(db);
    let mut db = Connection::open(&path).unwrap();
    install(&mut db);
    assert_eq!(queue::active_batch(&db).unwrap(), Some(frozen.clone()));
    assert_eq!(frozen.context_json, context);
    let tx = db.transaction().unwrap();
    queue::enqueue(&tx, &change(-1, -1, 10, 300)).unwrap();
    queue::enqueue(&tx, &change(8, 8, 11, 400)).unwrap();
    assert_eq!(
        queue::freeze(&tx, 0, "not new context", u64::MAX).unwrap(),
        Some(frozen.clone())
    );
    tx.commit().unwrap();
    assert_eq!(pin_count(&db), 3);
    let old = queue::changed_refs(&db, frozen.id, queue::leaf_key(-1, -1).unwrap()).unwrap();
    assert_eq!(old[0].observation_revision, 7);
    assert_eq!(queue::stats(&db, 500).unwrap().pending_chunks, 2);
    let tx = db.transaction().unwrap();
    assert!(queue::complete(&tx, frozen.id + 1).is_err());
    queue::complete(&tx, frozen.id).unwrap();
    tx.rollback().unwrap();
    assert_eq!(pin_count(&db), 3);
    assert_eq!(queue::active_batch(&db).unwrap(), Some(frozen.clone()));
    let tx = db.transaction().unwrap();
    queue::complete(&tx, frozen.id).unwrap();
    tx.commit().unwrap();
    assert!(queue::active_batch(&db).unwrap().is_none());
    assert_eq!(pin_count(&db), 2);
    assert!(queue::leaf_page(&db, frozen.id, None, 64).is_err());
    drop(db);
    let mut db = Connection::open(&path).unwrap();
    let tx = db.transaction().unwrap();
    let next = queue::freeze(&tx, 11, r#"{"snapshot":"two"}"#, 600)
        .unwrap()
        .unwrap();
    assert_eq!(next.id, frozen.id + 1);
    assert_eq!(next.source_observation_revision, 11);
    let refs = queue::changed_refs(&tx, next.id, queue::leaf_key(-1, -1).unwrap()).unwrap();
    assert_eq!(refs[0].observation_revision, 10);
    assert_eq!(refs[0].first_enqueued_ms, 300);
    queue::complete(&tx, next.id).unwrap();
    assert!(queue::freeze(&tx, 12, "{}", 700).unwrap().is_none());
    tx.commit().unwrap();
    assert_eq!(pin_count(&db), 0);
    assert_eq!(queue::stats(&db, 800).unwrap().pending_leaves, 0);
}

#[test]
fn freeze_rotates_only_metadata_and_rolls_back_atomically() {
    let mut db = database();
    let tx = db.transaction().unwrap();
    queue::enqueue(&tx, &change(0, 0, 5, 100)).unwrap();
    tx.commit().unwrap();
    let tx = db.transaction().unwrap();
    assert!(queue::freeze(&tx, 4, "{}", 200).is_err());
    assert!(queue::active_batch(&tx).unwrap().is_none());
    let before = tx.total_changes();
    let batch = queue::freeze(&tx, 5, "{}", 200).unwrap().unwrap();
    assert_eq!(
        tx.total_changes() - before,
        1,
        "freeze must not copy queued rows"
    );
    queue::enqueue(&tx, &change(0, 0, 6, 300)).unwrap();
    assert_eq!(pin_count(&tx), 2);
    tx.rollback().unwrap();
    assert!(queue::active_batch(&db).unwrap().is_none());
    let stats = queue::stats(&db, 400).unwrap();
    assert_eq!(stats.pending_queue_id, batch.id);
    assert_eq!(stats.pending_chunks, 1);
    assert_eq!(stats.max_observation_revision, Some(5));
}

#[test]
fn negative_coordinates_and_world_limits_use_floor_division() {
    for (chunk, leaf) in [(-9, -2), (-8, -1), (-1, -1), (0, 0), (7, 0), (8, 1)] {
        assert_eq!(
            queue::leaf_key(chunk, chunk).unwrap(),
            TileKey::new(0, leaf, leaf).unwrap()
        );
    }
    let mut db = database();
    let tx = db.transaction().unwrap();
    for (i, (cx, cz)) in [
        (-WORLD_LIMIT / 16, -WORLD_LIMIT / 16),
        (WORLD_LIMIT / 16 - 1, WORLD_LIMIT / 16 - 1),
        (-1, -9),
    ]
    .into_iter()
    .enumerate()
    {
        queue::enqueue(&tx, &change(cx, cz, i as u64, 100)).unwrap();
    }
    let batch = queue::freeze(&tx, 3, "{}", 200).unwrap().unwrap();
    let leaves = queue::leaf_page(&tx, batch.id, None, 64).unwrap();
    assert_eq!(leaves.len(), 3);
    for leaf in leaves {
        let refs = queue::changed_refs(&tx, batch.id, leaf.key).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(queue::leaf_key(refs[0].cx, refs[0].cz).unwrap(), leaf.key);
    }
}

#[test]
fn malformed_references_and_out_of_range_integers_never_enqueue() {
    let mut db = database();
    let tx = db.transaction().unwrap();
    for sha in [
        "",
        "abc",
        &"g".repeat(64),
        &"A".repeat(64),
        &"a".repeat(65),
        &"\u{e9}".repeat(32),
        &format!("{}\0", "a".repeat(63)),
    ] {
        let mut input = change(0, 0, 1, 100);
        input.sha256 = sha.into();
        assert!(queue::enqueue(&tx, &input).is_err());
    }
    for bytes in [0, MAX_TILE_BYTES + 1, usize::MAX] {
        let mut input = change(0, 0, 1, 100);
        input.bytes = bytes;
        assert!(queue::enqueue(&tx, &input).is_err());
    }
    for value in [i32::MIN, i32::MAX, -WORLD_LIMIT / 16 - 1, WORLD_LIMIT / 16] {
        assert!(queue::enqueue(&tx, &change(value, 0, 1, 100)).is_err());
        assert!(queue::enqueue(&tx, &change(0, value, 1, 100)).is_err());
    }
    assert!(queue::enqueue(&tx, &change(0, 0, u64::MAX, 100)).is_err());
    assert!(queue::enqueue(&tx, &change(0, 0, 1, u64::MAX)).is_err());
    assert!(queue::stats(&tx, u64::MAX).is_err());
    assert_eq!(pin_count(&tx), 0);
    assert_eq!(queue::stats(&tx, 100).unwrap().pending_leaves, 0);
}

#[test]
fn sqlite_integer_boundaries_round_trip_without_loss() {
    let mut db = database();
    let tx = db.transaction().unwrap();
    let maximum = i64::MAX as u64;
    let mut input = change(0, 0, maximum, maximum);
    input.bytes = MAX_TILE_BYTES;
    queue::enqueue(&tx, &input).unwrap();
    let stats = queue::stats(&tx, maximum).unwrap();
    assert_eq!(stats.oldest_pending_ms, Some(maximum));
    assert_eq!(stats.oldest_pending_age_ms, Some(0));
    assert_eq!(stats.max_observation_revision, Some(maximum));
    let batch = queue::freeze(&tx, maximum, "{}", maximum).unwrap().unwrap();
    assert_eq!(batch.source_observation_revision, maximum);
    assert_eq!(batch.frozen_ms, maximum);
    let leaf = queue::leaf_page(&tx, batch.id, None, 1).unwrap().remove(0);
    assert!(
        queue::leaf_page(&tx, batch.id, Some(leaf.cursor()), 1)
            .unwrap()
            .is_empty()
    );
    let reference = queue::changed_refs(&tx, batch.id, leaf.key)
        .unwrap()
        .remove(0);
    assert_eq!(reference.bytes, MAX_TILE_BYTES);
    assert_eq!(reference.observation_revision, maximum);
    assert_eq!(reference.first_enqueued_ms, maximum);
    assert_eq!(reference.last_enqueued_ms, maximum);
    assert!(
        tx.execute("UPDATE lod_queue_state SET source_revision=NULL", [])
            .is_err()
    );
    assert_eq!(queue::active_batch(&tx).unwrap(), Some(batch));
}

#[test]
fn context_is_an_opaque_bounded_json_object_and_is_frozen_verbatim() {
    let mut db = database();
    let tx = db.transaction().unwrap();
    queue::enqueue(&tx, &change(0, 0, 1, 100)).unwrap();
    for invalid in ["", "[]", "null", "{", r#"{"x":true} trailing"#] {
        assert!(queue::freeze(&tx, 1, invalid, 200).is_err());
    }
    let too_large = format!("{{\"x\":\"{}\"}}", "x".repeat(queue::MAX_CONTEXT_BYTES));
    assert!(queue::freeze(&tx, 1, &too_large, 200).is_err());
    assert!(queue::freeze(&tx, u64::MAX, "{}", 200).is_err());
    assert!(queue::freeze(&tx, 1, "{}", u64::MAX).is_err());
    assert!(queue::active_batch(&tx).unwrap().is_none());
    assert_eq!(queue::stats(&tx, 200).unwrap().pending_queue_id, 1);
    let exact = format!("{{\"x\":\"{}\"}}", "x".repeat(queue::MAX_CONTEXT_BYTES - 8));
    assert_eq!(exact.len(), queue::MAX_CONTEXT_BYTES);
    let batch = queue::freeze(&tx, 1, &exact, 200).unwrap().unwrap();
    assert_eq!(batch.context_json, exact);
}

#[test]
fn pagination_is_bounded_fair_and_has_no_duplicates_or_skips() {
    let mut db = database();
    let tx = db.transaction().unwrap();
    for x in (-65..65).rev() {
        queue::enqueue(
            &tx,
            &change(x * 8, -1, 1, if x % 2 == 0 { 100 } else { 200 }),
        )
        .unwrap();
    }
    let batch = queue::freeze(&tx, 1, "{}", 300).unwrap().unwrap();
    tx.commit().unwrap();
    assert!(queue::leaf_page(&db, batch.id, None, 0).is_err());
    assert!(queue::leaf_page(&db, batch.id, None, 65).is_err());
    assert!(queue::leaf_page(&db, -1, None, 64).is_err());
    assert!(queue::leaf_page(&db, batch.id + 1, None, 64).is_err());
    for cursor in [
        LeafCursor {
            first_enqueued_ms: u64::MAX,
            x: 0,
            z: 0,
        },
        LeafCursor {
            first_enqueued_ms: 0,
            x: i32::MAX,
            z: 0,
        },
    ] {
        assert!(queue::leaf_page(&db, batch.id, Some(cursor), 64).is_err());
    }
    let mut cursor = None;
    let mut seen = BTreeSet::new();
    let mut previous = None;
    let mut page_sizes = Vec::new();
    loop {
        let page = queue::leaf_page(&db, batch.id, cursor, 64).unwrap();
        if page.is_empty() {
            break;
        }
        page_sizes.push(page.len());
        for leaf in &page {
            let order = (leaf.first_enqueued_ms, leaf.key.z, leaf.key.x);
            assert!(previous.is_none_or(|p| p < order));
            previous = Some(order);
            assert!(seen.insert(leaf.key));
        }
        cursor = page.last().map(|leaf| leaf.cursor());
    }
    assert_eq!(page_sizes, vec![64, 64, 2]);
    assert_eq!(seen.len(), 130);
}

#[test]
fn per_leaf_references_are_capped_and_gc_pins_both_generations() {
    let mut db = database();
    let tx = db.transaction().unwrap();
    for cz in -8..0 {
        for cx in -8..0 {
            queue::enqueue(&tx, &change(cx, cz, 1, 100)).unwrap();
        }
    }
    let batch = queue::freeze(&tx, 1, "{}", 200).unwrap().unwrap();
    queue::enqueue(&tx, &change(-1, -1, 2, 300)).unwrap();
    assert_eq!(pin_count(&tx), 65);
    let refs = queue::changed_refs(&tx, batch.id, TileKey::new(0, -1, -1).unwrap()).unwrap();
    assert_eq!(refs.len(), 64);
    assert_eq!((refs[0].cx, refs[0].cz), (-8, -8));
    assert_eq!((refs[63].cx, refs[63].cz), (-1, -1));
    assert!(
        queue::changed_refs(&tx, batch.id, TileKey::new(0, 0, 0).unwrap())
            .unwrap()
            .is_empty()
    );
    assert!(queue::changed_refs(&tx, batch.id, TileKey::new(1, -1, -1).unwrap()).is_err());
    let mut observed = BTreeSet::new();
    queue::visit_references(&tx, |id, chunk| {
        observed.insert((id, chunk.observation_revision));
        Ok(())
    })
    .unwrap();
    assert_eq!(observed, BTreeSet::from([(batch.id, 1), (batch.id + 1, 2)]));
    let mut visited = 0;
    let aborted: Result<()> = queue::visit_references(&tx, |_, _| {
        visited += 1;
        anyhow::bail!("intentional callback stop")
    });
    assert!(aborted.is_err());
    assert_eq!(visited, 1);
    assert!(
        tx.execute(
            "UPDATE lod_queue_chunks SET sha256=?1 WHERE queue_id=?2",
            params!["f".repeat(64), batch.id]
        )
        .is_err()
    );
    queue::complete(&tx, batch.id).unwrap();
    assert_eq!(pin_count(&tx), 1);
    tx.commit().unwrap();
}
