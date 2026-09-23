use super::{
    config::{Access, Config},
    files, init, inspect, prepare,
    release::Release,
};
use crate::{doctor::Check, resources::Resources};
use anyhow::{Context, Result, ensure};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

#[derive(Serialize)]
pub struct Report {
    pub status: &'static str,
    pub checks: Vec<Check>,
}
impl Report {
    pub fn ok(&self) -> bool {
        self.checks
            .iter()
            .all(|c| c.severity != "required" || c.status == "pass")
    }
    fn required(
        &mut self,
        id: &'static str,
        result: Result<()>,
        success: &str,
        remediation: &'static str,
    ) -> bool {
        let passed = result.is_ok();
        self.checks.push(Check {
            id,
            status: if passed { "pass" } else { "fail" },
            severity: "required",
            message: result
                .map(|_| success.into())
                .unwrap_or_else(|e| format!("{e:#}")),
            remediation: (!passed).then_some(remediation),
        });
        passed
    }
}

/// No shell, writes, privilege escalation, implicit pulls, or unbounded output.
async fn docker(args: &[&str]) -> Result<Vec<u8>> {
    command_output("docker", args, Duration::from_secs(10)).await
}

async fn command_output(program: &str, args: &[&str], deadline: Duration) -> Result<Vec<u8>> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("Docker CLI is unavailable")?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = async |stream: Box<dyn tokio::io::AsyncRead + Unpin + Send>| -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        stream.take(1024 * 1024 + 1).read_to_end(&mut bytes).await?;
        ensure!(
            bytes.len() <= 1024 * 1024,
            "Docker output exceeds diagnostic limit"
        );
        Ok(bytes)
    };
    let operation = async {
        let (out, _err, status) =
            tokio::try_join!(read(Box::new(stdout)), read(Box::new(stderr)), async {
                Ok::<_, anyhow::Error>(child.wait().await?)
            })?;
        // Do not print Docker stderr, which can include private environment data.
        ensure!(
            status.success(),
            "Docker diagnostic command failed; check the local daemon/project manually"
        );
        Ok(out)
    };
    tokio::time::timeout(deadline, operation)
        .await
        .context("Docker diagnostic exceeded ten seconds")?
}

fn minimum(version: &str, required: [u64; 3]) -> bool {
    let parts: Option<Vec<u64>> = version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .take(3)
        .map(str::parse::<u64>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .ok();
    parts.is_some_and(|v| v.len() == 3 && v.as_slice() >= required.as_slice())
}

async fn prerequisites(root: &str) -> Result<()> {
    let info: Value = serde_json::from_slice(&docker(&["info", "--format", "{{json .}}"]).await?)?;
    ensure!(
        info["OSType"] == "linux"
            && minimum(info["ServerVersion"].as_str().unwrap_or(""), [28, 0, 4]),
        "reference host requires Linux Docker Engine >=28.0.4"
    );
    let options = info["SecurityOptions"]
        .as_array()
        .context("missing daemon security options")?;
    ensure!(
        !options.iter().any(|v| v
            .as_str()
            .is_some_and(|s| s.contains("rootless") || s.contains("userns"))),
        "rootless/user-namespace Docker is outside this topology"
    );
    let version = docker(&["compose", "version", "--short"]).await?;
    ensure!(
        minimum(std::str::from_utf8(&version)?, [2, 38, 2]),
        "reference host requires Docker Compose >=2.38.2"
    );
    docker(&[
        "compose",
        "--project-directory",
        root,
        "-f",
        &format!("{root}/compose.yaml"),
        "config",
        "--quiet",
    ])
    .await?;
    Ok(())
}

async fn runtime(root: &Path, config: &Config, lock: &init::Lock) -> Result<()> {
    let output = docker(&[
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        &format!("label=com.docker.compose.project={}", config.project),
    ])
    .await?;
    let ids: Vec<_> = std::str::from_utf8(&output)?.lines().collect();
    ensure!(
        !ids.is_empty() && ids.len() <= 3 && ids.iter().all(|id| files::valid_hash(id, 64)),
        "expected one container for each enabled service"
    );
    let mut args = vec!["inspect", "--type", "container"];
    args.extend(ids);
    let values: Vec<Value> = serde_json::from_slice(&docker(&args).await?)?;
    inspect::containers(root, config, lock, &values)?;
    for image in [&lock.release.gateway, &lock.release.runtime] {
        let reference = image.reference();
        let images: Vec<Value> =
            serde_json::from_slice(&docker(&["image", "inspect", &reference]).await?)?;
        ensure!(images.len() == 1, "image identity unavailable");
        let image_info = &images[0];
        ensure!(
            image_info["RepoDigests"]
                .as_array()
                .is_some_and(|v| v.contains(&Value::String(reference.clone()))),
            "image lacks expected registry digest"
        );
        for container in values.iter().filter(|v| v["Config"]["Image"] == reference) {
            ensure!(
                container["Image"] == image_info["Id"],
                "running image content differs from pinned image"
            );
        }
    }
    Ok(())
}

async fn response(
    client: &reqwest::Client,
    config: &Config,
    path: &str,
    password: Option<&str>,
    limit: usize,
) -> Result<(u16, Vec<u8>)> {
    let mut request = client.get(format!("{}{path}", config.public_origin));
    if let Some(password) = password {
        request = request.basic_auth(&config.viewer.username, Some(password));
    }
    let response = request
        .send()
        .await
        .context("HTTPS request failed (DNS, certificate, network or listener)")?;
    let status = response.status().as_u16();
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(bytes) = stream.next().await {
        let bytes = bytes?;
        ensure!(
            body.len() + bytes.len() <= limit,
            "HTTPS response exceeds diagnostic limit"
        );
        body.extend_from_slice(&bytes);
    }
    Ok((status, body))
}

fn freshness(
    value: &Value,
    terrain: bool,
    lock: &init::Lock,
) -> Result<(&'static str, Option<u64>)> {
    ensure!(
        value["schema_version"] == 1
            && value["world_id"] == lock.world_id
            && (!terrain || value["generation"] == serde_json::json!(lock.generation)),
        "feed identity differs"
    );
    let status = match value["status"].as_str() {
        Some("live") => "live",
        Some("starting") => "starting",
        Some("stale") => "stale",
        Some("unavailable") => "unavailable",
        Some("disabled") => "disabled",
        Some("degraded") => "degraded",
        _ => anyhow::bail!("invalid feed status"),
    };
    let age = &value[if terrain { "sample_age_ms" } else { "age_ms" }];
    ensure!(
        age.is_null() || age.as_u64().is_some(),
        "invalid sample age"
    );
    let age = age.as_u64();
    ensure!(
        status != "starting" || age.is_none(),
        "starting feed has a previous sample age"
    );
    ensure!(
        status != "live" || age.is_some_and(|v| v < if terrain { 30_000 } else { 10_000 }),
        "feed claims live with missing/stale sample"
    );
    if !terrain && status == "live" {
        ensure!(
            value["snapshot"]["world_id"] == lock.world_id
                && value["snapshot"]["players"].is_array(),
            "live roster is missing or belongs to another world"
        );
    }
    Ok((status, age))
}

pub async fn check(
    root: &Path,
    resources: &Resources,
    running: bool,
    expect_live: bool,
    password: Option<&str>,
) -> Result<Report> {
    ensure!(
        !expect_live || running,
        "E_CONFIG_INVALID: --expect-live requires --running"
    );
    let (config, lock) = init::load(root)?;
    ensure!(
        Release::load(resources)? == lock.release,
        "E_RESOURCE_MISMATCH: operator bundle differs from deployment"
    );
    let marker = prepare::load(root)?;
    if config.features.terrain {
        // Metadata only: reopening a WAL database can create SHM/WAL files.
        // The service checks the database identity before startup; HTTPS verifies
        // that identity while it is running, without a second database reader.
        files::private_metadata(&root.join("prepared/terrain"), true)?;
        files::private_metadata(&root.join("prepared/terrain/current.sqlite3"), false)?;
    }
    let root = root.canonicalize()?;
    let root_str = root.to_str().context("deployment path must be UTF-8")?;
    let mut report = Report {
        status: "prepared",
        checks: Vec::new(),
    };
    report.required("prepared", Ok(()), "Private configuration, identities, release and immutable preparation inventories match; terrain-store metadata is present.", "Review preparation without changing a live store.");
    report.required(
        "docker-compose",
        prerequisites(root_str).await,
        "Supported local Docker/Compose and generated configuration validate.",
        "Install the documented rootful Linux Docker/Compose versions and validate this project.",
    );
    report.checks.push(Check {id:"remote-network-boundary", status:"unknown", severity:"informational", message:"A local check cannot prove BDS-source filtering, public exposure or router forwarding.".into(), remediation:Some("Review/apply firewall-review.sh and test from authorized BDS and unauthorized LAN/Internet vantages.")});
    if running {
        let inspected = report.required("containers", runtime(&root, &config, &lock).await, "Exact project images, non-root mounts, ports, isolation and listener health match.", "Inspect only this Compose project; do not start or replace it through this diagnostic.");
        if inspected {
            ensure!(
                config.viewer.access != Access::Password || password.is_some(),
                "E_CONFIG_INVALID: viewer credentials required for running checks"
            );
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(5))
                .build()?;
            let probe = async {
                for (path, file) in [
                    ("/".to_owned(), resources.web().join("index.html")),
                    (
                        "/viewer-config.json".into(),
                        root.join("prepared/public/viewer-config.json"),
                    ),
                    (
                        format!("/maps/{}/manifest.json", marker.dataset_id),
                        root.join(format!(
                            "prepared/public/maps/{}/manifest.json",
                            marker.dataset_id
                        )),
                    ),
                ] {
                    if config.viewer.access == Access::Password {
                        ensure!(
                            response(&client, &config, &path, None, 4096).await?.0 == 401,
                            "anonymous private access was not denied"
                        );
                    }
                    let (status, body) =
                        response(&client, &config, &path, password, 16 * 1024 * 1024).await?;
                    ensure!(
                        status == 200 && files::digest(&body) == crate::assets::checksum(&file)?,
                        "HTTPS frontend or binding does not match this deployment"
                    );
                }
                for path in ["/healthz", "/ingest/v1/snapshot", "/deployment-lock.json"] {
                    ensure!(
                        response(&client, &config, path, password, 4096).await?.0 == 404,
                        "private operational route was exposed"
                    );
                }
                if config.features.terrain {
                    let path = format!("/api/v1/worlds/{}/terrain/manifest.json", lock.world_id);
                    let (status, body) =
                        response(&client, &config, &path, password, 16 * 1024 * 1024).await?;
                    let manifest: Value = serde_json::from_slice(&body)?;
                    ensure!(
                        status == 200
                            && manifest["format_version"] == 2
                            && manifest["world_id"] == lock.world_id
                            && manifest["generation"] == serde_json::json!(lock.generation),
                        "live terrain store identity differs"
                    );
                }
                Ok(())
            };
            if report.required(
                "https",
                probe.await,
                "Trusted HTTPS serves the exact frontend/seed/binding and protects private routes.",
                "Check hostname DNS, TCP80/443, certificates and viewer credentials.",
            ) {
                report.status = "serving_awaiting_bds";
                let mut all_live = true;
                for (id, enabled, terrain) in [
                    ("terrain-producer", config.features.terrain, true),
                    ("player-producer", config.features.players, false),
                ] {
                    if !enabled {
                        report.checks.push(Check {
                            id,
                            status: "not_applicable",
                            severity: "informational",
                            message: "Feature is disabled.".into(),
                            remediation: None,
                        });
                        continue;
                    }
                    let path = format!(
                        "/api/v1/worlds/{}/{}",
                        lock.world_id,
                        if terrain { "terrain/status" } else { "players" }
                    );
                    let result = async {
                        let (status, body) =
                            response(&client, &config, &path, password, 32 * 1024).await?;
                        ensure!(status == 200, "enabled read service is unavailable");
                        freshness(&serde_json::from_slice(&body)?, terrain, &lock)
                    }
                    .await;
                    match result {
                        Ok(("live", age)) => {
                            report.required(
                                id,
                                Ok(()),
                                &format!(
                                    "Fresh valid producer observation; sample age {} ms.",
                                    age.unwrap()
                                ),
                                "Check the installed pack and private delivery.",
                            );
                        }
                        Ok(("starting", _)) if !expect_live => {
                            all_live = false;
                            report.checks.push(Check {
                                id,
                                status: "waiting",
                                severity: "informational",
                                message: "Serving; no BDS observation received yet.".into(),
                                remediation: Some(
                                    "Install/verify this world's handoff, then run --expect-live.",
                                ),
                            });
                        }
                        other => {
                            all_live = false;
                            let failure = other
                                .map(|(status, age)| {
                                    anyhow::anyhow!("producer is {status}, sample age {age:?} ms")
                                })
                                .unwrap_or_else(|e| e);
                            report.required(id,Err(failure),"","Verify the enabled pack, world binding and private collector connection.");
                        }
                    }
                }
                if all_live {
                    report.status = "live_verified";
                }
            }
        }
    }
    if !report.ok() {
        report.status = "failed";
    }
    Ok(report)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use serde_json::json;
    pub(crate) fn fixture() -> (Config, init::Lock) {
        let config=Config::parse("schema_version=1\nproject='fixture-map'\npublic_origin='https://map.example.test'\ningest_bind='10.20.0.10'\nbds_source_ipv4='10.20.0.20'\n[features]\nterrain=true\nplayers=true\n").unwrap();
        let image = |name: &str| super::super::release::Image {
            repository: format!("registry.example.test/{name}"),
            index_digest: format!("sha256:{}", "a".repeat(64)),
            manifests: [
                ("amd64".into(), format!("sha256:{}", "b".repeat(64))),
                ("arm64".into(), format!("sha256:{}", "c".repeat(64))),
            ]
            .into(),
        };
        let lock = init::Lock {
            schema_version: 1,
            config_sha256: "a".repeat(64),
            world_id: "fixture-world".into(),
            generation: Some("b".repeat(64)),
            uid: 1000,
            gid: 1000,
            secret_sha256: Default::default(),
            release: Release {
                schema_version: 1,
                application_version: env!("CARGO_PKG_VERSION").into(),
                commit: "a".repeat(40),
                common_sha256: "b".repeat(64),
                registry_verified: true,
                runtime: image("runtime"),
                gateway: image("gateway"),
            },
        };
        (config, lock)
    }
    #[test]
    fn version_floor_is_not_lexical() {
        assert!(minimum("28.0.4", [28, 0, 4]));
        assert!(minimum("v2.40.0\n", [2, 38, 2]));
        for v in ["2.9.0", "2.38.1", "2.38", "2.38.2-rc1", "junk"] {
            assert!(!minimum(v, [2, 38, 2]));
        }
    }
    #[test]
    fn producer_freshness_requires_identity_and_age_not_just_http_success() {
        let (_, lock) = fixture();
        for terrain in [false, true] {
            let age_key = if terrain { "sample_age_ms" } else { "age_ms" };
            let mut view = json!({"schema_version":1,"world_id":lock.world_id,"generation":lock.generation,"status":"live",age_key:0,"snapshot":{"world_id":lock.world_id,"players":[]}});
            assert_eq!(freshness(&view, terrain, &lock).unwrap(), ("live", Some(0)));
            view[age_key] = json!(30_001);
            assert!(freshness(&view, terrain, &lock).is_err());
            view["status"] = json!("stale");
            assert_eq!(freshness(&view, terrain, &lock).unwrap().0, "stale");
            view["status"] = json!("starting");
            assert!(freshness(&view, terrain, &lock).is_err());
            view[age_key] = Value::Null;
            assert_eq!(
                freshness(&view, terrain, &lock).unwrap(),
                ("starting", None)
            );
            view["world_id"] = json!("other-world");
            assert!(freshness(&view, terrain, &lock).is_err());
        }
    }
    #[tokio::test]
    #[cfg(unix)]
    async fn command_bounds_and_redaction() {
        let error = command_output(
            "/bin/sh",
            &["-c", "printf 'private-canary' >&2; exit 1"],
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(!format!("{error:#}").contains("private-canary"));
        assert!(
            command_output("/bin/sleep", &["10"], Duration::from_millis(30))
                .await
                .is_err()
        );
        assert!(
            command_output("/usr/bin/yes", &[], Duration::from_secs(2))
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn http_probes_bound_bodies_and_never_follow_redirects() {
        use axum::{Router, response::Redirect, routing::get};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = fixture().0;
        config.public_origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/large", get(|| async { "x".repeat(4097) }))
                    .route(
                        "/redirect",
                        get(|| async { Redirect::temporary("http://invalid.example.test/") }),
                    ),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        assert!(
            response(&client, &config, "/large", None, 4096)
                .await
                .is_err()
        );
        assert_eq!(
            response(&client, &config, "/redirect", None, 4096)
                .await
                .unwrap()
                .0,
            307
        );
        task.abort();
    }
}
