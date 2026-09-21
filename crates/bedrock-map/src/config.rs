use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{fs, net::SocketAddr, path::Path};

pub const CONFIG_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema_version: u8,
    pub server: ServerConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    pub bind: String,
    pub base_path: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            server: ServerConfig {
                bind: "127.0.0.1:8080".into(),
                base_path: "/".into(),
            },
        }
    }
}

impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == CONFIG_SCHEMA_VERSION,
            "E_CONFIG_SCHEMA: supported schema is {CONFIG_SCHEMA_VERSION}"
        );
        let address: SocketAddr = self
            .server
            .bind
            .parse()
            .context("E_CONFIG_INVALID: server.bind must be an IP socket address")?;
        ensure!(
            address.ip().is_loopback(),
            "E_CONFIG_INVALID: server.bind must use an IPv4 or IPv6 loopback address"
        );
        validate_base_path(&self.server.base_path)
    }
}

pub fn validate_base_path(path: &str) -> Result<()> {
    ensure!(
        path.starts_with('/') && path.ends_with('/'),
        "E_CONFIG_INVALID: base_path must start and end with '/'"
    );
    ensure!(
        !path.contains(['?', '#', '\\', '%']),
        "E_CONFIG_INVALID: base_path contains reserved characters"
    );
    ensure!(
        !path.chars().any(char::is_control),
        "E_CONFIG_INVALID: base_path contains a control character"
    );
    for part in path.split('/').filter(|part| !part.is_empty()) {
        ensure!(
            part != "." && part != "..",
            "E_CONFIG_INVALID: base_path contains a dot segment"
        );
        ensure!(
            part.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
            "E_CONFIG_INVALID: base_path contains unsupported characters"
        );
    }
    Ok(())
}

pub fn load(path: &Path) -> Result<Config> {
    let bytes = fs::read(path)
        .with_context(|| format!("E_CONFIG_INVALID: cannot read {}", path.display()))?;
    let config: Config = toml::from_str(
        std::str::from_utf8(&bytes).context("E_CONFIG_INVALID: config is not UTF-8")?,
    )
    .context("E_CONFIG_INVALID: invalid configuration")?;
    config.validate()?;
    Ok(config)
}

pub fn encode(config: &Config) -> Result<Vec<u8>> {
    config.validate()?;
    Ok(toml::to_string_pretty(config)?.into_bytes())
}

pub fn socket_address(config: &Config, override_bind: Option<&str>) -> Result<SocketAddr> {
    let bind = override_bind.unwrap_or(&config.server.bind);
    let address: SocketAddr = bind
        .parse()
        .context("E_CONFIG_INVALID: invalid bind override")?;
    if !address.ip().is_loopback() {
        bail!("E_CONFIG_INVALID: server.bind must use an IPv4 or IPv6 loopback address");
    }
    Ok(address)
}
