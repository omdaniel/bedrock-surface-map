use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

pub const MAX_BODY: usize = 16 * 1024;
pub const STALE_MS: u64 = 10_000;
pub const EXPIRE_MS: u64 = 30_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub heading: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Player {
    pub id: String,
    pub name: String,
    pub dimension: Option<String>,
    pub position: Option<Position>,
    pub discontinuity: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub schema_version: u32,
    pub world_id: String,
    pub instance_id: String,
    pub started_at_ms: u64,
    pub sequence: u64,
    pub sampled_at_ms: u64,
    pub pack_version: String,
    pub players: Vec<Player>,
}
pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
impl Snapshot {
    pub fn validate(&self, world: &str, now: u64) -> Result<(), &'static str> {
        if self.schema_version != 1
            || self.world_id != world
            || !valid_id(&self.instance_id)
            || self.sequence == 0
            || self.sequence > 9_007_199_254_740_991
            || self.started_at_ms > self.sampled_at_ms
            || self.players.len() > 32
            || self.pack_version.len() > 32
            || self.pack_version.is_empty()
            || !self
                .pack_version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        {
            return Err("invalid snapshot");
        }
        if self.sampled_at_ms > now.saturating_add(5_000)
            || now.saturating_sub(self.sampled_at_ms) > STALE_MS
        {
            return Err("sample clock outside permitted window");
        }
        let mut ids = HashSet::new();
        for p in &self.players {
            if !valid_id(&p.id)
                || !ids.insert(&p.id)
                || p.name.is_empty()
                || p.name.len() > 128
                || p.name.chars().any(char::is_control)
                || p.name.eq_ignore_ascii_case("PopCello8931")
            {
                return Err("invalid player");
            }
            if let Some(d) = &p.dimension {
                if ![
                    "minecraft:overworld",
                    "minecraft:nether",
                    "minecraft:the_end",
                ]
                .contains(&d.as_str())
                {
                    return Err("invalid dimension");
                }
            } else if p.position.is_some() {
                return Err("position without dimension");
            }
            if let Some(v) = &p.position
                && (![v.x, v.y, v.z, v.heading].iter().all(|v| v.is_finite())
                    || v.x.abs() > 30_000_000.
                    || v.z.abs() > 30_000_000.
                    || v.y.abs() > 1_000_000.
                    || !(0.0..360.0).contains(&v.heading))
            {
                return Err("invalid position");
            }
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub struct View {
    pub schema_version: u32,
    pub world_id: String,
    pub status: &'static str,
    pub reason: Option<&'static str>,
    pub age_ms: Option<u64>,
    pub snapshot: Option<Snapshot>,
}
pub struct Store {
    pub world: String,
    latest: Option<Snapshot>,
    received: Option<Instant>,
    transport_age_ms: u64,
    high_water: Option<(u64, String, u64, u64)>,
    disabled: bool,
    last_pack_version: Option<String>,
    pub accepted: u64,
    pub rejected: u64,
}
impl Store {
    pub fn new(world: String, disabled: bool) -> Self {
        Self {
            world,
            latest: None,
            received: None,
            transport_age_ms: 0,
            high_water: None,
            disabled,
            last_pack_version: None,
            accepted: 0,
            rejected: 0,
        }
    }
    pub fn accept(
        &mut self,
        snapshot: Snapshot,
        now: u64,
        instant: Instant,
    ) -> Result<(), &'static str> {
        if self.disabled {
            return Err("tracking disabled");
        }
        snapshot.validate(&self.world, now)?;
        if let Some((started, instance, sequence, sampled)) = &self.high_water
            && (snapshot.started_at_ms < *started
                || (snapshot.started_at_ms == *started && snapshot.instance_id != *instance)
                || (snapshot.instance_id == *instance
                    && (snapshot.sequence <= *sequence || snapshot.started_at_ms != *started))
                || snapshot.sampled_at_ms < *sampled)
        {
            return Err("obsolete snapshot");
        }
        self.transport_age_ms = now.saturating_sub(snapshot.sampled_at_ms);
        self.high_water = Some((
            snapshot.started_at_ms,
            snapshot.instance_id.clone(),
            snapshot.sequence,
            snapshot.sampled_at_ms,
        ));
        self.received = Some(instant);
        self.last_pack_version = Some(snapshot.pack_version.clone());
        self.latest = Some(snapshot);
        self.accepted = self.accepted.saturating_add(1);
        Ok(())
    }
    pub fn age(&self, now: Instant) -> Option<u64> {
        self.received.map(|received| {
            self.transport_age_ms
                .saturating_add(now.saturating_duration_since(received).as_millis() as u64)
        })
    }
    pub fn view(&mut self, now: Instant) -> View {
        let age = self.age(now);
        if age.is_some_and(|v| v >= EXPIRE_MS) {
            self.latest = None;
        }
        let status = if self.disabled {
            "disabled"
        } else {
            match age {
                None => "starting",
                Some(v) if v >= EXPIRE_MS => "unavailable",
                Some(v) if v >= STALE_MS => "stale",
                _ => "live",
            }
        };
        View {
            schema_version: 1,
            world_id: self.world.clone(),
            status,
            reason: self
                .disabled
                .then_some("disabled_by_operator_or_compatibility_policy"),
            age_ms: age,
            snapshot: self.latest.clone(),
        }
    }
}
#[derive(Clone)]
pub struct App {
    pub store: Arc<Mutex<Store>>,
    token: Arc<Vec<u8>>,
    ingest_slots: Arc<Semaphore>,
    read_slots: Arc<Semaphore>,
}
impl App {
    pub fn new(world: String, token: Vec<u8>, disabled: bool) -> Result<Self, &'static str> {
        if !valid_id(&world) || token.len() != 64 || !token.iter().all(u8::is_ascii_hexdigit) {
            return Err("world ID and 64-character hexadecimal token required");
        }
        Ok(Self {
            store: Arc::new(Mutex::new(Store::new(world, disabled))),
            token: Arc::new(token),
            ingest_slots: Arc::new(Semaphore::new(1)),
            read_slots: Arc::new(Semaphore::new(16)),
        })
    }
}
pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}
fn response(status: StatusCode, body: impl IntoResponse) -> Response {
    let mut response = (status, body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}
async fn ingest_guard(State(app): State<App>, request: Request, next: Next) -> Response {
    let token = request
        .headers()
        .get("x-tracker-token")
        .map(|h| h.as_bytes())
        .unwrap_or_default();
    if !bool::from(token.ct_eq(&app.token)) {
        return response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Ok(_permit) = app.ingest_slots.try_acquire() else {
        return response(StatusCode::TOO_MANY_REQUESTS, "request in flight");
    };
    // Include body collection in the deadline, not just the handler itself.
    tokio::time::timeout(Duration::from_secs(2), next.run(request))
        .await
        .unwrap_or_else(|_| response(StatusCode::REQUEST_TIMEOUT, "request timeout"))
}
async fn read_guard(State(app): State<App>, request: Request, next: Next) -> Response {
    let Ok(_permit) = app.read_slots.try_acquire() else {
        return response(StatusCode::TOO_MANY_REQUESTS, "reader limit");
    };
    tokio::time::timeout(Duration::from_secs(2), next.run(request))
        .await
        .unwrap_or_else(|_| response(StatusCode::REQUEST_TIMEOUT, "request timeout"))
}
async fn ingest(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        != Some("application/json")
    {
        return response(StatusCode::UNSUPPORTED_MEDIA_TYPE, "JSON required");
    }
    let snapshot = match serde_json::from_slice::<Snapshot>(&body) {
        Ok(s) => s,
        Err(_) => return response(StatusCode::BAD_REQUEST, "invalid snapshot"),
    };
    let mut store = app.store.lock().unwrap();
    match store.accept(snapshot, unix_ms(), Instant::now()) {
        Ok(()) => response(StatusCode::NO_CONTENT, ()),
        Err(reason) => {
            store.rejected = store.rejected.saturating_add(1);
            response(StatusCode::UNPROCESSABLE_ENTITY, reason)
        }
    }
}
async fn players(State(app): State<App>, Path(world): Path<String>) -> Response {
    let mut store = app.store.lock().unwrap();
    if store.world != world {
        return response(StatusCode::NOT_FOUND, "unknown world");
    }
    response(StatusCode::OK, Json(store.view(Instant::now())))
}
async fn health(State(app): State<App>) -> Response {
    let mut store = app.store.lock().unwrap();
    let view = store.view(Instant::now());
    response(
        StatusCode::OK,
        Json(serde_json::json!({
            "service": "surface-tracker", "version": env!("CARGO_PKG_VERSION"),
            "status": view.status, "reason": view.reason, "age_ms": view.age_ms,
            "pack_version": store.last_pack_version,
            "accepted": store.accepted, "rejected": store.rejected
        })),
    )
}
pub fn ingest_router(app: App) -> Router {
    Router::new()
        .route("/ingest/v1/snapshot", post(ingest))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(middleware::from_fn_with_state(app.clone(), ingest_guard))
        .with_state(app)
}
pub fn read_router(app: App) -> Router {
    Router::new()
        .route("/api/v1/worlds/{world}/players", get(players))
        .route("/healthz", get(health))
        .layer(middleware::from_fn_with_state(app.clone(), read_guard))
        .with_state(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;
    fn snapshot() -> Snapshot {
        serde_json::from_str(include_str!("../../../fixtures/tracking/snapshot.json")).unwrap()
    }
    #[test]
    fn validation_and_whole_roster_replacement() {
        let mut s = snapshot();
        let now = s.sampled_at_ms;
        let instant = Instant::now();
        let mut store = Store::new(s.world_id.clone(), false);
        store.accept(s.clone(), now, instant).unwrap();
        assert_eq!(
            store.view(instant).snapshot.unwrap().players[0]
                .position
                .as_ref()
                .unwrap()
                .x,
            -12.25
        );
        assert!(store.accept(s.clone(), now, instant).is_err());
        s.sequence += 1;
        s.players.clear();
        store.accept(s, now, instant).unwrap();
        assert!(store.view(instant).snapshot.unwrap().players.is_empty());
        assert_eq!(
            store.view(instant + Duration::from_secs(10)).status,
            "stale"
        );
        let expired = store.view(instant + Duration::from_secs(30));
        assert_eq!(expired.status, "unavailable");
        assert!(expired.snapshot.is_none());
        assert!(store.latest.is_none());
    }
    #[test]
    fn restart_order_and_clock_bounds() {
        let mut s = snapshot();
        let now = s.sampled_at_ms;
        let instant = Instant::now();
        let mut store = Store::new(s.world_id.clone(), false);
        store.accept(s.clone(), now, instant).unwrap();
        let old = s.clone();
        s.started_at_ms = now + 1;
        s.sampled_at_ms = now + 1;
        s.instance_id = "new-instance".into();
        s.sequence = 1;
        store.accept(s, now + 1, instant).unwrap();
        assert!(store.accept(old.clone(), now + 1, instant).is_err());
        assert!(old.validate(&old.world_id, now + STALE_MS + 1).is_err());
        assert!(old.validate("wrong-world", now).is_err());
        assert_eq!(
            Store::new("world".into(), true).view(instant).status,
            "disabled"
        );
    }
    #[test]
    fn malformed_players_never_become_empty_terrain() {
        for kind in 0..6 {
            let mut s = snapshot();
            match kind {
                0 => s.players.push(s.players[0].clone()),
                1 => s.players[0].position.as_mut().unwrap().x = f64::NAN,
                2 => s.players[0].dimension = Some("other".into()),
                3 => s.players[0].position.as_mut().unwrap().heading = 360.,
                4 => s.players = vec![s.players[0].clone(); 33],
                _ => s.players[0].name = "PopCello8931".into(),
            }
            assert!(s.validate(&s.world_id, s.sampled_at_ms).is_err());
        }
        let mut s = snapshot();
        s.players[0].position = None;
        s.players[0].dimension = None;
        s.validate(&s.world_id, s.sampled_at_ms).unwrap();
    }
    #[tokio::test]
    async fn http_separates_read_write_and_never_exposes_secrets() {
        let app = App::new("fixture-world".into(), vec![b'a'; 64], false).unwrap();
        let mut s = snapshot();
        s.sampled_at_ms = unix_ms();
        s.started_at_ms = s.sampled_at_ms - 1;
        let payload = serde_json::to_vec(&s).unwrap();
        let request = |path: &str, token: &str, body: Vec<u8>| {
            Request::post(path)
                .header("x-tracker-token", token)
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap()
        };
        assert_eq!(
            read_router(app.clone())
                .oneshot(request(
                    "/ingest/v1/snapshot",
                    &"a".repeat(64),
                    payload.clone()
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            ingest_router(app.clone())
                .oneshot(request("/ingest/v1/snapshot", "wrong", payload.clone()))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            ingest_router(app.clone())
                .oneshot(request(
                    "/ingest/v1/snapshot",
                    &"a".repeat(64),
                    vec![b'x'; MAX_BODY + 1]
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            ingest_router(app.clone())
                .oneshot(request("/ingest/v1/snapshot", &"a".repeat(64), payload))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        let r = read_router(app)
            .oneshot(
                Request::get("/api/v1/worlds/fixture-world/players")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
        let body = to_bytes(r.into_body(), MAX_BODY).await.unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.contains("ExamplePlayer"));
        assert!(!text.contains(&"a".repeat(64)));
    }

    #[tokio::test]
    async fn authentication_precedes_body_and_concurrency_is_bounded() {
        let app = App::new("fixture-world".into(), vec![b'a'; 64], false).unwrap();
        let request = |token: &str| {
            Request::post("/ingest/v1/snapshot")
                .header("x-tracker-token", token)
                .body(Body::from(vec![b'x'; MAX_BODY + 1]))
                .unwrap()
        };
        assert_eq!(
            ingest_router(app.clone())
                .oneshot(request("wrong"))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let _permit = app.ingest_slots.acquire().await.unwrap();
        assert_eq!(
            ingest_router(app.clone())
                .oneshot(request(&"a".repeat(64)))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn slow_requests_expire_and_release_their_slot() {
        let app = App::new("fixture-world".into(), vec![b'a'; 64], false).unwrap();
        let router = Router::new()
            .route(
                "/slow",
                post(|| async {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    StatusCode::NO_CONTENT
                }),
            )
            .layer(middleware::from_fn_with_state(app.clone(), ingest_guard));
        let request = Request::post("/slow")
            .header("x-tracker-token", "a".repeat(64))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            router.oneshot(request).await.unwrap().status(),
            StatusCode::REQUEST_TIMEOUT
        );
        assert_eq!(app.ingest_slots.available_permits(), 1);
    }
}
