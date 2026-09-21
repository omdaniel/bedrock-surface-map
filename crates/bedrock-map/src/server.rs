use crate::{
    config::Config,
    resources::{Resources, safe_relative},
    state::State,
};
use anyhow::{Context, Result, ensure};
use axum::{
    Router,
    body::Body,
    extract::{Request, State as AxumState},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone)]
struct App {
    state: State,
    resources: Resources,
    base_path: String,
}

pub async fn serve(
    state: State,
    resources: Resources,
    config: Config,
    listener: tokio::net::TcpListener,
) -> Result<()> {
    let _ = listener.local_addr()?;
    resources.validate_release()?;
    resources.require_web()?;
    let app = App {
        state,
        resources,
        base_path: config.server.base_path,
    };
    axum::serve(listener, router(app))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

fn router(app: App) -> Router {
    Router::new()
        .fallback(get(handle))
        .with_state(Arc::new(app))
}

async fn handle(AxumState(app): AxumState<Arc<App>>, request: Request) -> Response {
    if !matches!(request.method().as_str(), "GET" | "HEAD") {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = request.uri().path();
    let without_base = if app.base_path == "/" {
        path.strip_prefix('/').unwrap_or_default()
    } else {
        let bare = app.base_path.trim_end_matches('/');
        if path == bare {
            return redirect(&app.base_path);
        }
        match path.strip_prefix(&app.base_path) {
            Some(rest) => rest,
            None => return StatusCode::NOT_FOUND.into_response(),
        }
    };
    if without_base.is_empty() {
        return file_response(
            &app.resources.web().join("index.html"),
            &request,
            "no-cache",
        )
        .unwrap_or_else(error_response);
    }
    if without_base == "viewer-config.json" {
        return viewer_config(&app, &request).unwrap_or_else(error_response);
    }
    if without_base == "api/v1/health/live" {
        return json_response(serde_json::json!({"ok":true}), "no-store");
    }
    if without_base == "api/v1/health/ready" {
        return match app.state.active() {
            Ok(Some(_)) => json_response(
                serde_json::json!({"service":"bedrock-map","ready":true}),
                "no-store",
            ),
            Ok(None) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
            Err(error) => error_response(error),
        };
    }
    let response = (|| -> Result<Response> {
        if let Some(relative) = without_base.strip_prefix("assets/") {
            resolve_child(&app.resources.web().join("assets"), relative).and_then(|file| {
                file_response(&file, &request, "public, max-age=31536000, immutable")
            })
        } else if let Some(relative) = without_base.strip_prefix("maps/") {
            let (id, rest) = relative.split_once('/').context("missing dataset path")?;
            let public = app
                .state
                .registered(id)?
                .context("dataset is not registered")?;
            resolve_child(&public, rest).and_then(|file| {
                file_response(&file, &request, "public, max-age=31536000, immutable")
            })
        } else {
            anyhow::bail!("not found")
        }
    })();
    response.unwrap_or_else(error_response)
}

fn viewer_config(app: &App, request: &Request) -> Result<Response> {
    let active = app
        .state
        .active()?
        .context("E_NO_DATASET: no selected dataset")?;
    json_response_with_request(
        serde_json::json!({"map": format!("maps/{}/manifest.json", active.dataset_id)}),
        request.headers(),
        "no-store",
    )
}

fn resolve_child(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = root.join(safe_relative(relative)?);
    let canonical_root = fs::canonicalize(root)?;
    let canonical = fs::canonicalize(&path)?;
    ensure!(
        canonical.starts_with(&canonical_root) && canonical.is_file(),
        "unsafe or unavailable resource path"
    );
    Ok(canonical)
}

fn file_response(path: &Path, request: &Request, cache: &str) -> Result<Response> {
    let bytes = fs::read(path)?;
    let tag = format!("\"{:x}\"", Sha256::digest(&bytes));
    if request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(&tag)
    {
        return Ok(response(
            StatusCode::NOT_MODIFIED,
            Body::empty(),
            mime(path),
            cache,
            &tag,
        ));
    }
    let body = if request.method() == "HEAD" {
        Body::empty()
    } else {
        Body::from(bytes)
    };
    Ok(response(StatusCode::OK, body, mime(path), cache, &tag))
}

fn json_response(value: serde_json::Value, cache: &str) -> Response {
    json_response_with_request(value, &HeaderMap::new(), cache).unwrap_or_else(error_response)
}
fn json_response_with_request(
    value: serde_json::Value,
    headers: &HeaderMap,
    cache: &str,
) -> Result<Response> {
    let bytes = serde_json::to_vec(&value)?;
    let tag = format!("\"{:x}\"", Sha256::digest(&bytes));
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|item| item.to_str().ok())
        == Some(&tag)
    {
        return Ok(response(
            StatusCode::NOT_MODIFIED,
            Body::empty(),
            "application/json",
            cache,
            &tag,
        ));
    }
    Ok(response(
        StatusCode::OK,
        Body::from(bytes),
        "application/json",
        cache,
        &tag,
    ))
}
fn response(
    status: StatusCode,
    body: Body,
    content_type: &str,
    cache: &str,
    tag: &str,
) -> Response {
    let mut result = (status, body).into_response();
    let headers = result.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type).expect("fixed content type"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_str(cache).unwrap());
    headers.insert(header::ETAG, HeaderValue::from_str(tag).unwrap());
    result
}
fn redirect(path: &str) -> Response {
    (StatusCode::PERMANENT_REDIRECT, [(header::LOCATION, path)]).into_response()
}
fn error_response(error: anyhow::Error) -> Response {
    (StatusCode::NOT_FOUND, format!("Not found: {error}")).into_response()
}
fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|item| item.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("wasm") => "application/wasm",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}
async fn shutdown() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, ServerConfig};
    use sha2::{Digest, Sha256};
    use std::fs;

    fn copy_tree(source: &Path, destination: &Path) {
        fs::create_dir_all(destination).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let from = entry.path();
            let to = destination.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&from, &to);
            } else {
                fs::copy(from, to).unwrap();
            }
        }
    }

    fn manifest(root: &Path) {
        fn walk(root: &Path, dir: &Path, records: &mut Vec<serde_json::Value>) {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                if entry.file_type().unwrap().is_dir() {
                    walk(root, &path, records);
                } else {
                    let bytes = fs::read(&path).unwrap();
                    records.push(serde_json::json!({"path":path.strip_prefix(root).unwrap().to_string_lossy(),"sha256":format!("{:x}", Sha256::digest(&bytes)),"bytes":bytes.len()}));
                }
            }
        }
        let mut files = Vec::new();
        walk(root, root, &mut files);
        fs::write(
            root.join("release-manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema_version":1,
                "application_version":"0.1.0",
                "commit":"a".repeat(40),
                "target":"x86_64-unknown-linux-musl",
                "files":files
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn serves_a_verified_snapshot_only_under_its_configured_prefix() {
        let temporary = tempfile::tempdir().unwrap();
        let package = temporary.path().join("package");
        let resources_root = package.join("share/bedrock-surface-map");
        fs::create_dir_all(resources_root.join("web/assets")).unwrap();
        fs::write(
            resources_root.join("web/index.html"),
            "<title>Bedrock Surface Map</title>",
        )
        .unwrap();
        fs::write(
            resources_root.join("web/assets/app.js"),
            "console.log('fixture')",
        )
        .unwrap();
        fs::create_dir_all(resources_root.join("fixtures/surface-v1")).unwrap();
        surface_cli::create_synthetic_fixture(&resources_root.join("fixtures/surface-v1")).unwrap();
        fs::write(package.join("bedrock-map"), "test binary").unwrap();
        manifest(&package);
        let resources = Resources::discover(Some(resources_root)).unwrap();
        let state = State::new(temporary.path().join("state")).unwrap();
        state.init().unwrap();
        let staged = state.staging().join("fixture/public");
        copy_tree(&resources.fixture(), &staged);
        let first = state
            .register_staged_dataset(&staged, "c".repeat(64), false)
            .unwrap();
        let root_app = App {
            state: state.clone(),
            resources: resources.clone(),
            base_path: "/".into(),
        };
        let root = handle(
            AxumState(Arc::new(root_app.clone())),
            Request::builder().uri("/").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(root.status(), StatusCode::OK);
        let head = handle(
            AxumState(Arc::new(root_app)),
            Request::builder()
                .method("HEAD")
                .uri("/assets/app.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(
            head.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            head.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let config = Config {
            schema_version: 1,
            server: ServerConfig {
                bind: address.to_string(),
                base_path: "/map/".into(),
            },
        };
        let task = tokio::spawn(serve(state.clone(), resources, config, listener));
        let client = reqwest::Client::new();
        let html = client
            .get(format!("http://{address}/map/"))
            .send()
            .await
            .unwrap();
        assert!(html.status().is_success());
        assert!(html.text().await.unwrap().contains("Bedrock Surface Map"));
        let config = client
            .get(format!("http://{address}/map/viewer-config.json"))
            .send()
            .await
            .unwrap();
        assert_eq!(config.headers()[header::CACHE_CONTROL], "no-store");
        let viewer: serde_json::Value =
            serde_json::from_str(&config.text().await.unwrap()).unwrap();
        assert!(viewer["map"].as_str().unwrap().starts_with("maps/"));
        let old_url = format!(
            "http://{address}/map/maps/{}/manifest.json",
            first.dataset_id
        );
        assert_eq!(
            client.get(&old_url).send().await.unwrap().status(),
            StatusCode::OK
        );
        let replacement = state.staging().join("replacement/public");
        copy_tree(
            &state.datasets().join(&first.dataset_id).join("public"),
            &replacement,
        );
        fs::write(replacement.join("assets/NOTICE.txt"), "replacement fixture").unwrap();
        let second = state
            .register_staged_dataset(&replacement, "d".repeat(64), true)
            .unwrap();
        assert_ne!(first.dataset_id, second.dataset_id);
        assert_eq!(
            client.get(&old_url).send().await.unwrap().status(),
            StatusCode::OK
        );
        let current: serde_json::Value = serde_json::from_str(
            &client
                .get(format!("http://{address}/map/viewer-config.json"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(
            current["map"]
                .as_str()
                .unwrap()
                .contains(&second.dataset_id)
        );
        assert_eq!(
            client
                .get(format!("http://{address}/config.toml"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .get(format!("http://{address}/map/../../active.json"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        task.abort();
    }
}
