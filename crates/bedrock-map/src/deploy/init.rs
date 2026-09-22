use super::{
    config::{Access, Config, identifier},
    files,
    release::Release,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Lock {
    pub schema_version: u8,
    pub config_sha256: String,
    pub world_id: String,
    pub generation: Option<String>,
    pub uid: u32,
    pub gid: u32,
    pub release: Release,
    pub secret_sha256: BTreeMap<String, String>,
}

fn random_hex() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|e| anyhow::anyhow!("secure randomness unavailable: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn secret_names(config: &Config) -> Vec<&'static str> {
    let mut names = Vec::new();
    if config.features.players {
        names.push("players.token");
    }
    if config.features.terrain {
        names.push("terrain.token");
    }
    if config.viewer.access == Access::Password {
        names.push("viewer.hash");
    }
    names
}

pub fn validate_password(password: &str) -> Result<()> {
    ensure!(
        (12..=72).contains(&password.len()) && !password.chars().any(char::is_control),
        "E_CONFIG_INVALID: viewer password requires 12-72 UTF-8 bytes without control characters"
    );
    Ok(())
}

pub fn read_password(path: Option<&Path>, confirm: bool) -> Result<String> {
    let password = if let Some(path) = path {
        String::from_utf8(files::read_private(path, 74)?)?
            .trim_end_matches(['\r', '\n'])
            .to_owned()
    } else {
        let password = rpassword::prompt_password("Viewer password: ")?;
        if confirm {
            ensure!(
                password == rpassword::prompt_password("Confirm viewer password: ")?,
                "E_CONFIG_INVALID: passwords differ"
            );
        }
        password
    };
    validate_password(&password)?;
    Ok(password)
}

/// Creates only a new, private deployment root. Existing incomplete roots and
/// conflicting identities are never repaired by regenerating credentials.
pub fn initialize(
    root: &Path,
    config: &Config,
    release: &Release,
    password: Option<&str>,
) -> Result<Lock> {
    config.validate()?;
    release.validate()?;
    let (uid, gid) = files::owner()?;
    if root.try_exists()? {
        let (stored, lock) = load(root)?;
        ensure!(
            &stored == config && &lock.release == release,
            "E_REPLACE_REQUIRED: deployment configuration or release differs; migration is not supported by init"
        );
        if let Some(password) = password {
            validate_password(password)?;
            ensure!(
                config.viewer.access == Access::Password,
                "E_CONFIG_INVALID: public access does not use a password"
            );
            let hash =
                String::from_utf8(files::read_private(&root.join("secrets/viewer.hash"), 128)?)?;
            ensure!(
                bcrypt::verify(password, &hash)?,
                "E_REPLACE_REQUIRED: viewer credential differs; init cannot rotate it"
            );
        }
        return Ok(lock);
    }
    let viewer_hash = if config.viewer.access == Access::Password {
        let password = password.context("E_CONFIG_INVALID: viewer password required")?;
        validate_password(password)?;
        Some(bcrypt::hash(password, 12)?)
    } else {
        ensure!(
            password.is_none(),
            "E_CONFIG_INVALID: public access does not use a password"
        );
        None
    };
    let encoded = toml::to_string_pretty(config)?;
    let mut secrets = BTreeMap::new();
    for name in secret_names(config) {
        let value = if name == "viewer.hash" {
            viewer_hash.clone().unwrap()
        } else {
            random_hex()?
        };
        secrets.insert(name, value);
    }
    let lock = Lock {
        schema_version: 1,
        config_sha256: files::digest(encoded.as_bytes()),
        world_id: config
            .world_id
            .clone()
            .unwrap_or(format!("world-{}", random_hex()?)),
        generation: config.features.terrain.then(random_hex).transpose()?,
        uid,
        gid,
        release: release.clone(),
        secret_sha256: secrets
            .iter()
            .map(|(name, value)| (name.to_string(), files::digest(value.as_bytes())))
            .collect(),
    };
    // Exclusive root creation prevents concurrent initializations from sharing
    // partial files. Only the operation that created this root may clean it up.
    files::mkdir(root)?;
    let result = (|| -> Result<()> {
        for dir in ["secrets", "work", "caddy-data", "caddy-config"] {
            files::mkdir(&root.join(dir))?;
        }
        files::write_new(&root.join("deployment.toml"), encoded.as_bytes())?;
        for (name, value) in &secrets {
            files::write_new(&root.join("secrets").join(name), value.as_bytes())?;
        }
        files::write_new(
            &root.join("deployment-lock.json"),
            &serde_json::to_vec_pretty(&lock)?,
        )?;
        fs::File::open(root)?.sync_all()?;
        Ok(())
    })();
    if let Err(error) = result {
        return match fs::remove_dir_all(root) {
            Ok(()) => Err(error),
            Err(cleanup) => {
                Err(error.context(format!("incomplete private deployment remains: {cleanup}")))
            }
        };
    }
    Ok(lock)
}

pub fn load(root: &Path) -> Result<(Config, Lock)> {
    files::private_metadata(root, true)?;
    for name in ["secrets", "work", "caddy-data", "caddy-config"] {
        files::private_metadata(&root.join(name), true)?;
    }
    let raw = files::read_private(&root.join("deployment.toml"), 16 * 1024)?;
    let config = Config::parse(std::str::from_utf8(&raw)?)?;
    let lock: Lock = serde_json::from_slice(&files::read_private(
        &root.join("deployment-lock.json"),
        64 * 1024,
    )?)?;
    lock.release.validate()?;
    let ids = files::owner()?;
    ensure!(
        lock.schema_version == 1
            && (lock.uid, lock.gid) == ids
            && files::digest(&raw) == lock.config_sha256
            && identifier(&lock.world_id, 80)
            && config
                .world_id
                .as_ref()
                .is_none_or(|id| id == &lock.world_id)
            && lock.generation.is_some() == config.features.terrain
            && lock
                .generation
                .as_ref()
                .is_none_or(|g| files::valid_hash(g, 64)),
        "E_STATE_UNSAFE: deployment identity/configuration mismatch"
    );
    let expected = secret_names(&config);
    ensure!(
        lock.secret_sha256.len() == expected.len(),
        "E_STATE_UNSAFE: secret inventory differs"
    );
    let actual = fs::read_dir(root.join("secrets"))?.collect::<std::io::Result<Vec<_>>>()?;
    ensure!(
        actual.len() == expected.len(),
        "E_STATE_UNSAFE: unexpected secret files"
    );
    for name in expected {
        let value = files::read_private(&root.join("secrets").join(name), 128)?;
        ensure!(
            lock.secret_sha256.get(name) == Some(&files::digest(&value)),
            "E_STATE_UNSAFE: secret missing or modified; init never regenerates it"
        );
        let value = std::str::from_utf8(&value)?;
        if name == "viewer.hash" {
            ensure!(
                value.len() == 60 && value.starts_with("$2b$12$"),
                "E_STATE_UNSAFE: invalid viewer hash"
            );
        } else {
            ensure!(
                files::valid_hash(value, 64),
                "E_STATE_UNSAFE: invalid ingest token"
            );
        }
    }
    Ok((config, lock))
}
