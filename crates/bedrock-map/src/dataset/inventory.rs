use super::{
    MAX_MANIFEST, SnapshotIdentity, ValidatedLod, digest, lod::Reader, read_bounded, read_relative,
    validate_atlas, validate_legacy, validate_lod,
};
use anyhow::{Result, ensure};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use surface_core::{MapManifest, lod::MAX_ATLAS_BYTES};
use surface_sync::seed::StreamManifest;

/// Verify all referenced files and return the exact permitted relative paths.
/// Supports legacy snapshots and v2 regional streams, with optional lod.json.
/// Callers must compare this closure against the directory inventory to reject
/// unlisted files. The legacy MapManifest-returning validate API is unchanged.
pub fn validate_inventory(root: &Path) -> Result<BTreeSet<PathBuf>> {
    validate_inventory_snapshot(root).map(|(_, files)| files)
}

pub fn validate_snapshot(root: &Path) -> Result<SnapshotIdentity> {
    validate_inventory_snapshot(root).map(|(identity, _)| identity)
}

pub(crate) fn validate_inventory_snapshot(
    root: &Path,
) -> Result<(SnapshotIdentity, BTreeSet<PathBuf>)> {
    inventory(root)
        .map_err(|e| anyhow::anyhow!("E_RESOURCE_MISMATCH: invalid dataset inventory: {e:#}"))
}

fn inventory(root: &Path) -> Result<(SnapshotIdentity, BTreeSet<PathBuf>)> {
    let metadata = fs::symlink_metadata(root)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "unsafe dataset root"
    );
    let bytes = read_bounded(&root.join("manifest.json"), 64 * 1024 * 1024)?;
    #[derive(Deserialize)]
    struct Format {
        format_version: u32,
    }
    let format: Format = serde_json::from_slice(&bytes)?;
    let identity: SnapshotIdentity = serde_json::from_slice(&bytes)?;
    let lod = validate_lod(root)?;
    let mut files = match format.format_version {
        1 => {
            ensure!(
                bytes.len() as u64 <= MAX_MANIFEST,
                "snapshot manifest byte limit"
            );
            drop(bytes);
            let manifest = validate_legacy(root)?;
            if let Some(lod) = &lod {
                match_snapshot(root, &manifest, lod)?;
            }
            let mut files = BTreeSet::from([PathBuf::from(&manifest.atlas)]);
            if !manifest.heights.is_empty() {
                files.insert(PathBuf::from(&manifest.heights));
            }
            files.extend(manifest.regions.into_iter().map(|r| PathBuf::from(r.url)));
            files
        }
        2 => {
            let manifest: StreamManifest = serde_json::from_slice(&bytes)?;
            drop(bytes);
            let (files, catalog_hash) = validate_stream(root, &manifest)?;
            if let Some(lod) = &lod {
                ensure!(
                    lod.root.bounds == manifest.bounds
                        && lod.root.spawn == manifest.spawn
                        && lod.root.name == manifest.name
                        && lod.root.source_sha256 == manifest.source_sha256
                        && lod.root.world_id.as_deref() == Some(&manifest.world_id)
                        && lod.root.generation == manifest.generation,
                    "stream/LOD identity mismatch"
                );
                // Live LOD revisions and legacy stream revisions are independent counters.
                ensure!(
                    lod.catalog_hash == catalog_hash && lod.root.atlas == manifest.atlas,
                    "stream/LOD appearance mismatch"
                );
            }
            files
        }
        _ => anyhow::bail!("unsupported dataset format"),
    };
    files.insert(PathBuf::from("manifest.json"));
    if let Some(lod) = lod {
        files.extend(lod.files);
    }
    for notice in ["assets/NOTICE.txt", "assets/MOJANG-LICENSE.md"] {
        match fs::symlink_metadata(root.join(notice)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            result => {
                result?;
            }
        }
        read_relative(root, notice, 1024 * 1024)?;
        files.insert(PathBuf::from(notice));
    }
    Ok((identity, files))
}

fn validate_stream(root: &Path, manifest: &StreamManifest) -> Result<(BTreeSet<PathBuf>, String)> {
    let mut reader = Reader::new(root);
    let materials = surface_sync::seed::validate_stream(manifest, |reference, limit| {
        reader.read(reference, limit)
    })?;
    validate_atlas(&reader.read(&manifest.atlas, MAX_ATLAS_BYTES)?)?;
    Ok((reader.paths(), digest(&serde_json::to_vec(&materials)?)))
}

pub(super) fn match_snapshot(
    root: &Path,
    manifest: &MapManifest,
    validated: &ValidatedLod,
) -> Result<()> {
    let lod = &validated.root;
    let source = &manifest.source_sha256;
    let fingerprint = if source.len() == 64 && source.bytes().all(|b| b.is_ascii_hexdigit()) {
        source.to_ascii_lowercase()
    } else {
        digest(&read_bounded(&root.join("manifest.json"), MAX_MANIFEST)?)
    };
    ensure!(
        lod.source_sha256 == fingerprint
            && lod.bounds == manifest.bounds
            && lod.spawn == manifest.spawn
            && lod.name == manifest.name
            && lod.material_count == manifest.materials.len()
            && lod.world_id.is_none(),
        "E_RESOURCE_MISMATCH: snapshot/LOD identity mismatch"
    );
    ensure!(
        manifest.catalog_version == validated.catalog_hash,
        "E_RESOURCE_MISMATCH: snapshot/LOD catalog mismatch"
    );
    ensure!(
        digest(&read_relative(
            root,
            &manifest.atlas,
            MAX_ATLAS_BYTES as u64
        )?) == lod.atlas.sha256,
        "E_RESOURCE_MISMATCH: snapshot/LOD atlas mismatch"
    );
    Ok(())
}
