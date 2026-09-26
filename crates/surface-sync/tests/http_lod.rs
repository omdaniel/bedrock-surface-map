use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
    response::Response,
};
use surface_core::lod::{
    APPEARANCE_VERSION, CatalogPageRef, LodManifest, NodeRef, ObjectRef, TileKey,
};
use surface_sync::{
    http::{App, ingest_router, read_router},
    store::{Store, hash},
};
use tempfile::TempDir;
use tower::ServiceExt;

const WORLD: &str = "synthetic-http-world";
const GENERATION: &str = "synthetic-http-generation";
const LOD_URL: &str = "/api/v1/worlds/synthetic-http-world/terrain/lod.json";
const LEGACY_URL: &str = "/api/v1/worlds/synthetic-http-world/terrain/manifest.json";

fn app() -> (TempDir, App) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path(), WORLD, GENERATION, 1 << 30).unwrap();
    let app = App::new(store, vec![b't'; 32], WORLD.into()).unwrap();
    (directory, app)
}

fn object(byte: u8, extension: &str) -> ObjectRef {
    let sha256 = hash(&[byte]);
    ObjectRef {
        url: format!("objects/{sha256}.{extension}"),
        sha256,
        bytes: 1,
    }
}

fn descriptor() -> LodManifest {
    let manifest = LodManifest {
        format_version: 1,
        kind: "surface-lod".into(),
        name: "Synthetic HTTP terrain".into(),
        bounds: [-128, -128, 0, 0],
        spawn: [-64, 32, -64],
        source_sha256: hash(b"synthetic-http-source"),
        generation: GENERATION.into(),
        world_id: Some(WORLD.into()),
        revision: 1,
        appearance_version: APPEARANCE_VERSION.into(),
        height_range: [16, 32],
        atlas: object(1, "png"),
        catalog: vec![CatalogPageRef {
            start: 0,
            count: 1,
            object: object(2, "json"),
        }],
        material_count: 1,
        roots: vec![NodeRef {
            key: TileKey::new(0, -1, -1).unwrap(),
            index: object(3, "json"),
        }],
    };
    manifest.validate().unwrap();
    manifest
}

fn install(app: &App, manifest: &LodManifest) {
    manifest.validate().unwrap();
    app.store
        .lock()
        .unwrap()
        .connection
        .execute(
            "INSERT INTO meta(key,value) VALUES('lod_manifest',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(manifest).unwrap()],
        )
        .unwrap();
}

async fn request(router: Router, method: &str, path: &str, tag: Option<&str>) -> Response {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(tag) = tag {
        request = request.header(header::IF_NONE_MATCH, tag);
    }
    router
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn empty_body(response: Response) {
    assert!(
        to_bytes(response.into_body(), 65536)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn missing_lod_is_starting_503_and_wrong_world_is_404() {
    let (_directory, app) = app();
    for method in ["GET", "HEAD"] {
        let response = request(read_router(app.clone()), method, LOD_URL, None).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(!response.headers().contains_key(header::ETAG));
        empty_body(response).await;
        let wrong = request(
            read_router(app.clone()),
            method,
            "/api/v1/worlds/not-this-world/terrain/lod.json",
            None,
        )
        .await;
        assert_eq!(wrong.status(), StatusCode::NOT_FOUND);
        empty_body(wrong).await;
    }
    install(&app, &descriptor());
    let wrong = request(
        read_router(app),
        "GET",
        "/api/v1/worlds/not-this-world/terrain/lod.json",
        None,
    )
    .await;
    assert_eq!(wrong.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn get_and_head_serve_the_same_validated_descriptor_headers() {
    let (_directory, app) = app();
    let manifest = descriptor();
    install(&app, &manifest);
    let get = request(read_router(app.clone()), "GET", LOD_URL, None).await;
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(get.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(get.headers()[header::CACHE_CONTROL], "no-cache");
    let tag = get.headers()[header::ETAG].clone();
    let bytes = to_bytes(get.into_body(), 65536).await.unwrap();
    assert_eq!(LodManifest::decode(&bytes).unwrap(), manifest);
    assert_eq!(tag.to_str().unwrap(), format!("\"{}\"", hash(&bytes)));
    let head = request(read_router(app), "HEAD", LOD_URL, None).await;
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(head.headers()[header::ETAG], tag);
    assert_eq!(head.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(head.headers()[header::CACHE_CONTROL], "no-cache");
    empty_body(head).await;
}

#[tokio::test]
async fn matching_etag_returns_304_and_new_publication_revalidates() {
    let (_directory, app) = app();
    let mut manifest = descriptor();
    install(&app, &manifest);
    let initial = request(read_router(app.clone()), "GET", LOD_URL, None).await;
    let tag = initial.headers()[header::ETAG].to_str().unwrap().to_owned();
    for method in ["GET", "HEAD"] {
        let response = request(read_router(app.clone()), method, LOD_URL, Some(&tag)).await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()[header::ETAG], tag);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        empty_body(response).await;
    }
    manifest.revision += 1;
    install(&app, &manifest);
    let newer = request(read_router(app), "GET", LOD_URL, Some(&tag)).await;
    assert_eq!(newer.status(), StatusCode::OK);
    assert_ne!(newer.headers()[header::ETAG], tag);
    assert_eq!(newer.headers()[header::CACHE_CONTROL], "no-cache");
    let bytes = to_bytes(newer.into_body(), 65536).await.unwrap();
    assert_eq!(LodManifest::decode(&bytes).unwrap(), manifest);
}

#[tokio::test]
async fn read_router_denies_lod_writes_and_ingest_router_has_no_lod_route() {
    let (_directory, app) = app();
    install(&app, &descriptor());
    for method in ["POST", "PUT", "PATCH", "DELETE"] {
        let response = request(read_router(app.clone()), method, LOD_URL, None).await;
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
    for method in ["GET", "HEAD", "POST"] {
        let response = request(ingest_router(app.clone()), method, LOD_URL, None).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    assert_eq!(
        app.store.lock().unwrap().lod_manifest().unwrap(),
        descriptor()
    );
}

#[tokio::test]
async fn invalid_lod_metadata_is_not_served_or_given_an_etag() {
    let (_directory, app) = app();
    for invalid in ["not-json", "{}"] {
        app.store
            .lock()
            .unwrap()
            .connection
            .execute(
                "INSERT INTO meta(key,value) VALUES('lod_manifest',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [invalid],
            )
            .unwrap();
        let response = request(read_router(app.clone()), "GET", LOD_URL, None).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(!response.headers().contains_key(header::ETAG));
        empty_body(response).await;
    }
}

#[tokio::test]
async fn legacy_manifest_keeps_its_existing_revalidation_behavior() {
    let (_directory, app) = app();
    let legacy = serde_json::json!({"format_version":2,"revision":1,"synthetic":true});
    app.store
        .lock()
        .unwrap()
        .connection
        .execute(
            "INSERT INTO meta(key,value) VALUES('manifest',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [legacy.to_string()],
        )
        .unwrap();
    let get = request(read_router(app.clone()), "GET", LEGACY_URL, None).await;
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(get.headers()[header::CACHE_CONTROL], "no-cache");
    let tag = get.headers()[header::ETAG].to_str().unwrap().to_owned();
    let bytes = to_bytes(get.into_body(), 65536).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        legacy
    );
    assert_eq!(tag, format!("\"{}\"", hash(&bytes)));
    let revalidated = request(read_router(app.clone()), "GET", LEGACY_URL, Some(&tag)).await;
    assert_eq!(revalidated.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(revalidated.headers()[header::CACHE_CONTROL], "no-cache");
    empty_body(revalidated).await;
    let head = request(read_router(app), "HEAD", LEGACY_URL, None).await;
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(head.headers()[header::ETAG], tag);
    empty_body(head).await;
}
