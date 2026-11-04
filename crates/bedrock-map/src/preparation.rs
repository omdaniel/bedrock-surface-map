//! Explicit offline LOD preparation. Ordinary import/demo/deploy paths never
//! trigger conversion. Only validated public references enter private staging.
use crate::{
    dataset,
    state::{ActiveDataset, State},
};
use anyhow::{Context, Result, ensure};
use std::{fs, path::Path};

pub const DEFAULT_LOD_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub fn prepare_lod(
    state: &State,
    input: &Path,
    max_output_bytes: u64,
    replace: bool,
) -> Result<ActiveDataset> {
    ensure!(
        max_output_bytes > 0,
        "E_CONFIG_INVALID: LOD output budget must be positive"
    );
    let _lock = state.lock_mutation()?;
    let inventory = dataset::inventory(input)?;
    let operation = state.operation("prepare-lod")?;
    let public = operation.path().join("public");
    fs::create_dir(&public)?;
    for path in &inventory.files {
        let destination = public.join(path);
        fs::create_dir_all(destination.parent().context("snapshot path")?)?;
        fs::copy(input.join(path), &destination)?;
    }
    // Revalidate after copying; input mutation cannot sneak unverified files
    // into the selected immutable snapshot.
    let copied = dataset::inventory(&public)?;
    ensure!(
        copied.source_sha256 == inventory.source_sha256,
        "E_INPUT_CHANGED: snapshot changed during preparation"
    );
    if !public.join("lod.json").exists() {
        surface_cli::lod::prepare_lod_with_options(
            &public.join("manifest.json"),
            &public,
            surface_cli::lod::PrepareLodOptions {
                max_output_bytes: Some(max_output_bytes),
            },
        )
        .context("E_PREPARE_LOD: explicit LOD conversion failed")?;
    }
    let lod = dataset::validate_lod(&public)?.context("E_PREPARE_LOD: missing LOD output")?;
    let bytes = lod
        .files
        .iter()
        .try_fold(0u64, |sum, path| -> Result<u64> {
            sum.checked_add(fs::metadata(public.join(path))?.len())
                .context("LOD size overflow")
        })?;
    ensure!(
        bytes <= max_output_bytes,
        "E_PREPARE_LOD: LOD output budget exceeded"
    );
    state.register_staged_dataset(&public, copied.source_sha256, replace)
}
