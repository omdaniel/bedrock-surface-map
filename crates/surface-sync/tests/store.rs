use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path};
use surface_core::{
    MapManifest, Material, RegionRef, SurfaceRegion, encode_region,
    terrain::{EMPTY, MaterialSpec, ScanDiagnostics, SurfaceChunk, TerrainObservation},
};
use surface_sync::store::{Store, hash, now_ms};
use tempfile::TempDir;

fn fixture(root: &Path, height: i32) {
    fs::create_dir_all(root).unwrap();
    let mut region = SurfaceRegion::empty(-1, 0);
    SurfaceChunk {
        cx: -1,
        cz: 0,
        columns: vec![[1, height, 1, 0x91bd59, 1, 0, -32768, 0, 1, height]; 256],
    }
    .apply(&mut region)
    .unwrap();
    let bytes = zstd::encode_all(encode_region(&region).unwrap().as_slice(), 3).unwrap();
    fs::write(root.join("region.zst"), &bytes).unwrap();
    fs::write(root.join("atlas.png"), b"fixture-only").unwrap();
    let materials = vec![
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
    ];
    let manifest = MapManifest {
        format_version: 1,
        name: "Synthetic".into(),
        bounds: [-256, 0, 0, 256],
        spawn: [-1, 2, 1],
        source_sha256: hash(b"fixture"),
        catalog_version: hash(b"catalog"),
        materials,
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
        height_range: [height as i16; 2],
        approximations: vec![],
    };
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
}
fn seeded() -> (TempDir, Store) {
    let dir = TempDir::new().unwrap();
    fixture(&dir.path().join("map"), 16);
    let mut store = Store::open(&dir.path().join("state"), "test", "generation", 1 << 30).unwrap();
    store.seed(&dir.path().join("map"), None, None).unwrap();
    (dir, store)
}
fn observation(sequence: u64, start: u64, height: i32) -> TerrainObservation {
    TerrainObservation {
        schema_version: 1,
        rules_version: 1,
        world_id: "test".into(),
        generation: "generation".into(),
        producer: format!("boot-{start}"),
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
        chunks: vec![SurfaceChunk {
            cx: -1,
            cz: 0,
            columns: vec![[1, height, 1, 0x91bd59, 1, 0, -32768, 0, 1, height]; 256],
        }],
        diagnostics: ScanDiagnostics::default(),
    }
}
fn current_height(store: &Store) -> i32 {
    let manifest = store.manifest().unwrap();
    let url = manifest["regions"][0]["index"]["url"].as_str().unwrap();
    let index: Value =
        serde_json::from_slice(&store.object(url.trim_start_matches("objects/")).unwrap()).unwrap();
    let url = index["chunks"]["-1,0"]["url"].as_str().unwrap();
    let bytes = store.object(url.trim_start_matches("objects/")).unwrap();
    SurfaceChunk::decode(&surface_core::decompress(&bytes, 32768).unwrap())
        .unwrap()
        .columns[0][1]
}
#[test]
fn unchanged_content_updates_observation_without_republishing() {
    let (_dir, mut s) = seeded();
    let start = now_ms();
    let initial = s.manifest().unwrap();
    assert!(!s.ingest(&observation(1, start, 16), start + 2).unwrap());
    assert_eq!(s.manifest().unwrap(), initial);
    assert!(s.ingest(&observation(2, start, 32), start + 3).unwrap());
    assert_eq!(current_height(&s), 32);
    assert_eq!(s.manifest().unwrap()["revision"], json!(2));
    assert!(s.ingest(&observation(2, start, 16), start + 4).is_err());
    assert_eq!(current_height(&s), 32);
}
#[test]
fn old_sessions_wrong_world_and_failed_batch_do_not_mutate() {
    let (_dir, mut s) = seeded();
    let start = now_ms();
    s.ingest(&observation(1, start, 32), start + 2).unwrap();
    s.ingest(&observation(1, start + 10, 48), start + 12)
        .unwrap();
    assert!(s.ingest(&observation(5, start, 16), start + 15).is_err());
    let mut wrong = observation(2, start + 10, 16);
    wrong.world_id = "elsewhere".into();
    assert!(s.ingest(&wrong, start + 20).is_err());
    wrong.world_id = "test".into();
    wrong.chunks[0].columns[0][2] = 200;
    assert!(s.ingest(&wrong, start + 20).is_err());
    assert_eq!(current_height(&s), 48);
}
#[test]
fn unchanged_newer_live_observation_wins_over_backup() {
    let (dir, mut s) = seeded();
    let b = s.boundary().unwrap();
    fixture(&dir.path().join("older-backup"), 48);
    s.ingest(&observation(1, b.created_ms + 1, 16), b.created_ms + 5)
        .unwrap();
    let report = s
        .seed(&dir.path().join("older-backup"), None, Some(&b))
        .unwrap();
    assert_eq!(report["newer_live_preserved"], json!(1));
    assert_eq!(current_height(&s), 16);
    drop(s);
    let mut reopened =
        Store::open(&dir.path().join("state"), "test", "generation", 1 << 30).unwrap();
    assert_eq!(current_height(&reopened), 16);
    assert!(
        reopened
            .ingest(&observation(1, b.created_ms + 1, 32), b.created_ms + 8)
            .is_err()
    );
}

#[test]
fn a_superseded_repair_boundary_still_cannot_replace_newer_observations() {
    let (dir, mut s) = seeded();
    let old = s.boundary().unwrap();
    s.ingest(&observation(1, old.created_ms + 1, 32), old.created_ms + 2)
        .unwrap();
    let _new = s.boundary().unwrap();
    fixture(&dir.path().join("old"), 48);
    let result = s.seed(&dir.path().join("old"), None, Some(&old)).unwrap();
    assert_eq!(result["newer_live_preserved"], json!(1));
    assert_eq!(current_height(&s), 32);
}
#[test]
fn new_chunks_empty_columns_and_catalog_ids_are_stable() {
    let (_dir, mut s) = seeded();
    let start = now_ms();
    let mut a = observation(1, start, 16);
    a.chunks[0].cx = 32;
    a.materials[1].name = "minecraft:diamond_block".into();
    s.ingest(&a, start + 2).unwrap();
    let manifest = s.manifest().unwrap();
    assert_eq!(manifest["bounds"], json!([-256, 0, 768, 256]));
    let catalog: Value = serde_json::from_slice(
        &s.object(
            manifest["catalog"]["url"]
                .as_str()
                .unwrap()
                .trim_start_matches("objects/"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(catalog[1]["name"], json!("stone"));
    assert_eq!(catalog[2]["name"], json!("diamond_block"));
    a.sequence = 2;
    a.chunks[0].columns = vec![EMPTY; 256];
    s.ingest(&a, start + 3).unwrap();
    assert_eq!(current_height(&s), 16);
}
#[test]
fn capacity_and_missing_objects_fail_without_replacing_manifest() {
    let (_dir, mut s) = seeded();
    let before = s.manifest().unwrap();
    s.limit = 1;
    assert!(
        s.ingest(&observation(1, now_ms(), 32), now_ms() + 2)
            .is_err()
    );
    assert_eq!(s.manifest().unwrap(), before);
    assert!(s.object("../current.sqlite3").is_err());
    assert!(!surface_sync::store::valid_object_name(
        &"\u{1f600}".repeat(18)
    ));
}

#[test]
fn external_repair_writes_refresh_the_running_process_storage_budget() {
    let (dir, mut s) = seeded();
    // Simulate another accepted writer and a large derived object allocation.
    let external = Store::open(&dir.path().join("state"), "test", "generation", 1 << 30).unwrap();
    external.disable(false, "live").unwrap();
    let file = fs::File::create(s.root.join("objects/quota-fixture.part")).unwrap();
    file.set_len(32 * 1024 * 1024).unwrap();
    s.limit = 16 * 1024 * 1024;
    assert!(
        s.ingest(&observation(1, now_ms(), 32), now_ms() + 2)
            .is_err()
    );
    assert_eq!(current_height(&s), 16);
}

#[tokio::test]
async fn slow_authenticated_body_expires_without_queueing_another_writer() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use surface_sync::http::{App, ingest_router};
    use tower::ServiceExt;
    let (_dir, store) = seeded();
    let app = App::new(store, vec![b'a'; 32], "test".into()).unwrap();
    let stream = futures_util::stream::pending::<Result<axum::body::Bytes, std::io::Error>>();
    let req = Request::post("/ingest/v1/terrain")
        .header("x-terrain-token", "a".repeat(32))
        .body(Body::from_stream(stream))
        .unwrap();
    let task = tokio::spawn(ingest_router(app.clone()).oneshot(req));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let req = || {
        Request::post("/ingest/v1/terrain")
            .header("x-terrain-token", "a".repeat(32))
            .body(Body::from("{}"))
            .unwrap()
    };
    assert_eq!(
        ingest_router(app.clone())
            .oneshot(req())
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        task.await.unwrap().unwrap().status(),
        StatusCode::REQUEST_TIMEOUT
    );
    assert_eq!(
        ingest_router(app).oneshot(req()).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
}
#[tokio::test]
async fn read_listener_never_accepts_ingestion_and_bad_tokens_cannot_write() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use surface_sync::http::{App, ingest_router, read_router};
    use tower::ServiceExt;
    let (_dir, store) = seeded();
    let app = App::new(store, vec![b'a'; 32], "test".into()).unwrap();
    let r = read_router(app.clone())
        .oneshot(
            Request::post("/ingest/v1/terrain")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let r = ingest_router(app.clone())
        .oneshot(
            Request::post("/ingest/v1/terrain")
                .header("x-terrain-token", "bad")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let r = ingest_router(app.clone())
        .oneshot(
            Request::post("/ingest/v1/terrain")
                .header("x-terrain-token", "a".repeat(32))
                .body(Body::from(vec![b'x'; 262145]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let r = read_router(app)
        .oneshot(
            Request::get("/api/v1/worlds/test/terrain/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.headers()["cache-control"], "no-store");
}
