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
    #[serde(default)]
    application_version: Option<String>,
    #[serde(default)]
    commit: Option<String>,
    #[serde(default)]
    target: Option<String>,
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
    pub fn mojang_source(&self) -> PathBuf {
        self.root.join("provenance/mojang.json")
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
        if let Some(version) = &manifest.application_version {
            ensure!(
                !version.trim().is_empty(),
                "E_RESOURCE_MISMATCH: invalid application version"
            );
        }
        if let Some(commit) = &manifest.commit {
            ensure!(
                commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "E_RESOURCE_MISMATCH: invalid release commit"
            );
            let executable_commit = env!("BEDROCK_MAP_BUILD_COMMIT");
            if executable_commit != "source" {
                ensure!(
                    commit == executable_commit,
                    "E_RESOURCE_MISMATCH: executable and release manifest commits differ"
                );
            }
        }
        if let Some(target) = &manifest.target {
            ensure!(
                matches!(
                    target.as_str(),
                    "x86_64-unknown-linux-musl" | "aarch64-unknown-linux-musl"
                ),
                "E_RESOURCE_MISMATCH: unsupported release target"
            );
        }
        ensure!(
            manifest
                .files
                .iter()
                .any(|file| file.path == "share/bedrock-surface-map/web/index.html"),
            "E_RESOURCE_MISMATCH: viewer entry is absent from release inventory"
        );
        let package_root = self
            .root
            .parent()
            .unwrap_or(&self.root)
            .parent()
            .unwrap_or(&self.root);
        for file in manifest.files {
            ensure!(
                safe_relative(&file.path).is_ok(),
                "E_RESOURCE_MISMATCH: unsafe manifest entry"
            );
            let full = package_root.join(&file.path);
            let canonical = fs::canonicalize(&full).with_context(|| {
                format!("E_RESOURCE_MISMATCH: missing bundled file {}", file.path)
            })?;
            ensure!(
                canonical.starts_with(package_root) && canonical.is_file(),
                "E_RESOURCE_MISMATCH: unsafe bundled file {}",
                file.path
            );
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
