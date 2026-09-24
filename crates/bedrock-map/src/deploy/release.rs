use super::files::valid_hash;
use crate::resources::Resources;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Supplied beside the operator distribution, after registry publication verifies
/// the exact OCI objects. It is external to the images to avoid a digest cycle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Release {
    pub schema_version: u8,
    pub application_version: String,
    pub commit: String,
    pub common_sha256: String,
    pub registry_verified: bool,
    pub runtime: Image,
    pub gateway: Image,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Image {
    pub repository: String,
    pub index_digest: String,
    pub manifests: BTreeMap<String, String>,
}
impl Image {
    pub fn reference(&self) -> String {
        format!("{}@{}", self.repository, self.index_digest)
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.repository.len() <= 256
                && self.repository.contains('/')
                && !self.repository.starts_with('/')
                && !self.repository.contains("//")
                && self
                    .repository
                    .split('/')
                    .all(|s| !s.is_empty() && s != "." && s != "..")
                && self
                    .repository
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"./-_:".contains(&b))
                && !self.repository.contains('@'),
            "E_RESOURCE_MISMATCH: invalid OCI repository"
        );
        // Colons are allowed only for a registry port, never an image tag.
        ensure!(
            !self.repository.split_once('/').unwrap().1.contains(':'),
            "E_RESOURCE_MISMATCH: image tags are forbidden"
        );
        let valid_digest = |v: &str| v.strip_prefix("sha256:").is_some_and(|h| valid_hash(h, 64));
        ensure!(
            valid_digest(&self.index_digest)
                && self.manifests.len() == 2
                && ["amd64", "arm64"]
                    .iter()
                    .all(|arch| self.manifests.get(*arch).is_some_and(|v| valid_digest(v))),
            "E_RESOURCE_MISMATCH: both immutable native image manifests are required"
        );
        Ok(())
    }
}
impl Release {
    pub fn load(resources: &Resources) -> Result<Self> {
        resources.validate_release()?;
        let path = resources.release_manifest();
        let package: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        let raw = std::fs::read(path.parent().unwrap().join("deployment-release.json"))
            .context("E_RESOURCE_MISMATCH: registry-verified deployment release is unavailable")?;
        ensure!(
            raw.len() <= 64 * 1024,
            "E_RESOURCE_MISMATCH: oversized deployment release"
        );
        let release: Self = serde_json::from_slice(&raw)?;
        release.validate()?;
        let common = std::fs::read(resources.root.join("provenance/common-manifest.json"))?;
        ensure!(
            package["commit"].as_str() == Some(&release.commit)
                && super::files::digest(&common) == release.common_sha256,
            "E_RESOURCE_MISMATCH: deployment images and operator resources differ"
        );
        Ok(release)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1
                && self.application_version == env!("CARGO_PKG_VERSION")
                && valid_hash(&self.commit, 40)
                && valid_hash(&self.common_sha256, 64),
            "E_RESOURCE_MISMATCH: deployment release identity differs"
        );
        ensure!(
            self.registry_verified,
            "E_RESOURCE_MISMATCH: unpublished images block deployment; no source-build fallback"
        );
        for image in [&self.runtime, &self.gateway] {
            image.validate()?;
        }
        ensure!(
            self.runtime.repository != self.gateway.repository,
            "E_RESOURCE_MISMATCH: runtime and gateway repositories must be distinct"
        );
        Ok(())
    }
}
