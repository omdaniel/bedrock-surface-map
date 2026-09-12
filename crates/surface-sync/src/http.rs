use crate::store::{Store, hash, now_ms, valid_object_name};
use axum::{
    Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use std::sync::{Arc, Mutex};
use subtle::ConstantTimeEq;
use surface_core::terrain::{MAX_REQUEST_BYTES, TerrainObservation};

#[derive(Clone)]
pub struct App {
    pub store: Arc<Mutex<Store>>,
    pub token: Arc<Vec<u8>>,
    pub world: String,
    writers: Arc<tokio::sync::Semaphore>,
}
impl App {
    pub fn new(store: Store, token: Vec<u8>, world: String) -> anyhow::Result<Self> {
        anyhow::ensure!(
            token.len() >= 32 && token.len() <= 256,
            "invalid terrain secret length"
        );
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            token: Arc::new(token),
            world,
            writers: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }
}
pub fn ingest_router(app: App) -> Router {
    Router::new()
        .route("/ingest/v1/terrain", post(ingest))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(app)
}
pub fn read_router(app: App) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/api/v1/worlds/{world}/terrain/status", get(status))
        .route(
            "/api/v1/worlds/{world}/terrain/manifest.json",
            get(manifest),
        )
        .route("/api/v1/worlds/{world}/terrain/objects/{name}", get(object))
        .with_state(app)
}
fn response(
    status: StatusCode,
    body: impl Into<axum::body::Body>,
    content_type: &str,
    cache: &str,
) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, cache),
        ],
        body.into(),
    )
        .into_response()
}
async fn ingest(State(app): State<App>, request: Request) -> Response {
    let given = request
        .headers()
        .get("x-terrain-token")
        .map(|v| v.as_bytes())
        .unwrap_or_default();
    if !bool::from(given.ct_eq(&app.token)) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(permit) = app.writers.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let body = match tokio::time::timeout(
        std::time::Duration::from_secs(2),
        axum::body::to_bytes(request.into_body(), MAX_REQUEST_BYTES),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let parsed = serde_json::from_slice::<TerrainObservation>(&body)
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        let mut store = app
            .store
            .lock()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        match store.ingest(&parsed, now_ms()) {
            Ok(_) => Ok(()),
            Err(error) => {
                let message = error.to_string();
                if message.contains("capacity")
                    || message.contains("disk")
                    || message.contains("database")
                {
                    store.error("storage-unavailable");
                    Err(StatusCode::SERVICE_UNAVAILABLE)
                } else if message.contains("producer") || message.contains("sequence") {
                    Err(StatusCode::CONFLICT)
                } else {
                    Err(StatusCode::BAD_REQUEST)
                }
            }
        }
    })
    .await;
    match result {
        Ok(Ok(())) => StatusCode::NO_CONTENT,
        Ok(Err(code)) => code,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE,
    }
    .into_response()
}
async fn manifest(
    State(app): State<App>,
    Path(world): Path<String>,
    headers: HeaderMap,
) -> Response {
    if world != app.world {
        return StatusCode::NOT_FOUND.into_response();
    }
    let result =
        tokio::task::spawn_blocking(move || app.store.lock().ok().and_then(|s| s.manifest().ok()))
            .await
            .ok()
            .flatten();
    match result {
        Some(value) => {
            let bytes = serde_json::to_vec(&value).unwrap();
            let tag = format!("\"{}\"", hash(&bytes));
            let mut r = if headers
                .get(header::IF_NONE_MATCH)
                .and_then(|h| h.to_str().ok())
                == Some(&tag)
            {
                response(
                    StatusCode::NOT_MODIFIED,
                    Vec::new(),
                    "application/json",
                    "no-cache",
                )
            } else {
                response(StatusCode::OK, bytes, "application/json", "no-cache")
            };
            r.headers_mut().insert(header::ETAG, tag.parse().unwrap());
            r
        }
        None => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}
async fn object(State(app): State<App>, Path((world, name)): Path<(String, String)>) -> Response {
    if world != app.world || !valid_object_name(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let requested = name.clone();
    let result = tokio::task::spawn_blocking(move || {
        app.store
            .lock()
            .ok()
            .and_then(|s| s.object(&requested).ok())
    })
    .await
    .ok()
    .flatten();
    match result {
        Some(bytes) => response(
            StatusCode::OK,
            bytes,
            if name.ends_with(".png") {
                "image/png"
            } else if name.ends_with(".json") {
                "application/json"
            } else {
                "application/octet-stream"
            },
            "public, max-age=31536000, immutable",
        ),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn health(State(app): State<App>) -> Response {
    match tokio::task::spawn_blocking(move || {
        app.store.lock().ok().and_then(|s| s.health(now_ms()).ok())
    })
    .await
    .ok()
    .flatten()
    {
        Some(value) => response(
            StatusCode::OK,
            serde_json::to_vec(&value).unwrap(),
            "application/json",
            "no-store",
        ),
        None => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}
async fn status(State(app): State<App>, Path(world): Path<String>) -> Response {
    if world != app.world {
        return StatusCode::NOT_FOUND.into_response();
    }
    health(State(app)).await
}
