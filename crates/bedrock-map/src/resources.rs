use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct Resources {
    pub root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseManifest {
    schema_version: u8,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFile {
    path: String,
    sha256: String,
    bytes: u64,
}

impl Resources {
    pub fn discover(override_root: Option<PathBuf>) -> Result<Self> {
        let root = match override_root {
            Some(root) => root,
            None => {
                let executable = std::env::current_exe()?;
                executable
                    .parent()
                    .context("cannot find executable directory")?
                    .join("share/bedrock-surface-map")
            }
        };
        let root = fs::canonicalize(&root).with_context(|| {
            format!(
                "E_RESOURCE_MISMATCH: resource directory unavailable: {}",
                root.display()
            )
        })?;
        ensure!(
            root.is_dir(),
            "E_RESOURCE_MISMATCH: resource path is not a directory"
        );
        Ok(Self { root })
    }

    pub fn web(&self) -> PathBuf {
        self.root.join("web")
    }
    pub fn fixture(&self) -> PathBuf {
        self.root.join("fixtures/surface-v1")
    }
    pub fn release_manifest(&self) -> PathBuf {
        self.root
            .parent()
            .unwrap_or(&self.root)
            .parent()
            .unwrap_or(&self.root)
            .join("release-manifest.json")
    }

    pub fn validate_release(&self) -> Result<()> {
        let manifest: ReleaseManifest = serde_json::from_slice(
            &fs::read(self.release_manifest())
                .context("E_RESOURCE_MISMATCH: release manifest unavailable")?,
        )?;
        ensure!(
            manifest.schema_version == 1,
            "E_RESOURCE_MISMATCH: unsupported release manifest schema"
        );
        for file in manifest.files {
            ensure!(
                !file.path.contains("..") && !file.path.starts_with('/'),
                "E_RESOURCE_MISMATCH: unsafe manifest entry"
            );
            let full = self
                .root
                .parent()
                .unwrap_or(&self.root)
                .parent()
                .unwrap_or(&self.root)
                .join(&file.path);
            let bytes = fs::read(&full).with_context(|| {
                format!("E_RESOURCE_MISMATCH: missing bundled file {}", file.path)
            })?;
            ensure!(
                bytes.len() as u64 == file.bytes
                    && format!("{:x}", Sha256::digest(&bytes)) == file.sha256,
                "E_RESOURCE_MISMATCH: bundled file checksum mismatch: {}",
                file.path
            );
        }
        Ok(())
    }

    pub fn require_web(&self) -> Result<()> {
        ensure!(
            self.web().join("index.html").is_file(),
            "E_RESOURCE_MISMATCH: packaged viewer is missing"
        );
        Ok(())
    }
}

pub fn safe_relative(path: &str) -> Result<&Path> {
    ensure!(
        !path.is_empty() && !path.starts_with('/') && !path.contains('\\') && !path.contains('%'),
        "E_RESOURCE_MISMATCH: unsafe resource path"
    );
    let candidate = Path::new(path);
    ensure!(
        candidate
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_))),
        "E_RESOURCE_MISMATCH: unsafe resource path"
    );
    Ok(candidate)
}
