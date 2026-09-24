use super::{config::Features, files, generate, init, release::Release};
use crate::{assets, dataset, resources::Resources, state::State};
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Preparation {
    pub schema_version: u8,
    pub commit: String,
    pub common_sha256: String,
    pub config_sha256: String,
    pub world_id: String,
    pub generation: Option<String>,
    pub features: Features,
    pub dataset_id: String,
    pub source_sha256: String,
    pub asset_sha256: Option<String>,
    pub immutable_files: BTreeMap<String, String>,
    pub seed_files: BTreeMap<String, String>,
}

pub fn prepare(
    root: &Path,
    source: &State,
    resources: &Resources,
    asset_override: Option<&Path>,
) -> Result<Preparation> {
    let (config, lock) = init::load(root)?;
    ensure!(
        Release::load(resources)? == lock.release,
        "E_RESOURCE_MISMATCH: preparation requires the initialized component release"
    );
    let lockfile = root.join("work/prepare.lock");
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let guard = options.open(&lockfile)?;
    files::private_metadata(&lockfile, false)?;
    guard
        .try_lock_exclusive()
        .map_err(|_| anyhow::anyhow!("E_STATE_BUSY: deployment preparation is already running"))?;
    for entry in fs::read_dir(root.join("work"))? {
        ensure!(
            !entry?.file_name().to_string_lossy().starts_with("prepare-"),
            "E_STATE_RECOVERY_REQUIRED: interrupted private preparation remains under work/prepare-*; inspect and remove only that abandoned scratch before retrying"
        );
    }
    let dataset = source
        .active_validated()?
        .context("E_NO_DATASET: import and select a snapshot first")?;
    let input = source
        .registered(&dataset.dataset_id)?
        .context("E_NO_DATASET: snapshot is unavailable")?;
    let manifest = dataset::validate(&input)?;
    ensure!(
        manifest.source_sha256 == dataset.source_sha256,
        "E_RESOURCE_MISMATCH: snapshot source fingerprint mismatch"
    );
    let inventory: BTreeMap<_, _> = source
        .registered_inventory(&dataset.dataset_id)?
        .context("E_NO_DATASET: snapshot inventory unavailable")?
        .into_iter()
        .map(|(p, h)| (p.to_string_lossy().into_owned(), h))
        .collect();
    let asset = if config.features.terrain {
        Some(match asset_override {
            Some(path) => path.to_path_buf(),
            None => source.asset_archive(&assets::managed_digest(resources)?)?,
        })
    } else {
        ensure!(
            asset_override.is_none(),
            "E_CONFIG_INVALID: players-only preparation does not use an asset library"
        );
        None
    };
    let asset_sha256 = asset.as_deref().map(assets::checksum).transpose()?;
    if root.join("prepared").try_exists()? {
        let prepared = load(root)?;
        ensure!(
            prepared.dataset_id == dataset.dataset_id
                && prepared.source_sha256 == dataset.source_sha256
                && prepared.asset_sha256 == asset_sha256,
            "E_REPLACE_REQUIRED: preparation input differs; initial preparation cannot migrate or reseed"
        );
        if config.features.terrain {
            ensure!(
                files::inventory(&root.join("prepared/terrain"))? == prepared.seed_files,
                "E_REPLACE_REQUIRED: terrain store differs from initial seed; prepare never reseeds active data"
            );
        }
        return Ok(prepared);
    }
    let staging = tempfile::Builder::new()
        .prefix("prepare-")
        .tempdir_in(root.join("work"))?;
    let output = staging.path().join("prepared");
    files::mkdir(&output)?;
    files::mkdir(&output.join("public"))?;
    fs::create_dir_all(output.join("public/maps").join(&dataset.dataset_id))?;
    let copied = output.join("public/maps").join(&dataset.dataset_id);
    files::copy_inventory(&input, &copied, &inventory)?;
    dataset::validate(&copied)?;
    if let Some(asset) = asset {
        let library = staging.path().join("library");
        files::mkdir(&library)?;
        surface_cli::prepare_asset_library(&asset, &library)?;
        ensure!(
            Some(assets::checksum(&asset)?) == asset_sha256,
            "E_INPUT_CHANGED: asset archive changed while preparing"
        );
        let state = output.join("terrain");
        files::mkdir(&state)?;
        let mut store = surface_sync::store::Store::open(
            &state,
            &lock.world_id,
            lock.generation.as_deref().unwrap(),
            2 * 1024 * 1024 * 1024,
        )?;
        store.seed(&copied, Some(&library), None)?;
        drop(store);
    }
    generate::write_projection(&output, root, &config, &lock, &dataset, resources)?;
    // Source selection and release inputs must still match after all long work.
    let selected = source
        .active_validated()?
        .context("E_INPUT_CHANGED: source selection disappeared")?;
    ensure!(
        selected.dataset_id == dataset.dataset_id
            && selected.source_sha256 == dataset.source_sha256
            && init::load(root)?.1 == lock,
        "E_INPUT_CHANGED: source/deployment changed during preparation"
    );
    let (immutable_files, seed_files) = inventories(&output)?;
    let result = Preparation {
        schema_version: 1,
        commit: lock.release.commit,
        common_sha256: lock.release.common_sha256,
        config_sha256: lock.config_sha256,
        world_id: lock.world_id,
        generation: lock.generation,
        features: config.features,
        dataset_id: dataset.dataset_id,
        source_sha256: dataset.source_sha256,
        asset_sha256,
        immutable_files,
        seed_files,
    };
    files::write_new(
        &output.join("preparation.json"),
        &serde_json::to_vec_pretty(&result)?,
    )?;
    files::make_private(&output)?;
    publish(&output, root, |root| fs::File::open(root)?.sync_all())?;
    Ok(result)
}

fn publish(
    output: &Path,
    root: &Path,
    mut sync: impl FnMut(&Path) -> std::io::Result<()>,
) -> Result<()> {
    // Final permissions and every nested directory entry must be durable before
    // the tree becomes visible at its destination.
    sync_tree(output, &mut sync).context(
        "E_PREPARE_SYNC: staged preparation could not be synchronized; prepared/ was not published",
    )?;
    fs::rename(output, root.join("prepared"))?;
    sync(root).context(
        "E_PREPARED_DURABILITY: prepared/ was published, but parent-directory durability could not be confirmed; preserve prepared/, inspect the filesystem, and run deploy check before starting services; do not delete or reseed it",
    )
}

fn sync_tree(path: &Path, sync: &mut impl FnMut(&Path) -> std::io::Result<()>) -> Result<()> {
    let kind = fs::symlink_metadata(path)?.file_type();
    ensure!(
        kind.is_dir() || kind.is_file(),
        "E_STATE_UNSAFE: unexpected generated entry"
    );
    if kind.is_dir() {
        for entry in fs::read_dir(path)? {
            sync_tree(&entry?.path(), sync)?;
        }
    }
    sync(path)?;
    Ok(())
}

fn inventories(root: &Path) -> Result<(BTreeMap<String, String>, BTreeMap<String, String>)> {
    let immutable = immutable_inventory(root)?;
    let seed = if root.join("terrain").exists() {
        files::inventory(&root.join("terrain"))?
    } else {
        BTreeMap::new()
    };
    Ok((immutable, seed))
}

fn immutable_inventory(root: &Path) -> Result<BTreeMap<String, String>> {
    let mut immutable = BTreeMap::new();
    for dir in ["public", "gateway", "bds-handoff"] {
        immutable.extend(
            files::inventory(&root.join(dir))?
                .into_iter()
                .map(|(p, h)| (format!("{dir}/{p}"), h)),
        );
    }
    Ok(immutable)
}

pub fn load(root: &Path) -> Result<Preparation> {
    let (config, lock) = init::load(root)?;
    let dir = root.join("prepared");
    files::private_metadata(&dir, true)?;
    let record: Preparation = serde_json::from_slice(&files::read_private(
        &dir.join("preparation.json"),
        8 * 1024 * 1024,
    )?)?;
    ensure!(
        record.schema_version == 1
            && files::valid_hash(&record.dataset_id, 64)
            && files::valid_hash(&record.source_sha256, 64)
            && record
                .asset_sha256
                .as_ref()
                .is_none_or(|hash| files::valid_hash(hash, 64))
            && record.asset_sha256.is_some() == config.features.terrain
            && record.commit == lock.release.commit
            && record.common_sha256 == lock.release.common_sha256
            && record.config_sha256 == lock.config_sha256
            && record.world_id == lock.world_id
            && record.generation == lock.generation
            && record.features == config.features,
        "E_RESOURCE_MISMATCH: preparation identity mismatch"
    );
    ensure!(
        immutable_inventory(&dir)? == record.immutable_files,
        "E_RESOURCE_MISMATCH: immutable preparation files differ"
    );
    let snapshot = dir.join("public/maps").join(&record.dataset_id);
    let validated = dataset::validate(&snapshot)?;
    ensure!(
        validated.source_sha256 == record.source_sha256,
        "E_RESOURCE_MISMATCH: prepared fingerprint differs"
    );
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_tree_is_synchronized_child_first_before_publication() {
        let root = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir_in(root.path()).unwrap();
        let output = staging.path().join("prepared");
        let nested = output.join("public/maps/fixture");
        fs::create_dir_all(&nested).unwrap();
        files::write_new(&nested.join("manifest.json"), b"fixture").unwrap();
        files::make_private(&output).unwrap();
        let mut synchronized = Vec::new();
        publish(&output, root.path(), |path| {
            if path == root.path() {
                assert!(!output.exists());
                assert!(
                    path.join("prepared/public/maps/fixture/manifest.json")
                        .is_file()
                );
            } else {
                assert!(!root.path().join("prepared").exists());
                files::private_metadata(path, path.is_dir()).unwrap();
            }
            fs::File::open(path)?.sync_all()?;
            synchronized.push(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            synchronized,
            [
                nested.join("manifest.json"),
                nested,
                output.join("public/maps"),
                output.join("public"),
                output,
                root.path().to_path_buf(),
            ]
        );
    }

    #[test]
    fn staged_sync_failure_prevents_publication() {
        for failure in ["public/nested/fixture", "public/nested", ""] {
            let root = tempfile::tempdir().unwrap();
            let staging = tempfile::tempdir_in(root.path()).unwrap();
            let output = staging.path().join("prepared");
            fs::create_dir_all(output.join("public/nested")).unwrap();
            fs::write(output.join("public/nested/fixture"), b"fixture").unwrap();
            let error = publish(&output, root.path(), |path| {
                assert_ne!(path, root.path());
                assert!(!root.path().join("prepared").exists());
                if path == output.join(failure) {
                    Err(std::io::Error::other("injected staged sync failure"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
            assert!(error.to_string().starts_with("E_PREPARE_SYNC:"));
            assert!(!error.to_string().contains("E_PREPARED_DURABILITY"));
            assert_eq!(
                fs::read(output.join("public/nested/fixture")).unwrap(),
                b"fixture"
            );
            drop(staging);
            assert!(!root.path().join("prepared").exists());
        }
    }

    #[test]
    fn published_preparation_survives_durability_failure() {
        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::Other,
        ] {
            let root = tempfile::tempdir().unwrap();
            let staging = tempfile::tempdir_in(root.path()).unwrap();
            let output = staging.path().join("prepared");
            fs::create_dir(&output).unwrap();
            fs::write(output.join("preparation.json"), b"completed fixture").unwrap();
            let error = publish(&output, root.path(), |parent| {
                if parent != root.path() {
                    assert!(!root.path().join("prepared").exists());
                    return Ok(());
                }
                assert!(parent.join("prepared/preparation.json").is_file());
                assert!(!output.exists());
                Err(std::io::Error::new(
                    kind,
                    "injected post-publication failure",
                ))
            })
            .unwrap_err();
            assert!(error.to_string().starts_with("E_PREPARED_DURABILITY:"));
            drop(staging);
            assert_eq!(
                fs::read(root.path().join("prepared/preparation.json")).unwrap(),
                b"completed fixture"
            );
        }
    }

    #[test]
    fn rename_failure_is_not_reported_as_published() {
        let root = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir_in(root.path()).unwrap();
        let output = staging.path().join("prepared");
        fs::create_dir(&output).unwrap();
        fs::write(root.path().join("prepared"), b"existing non-directory").unwrap();
        let error = publish(&output, root.path(), |path| {
            assert_eq!(path, output);
            Ok(())
        })
        .unwrap_err();
        assert!(!error.to_string().contains("E_PREPARED_DURABILITY"));
        assert!(!error.to_string().contains("E_PREPARE_SYNC"));
        assert!(output.is_dir());
        assert_eq!(
            fs::read(root.path().join("prepared")).unwrap(),
            b"existing non-directory"
        );
    }
}
