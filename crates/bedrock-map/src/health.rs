use anyhow::{Result, ensure};
use futures_util::StreamExt;
use std::{net::SocketAddr, time::Duration};

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum Service {
    Players,
    Terrain,
}

pub async fn check(service: Service) -> Result<()> {
    let port = match service {
        Service::Players => 8110,
        Service::Terrain => 8111,
    };
    probe(SocketAddr::from(([127, 0, 0, 1], port))).await
}

async fn probe(address: SocketAddr) -> Result<()> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?;
    let response = client
        .get(format!("http://{address}/healthz"))
        .send()
        .await?;
    ensure!(
        response.status() == 200,
        "service health listener is not ready"
    );
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(bytes) = stream.next().await {
        let bytes = bytes?;
        ensure!(
            body.len() + bytes.len() <= 16 * 1024,
            "health response exceeds limit"
        );
        body.extend_from_slice(&bytes);
    }
    let value: serde_json::Value = serde_json::from_slice(&body)?;
    ensure!(
        value.is_object() && value["status"].is_string(),
        "invalid health response"
    );
    // Freshness is a deployment-check concern. No producer, stale data and
    // deliberately disabled feeds must not cause container restart loops.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, http::StatusCode, routing::get};

    async fn fixture(
        status: StatusCode,
        body: &'static str,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/healthz", get(move || async move { (status, body) })),
            )
            .await
            .unwrap();
        });
        (address, task)
    }

    #[tokio::test]
    async fn readiness_does_not_require_a_producer() {
        for body in [
            r#"{"status":"starting"}"#,
            r#"{"status":"stale"}"#,
            r#"{"status":"disabled"}"#,
            r#"{"status":"live"}"#,
        ] {
            let (address, task) = fixture(StatusCode::OK, body).await;
            let result = probe(address).await;
            task.abort();
            result.unwrap();
        }
    }

    #[tokio::test]
    async fn unavailable_or_invalid_listener_fails_readiness() {
        for (status, body) in [
            (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            (StatusCode::FOUND, "redirect"),
            (StatusCode::OK, "not-json"),
            (StatusCode::OK, r#"{"not":"health"}"#),
        ] {
            let (address, task) = fixture(status, body).await;
            let result = probe(address).await;
            task.abort();
            assert!(result.is_err());
        }
    }

    #[tokio::test]
    async fn probe_bounds_body_and_wait_time() {
        for slow in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let task = tokio::spawn(async move {
                let app = Router::new().route(
                    "/healthz",
                    get(move || async move {
                        if slow {
                            tokio::time::sleep(Duration::from_secs(10)).await;
                        }
                        format!(r#"{{"status":"{}"}}"#, "x".repeat(20 * 1024))
                    }),
                );
                axum::serve(listener, app).await.unwrap();
            });
            let result = probe(address).await;
            task.abort();
            assert!(result.is_err());
        }
    }
}
