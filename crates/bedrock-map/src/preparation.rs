//! LOD derivation inside private staging, before immutable dataset registration.
use anyhow::{Context, Result, ensure};
use std::path::Path;
use surface_cli::lod::{PrepareLodOptions, prepare_lod_with_options};

pub const DEFAULT_LOD_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub fn ensure_lod(staged: &Path, max_output_bytes: u64) -> Result<()> {
    ensure!(
        max_output_bytes > 0,
        "E_CONFIG_INVALID: LOD output budget must be positive"
    );
    crate::dataset::validate_snapshot(staged)?;
    if crate::dataset::validate_lod(staged)?.is_none() {
        prepare_lod_with_options(
            &staged.join("manifest.json"),
            staged,
            PrepareLodOptions {
                max_output_bytes: Some(max_output_bytes),
            },
        )
        .context("E_PREPARE_LOD: cannot derive LOD within the requested output budget")?;
        ensure!(
            crate::dataset::validate_lod(staged)?.is_some(),
            "E_RESOURCE_MISMATCH: LOD preparation did not publish a valid hierarchy"
        );
    }
    crate::dataset::validate_snapshot(staged)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn derives_from_surface_snapshot_without_changing_its_manifest() {
        let dir = tempfile::tempdir().unwrap();
        surface_cli::create_synthetic_fixture(dir.path()).unwrap();
        let before = fs::read(dir.path().join("manifest.json")).unwrap();
        ensure_lod(dir.path(), DEFAULT_LOD_MAX_BYTES).unwrap();
        let first = fs::read(dir.path().join("lod.json")).unwrap();
        ensure_lod(dir.path(), DEFAULT_LOD_MAX_BYTES).unwrap();
        assert_eq!(before, fs::read(dir.path().join("manifest.json")).unwrap());
        assert_eq!(first, fs::read(dir.path().join("lod.json")).unwrap());
    }

    #[test]
    fn quota_failure_does_not_publish_a_partial_lod_root() {
        let dir = tempfile::tempdir().unwrap();
        surface_cli::create_synthetic_fixture(dir.path()).unwrap();
        assert!(ensure_lod(dir.path(), 1).is_err());
        assert!(!dir.path().join("lod.json").exists());
        crate::dataset::validate(dir.path()).unwrap();
    }
}
