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
            Ok(Some(_)) => json_response(serde_json::json!({"ready":true}), "no-store"),
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
            let active = app
                .state
                .active()?
                .context("E_NO_DATASET: no selected dataset")?;
            ensure!(id == active.dataset_id, "dataset is not selected");
            resolve_child(&app.state.datasets().join(id).join("public"), rest).and_then(|file| {
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
    let _ = tokio::signal::ctrl_c().await;
}
