use super::{config::identifier, files, prepare::Preparation};
use anyhow::{Result, ensure};
use std::{fs, path::Path, process::Command};

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum Service {
    Gateway,
    Terrain,
    Players,
}

pub fn validate_marker(marker: &Preparation, commit: &str, common: &[u8]) -> Result<()> {
    ensure!(
        marker.schema_version == 1
            && marker.commit == commit
            && files::digest(common) == marker.common_sha256
            && identifier(&marker.world_id, 80)
            && files::valid_hash(&marker.dataset_id, 64)
            && files::valid_hash(&marker.source_sha256, 64)
            && marker.generation.is_some() == marker.features.terrain
            && marker
                .generation
                .as_ref()
                .is_none_or(|g| files::valid_hash(g, 64)),
        "E_RESOURCE_MISMATCH: missing or incompatible preparation marker"
    );
    Ok(())
}

pub fn validate_store(path: &Path, marker: &Preparation) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "E_STATE_UNSAFE: prepared terrain database missing"
    );
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(std::time::Duration::from_secs(2))?;
    let read = |key: &str| -> Result<serde_json::Value> {
        let value: String =
            db.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))?;
        Ok(serde_json::from_str(&value)?)
    };
    ensure!(
        read("world_id")? == marker.world_id
            && read("generation")? == serde_json::json!(marker.generation)
            && read("manifest")?["regions"].is_array(),
        "E_RESOURCE_MISMATCH: terrain store is not seeded for this identity"
    );
    Ok(())
}

pub fn run(service: Service) -> Result<()> {
    let marker: Preparation = serde_json::from_slice(&files::read_private(
        Path::new("/run/preparation.json"),
        8 * 1024 * 1024,
    )?)?;
    let gateway = matches!(service, Service::Gateway);
    let common = fs::read(if gateway {
        "/opt/bedrock-map/common-manifest.json"
    } else {
        "/opt/bedrock-map/share/bedrock-surface-map/provenance/common-manifest.json"
    })?;
    validate_marker(&marker, env!("BEDROCK_MAP_BUILD_COMMIT"), &common)?;
    let mut command = match service {
        Service::Gateway => {
            for (relative, expected) in &marker.immutable_files {
                let (prefix, base) = if relative.starts_with("gateway/") {
                    ("gateway/", "/etc/bedrock-map")
                } else if relative.starts_with("public/") {
                    ("public/", "/srv/map-public")
                } else {
                    continue;
                };
                let path = crate::resources::safe_relative(relative.strip_prefix(prefix).unwrap())?;
                ensure!(
                    crate::assets::checksum(&Path::new(base).join(path))? == *expected,
                    "E_RESOURCE_MISMATCH: gateway preparation changed"
                );
            }
            let mut cmd = Command::new("caddy");
            cmd.args([
                "run",
                "--config",
                "/etc/bedrock-map/Caddyfile",
                "--adapter",
                "caddyfile",
            ]);
            cmd
        }
        Service::Terrain => {
            ensure!(
                marker.features.terrain,
                "E_CONFIG_INVALID: terrain is disabled"
            );
            validate_store(Path::new("/state/current.sqlite3"), &marker)?;
            let mut cmd = Command::new("/opt/bedrock-map/libexec/surface-sync");
            cmd.args([
                "--state",
                "/state",
                "--world",
                &marker.world_id,
                "--generation",
                marker.generation.as_deref().unwrap(),
                "serve",
                "--token-file",
                "/run/secrets/terrain.token",
                "--ingest",
                "0.0.0.0:8082",
                "--read",
                "0.0.0.0:8111",
            ]);
            cmd
        }
        Service::Players => {
            ensure!(
                marker.features.players,
                "E_CONFIG_INVALID: players are disabled"
            );
            let mut cmd = Command::new("/opt/bedrock-map/libexec/surface-tracker");
            cmd.env("TRACKER_WORLD_ID", &marker.world_id)
                .env("TRACKER_TOKEN_FILE", "/run/secrets/players.token")
                .env("TRACKER_INGEST_BIND", "0.0.0.0:8081")
                .env("TRACKER_READ_BIND", "0.0.0.0:8110")
                .env("TRACKER_DISABLED", "false");
            cmd
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec().into())
    }
    #[cfg(not(unix))]
    {
        anyhow::bail!("E_CONFIG_INVALID: runtime launch requires Unix")
    }
}
