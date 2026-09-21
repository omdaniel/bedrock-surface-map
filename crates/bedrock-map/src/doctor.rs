use crate::{config::Config, resources::Resources, state::State};
use anyhow::{Result, ensure};
use futures_util::StreamExt;
use serde::Serialize;
use std::{net::IpAddr, time::Duration};

#[derive(Debug, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub status: &'static str,
    pub severity: &'static str,
    pub message: String,
    pub remediation: Option<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct Doctor {
    pub checks: Vec<Check>,
}

impl Doctor {
    pub fn ok(&self) -> bool {
        self.checks
            .iter()
            .all(|check| check.severity != "required" || check.status == "pass")
    }
}

fn required(id: &'static str, result: Result<String, String>, remediation: &'static str) -> Check {
    match result {
        Ok(message) => Check {
            id,
            status: "pass",
            severity: "required",
            message,
            remediation: None,
        },
        Err(message) => Check {
            id,
            status: "fail",
            severity: "required",
            message,
            remediation: Some(remediation),
        },
    }
}

pub async fn check(
    state: &State,
    resources: Result<&Resources, String>,
    config: Result<Config, String>,
    url: Option<&str>,
) -> Result<Doctor> {
    let mut checks = vec![required(
        "state",
        config
            .as_ref()
            .map(|_| "State configuration is valid.".into())
            .map_err(Clone::clone),
        "Initialize or repair the state configuration manually.",
    )];
    checks.push(required(
        "loopback-bind",
        config
            .as_ref()
            .map(|value| format!("Snapshot server is configured for {}.", value.server.bind))
            .map_err(Clone::clone),
        "Correct the loopback bind configuration.",
    ));
    checks.push(required(
        "dataset",
        match state.active_validated() {
            Ok(Some(active)) => Ok(format!("Selected immutable dataset {}.", active.dataset_id)),
            Ok(None) => Err("No dataset is selected.".into()),
            Err(error) => Err(format!("{error:#}")),
        },
        "Run bedrock-map demo or import a complete snapshot.",
    ));
    checks.push(required(
        "resources",
        resources.and_then(|value| {
            value
                .validate_release()
                .and_then(|_| value.require_web())
                .map(|_| "Packaged viewer resources passed integrity checks.".into())
                .map_err(|error| format!("{error:#}"))
        }),
        "Use a complete matching release or repair development resources.",
    ));
    if let Some(url) = url {
        let parsed = reqwest::Url::parse(url)
            .map_err(|error| anyhow::anyhow!("E_CONFIG_INVALID: invalid doctor URL: {error}"))?;
        ensure!(
            parsed.scheme() == "http"
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.query().is_none()
                && parsed.fragment().is_none(),
            "E_CONFIG_INVALID: doctor URL must be an HTTP loopback origin without credentials, query or fragment"
        );
        let host: IpAddr = parsed
            .host_str()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse()
            .map_err(|_| {
                anyhow::anyhow!("E_CONFIG_INVALID: doctor URL requires a literal loopback IP")
            })?;
        ensure!(
            host.is_loopback() && parsed.port().is_some(),
            "E_CONFIG_INVALID: doctor URL requires a literal loopback IP and port"
        );
        if let Ok(config) = &config {
            ensure!(
                parsed.path() == config.server.base_path,
                "E_CONFIG_INVALID: doctor URL must use the configured mount prefix"
            );
        }
        checks.push(required(
            "readiness-url",
            probe(parsed).await.map_err(|error| format!("{error:#}")),
            "Start the selected bedrock-map server at this loopback URL.",
        ));
    }
    checks.push(Check {
        id: "browser-webgpu",
        status: "unknown",
        severity: "informational",
        message: "A native check cannot prove browser WebGPU rendering.".into(),
        remediation: Some("Run browser acceptance separately."),
    });
    checks.push(Check {
        id: "live-services",
        status: "not_applicable",
        severity: "informational",
        message: "This snapshot runtime has no live ingest service.".into(),
        remediation: None,
    });
    Ok(Doctor { checks })
}

async fn probe(mut url: reqwest::Url) -> anyhow::Result<String> {
    url.set_path(&format!("{}api/v1/health/ready", url.path()));
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(3))
        .build()?;
    let response = client.get(url).send().await?;
    ensure!(
        response.status() == reqwest::StatusCode::OK,
        "readiness endpoint returned {}",
        response.status()
    );
    ensure!(
        response
            .content_length()
            .is_none_or(|length| length <= 4096),
        "readiness response is too large"
    );
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        ensure!(
            body.len() + chunk.len() <= 4096,
            "readiness response is too large"
        );
        body.extend_from_slice(&chunk);
    }
    let value: serde_json::Value = serde_json::from_slice(&body)?;
    ensure!(
        value["service"] == "bedrock-map" && value["ready"] == true,
        "readiness response is not from a ready bedrock-map server"
    );
    Ok("Loopback snapshot service is ready.".into())
}
