use super::{config::Config, generate, init::Lock};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

/// Checks only the named project's actual containers. Docker is trusted as the
/// operator's host administration boundary, not as a remote attestation service.
pub fn containers(root: &Path, config: &Config, lock: &Lock, values: &[Value]) -> Result<()> {
    let expected: Value = serde_json::from_slice(&generate::compose(config, lock)?)?;
    let services = expected["services"].as_object().unwrap();
    ensure!(
        values.len() == services.len(),
        "project service count differs"
    );
    let mut seen = std::collections::BTreeSet::new();
    for value in values {
        let labels = &value["Config"]["Labels"];
        let name = labels["com.docker.compose.service"]
            .as_str()
            .context("missing service label")?;
        let service = services.get(name).context("unexpected project service")?;
        ensure!(seen.insert(name), "duplicate service container");
        ensure!(
            labels["com.docker.compose.project"] == config.project
                && labels["com.docker.compose.project.working_dir"].as_str() == root.to_str()
                && value["Config"]["Image"] == service["image"]
                && labels["org.opencontainers.image.revision"] == lock.release.commit
                && labels["dev.bedrock-surface-map.common-sha256"] == lock.release.common_sha256,
            "{name}: project or image identity differs"
        );
        let host = &value["HostConfig"];
        let mut networks = std::collections::BTreeSet::from([format!("{}_app", config.project)]);
        if name != "gateway"
            && let Some(network) = &config.bds.network
        {
            networks.insert(network.clone());
        }
        ensure!(
            value["State"]["Running"] == true
                && value["State"]["Restarting"] == false
                && value["Config"]["User"] == service["user"]
                && value["Config"]["Cmd"] == service["command"]
                && value["Config"]["Entrypoint"]
                    .as_array()
                    .is_none_or(Vec::is_empty)
                && host["Privileged"] == false
                && host["ReadonlyRootfs"] == true
                && host["CapDrop"] == json!(["ALL"])
                && host["CapAdd"].as_array().is_none_or(Vec::is_empty)
                && host["SecurityOpt"] == json!(["no-new-privileges:true"])
                && host["Memory"] == 256 * 1024 * 1024
                && host["NanoCpus"]
                    == if name == "gateway" {
                        1_000_000_000
                    } else {
                        500_000_000
                    }
                && host["PidsLimit"] == 128
                && host["RestartPolicy"]["Name"] == "unless-stopped"
                && host["NetworkMode"]
                    .as_str()
                    .is_some_and(|mode| networks.contains(mode))
                && host["Devices"].as_array().is_none_or(Vec::is_empty)
                && host["PidMode"].as_str().is_none_or(str::is_empty),
            "{name}: runtime state or isolation differs"
        );
        ensure!(
            host["LogConfig"]["Type"] == "json-file"
                && host["LogConfig"]["Config"] == service["logging"]["options"],
            "{name}: bounded log policy differs"
        );
        ensure!(
            value["NetworkSettings"]["Networks"]
                .as_object()
                .is_some_and(|actual| actual
                    .keys()
                    .cloned()
                    .collect::<std::collections::BTreeSet<_>>()
                    == networks),
            "{name}: unexpected attached networks"
        );
        if name != "gateway" {
            ensure!(
                value["State"]["Health"]["Status"] == "healthy",
                "{name}: listener is unhealthy"
            );
        }
        let mounts = value["Mounts"].as_array().context("missing mounts")?;
        let declared = service["volumes"].as_array().unwrap();
        ensure!(mounts.len() == declared.len(), "{name}: unexpected mounts");
        for mount in declared {
            let destination = &mount["target"];
            let matches: Vec<_> = mounts
                .iter()
                .filter(|m| &m["Destination"] == destination)
                .collect();
            ensure!(matches.len() == 1, "{name}: missing or duplicate mount");
            let actual = matches[0];
            let source = root.join(mount["source"].as_str().unwrap().trim_start_matches("./"));
            ensure!(
                actual["Type"] == "bind"
                    && actual["Source"].as_str() == source.to_str()
                    && actual["RW"].as_bool() == Some(!mount["read_only"].as_bool().unwrap()),
                "{name}: mount source or access differs"
            );
        }
        let mut ports: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        for p in service["ports"].as_array().into_iter().flatten() {
            let bind = p["host_ip"].as_str().unwrap_or("0.0.0.0");
            ports.insert(
                format!("{}/tcp", p["target"]),
                vec![(bind.into(), p["published"].as_str().unwrap().into())],
            );
        }
        validate_ports(&host["PortBindings"], &ports, false)?;
        validate_ports(&value["NetworkSettings"]["Ports"], &ports, true)?;
    }
    Ok(())
}

fn validate_ports(
    actual: &Value,
    expected: &BTreeMap<String, Vec<(String, String)>>,
    runtime: bool,
) -> Result<()> {
    if actual.is_null() && expected.is_empty() {
        return Ok(());
    }
    let map = actual.as_object().context("missing port bindings")?;
    let mut matched = std::collections::BTreeSet::new();
    for (port, list) in map {
        // Image EXPOSE metadata is not a published port.
        if list.is_null() {
            continue;
        }
        let configured = expected.get(port).context("unexpected published port")?;
        let entries = list.as_array().context("invalid port bindings")?;
        ensure!(!entries.is_empty(), "empty published binding");
        let mut seen = std::collections::BTreeSet::new();
        for item in entries {
            let mut host = item["HostIp"].as_str().context("invalid host binding")?;
            let number = item["HostPort"].as_str().context("invalid host port")?;
            ensure!(seen.insert((host, number)), "duplicate published binding");
            if host.is_empty() || (runtime && host == "::" && configured[0].0 == "0.0.0.0") {
                host = "0.0.0.0";
            }
            ensure!(
                configured.contains(&(host.into(), number.into())),
                "published address or port differs"
            );
        }
        matched.insert(port.clone());
    }
    ensure!(matched.len() == expected.len(), "missing published ports");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(config: &Config, lock: &Lock) -> Vec<Value> {
        let generated: Value =
            serde_json::from_slice(&generate::compose(config, lock).unwrap()).unwrap();
        generated["services"].as_object().unwrap().iter().map(|(name,s)| {
            let mut ports=serde_json::Map::new();
            for p in s["ports"].as_array().into_iter().flatten() {
                ports.insert(format!("{}/tcp",p["target"]),json!([{"HostIp":p["host_ip"].as_str().unwrap_or(""),"HostPort":p["published"]}]));
            }
            let mounts:Vec<_>=s["volumes"].as_array().unwrap().iter().map(|v|json!({"Type":"bind","Source":format!("/fixture/{}",v["source"].as_str().unwrap().trim_start_matches("./")),"Destination":v["target"],"RW":!v["read_only"].as_bool().unwrap()})).collect();
            let mut networks = json!({format!("{}_app", config.project): {}});
            if name != "gateway" && let Some(network) = &config.bds.network {
                networks[network] = json!({});
            }
            json!({
                "Config": {
                    "Labels": {
                        "com.docker.compose.service": name,
                        "com.docker.compose.project": config.project,
                        "com.docker.compose.project.working_dir": "/fixture",
                        "org.opencontainers.image.revision": lock.release.commit,
                        "dev.bedrock-surface-map.common-sha256": lock.release.common_sha256
                    },
                    "Image": s["image"], "User": s["user"], "Cmd": s["command"], "Entrypoint": null
                },
                "State": {"Running": true, "Restarting": false, "Health": {"Status": "healthy"}},
                "HostConfig": {
                    "Privileged": false, "ReadonlyRootfs": true, "CapDrop": ["ALL"],
                    "CapAdd": null, "SecurityOpt": ["no-new-privileges:true"], "Memory": 268435456,
                    "NanoCpus": if name=="gateway" {1_000_000_000} else {500_000_000},
                    "PidsLimit": 128, "RestartPolicy": {"Name": "unless-stopped"},
                    "NetworkMode": format!("{}_app", config.project), "Devices": [], "PidMode": "",
                    "PortBindings": ports, "LogConfig": {"Type":"json-file", "Config":s["logging"]["options"]}
                },
                "Mounts": mounts,
                "NetworkSettings": {"Ports": ports, "Networks": networks}
            })
        }).collect()
    }
    #[test]
    fn exact_containers_and_feature_combinations_validate() {
        let (mut config, lock) = super::super::check::tests::fixture();
        for (terrain, players) in [(true, true), (true, false), (false, true)] {
            config.features.terrain = terrain;
            config.features.players = players;
            containers(
                Path::new("/fixture"),
                &config,
                &lock,
                &fixture(&config, &lock),
            )
            .unwrap();
        }
    }
    #[test]
    fn mismatched_isolation_images_paths_and_extra_publications_refuse() {
        let (config, lock) = super::super::check::tests::fixture();
        for (path, bad) in [
            ("/Config/User", json!("0:0")),
            ("/Config/Image", json!("untrusted:latest")),
            (
                "/Config/Labels/com.docker.compose.project.working_dir",
                json!("/other"),
            ),
            ("/HostConfig/Privileged", json!(true)),
            ("/HostConfig/ReadonlyRootfs", json!(false)),
            ("/HostConfig/CapAdd", json!(["SYS_ADMIN"])),
            ("/HostConfig/Memory", json!(0)),
            ("/HostConfig/PidsLimit", json!(-1)),
            ("/HostConfig/NetworkMode", json!("host")),
            ("/State/Running", json!(false)),
            ("/Mounts/0/Source", json!("/var/run/docker.sock")),
            ("/Mounts/0/RW", json!(true)),
        ] {
            let mut values = fixture(&config, &lock);
            *values[0].pointer_mut(path).unwrap() = bad;
            assert!(
                containers(Path::new("/fixture"), &config, &lock, &values).is_err(),
                "{path}"
            );
        }
        let mut values = fixture(&config, &lock);
        values[0]["HostConfig"]["PortBindings"]["2019/tcp"] =
            json!([{"HostIp":"0.0.0.0","HostPort":"2019"}]);
        assert!(containers(Path::new("/fixture"), &config, &lock, &values).is_err());
        let mut values = fixture(&config, &lock);
        values[1]["HostConfig"]["PortBindings"]["8081/tcp"][0]["HostIp"] = json!("0.0.0.0");
        assert!(containers(Path::new("/fixture"), &config, &lock, &values).is_err());
    }

    #[test]
    fn docker_ingestion_and_proxy_keep_ports_and_networks_narrow() {
        let (mut config, lock) = super::super::check::tests::fixture();
        config.ingest_bind = None;
        config.bds_source_ipv4 = None;
        config.bds.network = Some("minecraft-map-ingest".into());
        config.gateway = super::super::config::Gateway::Proxy {
            bind: std::net::Ipv4Addr::LOCALHOST,
            port: 8080,
        };
        config.validate().unwrap();
        let generated: Value =
            serde_json::from_slice(&generate::compose(&config, &lock).unwrap()).unwrap();
        assert_eq!(
            generated["networks"]["ingest"],
            json!({"external":true,"name":"minecraft-map-ingest"})
        );
        for name in ["terrain", "players"] {
            assert!(generated["services"][name]["ports"].is_null());
            assert_eq!(
                generated["services"][name]["networks"]["ingest"]["aliases"],
                json!([config.ingest_alias(name)])
            );
        }
        assert!(
            generated["services"]["gateway"]["networks"]
                .as_array()
                .is_some()
        );
        assert_eq!(
            generated["services"]["gateway"]["ports"],
            json!([{"target":8080,"published":"8080","host_ip":"127.0.0.1","protocol":"tcp"}])
        );
        let values = fixture(&config, &lock);
        containers(Path::new("/fixture"), &config, &lock, &values).unwrap();
        let mut exposed = values.clone();
        exposed[1]["HostConfig"]["PortBindings"]["8081/tcp"] =
            json!([{"HostIp":"0.0.0.0","HostPort":"8081"}]);
        assert!(containers(Path::new("/fixture"), &config, &lock, &exposed).is_err());
        let mut joined = values.clone();
        joined[0]["NetworkSettings"]["Networks"]["minecraft-map-ingest"] = json!({});
        assert!(containers(Path::new("/fixture"), &config, &lock, &joined).is_err());
        let gateway = generate::gateway(
            &config,
            &lock,
            &BTreeMap::from([("index.html".into(), "a".repeat(64))]),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(gateway.contains("http://map.example.test:8080 {"));
        assert!(gateway.contains("import /etc/bedrock-map/viewer-auth.caddy"));
        assert!(!gateway.contains("https://"));
        assert!(!generate::firewall_review(&config).contains("iptables"));
    }
}
