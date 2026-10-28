use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema_version: u8,
    pub project: String,
    pub public_origin: String,
    pub ingest_bind: Option<Ipv4Addr>,
    pub bds_source_ipv4: Option<Ipv4Addr>,
    #[serde(default)]
    pub bds: Bds,
    #[serde(default)]
    pub gateway: Gateway,
    pub world_id: Option<String>,
    #[serde(default)]
    pub features: Features,
    #[serde(default)]
    pub viewer: Viewer,
    #[serde(default)]
    pub ports: Ports,
    #[serde(default)]
    pub terrain_pack: TerrainPack,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Bds {
    /// An existing dedicated internal Docker network shared with BDS.
    pub network: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum Gateway {
    #[default]
    Managed,
    Proxy {
        #[serde(default = "proxy_bind")]
        bind: Ipv4Addr,
        #[serde(default = "proxy_port")]
        port: u16,
    },
}

fn proxy_bind() -> Ipv4Addr {
    Ipv4Addr::LOCALHOST
}
fn proxy_port() -> u16 {
    8080
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct TerrainPack {
    pub view_distance: u8,
    pub scan_budget_ms: u8,
}

impl Default for TerrainPack {
    fn default() -> Self {
        Self {
            view_distance: 16,
            scan_budget_ms: 1,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Features {
    pub terrain: bool,
    pub players: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Ports {
    pub terrain: u16,
    pub players: u16,
}

impl Default for Ports {
    fn default() -> Self {
        Self {
            terrain: 18082,
            players: 18081,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    #[default]
    Password,
    Public,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Viewer {
    pub access: Access,
    pub username: String,
    pub acknowledge_public_locations: bool,
}

impl Default for Viewer {
    fn default() -> Self {
        Self {
            access: Access::Password,
            username: "map".into(),
            acknowledge_public_locations: false,
        }
    }
}

pub fn identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        && value.as_bytes()[0].is_ascii_alphanumeric()
}

impl Config {
    pub fn ingest_alias(&self, service: &str) -> String {
        format!("{}-{service}-ingest", self.project.replace('_', "-"))
    }

    pub fn ingest_url(&self, service: &str) -> Result<String> {
        let (internal, published, route) = match service {
            "players" => (8081, self.ports.players, "snapshot"),
            "terrain" => (8082, self.ports.terrain, "terrain"),
            _ => anyhow::bail!("E_CONFIG_INVALID: unknown ingest service"),
        };
        let (host, port) = if self.bds.network.is_some() {
            (self.ingest_alias(service), internal)
        } else {
            (
                self.ingest_bind
                    .context("E_CONFIG_INVALID: ingest_bind is required")?
                    .to_string(),
                published,
            )
        };
        Ok(format!("http://{host}:{port}/ingest/v1/{route}"))
    }

    pub fn parse(text: &str) -> Result<Self> {
        ensure!(
            text.len() <= 16 * 1024,
            "E_CONFIG_INVALID: deployment configuration too large"
        );
        let config: Self = toml::from_str(text).map_err(|_| {
            anyhow::anyhow!("E_CONFIG_INVALID: invalid deployment TOML or unknown fields")
        })?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1,
            "E_CONFIG_SCHEMA: unsupported deployment schema"
        );
        ensure!(
            identifier(&self.project, 48),
            "E_CONFIG_INVALID: invalid Compose project name"
        );
        let host = self
            .public_origin
            .strip_prefix("https://")
            .ok_or_else(|| anyhow::anyhow!("E_CONFIG_INVALID: public_origin requires HTTPS"))?;
        let parsed = reqwest::Url::parse(&self.public_origin)?;
        // Validate the literal input, not a URL parser's normalized path/authority.
        ensure!(
            host.len() <= 253
                && host.contains('.')
                && host.parse::<Ipv4Addr>().is_err()
                && parsed.host_str() == Some(host)
                && host.split('.').all(|part| !part.is_empty()
                    && part.len() <= 63
                    && part.as_bytes()[0].is_ascii_alphanumeric()
                    && part.as_bytes()[part.len() - 1].is_ascii_alphanumeric()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')),
            "E_CONFIG_INVALID: use a dedicated lowercase hostname HTTPS origin, without port, trailing slash, path or credentials"
        );
        if let Some(network) = &self.bds.network {
            ensure!(
                self.ingest_bind.is_none()
                    && self.bds_source_ipv4.is_none()
                    && (1..=63).contains(&network.len())
                    && network.as_bytes()[0].is_ascii_alphanumeric()
                    && network
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                    && network != &format!("{}_app", self.project),
                "E_CONFIG_INVALID: bds.network must name a dedicated internal Docker network; omit LAN ingestion addresses"
            );
        } else {
            ensure!(
                self.ingest_bind.is_some_and(|a| a.is_private())
                    && self.bds_source_ipv4.is_some_and(|a| a.is_private()),
                "E_CONFIG_INVALID: ingest and BDS source must be explicit RFC1918 IPv4 addresses on a trusted LAN/VPN"
            );
        }
        if let Gateway::Proxy { bind, port } = self.gateway {
            ensure!(
                (bind.is_loopback() || bind.is_private()) && port >= 1024,
                "E_CONFIG_INVALID: proxy gateway requires a loopback/private IPv4 bind and an unprivileged port"
            );
            ensure!(
                self.bds.network.is_some()
                    || self.ingest_bind != Some(bind)
                    || ((!self.features.players || self.ports.players != port)
                        && (!self.features.terrain || self.ports.terrain != port)),
                "E_CONFIG_INVALID: proxy and ingestion ports conflict"
            );
        }
        ensure!(
            self.features.terrain || self.features.players,
            "E_CONFIG_INVALID: enable at least one live feed; snapshots use the snapshot commands"
        );
        ensure!(
            self.ports.terrain >= 1024
                && self.ports.players >= 1024
                && self.ports.terrain != self.ports.players,
            "E_CONFIG_INVALID: ingest ports must be distinct unprivileged ports"
        );
        ensure!(
            self.world_id.as_deref().is_none_or(|id| identifier(id, 64)),
            "E_CONFIG_INVALID: invalid world_id"
        );
        ensure!(
            (4..=16).contains(&self.terrain_pack.view_distance)
                && (1..=4).contains(&self.terrain_pack.scan_budget_ms),
            "E_CONFIG_INVALID: terrain_pack requires view_distance 4-16 and scan_budget_ms 1-4"
        );
        ensure!(
            identifier(&self.viewer.username, 64),
            "E_CONFIG_INVALID: invalid viewer username"
        );
        ensure!(
            self.viewer.access != Access::Public || self.viewer.acknowledge_public_locations,
            "E_CONFIG_INVALID: public access exposes terrain and player names/locations; acknowledge_public_locations must be true"
        );
        ensure!(
            self.viewer.access != Access::Password || !self.viewer.acknowledge_public_locations,
            "E_CONFIG_INVALID: public acknowledgment conflicts with password access"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn input() -> String {
        "schema_version=1\nproject='fixture-map'\npublic_origin='https://map.example.test'\ningest_bind='10.20.0.10'\nbds_source_ipv4='10.20.0.20'\n[features]\nplayers=true\n".into()
    }
    #[test]
    fn default_private_and_explicit_features() {
        let c = Config::parse(&input()).unwrap();
        assert_eq!(c.viewer.access, Access::Password);
        assert!(!c.features.terrain);
        assert_eq!(c.ports.players, 18081);
        assert_eq!(c.terrain_pack, TerrainPack::default());
        assert!(Config::parse(&input().replace("players=true", "players=false")).is_err());
        assert!(Config::parse(&(input() + "misspelling=true\n")).is_err());
    }
    #[test]
    fn terrain_pack_settings_are_explicit_and_bounded() {
        let c = Config::parse(&(input() + "[terrain_pack]\nview_distance=4\nscan_budget_ms=4\n"))
            .unwrap();
        assert_eq!(
            c.terrain_pack,
            TerrainPack {
                view_distance: 4,
                scan_budget_ms: 4
            }
        );
        assert_eq!(Config::parse(&toml::to_string(&c).unwrap()).unwrap(), c);
        for fields in [
            "view_distance=3",
            "view_distance=17",
            "scan_budget_ms=0",
            "scan_budget_ms=5",
            "scan_budget_ms=-1",
            "scan_budget_ms=1.5",
            "scan_budget_ms='4'",
            "misspelling=4",
        ] {
            assert!(
                Config::parse(&(input() + "[terrain_pack]\n" + fields)).is_err(),
                "{fields}"
            );
        }
    }
    #[test]
    fn authority_and_injection_inputs_refuse() {
        for origin in [
            "http://map.example.test",
            "https://map.example.test/",
            "https://map.example.test:8443",
            "https://map.example.test/../",
            "https://map.example.test?x=1",
            "https://user@map.example.test",
            "https://*.example.test",
            "https://map.example.test{",
            "https://127.0.0.1",
            "https://map..test",
            "https://map.example.test.",
            "https://map.example.test\\x",
            "https://map.example.test%0a",
        ] {
            let mut c = Config::parse(&input()).unwrap();
            c.public_origin = origin.into();
            assert!(c.validate().is_err(), "{origin}");
        }
        for address in [
            "0.0.0.0",
            "127.0.0.1",
            "169.254.1.1",
            "1.1.1.1",
            "255.255.255.255",
        ] {
            let mut c = Config::parse(&input()).unwrap();
            c.ingest_bind = Some(address.parse().unwrap());
            assert!(c.validate().is_err(), "{address}");
        }
    }
    #[test]
    fn public_is_an_explicit_disclosure() {
        let mut c = Config::parse(&input()).unwrap();
        c.viewer.access = Access::Public;
        assert!(c.validate().is_err());
        c.viewer.acknowledge_public_locations = true;
        c.validate().unwrap();
    }

    #[test]
    fn docker_ingestion_uses_service_dns_without_host_addresses() {
        let input = input()
            .replace("ingest_bind='10.20.0.10'\n", "")
            .replace("bds_source_ipv4='10.20.0.20'\n", "")
            + "[bds]\nnetwork='minecraft-map-ingest'\n";
        let config = Config::parse(&input).unwrap();
        assert_eq!(
            config.ingest_url("players").unwrap(),
            "http://fixture-map-players-ingest:8081/ingest/v1/snapshot"
        );
        assert_eq!(
            config.ingest_url("terrain").unwrap(),
            "http://fixture-map-terrain-ingest:8082/ingest/v1/terrain"
        );
        assert_eq!(
            Config::parse(&toml::to_string(&config).unwrap()).unwrap(),
            config
        );
        assert!(Config::parse(&(self::input() + "[bds]\nnetwork='private'\n")).is_err());
        for name in ["", "../unsafe", "fixture-map_app", "bad network", "-bad"] {
            assert!(Config::parse(&input.replace("minecraft-map-ingest", name)).is_err());
        }
    }

    #[test]
    fn proxy_requires_a_private_listener_and_preserves_public_https_origin() {
        let config = Config::parse(&(input() + "[gateway]\nmode='proxy'\n")).unwrap();
        assert_eq!(
            config.gateway,
            Gateway::Proxy {
                bind: Ipv4Addr::LOCALHOST,
                port: 8080
            }
        );
        assert_eq!(
            Config::parse(&toml::to_string(&config).unwrap()).unwrap(),
            config
        );
        for fields in [
            "bind='0.0.0.0'",
            "bind='1.1.1.1'",
            "port=80",
            "port=65536",
            "port='8080'",
            "unknown=true",
        ] {
            assert!(
                Config::parse(&(input() + "[gateway]\nmode='proxy'\n" + fields)).is_err(),
                "{fields}"
            );
        }
        assert!(
            Config::parse(&(input() + "[gateway]\nmode='proxy'\nbind='10.20.0.10'\nport=18081\n"))
                .is_err()
        );
    }
}
