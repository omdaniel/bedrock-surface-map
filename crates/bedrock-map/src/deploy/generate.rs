use super::{
    config::{Access, Config},
    files,
    init::Lock,
};
use crate::{resources::Resources, state::ActiveDataset};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path};

fn bind(source: &str, target: &str, writable: bool) -> Value {
    json!({"type":"bind","source":source,"target":target,"read_only":!writable,"bind":{"create_host_path":false}})
}

pub fn firewall_review(config: &Config) -> String {
    let ports: Vec<_> = [
        (config.features.terrain, config.ports.terrain),
        (config.features.players, config.ports.players),
    ]
    .into_iter()
    .filter_map(|(enabled, port)| enabled.then_some(port.to_string()))
    .collect();
    format!(
        r#"#!/bin/sh
# Operator-reviewed Docker iptables-backend policy. Never run by deploy commands.
set -eu
case "${{1:-}}" in check|apply|remove) action=$1 ;; *) printf '%s\n' 'Usage: sudo sh firewall-review.sh check|apply|remove' >&2; exit 2 ;; esac
test "$(id -u)" = 0 || {{ printf '%s\n' 'Requires root after reviewing the scoped rules.' >&2; exit 2; }}
iptables -w 5 -S DOCKER-USER >/dev/null
for port in {ports}; do
  set -- -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst {bind} --ctorigdstport "$port" ! -s {source} -m comment --comment 'bedrock-map:{project}' -j DROP
  case "$action" in
    check) iptables -w 5 -C DOCKER-USER "$@" ;;
    apply) if ! iptables -w 5 -C DOCKER-USER "$@" 2>/dev/null; then iptables -w 5 -I DOCKER-USER 1 "$@"; fi ;;
    remove) if iptables -w 5 -C DOCKER-USER "$@" 2>/dev/null; then iptables -w 5 -D DOCKER-USER "$@"; fi ;;
  esac
done
"#,
        ports = ports.join(" "),
        bind = config.ingest_bind,
        source = config.bds_source_ipv4,
        project = config.project
    )
}

pub fn compose(config: &Config, lock: &Lock) -> Result<Vec<u8>> {
    let mut services = serde_json::Map::new();
    for (name, enabled) in [
        ("gateway", true),
        ("terrain", config.features.terrain),
        ("players", config.features.players),
    ] {
        if !enabled {
            continue;
        }
        let gateway = name == "gateway";
        let mut service = json!({
            "image":if gateway {lock.release.gateway.reference()} else {lock.release.runtime.reference()},
            "user":format!("{}:{}",lock.uid,lock.gid),"read_only":true,"cap_drop":["ALL"],
            "security_opt":["no-new-privileges:true"],"restart":"unless-stopped","stop_grace_period":"15s",
            "mem_limit":"256m","cpus":if gateway {1.0} else {0.5},"pids_limit":128,
            "logging":{"driver":"json-file","options":{"max-size":"5m","max-file":"2"}},
            "command":["/opt/bedrock-map/bedrock-map","internal-run",name],"networks":["app"]
        });
        let mut mounts = vec![bind(
            "./prepared/preparation.json",
            "/run/preparation.json",
            false,
        )];
        if gateway {
            mounts.extend([
                bind("./prepared/public", "/srv/map-public", false),
                bind("./prepared/gateway", "/etc/bedrock-map", false),
                bind("./caddy-data", "/data", true),
                bind("./caddy-config", "/config", true),
            ]);
            service["sysctls"] = json!({"net.ipv4.ip_unprivileged_port_start":"0"});
            service["ports"] = json!([{"target":80,"published":"80","protocol":"tcp"},{"target":443,"published":"443","protocol":"tcp"}]);
        } else {
            let (port, internal) = if name == "terrain" {
                (config.ports.terrain, 8082)
            } else {
                (config.ports.players, 8081)
            };
            service["ports"] = json!([{"target":internal,"published":port.to_string(),"host_ip":config.ingest_bind.to_string(),"protocol":"tcp"}]);
            mounts.push(bind(
                &format!("./secrets/{name}.token"),
                &format!("/run/secrets/{name}.token"),
                false,
            ));
            if name == "terrain" {
                mounts.push(bind("./prepared/terrain", "/state", true));
            }
            service["healthcheck"] = json!({"test":["CMD","/opt/bedrock-map/bedrock-map","internal-health",name],
                "interval":"10s","timeout":"3s","start_period":"5s","retries":3});
        }
        service["volumes"] = json!(mounts);
        services.insert(name.into(), service);
    }
    Ok(serde_json::to_vec_pretty(
        &json!({"name":config.project,"services":services,"networks":{"app":{"driver":"bridge"}}}),
    )?)
}

pub fn viewer(config: &Config, lock: &Lock, dataset: &ActiveDataset) -> Value {
    let mut viewer = json!({"map":format!("maps/{}/manifest.json",dataset.dataset_id)});
    if config.features.terrain {
        viewer["terrain"] = json!({"world_id":lock.world_id,"generation":lock.generation,
        "url":format!("/api/v1/worlds/{}/terrain/manifest.json",lock.world_id)});
    }
    if config.features.players {
        viewer["players"] = json!({"world_id":lock.world_id,"source_sha256":dataset.source_sha256,
            "url":format!("/api/v1/worlds/{}/players",lock.world_id),"poll_interval_ms":100});
        if let Some(generation) = &lock.generation {
            viewer["players"]["generation"] = generation.clone().into();
        }
    }
    viewer
}

fn caddy_path(path: &str) -> Result<String> {
    ensure!(
        path.starts_with('/')
            && path
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b)),
        "E_RESOURCE_MISMATCH: unsupported public path in gateway inventory"
    );
    Ok(serde_json::to_string(path)?)
}

pub fn gateway(
    config: &Config,
    lock: &Lock,
    web: &BTreeMap<String, String>,
    public: &BTreeMap<String, String>,
) -> Result<String> {
    let mut out = format!(
        "{{\n  admin off\n  skip_install_trust\n}}\n{} {{\n  route {{\n",
        config.public_origin
    );
    if config.viewer.access == Access::Password {
        out.push_str("    import /etc/bedrock-map/viewer-auth.caddy\n    header Cache-Control \"private, no-store\" {\n      defer\n    }\n");
    }
    out.push_str("    header X-Content-Type-Options nosniff\n    @write not method GET HEAD\n    respond @write 405\n");
    // Inventory URLs use plain ASCII paths. Refuse aliases before Caddy's
    // path matchers normalize dot segments, escaped separators or double slashes.
    out.push_str("    @noncanonical expression `!{http.request.orig_uri}.matches('^/[A-Za-z0-9/_.-]*([?].*)?$') || {http.request.orig_uri}.matches('^[^?]*(//|/[.][.]?(/|[?]|$))')`\n    respond @noncanonical 404\n");
    // Exact inventory, not a wildcard web root or a general SPA fallback.
    for (label, root, inventory) in [
        ("web", "/opt/bedrock-map/web", web),
        ("public", "/srv/map-public", public),
    ] {
        let mut paths = Vec::new();
        if label == "web" {
            paths.push(caddy_path("/")?);
        }
        for path in inventory.keys() {
            paths.push(caddy_path(&format!("/{path}"))?);
        }
        if !paths.is_empty() {
            out.push_str(&format!("    @{label} path {}\n    handle @{label} {{\n      root * {root}\n      file_server\n    }}\n",paths.join(" ")));
        }
    }
    for (name, enabled, port) in [
        ("players", config.features.players, 8110),
        ("terrain", config.features.terrain, 8111),
    ] {
        if !enabled {
            continue;
        }
        let matcher = if name == "players" {
            format!("path /api/v1/worlds/{}/players", lock.world_id)
        } else {
            format!(
                "path_regexp terrain ^/api/v1/worlds/{}/terrain/(manifest\\.json|status|objects/[a-f0-9]{{64}}\\.(zst|json|png|txt))$",
                lock.world_id
            )
        };
        out.push_str(&format!("    @{name} {matcher}\n    handle @{name} {{\n      reverse_proxy {name}:{port} {{\n        header_up -*\n        header_up Host {name}:{port}\n        header_up If-None-Match {{http.request.header.If-None-Match}}\n        transport http {{\n          dial_timeout 2s\n          response_header_timeout 5s\n          read_timeout 5s\n          write_timeout 5s\n          compression off\n        }}\n      }}\n    }}\n"));
    }
    out.push_str("    respond 404\n  }\n}\n");
    Ok(out)
}

pub fn write_projection(
    root: &Path,
    deployment: &Path,
    config: &Config,
    lock: &Lock,
    dataset: &ActiveDataset,
    resources: &Resources,
) -> Result<()> {
    files::write_new(
        &root.join("public/viewer-config.json"),
        &serde_json::to_vec_pretty(&viewer(config, lock, dataset))?,
    )?;
    files::mkdir(&root.join("gateway"))?;
    let mut web = files::inventory(&resources.web())?;
    // The packaged snapshot default stays immutable in the image. Deployment
    // serves only its generated binding at this exact route.
    web.remove("viewer-config.json");
    let public = files::inventory(&root.join("public"))?;
    ensure!(
        web.contains_key("index.html"),
        "E_RESOURCE_MISMATCH: frontend index is missing"
    );
    files::write_new(
        &root.join("gateway/Caddyfile"),
        gateway(config, lock, &web, &public)?.as_bytes(),
    )?;
    if config.viewer.access == Access::Password {
        let hash = String::from_utf8(files::read_private(
            &deployment.join("secrets/viewer.hash"),
            128,
        )?)?;
        files::write_new(
            &root.join("gateway/viewer-auth.caddy"),
            format!("basic_auth {{\n  {} {hash}\n}}\n", config.viewer.username).as_bytes(),
        )?;
    }
    handoff(root, deployment, config, lock, resources)?;
    Ok(())
}

fn handoff(
    root: &Path,
    deployment: &Path,
    config: &Config,
    lock: &Lock,
    resources: &Resources,
) -> Result<()> {
    let handoff = root.join("bds-handoff");
    files::mkdir(&handoff)?;
    files::mkdir(&handoff.join("packs"))?;
    files::mkdir(&handoff.join("config"))?;
    let mut entries = Vec::new();
    for (name, pack, enabled, port, route, key, max) in [
        (
            "players",
            "tracking",
            config.features.players,
            config.ports.players,
            "snapshot",
            "tracker_token",
            16384,
        ),
        (
            "terrain",
            "terrain",
            config.features.terrain,
            config.ports.terrain,
            "terrain",
            "terrain_token",
            262144,
        ),
    ] {
        if !enabled {
            continue;
        }
        let source = resources.root.join("packs").join(pack);
        let inventory = files::inventory(&source)?;
        let manifest: Value = serde_json::from_slice(&fs::read(source.join("manifest.json"))?)?;
        let modules = manifest["modules"]
            .as_array()
            .context("E_RESOURCE_MISMATCH: pack has no modules")?;
        let scripts: Vec<_> = modules.iter().filter(|m| m["type"] == "script").collect();
        ensure!(
            scripts.len() == 1,
            "E_RESOURCE_MISMATCH: pack requires one script module"
        );
        let module = scripts[0]["uuid"]
            .as_str()
            .context("E_RESOURCE_MISMATCH: script UUID missing")?;
        let header = manifest["header"]["uuid"]
            .as_str()
            .context("E_RESOURCE_MISMATCH: pack UUID missing")?;
        let uuid = |id: &str| {
            id.len() == 36
                && id.split('-').map(str::len).eq([8, 4, 4, 4, 12])
                && id.bytes().all(|b| b == b'-' || b.is_ascii_hexdigit())
        };
        ensure!(
            uuid(module) && uuid(header) && module != header,
            "E_RESOURCE_MISMATCH: pack/module UUID mismatch"
        );
        let version = manifest["header"]["version"]
            .as_array()
            .context("E_RESOURCE_MISMATCH: pack version missing")?;
        ensure!(
            version.len() == 3 && version.iter().all(|v| v.as_u64().is_some()),
            "E_RESOURCE_MISMATCH: invalid pack version"
        );
        let dependencies = manifest["dependencies"]
            .as_array()
            .context("E_RESOURCE_MISMATCH: pack runtime dependencies missing")?;
        let mut allowed = std::collections::BTreeSet::new();
        for dependency in dependencies {
            let name = dependency["module_name"]
                .as_str()
                .context("E_RESOURCE_MISMATCH: unsupported pack dependency")?;
            ensure!(
                matches!(
                    name,
                    "@minecraft/server" | "@minecraft/server-net" | "@minecraft/server-admin"
                ) && dependency["version"]
                    .as_str()
                    .is_some_and(|v| !v.is_empty())
                    && allowed.insert(name),
                "E_RESOURCE_MISMATCH: unaudited or duplicate runtime module"
            );
        }
        ensure!(
            allowed.len() == 3,
            "E_RESOURCE_MISMATCH: required runtime module missing"
        );
        let target = handoff.join("packs").join(header);
        files::mkdir(&target)?;
        files::copy_inventory(&source, &target, &inventory)?;
        let module_dir = handoff.join("config").join(module);
        files::mkdir(&module_dir)?;
        let url = format!("http://{}:{port}/ingest/v1/{route}", config.ingest_bind);
        let mut variables = json!({"world_id":lock.world_id});
        if name == "players" {
            variables["collector_url"] = url.clone().into();
            variables["update_interval_ms"] = json!(100);
        } else {
            variables["terrain_url"] = url.clone().into();
            variables["generation"] = json!(lock.generation);
            variables["view_distance"] = json!(config.terrain_pack.view_distance);
            variables["scan_budget_ms"] = json!(config.terrain_pack.scan_budget_ms);
        }
        let secret = String::from_utf8(files::read_private(
            &deployment.join(format!("secrets/{name}.token")),
            128,
        )?)?;
        for (file, data) in [
            ("variables.json", variables),
            ("secrets.json", json!({key:secret})),
            (
                "permissions.json",
                json!({
                    "allowed_modules":allowed,
                    "module_permissions":{"@minecraft/server-net":{"allowed_uris":[url],"max_body_bytes":max,"max_concurrent_requests":1}}
                }),
            ),
        ] {
            files::write_new(&module_dir.join(file), &serde_json::to_vec_pretty(&data)?)?;
        }
        files::write_new(
            &module_dir.join("runtime-requirements.json"),
            &serde_json::to_vec_pretty(&json!({
                "pack_id":header,"pack_version":version,"script_module_id":module,
                "dependencies":dependencies,"min_engine_version":manifest["header"]["min_engine_version"],
                "note":"Manifest runtime dependency versions, not npm declaration package versions. Test the actual BDS binary before installation."
            }))?,
        )?;
        entries.push(json!({"pack_id":header,"version":version}));
    }
    files::write_new(
        &handoff.join("world-pack-entries.json"),
        &serde_json::to_vec_pretty(&entries)?,
    )?;
    files::write_new(&handoff.join("README.txt"),b"PRIVATE HANDOFF: contains collector credentials; never serve this directory.\nUse an independently backed-up disposable/restored world first. This tool does not modify BDS.\nConfirm the snapshot belongs to the intended world and approve Beta APIs before installation. Experiments are not undone by pack removal.\nCopy each reviewed pack directory into BDS behavior_packs. Merge entries from world-pack-entries.json into the selected world's world_behavior_packs.json; never replace unrelated entries.\nThe config directory is keyed by script module UUID, not pack header UUID. Review and merge each variables.json, secrets.json and permissions.json by key into BDS config/<module-uuid>; never overwrite existing module settings or grant default networking permissions.\nAllow private TCP ingestion only from the declared BDS source using Docker-aware filtering. HTTP tokens are not encrypted on the LAN/VPN. No firewall is changed automatically.\nTest the shipped runtime dependencies against the actual BDS binary. The compatibility target is BDS 1.26.45.1; force_tls is intentionally omitted for that target. It is not universal compatibility evidence.\nRestart BDS through its own guarded idle maintenance and verify collector observations. No online players are required for roster heartbeats.\nTo remove: during guarded idle maintenance, remove only these pack entries and their reviewed module settings. Do not restore an old world or disable experimental metadata automatically.\n")?;
    Ok(())
}
