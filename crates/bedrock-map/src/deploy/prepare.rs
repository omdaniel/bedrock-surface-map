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
    fs::rename(&output, root.join("prepared"))?;
    fs::File::open(root)?.sync_all()?;
    Ok(result)
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
