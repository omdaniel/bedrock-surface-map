//! Durable changed-chunk references for a single-owner LOD publisher.
//!
//! Install and mutate inside the caller's observation/publication transaction.
//! Freeze rotates IDs without copying terrain or queued rows. A frozen queue is
//! immutable through this API while later observations coalesce in the new queue.
//! This module neither publishes files nor coordinates a publisher lease.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};
use surface_core::lod::{MAX_TILE_BYTES, ObjectRef, TileKey, WORLD_LIMIT};

pub const MAX_CONTEXT_BYTES: usize = 64 * 1024;
pub const MAX_LEAF_PAGE: usize = 64;
pub const MAX_CHANGED_REFS: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangedChunk {
    pub cx: i32,
    pub cz: i32,
    pub sha256: String,
    pub bytes: usize,
    pub observation_revision: u64,
    pub now_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueuedChunk {
    pub cx: i32,
    pub cz: i32,
    pub sha256: String,
    pub bytes: usize,
    pub observation_revision: u64,
    pub first_enqueued_ms: u64,
    pub last_enqueued_ms: u64,
}

impl QueuedChunk {
    pub fn object_ref(&self) -> ObjectRef {
        ObjectRef {
            url: format!("objects/{}.zst", self.sha256),
            sha256: self.sha256.clone(),
            bytes: self.bytes,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrozenBatch {
    pub id: i64,
    pub source_observation_revision: u64,
    /// Opaque source snapshot descriptor, not a copied world/catalog payload.
    pub context_json: String,
    pub frozen_ms: u64,
}

/// Keyset cursor in first-dirty order, with deterministic coordinate tie breaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LeafCursor {
    pub first_enqueued_ms: u64,
    pub x: i32,
    pub z: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueuedLeaf {
    pub key: TileKey,
    pub first_enqueued_ms: u64,
}

impl QueuedLeaf {
    pub fn cursor(&self) -> LeafCursor {
        LeafCursor {
            first_enqueued_ms: self.first_enqueued_ms,
            x: self.key.x,
            z: self.key.z,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueStats {
    pub pending_queue_id: i64,
    pub active_batch_id: Option<i64>,
    pub pending_chunks: u64,
    pub pending_leaves: u64,
    pub oldest_pending_ms: Option<u64>,
    pub oldest_pending_age_ms: Option<u64>,
    pub min_observation_revision: Option<u64>,
    pub max_observation_revision: Option<u64>,
}

fn sql_integer(value: u64) -> Result<i64> {
    i64::try_from(value).context("queue integer exceeds SQLite range")
}

fn nonnegative<T: TryFrom<i64>>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
    let value: i64 = row.get(index)?;
    T::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

fn optional_nonnegative(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| {
            u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
        })
        .transpose()
}

/// Chunk coordinates address 16-block chunks; leaves address 128-block tiles.
pub fn leaf_key(cx: i32, cz: i32) -> Result<TileKey> {
    TileKey::new(0, cx.div_euclid(8), cz.div_euclid(8))
}

/// Idempotent installation, without modifying the shared database user_version.
pub fn install(tx: &Transaction<'_>) -> Result<()> {
    let leaf_limit = WORLD_LIMIT / 128;
    tx.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS lod_queue_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            schema_version INTEGER NOT NULL CHECK(schema_version=1),
            pending_id INTEGER NOT NULL CHECK(pending_id>0),
            active_id INTEGER,
            source_revision INTEGER,
            context_json TEXT,
            frozen_ms INTEGER,
            CHECK((active_id IS NULL AND source_revision IS NULL AND context_json IS NULL AND frozen_ms IS NULL)
                OR (active_id IS NOT NULL AND active_id>0 AND active_id=pending_id-1
                    AND source_revision IS NOT NULL AND source_revision>=0
                    AND context_json IS NOT NULL AND frozen_ms IS NOT NULL AND frozen_ms>=0
                    AND length(CAST(context_json AS BLOB))<={MAX_CONTEXT_BYTES}))
        );
        INSERT OR IGNORE INTO lod_queue_state(singleton,schema_version,pending_id) VALUES(1,1,1);
        CREATE TABLE IF NOT EXISTS lod_queue_leaves (
            queue_id INTEGER NOT NULL CHECK(queue_id>0),
            leaf_x INTEGER NOT NULL CHECK(leaf_x>=-{leaf_limit} AND leaf_x<{leaf_limit}),
            leaf_z INTEGER NOT NULL CHECK(leaf_z>=-{leaf_limit} AND leaf_z<{leaf_limit}),
            first_ms INTEGER NOT NULL CHECK(first_ms>=0),
            PRIMARY KEY(queue_id,leaf_z,leaf_x)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS lod_queue_leaf_age
            ON lod_queue_leaves(queue_id,first_ms,leaf_z,leaf_x);
        CREATE TABLE IF NOT EXISTS lod_queue_chunks (
            queue_id INTEGER NOT NULL CHECK(queue_id>0),
            cx INTEGER NOT NULL,
            cz INTEGER NOT NULL,
            leaf_x INTEGER NOT NULL CHECK(leaf_x>=-{leaf_limit} AND leaf_x<{leaf_limit}),
            leaf_z INTEGER NOT NULL CHECK(leaf_z>=-{leaf_limit} AND leaf_z<{leaf_limit}),
            sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
            bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes<={MAX_TILE_BYTES}),
            observation_revision INTEGER NOT NULL CHECK(observation_revision>=0),
            first_ms INTEGER NOT NULL CHECK(first_ms>=0),
            last_ms INTEGER NOT NULL CHECK(last_ms>=0),
            PRIMARY KEY(queue_id,cz,cx),
            CHECK(cx>=leaf_x*8 AND cx<(leaf_x+1)*8 AND cz>=leaf_z*8 AND cz<(leaf_z+1)*8)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS lod_queue_chunks_by_leaf
            ON lod_queue_chunks(queue_id,leaf_z,leaf_x,cz,cx);
        CREATE INDEX IF NOT EXISTS lod_queue_chunk_revision
            ON lod_queue_chunks(queue_id,observation_revision);
        CREATE TRIGGER IF NOT EXISTS lod_queue_insert_pending BEFORE INSERT ON lod_queue_chunks
        BEGIN
            SELECT RAISE(ABORT,'queue insert is not pending')
                WHERE NEW.queue_id IS NOT (SELECT pending_id FROM lod_queue_state WHERE singleton=1);
        END;
        CREATE TRIGGER IF NOT EXISTS lod_queue_update_pending BEFORE UPDATE ON lod_queue_chunks
        BEGIN
            SELECT RAISE(ABORT,'frozen queue references are immutable')
                WHERE OLD.queue_id IS NOT (SELECT pending_id FROM lod_queue_state WHERE singleton=1)
                    OR NEW.queue_id!=OLD.queue_id OR NEW.cx!=OLD.cx OR NEW.cz!=OLD.cz
                    OR NEW.first_ms!=OLD.first_ms;
        END;
        CREATE TRIGGER IF NOT EXISTS lod_queue_new_leaf AFTER INSERT ON lod_queue_chunks
        BEGIN
            INSERT INTO lod_queue_leaves(queue_id,leaf_x,leaf_z,first_ms)
                VALUES(NEW.queue_id,NEW.leaf_x,NEW.leaf_z,NEW.first_ms)
                ON CONFLICT(queue_id,leaf_z,leaf_x) DO NOTHING;
        END;
        CREATE TRIGGER IF NOT EXISTS lod_queue_complete AFTER UPDATE OF active_id ON lod_queue_state
        WHEN OLD.active_id IS NOT NULL AND NEW.active_id IS NULL
        BEGIN
            DELETE FROM lod_queue_chunks WHERE queue_id=OLD.active_id;
            DELETE FROM lod_queue_leaves WHERE queue_id=OLD.active_id;
        END;"
    ))?;
    Ok(())
}

/// Returns true for an insertion/newer revision, false for a stale or identical
/// retry. Equal revisions with conflicting references are rejected. Object bytes
/// must already be durable and content-verified by the caller; no file I/O occurs.
pub fn enqueue(tx: &Transaction<'_>, change: &ChangedChunk) -> Result<bool> {
    let key = leaf_key(change.cx, change.cz)?;
    ObjectRef {
        url: format!("objects/{}.zst", change.sha256),
        sha256: change.sha256.clone(),
        bytes: change.bytes,
    }
    .validate(MAX_TILE_BYTES)?;
    let revision = sql_integer(change.observation_revision)?;
    let now = sql_integer(change.now_ms)?;
    let pending: i64 = tx.query_row(
        "SELECT pending_id FROM lod_queue_state WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    let previous: Option<(String, usize, u64)> = tx
        .query_row(
            "SELECT sha256,bytes,observation_revision FROM lod_queue_chunks
             WHERE queue_id=?1 AND cx=?2 AND cz=?3",
            params![pending, change.cx, change.cz],
            |row| Ok((row.get(0)?, nonnegative(row, 1)?, nonnegative(row, 2)?)),
        )
        .optional()?;
    if let Some((hash, bytes, old_revision)) = previous
        && old_revision >= change.observation_revision
    {
        ensure!(
            old_revision != change.observation_revision
                || (hash == change.sha256 && bytes == change.bytes),
            "conflicting chunk references at the same observation revision"
        );
        return Ok(false);
    }
    Ok(tx.execute(
        "INSERT INTO lod_queue_chunks(queue_id,cx,cz,leaf_x,leaf_z,sha256,bytes,observation_revision,first_ms,last_ms)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
         ON CONFLICT(queue_id,cz,cx) DO UPDATE SET sha256=excluded.sha256,bytes=excluded.bytes,
             observation_revision=excluded.observation_revision,last_ms=excluded.last_ms
         WHERE excluded.observation_revision>lod_queue_chunks.observation_revision",
        params![pending, change.cx, change.cz, key.x, key.z, change.sha256, change.bytes as i64, revision, now],
    )? == 1)
}

pub fn active_batch(db: &Connection) -> Result<Option<FrozenBatch>> {
    Ok(db
        .query_row(
            "SELECT active_id,source_revision,context_json,frozen_ms FROM lod_queue_state
             WHERE singleton=1 AND active_id IS NOT NULL",
            [],
            |row| {
                Ok(FrozenBatch {
                    id: row.get(0)?,
                    source_observation_revision: nonnegative(row, 1)?,
                    context_json: row.get(2)?,
                    frozen_ms: nonnegative(row, 3)?,
                })
            },
        )
        .optional()?)
}

/// Returns the existing active batch unchanged, even if new arguments differ.
/// Otherwise freezes all pending references with one control-row update, or
/// returns None when empty. The observation boundary must cover queued revisions.
/// Context must be a JSON object <=64 KiB; its semantics/identity are caller-owned.
pub fn freeze(
    tx: &Transaction<'_>,
    source_observation_revision: u64,
    context_json: &str,
    now_ms: u64,
) -> Result<Option<FrozenBatch>> {
    freeze_inner(tx, source_observation_revision, context_json, now_ms, false)
}

/// Also permit a metadata-only publication (for example updated provenance).
/// Like a changed-chunk batch, it has an immutable boundary and rotates queue IDs.
pub fn freeze_metadata(
    tx: &Transaction<'_>,
    source_observation_revision: u64,
    context_json: &str,
    now_ms: u64,
) -> Result<Option<FrozenBatch>> {
    freeze_inner(tx, source_observation_revision, context_json, now_ms, true)
}

fn freeze_inner(
    tx: &Transaction<'_>,
    source_observation_revision: u64,
    context_json: &str,
    now_ms: u64,
    allow_empty: bool,
) -> Result<Option<FrozenBatch>> {
    if let Some(batch) = active_batch(tx)? {
        return Ok(Some(batch));
    }
    let (pending_id, max_revision): (i64, Option<u64>) = tx.query_row(
        "SELECT pending_id,
            (SELECT MAX(observation_revision) FROM lod_queue_chunks WHERE queue_id=pending_id)
         FROM lod_queue_state WHERE singleton=1",
        [],
        |row| Ok((row.get(0)?, optional_nonnegative(row, 1)?)),
    )?;
    if max_revision.is_none() && !allow_empty {
        return Ok(None);
    }
    let max_revision = max_revision.unwrap_or(0);
    ensure!(pending_id < i64::MAX, "queue ID exhausted");
    ensure!(
        source_observation_revision >= max_revision,
        "source boundary precedes queued observations"
    );
    let revision = sql_integer(source_observation_revision)?;
    let now = sql_integer(now_ms)?;
    ensure!(
        context_json.len() <= MAX_CONTEXT_BYTES,
        "queue context byte limit"
    );
    let context: serde_json::Value = serde_json::from_str(context_json)?;
    ensure!(context.is_object(), "queue context must be a JSON object");
    tx.execute(
        "UPDATE lod_queue_state SET active_id=pending_id,pending_id=pending_id+1,
             source_revision=?1,context_json=?2,frozen_ms=?3 WHERE singleton=1 AND active_id IS NULL",
        params![revision, context_json, now],
    )?;
    active_batch(tx)
}

fn require_active(db: &Connection, batch_id: i64) -> Result<()> {
    ensure!(batch_id > 0, "invalid queue batch ID");
    let active: Option<i64> = db.query_row(
        "SELECT active_id FROM lod_queue_state WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    ensure!(active == Some(batch_id), "queue batch is not active");
    Ok(())
}

/// Reads <=64 leaves, oldest first. Continue using the last row's cursor.
/// An empty page ends traversal. Pass a caller read transaction as &Connection
/// when several reads must share a snapshot with concurrent completion.
pub fn leaf_page(
    db: &Connection,
    batch_id: i64,
    after: Option<LeafCursor>,
    limit: usize,
) -> Result<Vec<QueuedLeaf>> {
    ensure!((1..=MAX_LEAF_PAGE).contains(&limit), "leaf page limit");
    require_active(db, batch_id)?;
    let (time, z, x) = if let Some(cursor) = after {
        TileKey::new(0, cursor.x, cursor.z)?;
        (sql_integer(cursor.first_enqueued_ms)?, cursor.z, cursor.x)
    } else {
        (-1, 0, 0)
    };
    let mut statement = db.prepare(
        "SELECT leaf_x,leaf_z,first_ms FROM lod_queue_leaves
         WHERE queue_id=?1 AND (first_ms,leaf_z,leaf_x)>(?2,?3,?4)
         ORDER BY first_ms,leaf_z,leaf_x LIMIT ?5",
    )?;
    let mut rows = statement.query(params![batch_id, time, z, x, limit as i64])?;
    let mut page = Vec::with_capacity(limit);
    while let Some(row) = rows.next()? {
        page.push(QueuedLeaf {
            key: TileKey::new(0, row.get(0)?, row.get(1)?)?,
            first_enqueued_ms: nonnegative(row, 2)?,
        });
    }
    Ok(page)
}

fn chunk_row(row: &Row<'_>) -> rusqlite::Result<QueuedChunk> {
    Ok(QueuedChunk {
        cx: row.get(0)?,
        cz: row.get(1)?,
        sha256: row.get(2)?,
        bytes: nonnegative(row, 3)?,
        observation_revision: nonnegative(row, 4)?,
        first_enqueued_ms: nonnegative(row, 5)?,
        last_enqueued_ms: nonnegative(row, 6)?,
    })
}

/// Only changed references, not a whole-leaf/world snapshot. The caller merges
/// these <=64 refs with its pinned published source snapshot.
pub fn changed_refs(db: &Connection, batch_id: i64, leaf: TileKey) -> Result<Vec<QueuedChunk>> {
    leaf.validate()?;
    ensure!(leaf.level == 0, "changed references require a detail leaf");
    require_active(db, batch_id)?;
    let mut statement = db.prepare(
        "SELECT cx,cz,sha256,bytes,observation_revision,first_ms,last_ms FROM lod_queue_chunks
         WHERE queue_id=?1 AND leaf_x=?2 AND leaf_z=?3 ORDER BY cz,cx LIMIT 65",
    )?;
    let refs = statement
        .query_map(params![batch_id, leaf.x, leaf.z], chunk_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(refs.len() <= MAX_CHANGED_REFS, "changed reference limit");
    Ok(refs)
}

/// Streams both pending and frozen chunk pins, including duplicate hashes.
/// Callback errors stop traversal. GC must separately pin objects described by
/// opaque context and coordinate its sweep with concurrent object publication.
pub fn visit_references(
    db: &Connection,
    mut visitor: impl FnMut(i64, &QueuedChunk) -> Result<()>,
) -> Result<()> {
    let mut statement = db.prepare(
        "SELECT cx,cz,sha256,bytes,observation_revision,first_ms,last_ms,queue_id
         FROM lod_queue_chunks ORDER BY queue_id,cz,cx",
    )?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        visitor(row.get(7)?, &chunk_row(row)?)?;
    }
    Ok(())
}

/// Pending-only age/revision statistics from a single SQLite read snapshot.
/// Age saturates at zero if the caller's clock moves backward.
pub fn stats(db: &Connection, now_ms: u64) -> Result<QueueStats> {
    sql_integer(now_ms)?;
    Ok(db.query_row(
        "SELECT pending_id,active_id,
            (SELECT COUNT(*) FROM lod_queue_chunks WHERE queue_id=pending_id),
            (SELECT COUNT(*) FROM lod_queue_leaves WHERE queue_id=pending_id),
            (SELECT MIN(first_ms) FROM lod_queue_leaves WHERE queue_id=pending_id),
            (SELECT MIN(observation_revision) FROM lod_queue_chunks WHERE queue_id=pending_id),
            (SELECT MAX(observation_revision) FROM lod_queue_chunks WHERE queue_id=pending_id)
         FROM lod_queue_state WHERE singleton=1",
        [],
        |row| {
            let oldest = optional_nonnegative(row, 4)?;
            Ok(QueueStats {
                pending_queue_id: row.get(0)?,
                active_batch_id: row.get(1)?,
                pending_chunks: nonnegative(row, 2)?,
                pending_leaves: nonnegative(row, 3)?,
                oldest_pending_ms: oldest,
                oldest_pending_age_ms: oldest.map(|first| now_ms.saturating_sub(first)),
                min_observation_revision: optional_nonnegative(row, 5)?,
                max_observation_revision: optional_nonnegative(row, 6)?,
            })
        },
    )?)
}

/// Acknowledge only after coherent publication succeeds. No per-leaf work state
/// is tracked: the caller owns that completion decision. One SQL statement and
/// its cleanup trigger remove only the active queue, preserving newer edits.
pub fn complete(tx: &Transaction<'_>, batch_id: i64) -> Result<()> {
    require_active(tx, batch_id)?;
    ensure!(tx.execute(
        "UPDATE lod_queue_state SET active_id=NULL,source_revision=NULL,context_json=NULL,frozen_ms=NULL
         WHERE singleton=1 AND active_id=?1",
        [batch_id],
    )? == 1, "queue batch is not active");
    Ok(())
}
