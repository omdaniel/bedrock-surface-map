use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use surface_core::{
    MapManifest, Material, RegionRef, SurfaceRegion, encode_region,
    lod::*,
    terrain::{MaterialSpec, ScanDiagnostics, SurfaceChunk, TerrainObservation},
};
use surface_sync::{
    lod_publish::{Publisher, Step},
    lod_queue,
    store::{Store, hash, now_ms},
};
use tempfile::TempDir;

const LIMIT: u64 = 1 << 30;
const STEP_LIMIT: usize = 256;
type SharedStore = Arc<Mutex<Store>>;

fn chunk(height: i32) -> SurfaceChunk {
    SurfaceChunk {
        cx: -1,
        cz: 0,
        columns: vec![[1, height, 1, 0x91bd59, 1, 0, -32768, 0, 1, height]; 256],
    }
}

fn fixture(root: &Path) {
    fs::create_dir_all(root).unwrap();
    let mut region = SurfaceRegion::empty(-1, 0);
    chunk(16).apply(&mut region).unwrap();
    let bytes = zstd::encode_all(encode_region(&region).unwrap().as_slice(), 3).unwrap();
    fs::write(root.join("region.zst"), &bytes).unwrap();
    fs::write(root.join("atlas.png"), b"synthetic-publisher-fixture").unwrap();
    let manifest = MapManifest {
        format_version: 1,
        name: "Synthetic publisher fixture".into(),
        bounds: [-256, 0, 0, 256],
        spawn: [-1, 2, 1],
        source_sha256: hash(b"synthetic-publisher-source"),
        catalog_version: hash(b"synthetic-publisher-catalog"),
        materials: vec![
            Material {
                key: "unknown".into(),
                name: "Unknown".into(),
                texture: "unknown".into(),
                tint: 0,
                approximate: true,
                uv: [0., 0., 1., 1.],
                average: [1., 0., 1., 1.],
            },
            Material {
                key: r#"["minecraft:stone",{}]"#.into(),
                name: "stone".into(),
                texture: "stone".into(),
                tint: 0,
                approximate: false,
                uv: [0., 0., 1., 1.],
                average: [0.5, 0.5, 0.5, 1.],
            },
        ],
        atlas: "atlas.png".into(),
        regions: vec![RegionRef {
            rx: -1,
            rz: 0,
            url: "region.zst".into(),
            sha256: hash(&bytes),
            bytes: bytes.len(),
            columns: 256,
        }],
        heights: String::new(),
        heights_sha256: String::new(),
        height_range: [16, 16],
        approximations: vec![],
    };
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
}

fn seeded() -> (TempDir, SharedStore) {
    let directory = tempfile::tempdir().unwrap();
    fixture(&directory.path().join("map"));
    let mut store =
        Store::open(&directory.path().join("state"), "test", "generation", LIMIT).unwrap();
    store
        .seed(&directory.path().join("map"), None, None)
        .unwrap();
    (directory, Arc::new(Mutex::new(store)))
}

fn observation(sequence: u64, start: u64, height: i32) -> TerrainObservation {
    TerrainObservation {
        schema_version: 1,
        rules_version: 1,
        world_id: "test".into(),
        generation: "generation".into(),
        producer: "synthetic-publisher".into(),
        started_ms: start,
        sequence,
        scan_start_ms: start,
        scan_end_ms: start + 1,
        materials: vec![
            MaterialSpec {
                name: "surface:unknown".into(),
                states: BTreeMap::new(),
            },
            MaterialSpec {
                name: "minecraft:stone".into(),
                states: BTreeMap::new(),
            },
        ],
        chunks: vec![chunk(height)],
        diagnostics: ScanDiagnostics::default(),
    }
}

fn ingest(store: &SharedStore, sequence: u64, start: u64, height: i32) -> bool {
    store
        .lock()
        .unwrap()
        .ingest(&observation(sequence, start, height), start + sequence + 1)
        .unwrap()
}

fn current(store: &SharedStore) -> LodManifest {
    store.lock().unwrap().lod_manifest().unwrap()
}

fn lod_health(store: &SharedStore, now: u64) -> Value {
    store.lock().unwrap().health(now).unwrap()["lod"].clone()
}

fn root(store: &SharedStore) -> PathBuf {
    store.lock().unwrap().root.clone()
}

fn publish(publisher: &mut Publisher) -> u64 {
    for step in 0..STEP_LIMIT {
        match publisher
            .step()
            .unwrap_or_else(|error| panic!("publisher step {step}: {error:#}"))
        {
            Step::Published(revision) => return revision,
            Step::Working => {}
            Step::Idle => panic!("publisher went idle before completing requested publication"),
        }
    }
    panic!("publisher exceeded {STEP_LIMIT} steps for the tiny fixture")
}

fn until_staged(publisher: &mut Publisher, store: &SharedStore) {
    for step in 0..STEP_LIMIT {
        assert_eq!(
            publisher
                .step()
                .unwrap_or_else(|e| panic!("staging step {step}: {e:#}")),
            Step::Working
        );
        let store = store.lock().unwrap();
        let count: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM lod_work WHERE index_ref IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        if count > 0 {
            return;
        }
    }
    panic!("publisher never staged a node")
}

fn verified(root: &Path, reference: &ObjectRef, limit: usize) -> Vec<u8> {
    reference.validate(limit).unwrap();
    let path = root.join(&reference.url);
    assert_eq!(fs::metadata(&path).unwrap().len(), reference.bytes as u64);
    let bytes = fs::read(path).unwrap();
    assert_eq!(hash(&bytes), reference.sha256);
    bytes
}

#[derive(Default)]
struct Graph {
    nodes: BTreeMap<TileKey, LodNode>,
    hashes: BTreeSet<String>,
    present_columns: usize,
}

impl Graph {
    fn read(&mut self, root: &Path, reference: &ObjectRef, limit: usize) -> Vec<u8> {
        self.hashes.insert(reference.sha256.clone());
        verified(root, reference, limit)
    }

    fn visit(
        &mut self,
        root: &Path,
        reference: &NodeRef,
        manifest: &LodManifest,
        materials: &[Material],
    ) -> SummaryTile {
        let node = LodNode::decode(&self.read(root, &reference.index, MAX_NODE_BYTES)).unwrap();
        assert_eq!(node.key, reference.key);
        assert!(self.nodes.insert(node.key, node.clone()).is_none());
        let data = decompress_lod(&self.read(root, &node.data, MAX_TILE_BYTES)).unwrap();
        let heights = HeightTile::decode(
            &decompress_lod(&self.read(root, &node.height, MAX_TILE_BYTES)).unwrap(),
        )
        .unwrap();
        assert_eq!(heights.key, node.key);
        if node.key.level == 0 {
            let detail = DetailTile::decode(&data).unwrap();
            assert_eq!(detail.key, node.key);
            assert_eq!(heights, HeightTile::from_detail(&detail).unwrap());
            self.present_columns += detail.columns.iter().filter(|c| c[0] == 1).count();
            for reference in &node.chunks {
                let raw =
                    decompress_lod(&self.read(root, &reference.object, MAX_TILE_BYTES)).unwrap();
                let chunk = SurfaceChunk::decode(&raw).unwrap();
                assert_eq!((chunk.cx, chunk.cz), (reference.cx, reference.cz));
                let ox = chunk.cx.rem_euclid(8) as usize * 16;
                let oz = chunk.cz.rem_euclid(8) as usize * 16;
                for z in 0..16 {
                    assert_eq!(
                        &detail.columns[(oz + z) * 128 + ox..(oz + z) * 128 + ox + 16],
                        &chunk.columns[z * 16..z * 16 + 16]
                    );
                }
            }
            SummaryTile::from_detail(&detail, materials).unwrap()
        } else {
            let summary = SummaryTile::decode(&data).unwrap();
            assert_eq!(summary.key, node.key);
            assert_eq!(heights, HeightTile::from_summary(&summary).unwrap());
            if node.children.is_empty() {
                assert_eq!(
                    summary,
                    SummaryTile::absent(node.key, manifest.bounds).unwrap()
                );
            } else {
                let children = node.key.children().unwrap().map(|key| {
                    if let Some(child) = node.children.iter().find(|child| child.key == key) {
                        self.visit(root, child, manifest, materials)
                    } else {
                        let bounds = key.bounds().unwrap();
                        assert!(
                            bounds[2] <= manifest.bounds[0]
                                || bounds[0] >= manifest.bounds[2]
                                || bounds[3] <= manifest.bounds[1]
                                || bounds[1] >= manifest.bounds[3],
                            "missing intersecting child {key:?}"
                        );
                        SummaryTile::absent(key, manifest.bounds).unwrap()
                    }
                });
                assert_eq!(
                    summary,
                    SummaryTile::from_children(
                        node.key,
                        [&children[0], &children[1], &children[2], &children[3]]
                    )
                    .unwrap()
                );
            }
            summary
        }
    }
}

fn audit_graph(root: &Path, manifest: &LodManifest) -> Graph {
    manifest.validate().unwrap();
    let mut graph = Graph::default();
    graph.read(root, &manifest.atlas, MAX_ATLAS_BYTES);
    let mut materials = Vec::new();
    for page in &manifest.catalog {
        assert_eq!(page.start, materials.len());
        let decoded: Vec<Material> =
            serde_json::from_slice(&graph.read(root, &page.object, MAX_CATALOG_PAGE_BYTES))
                .unwrap();
        assert_eq!(decoded.len(), page.count);
        materials.extend(decoded);
    }
    assert_eq!(materials.len(), manifest.material_count);
    let mut range = [i16::MAX, i16::MIN];
    for reference in &manifest.roots {
        let summary = graph.visit(root, reference, manifest, &materials);
        for sample in summary.samples.iter().filter(|s| s.flags & PRESENT != 0) {
            range[0] = range[0].min(sample.min_height);
            range[1] = range[1].max(sample.max_height);
        }
    }
    assert_eq!(range, manifest.height_range);
    graph
}

fn audit(root: &Path, manifest: &LodManifest) -> Graph {
    let graph = audit_graph(root, manifest);
    assert_eq!(graph.nodes.len(), 5);
    assert_eq!(graph.present_columns, 256);
    graph
}

fn height(root: &Path, graph: &Graph) -> i32 {
    let node = &graph.nodes[&TileKey::new(0, -1, 0).unwrap()];
    let detail =
        DetailTile::decode(&decompress_lod(&verified(root, &node.data, MAX_TILE_BYTES)).unwrap())
            .unwrap();
    detail.columns[112][1]
}

#[test]
fn bootstraps_existing_chunks_and_publishes_a_fully_verified_graph() {
    let (_directory, store) = seeded();
    assert_eq!(lod_health(&store, now_ms())["status"], "starting");
    // Model a legacy database with terrain but no queued changes from before LOD rollout.
    store
        .lock()
        .unwrap()
        .connection
        .execute_batch("DELETE FROM lod_queue_chunks; DELETE FROM lod_queue_leaves;")
        .unwrap();
    let mut publisher = Publisher::open(store.clone()).unwrap();
    assert_eq!(
        lod_queue::stats(&store.lock().unwrap().connection, now_ms())
            .unwrap()
            .pending_chunks,
        1
    );
    assert_eq!(publish(&mut publisher), 1);
    let manifest = current(&store);
    assert_eq!(manifest.bounds, [-256, 0, 0, 256]);
    assert_eq!(manifest.roots[0].key, TileKey::new(1, -1, 0).unwrap());
    assert_eq!(manifest.world_id.as_deref(), Some("test"));
    assert_eq!(manifest.generation, "generation");
    assert_eq!(manifest.height_range, [16, 16]);
    let graph = audit(&root(&store), &manifest);
    assert_eq!(height(&root(&store), &graph), 16);
    let health = lod_health(&store, now_ms());
    assert_eq!(health["status"], "live");
    assert_eq!(health["revision_lag"], 0);
    assert!(
        lod_queue::active_batch(&store.lock().unwrap().connection)
            .unwrap()
            .is_none()
    );
    assert_eq!(publisher.step().unwrap(), Step::Idle);
}

#[test]
fn unchanged_observations_stay_idle_and_preserve_all_hashes() {
    let (_directory, store) = seeded();
    let mut publisher = Publisher::open(store.clone()).unwrap();
    publish(&mut publisher);
    let before = current(&store);
    let hashes = audit(&root(&store), &before).hashes;
    assert!(!ingest(&store, 1, now_ms(), 16));
    for _ in 0..3 {
        assert_eq!(publisher.step().unwrap(), Step::Idle);
    }
    assert_eq!(current(&store), before);
    assert_eq!(audit(&root(&store), &before).hashes, hashes);
}

#[test]
fn live_changes_replace_fine_and_coarse_only_at_atomic_publication() {
    let (_directory, store) = seeded();
    let mut publisher = Publisher::open(store.clone()).unwrap();
    publish(&mut publisher);
    let before = current(&store);
    let old = audit(&root(&store), &before);
    let start = now_ms();
    assert!(ingest(&store, 1, start, 48));
    let health = lod_health(&store, start + 2);
    assert_eq!(health["status"], "updating");
    assert!(health["revision_lag"].as_u64().unwrap() > 0);
    assert_eq!(health["pending_age_ms"], 0);
    let aged = lod_health(&store, start + 31_002);
    assert_eq!(aged["status"], "degraded");
    assert_eq!(aged["pending_age_ms"], 31_000);
    let mut published = false;
    for _ in 0..STEP_LIMIT {
        match publisher.step().unwrap() {
            Step::Working => assert_eq!(current(&store), before),
            Step::Published(2) => {
                published = true;
                break;
            }
            other => panic!("unexpected publisher result: {other:?}"),
        }
    }
    assert!(published);
    let next = current(&store);
    let new = audit(&root(&store), &next);
    assert_eq!(height(&root(&store), &new), 48);
    assert_eq!(next.height_range, [48, 48]);
    let leaf = TileKey::new(0, -1, 0).unwrap();
    let coarse = TileKey::new(1, -1, 0).unwrap();
    for key in [leaf, coarse] {
        assert_ne!(old.nodes[&key].data, new.nodes[&key].data);
        assert_ne!(old.nodes[&key].height, new.nodes[&key].height);
    }
    for (key, node) in &old.nodes {
        if *key != leaf && *key != coarse {
            assert_eq!(node, &new.nodes[key]);
        }
    }
    assert_eq!(publisher.step().unwrap(), Step::Idle);
    let health = lod_health(&store, now_ms());
    assert_eq!(health["status"], "live");
    assert_eq!(health["revision_lag"], 0);
    assert!(health["pending_age_ms"].is_null());
}

#[test]
fn frozen_publication_keeps_newer_writes_for_the_next_batch() {
    let (_directory, store) = seeded();
    let mut publisher = Publisher::open(store.clone()).unwrap();
    publish(&mut publisher);
    let before = current(&store);
    let start = now_ms();
    assert!(ingest(&store, 1, start, 48));
    assert_eq!(publisher.step().unwrap(), Step::Working);
    let aged_frozen = lod_health(&store, start + 31_002);
    assert_eq!(aged_frozen["status"], "degraded");
    assert_eq!(aged_frozen["pending_age_ms"], 31_000);
    let frozen = lod_queue::active_batch(&store.lock().unwrap().connection)
        .unwrap()
        .unwrap();
    assert!(ingest(&store, 2, start, 80));
    assert_eq!(current(&store), before);
    assert_eq!(
        lod_queue::active_batch(&store.lock().unwrap().connection).unwrap(),
        Some(frozen)
    );
    assert_eq!(publish(&mut publisher), 2);
    let intermediate = current(&store);
    assert_eq!(
        height(&root(&store), &audit(&root(&store), &intermediate)),
        48
    );
    assert_eq!(
        lod_queue::stats(&store.lock().unwrap().connection, now_ms())
            .unwrap()
            .pending_chunks,
        1
    );
    assert_eq!(publish(&mut publisher), 3);
    assert_eq!(
        height(&root(&store), &audit(&root(&store), &current(&store))),
        80
    );
    assert_eq!(publisher.step().unwrap(), Step::Idle);
}

#[test]
fn restart_resumes_staged_batch_and_lease_excludes_another_publisher() {
    let (directory, store) = seeded();
    let mut publisher = Publisher::open(store.clone()).unwrap();
    assert!(Publisher::open(store.clone()).is_err());
    let separate = Arc::new(Mutex::new(
        Store::open(&root(&store), "test", "generation", LIMIT).unwrap(),
    ));
    assert!(Publisher::open(separate).is_err());
    until_staged(&mut publisher, &store);
    assert!(store.lock().unwrap().lod_manifest().is_err());
    let frozen = lod_queue::active_batch(&store.lock().unwrap().connection)
        .unwrap()
        .unwrap();
    drop(publisher);
    drop(store);
    let reopened = Arc::new(Mutex::new(
        Store::open(&directory.path().join("state"), "test", "generation", LIMIT).unwrap(),
    ));
    let mut publisher = Publisher::open(reopened.clone()).unwrap();
    assert_eq!(
        lod_queue::active_batch(&reopened.lock().unwrap().connection).unwrap(),
        Some(frozen)
    );
    assert_eq!(publish(&mut publisher), 1);
    let restarted = current(&reopened);
    let graph = audit(&root(&reopened), &restarted);
    let (_other_directory, other) = seeded();
    let mut uninterrupted = Publisher::open(other.clone()).unwrap();
    assert_eq!(publish(&mut uninterrupted), 1);
    assert_eq!(current(&other), restarted);
    assert_eq!(audit(&root(&other), &current(&other)).hashes, graph.hashes);
}

#[test]
fn quota_failure_preserves_publication_and_batch_can_resume() {
    let (_directory, store) = seeded();
    let mut publisher = Publisher::open(store.clone()).unwrap();
    publish(&mut publisher);
    let before = current(&store);
    assert!(ingest(&store, 1, now_ms(), 48));
    store.lock().unwrap().limit = 0;
    let mut failed = false;
    for _ in 0..STEP_LIMIT {
        match publisher.step() {
            Err(error) => {
                assert!(error.to_string().contains("capacity"), "{error:#}");
                failed = true;
                break;
            }
            Ok(Step::Working) => assert_eq!(current(&store), before),
            other => panic!("quota bypass: {other:?}"),
        }
    }
    assert!(failed);
    assert_eq!(current(&store), before);
    audit(&root(&store), &before);
    assert!(
        lod_queue::active_batch(&store.lock().unwrap().connection)
            .unwrap()
            .is_some()
    );
    store.lock().unwrap().limit = LIMIT;
    assert_eq!(publish(&mut publisher), 2);
    assert_eq!(
        height(&root(&store), &audit(&root(&store), &current(&store))),
        48
    );
}

#[test]
fn gc_preserves_published_staged_frozen_and_pending_objects() {
    let (_directory, store) = seeded();
    let mut publisher = Publisher::open(store.clone()).unwrap();
    publish(&mut publisher);
    let before = current(&store);
    let old = audit(&root(&store), &before);
    let old_leaf = old.nodes[&TileKey::new(0, -1, 0).unwrap()].data.clone();
    let start = now_ms();
    assert!(ingest(&store, 1, start, 48));
    until_staged(&mut publisher, &store);
    let staged: Vec<(ObjectRef, LodNode)> = {
        let store = store.lock().unwrap();
        let mut query = store
            .connection
            .prepare("SELECT index_ref,node FROM lod_work WHERE index_ref IS NOT NULL")
            .unwrap();
        query
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .map(|row| {
                let (reference, node) = row.unwrap();
                (
                    serde_json::from_str(&reference).unwrap(),
                    serde_json::from_str(&node).unwrap(),
                )
            })
            .collect()
    };
    assert!(!staged.is_empty());
    assert!(ingest(&store, 2, start, 80));
    let path = root(&store);
    let orphan = path
        .join("objects")
        .join(format!("{}.zst", hash(b"synthetic-orphan")));
    fs::write(&orphan, b"synthetic-orphan").unwrap();
    store.lock().unwrap().gc(now_ms() + 3_700_000).unwrap();
    assert!(!orphan.exists());
    audit(&path, &before);
    for (reference, node) in staged {
        verified(&path, &reference, MAX_NODE_BYTES);
        verified(&path, &node.data, MAX_TILE_BYTES);
        verified(&path, &node.height, MAX_TILE_BYTES);
    }
    lod_queue::visit_references(&store.lock().unwrap().connection, |_, reference| {
        verified(&path, &reference.object_ref(), MAX_TILE_BYTES);
        Ok(())
    })
    .unwrap();
    assert_eq!(publish(&mut publisher), 2);
    assert_eq!(publish(&mut publisher), 3);
    store.lock().unwrap().gc(now_ms() + 3_700_000).unwrap();
    audit(&path, &current(&store));
    assert!(
        !path.join(old_leaf.url).exists(),
        "unreferenced old detail should become collectible"
    );
    let work: i64 = store
        .lock()
        .unwrap()
        .connection
        .query_row("SELECT COUNT(*) FROM lod_work", [], |r| r.get(0))
        .unwrap();
    assert_eq!(work, 0);
}

#[test]
fn new_negative_chunk_grows_the_root_and_preserves_terrain_and_unknown_gaps() {
    let (_directory, store) = seeded();
    let mut publisher = Publisher::open(store.clone()).unwrap();
    publish(&mut publisher);
    let before = current(&store);
    let path = root(&store);
    let old = audit(&path, &before);
    let start = now_ms();
    let mut new_region = observation(1, start, 96);
    new_region.chunks[0].cx = -33;
    assert!(
        store
            .lock()
            .unwrap()
            .ingest(&new_region, start + 2)
            .unwrap()
    );
    assert_eq!(publish(&mut publisher), 2);
    let next = current(&store);
    assert_eq!(next.bounds, [-768, 0, 0, 256]);
    assert_eq!(next.roots.len(), 1);
    assert_eq!(next.roots[0].key, TileKey::new(3, -1, 0).unwrap());
    assert_eq!(next.height_range, [16, 96]);
    let graph = audit_graph(&path, &next);
    assert_eq!(graph.present_columns, 512);
    for (key, node) in &old.nodes {
        assert_eq!(&graph.nodes[key], node, "old terrain changed at {key:?}");
    }
    assert_eq!(height(&path, &graph), 16);
    let new_leaf = &graph.nodes[&TileKey::new(0, -5, 0).unwrap()];
    let detail = DetailTile::decode(
        &decompress_lod(&verified(&path, &new_leaf.data, MAX_TILE_BYTES)).unwrap(),
    )
    .unwrap();
    assert_eq!(detail.columns[112], chunk(96).columns[0]);
    let gap = &graph.nodes[&TileKey::new(1, -2, 0).unwrap()];
    assert!(
        gap.children.is_empty(),
        "gap should be an explicit terminal unknown subtree"
    );
    let summary =
        SummaryTile::decode(&decompress_lod(&verified(&path, &gap.data, MAX_TILE_BYTES)).unwrap())
            .unwrap();
    assert!(
        summary
            .samples
            .iter()
            .all(|s| *s == SummarySample::absent(UNKNOWN_FLAG))
    );
    let top = &graph.nodes[&next.roots[0].key];
    let summary =
        SummaryTile::decode(&decompress_lod(&verified(&path, &top.data, MAX_TILE_BYTES)).unwrap())
            .unwrap();
    assert_eq!(
        summary.samples.iter().fold(0, |flags, s| flags | s.flags),
        PRESENT | UNKNOWN_FLAG | OUTSIDE
    );
    assert_eq!(publisher.step().unwrap(), Step::Idle);
}

#[test]
fn metadata_only_provenance_republishes_without_changing_any_node_hash() {
    let (directory, store) = seeded();
    let mut publisher = Publisher::open(store.clone()).unwrap();
    publish(&mut publisher);
    let before = current(&store);
    let path = root(&store);
    let old = audit(&path, &before);
    let source_path = directory.path().join("map/manifest.json");
    let mut source: MapManifest = serde_json::from_slice(&fs::read(&source_path).unwrap()).unwrap();
    source.source_sha256 = hash(b"new-synthetic-backup-provenance");
    fs::write(source_path, serde_json::to_vec(&source).unwrap()).unwrap();
    let boundary = store.lock().unwrap().boundary().unwrap();
    let report = store
        .lock()
        .unwrap()
        .seed(&directory.path().join("map"), None, Some(&boundary))
        .unwrap();
    assert_eq!(report["changed"], 0);
    assert_eq!(
        lod_queue::stats(&store.lock().unwrap().connection, now_ms())
            .unwrap()
            .pending_chunks,
        0
    );
    assert_eq!(current(&store), before);
    assert_eq!(publish(&mut publisher), 2);
    let next = current(&store);
    assert_eq!(next.source_sha256, source.source_sha256);
    assert_ne!(next.source_sha256, before.source_sha256);
    assert_eq!(next.roots, before.roots);
    assert_eq!(next.catalog, before.catalog);
    assert_eq!(next.atlas, before.atlas);
    let graph = audit(&path, &next);
    assert_eq!(graph.nodes, old.nodes);
    assert_eq!(graph.hashes, old.hashes);
    assert_eq!(publisher.step().unwrap(), Step::Idle);
}

#[test]
fn catalog_append_reuses_nodes_but_descriptor_mutation_regrades_parent_colors() {
    let (_directory, store) = seeded();
    let mut publisher = Publisher::open(store.clone()).unwrap();
    publish(&mut publisher);
    let before = current(&store);
    let path = root(&store);
    let old = audit(&path, &before);
    let original_materials: Vec<Material> = serde_json::from_slice(&verified(
        &path,
        &before.catalog[0].object,
        MAX_CATALOG_PAGE_BYTES,
    ))
    .unwrap();
    let start = now_ms();
    let mut append = observation(1, start, 16);
    append.chunks.clear();
    append.materials.push(MaterialSpec {
        name: "minecraft:sand".into(),
        states: BTreeMap::new(),
    });
    assert!(!store.lock().unwrap().ingest(&append, start + 2).unwrap());
    // Replace the newly interned placeholder using the public catalog repair path.
    let mut sand = original_materials[1].clone();
    sand.name = "sand".into();
    sand.texture = "synthetic:sand".into();
    sand.average = [0.8, 0.7, 0.2, 1.];
    {
        let mut store = store.lock().unwrap();
        store
            .connection
            .execute(
                "INSERT INTO templates(name,material) VALUES('sand',?1)",
                [serde_json::to_string(&sand).unwrap()],
            )
            .unwrap();
        assert_eq!(store.refresh_catalog().unwrap(), 1);
        assert_eq!(
            lod_queue::stats(&store.connection, now_ms())
                .unwrap()
                .pending_chunks,
            0
        );
    }
    assert_eq!(publish(&mut publisher), 2);
    let appended = current(&store);
    let appended_graph = audit(&path, &appended);
    assert_eq!(appended.material_count, before.material_count + 1);
    let appended_materials: Vec<Material> = serde_json::from_slice(&verified(
        &path,
        &appended.catalog[0].object,
        MAX_CATALOG_PAGE_BYTES,
    ))
    .unwrap();
    assert_eq!(
        serde_json::to_vec(&appended_materials[..original_materials.len()]).unwrap(),
        serde_json::to_vec(&original_materials).unwrap()
    );
    assert_eq!(appended.roots, before.roots);
    assert_eq!(appended_graph.nodes, old.nodes);

    let mut stone = original_materials[1].clone();
    stone.average = [0.1, 0.8, 0.2, 1.];
    {
        let mut store = store.lock().unwrap();
        store
            .connection
            .execute(
                "UPDATE templates SET material=?1 WHERE name='stone'",
                [serde_json::to_string(&stone).unwrap()],
            )
            .unwrap();
        assert_eq!(store.refresh_catalog().unwrap(), 1);
        assert_eq!(
            lod_queue::stats(&store.connection, now_ms())
                .unwrap()
                .pending_chunks,
            0
        );
    }
    assert_eq!(current(&store), appended);
    assert_eq!(publish(&mut publisher), 3);
    let changed = current(&store);
    let changed_graph = audit(&path, &changed);
    assert_eq!(changed.material_count, appended.material_count);
    assert_ne!(changed.catalog, appended.catalog);
    for (key, node) in &appended_graph.nodes {
        assert_eq!(changed_graph.nodes[key].height, node.height);
        if key.level == 0 {
            assert_eq!(
                &changed_graph.nodes[key], node,
                "exact fields changed after descriptor repair"
            );
        }
    }
    let parent = appended.roots[0].key;
    let old_summary = SummaryTile::decode(
        &decompress_lod(&verified(
            &path,
            &appended_graph.nodes[&parent].data,
            MAX_TILE_BYTES,
        ))
        .unwrap(),
    )
    .unwrap();
    let new_summary = SummaryTile::decode(
        &decompress_lod(&verified(
            &path,
            &changed_graph.nodes[&parent].data,
            MAX_TILE_BYTES,
        ))
        .unwrap(),
    )
    .unwrap();
    assert!(
        old_summary
            .samples
            .iter()
            .zip(&new_summary.samples)
            .any(|(old, new)| old.flags & PRESENT != 0
                && old.original != new.original
                && old.vivid != new.vivid)
    );
    assert_eq!(height(&path, &changed_graph), 16);
    assert_eq!(publisher.step().unwrap(), Step::Idle);
}
