use crate::{
    config::{self, Config},
    dataset,
};
use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct State {
    pub root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActiveDataset {
    pub schema_version: u8,
    pub dataset_id: String,
    pub source_sha256: String,
}

#[derive(Debug)]
pub struct MutationLock(File);

impl Drop for MutationLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

trait PublicationIo {
    fn create_dir(&self, path: &Path) -> Result<()>;
    fn rename(&self, from: &Path, to: &Path) -> Result<()>;
    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<()>;
}

struct HostPublicationIo;

impl PublicationIo for HostPublicationIo {
    fn create_dir(&self, path: &Path) -> Result<()> {
        fs::create_dir(path).map_err(Into::into)
    }

    fn rename(&self, from: &Path, to: &Path) -> Result<()> {
        fs::rename(from, to).map_err(Into::into)
    }

    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        write_atomic(path, bytes)
    }
}

impl State {
    pub fn new(path: PathBuf) -> Result<Self> {
        ensure!(
            !path.as_os_str().is_empty(),
            "E_STATE_UNSAFE: empty state path"
        );
        Ok(Self {
            root: absolute(path)?,
        })
    }

    pub fn config_path(&self) -> PathBuf {
        self.root.join("config.toml")
    }
    pub fn active_path(&self) -> PathBuf {
        self.root.join("active.json")
    }
    pub fn datasets(&self) -> PathBuf {
        self.root.join("datasets")
    }
    pub fn staging(&self) -> PathBuf {
        self.root.join("staging")
    }
    pub fn operation(&self, prefix: &str) -> Result<tempfile::TempDir> {
        ensure!(
            matches!(prefix, "demo" | "import"),
            "E_STATE_UNSAFE: invalid operation kind"
        );
        let root = self.staging();
        reject_symlink(&root)?;
        Ok(tempfile::Builder::new().prefix(prefix).tempdir_in(root)?)
    }
    pub fn asset_archive(&self, sha256: &str) -> Result<PathBuf> {
        ensure!(valid_hash(sha256), "E_ASSET_HASH: invalid asset checksum");
        let path = self
            .root
            .join("assets/archives")
            .join(format!("{sha256}.zip"));
        ensure!(
            path.is_file(),
            "E_ASSET_MISSING: supported material asset archive is not available"
        );
        Ok(path)
    }
    pub fn asset_record_path(&self, sha256: &str) -> Result<PathBuf> {
        ensure!(valid_hash(sha256), "E_ASSET_HASH: invalid asset checksum");
        Ok(self
            .root
            .join("assets/records")
            .join(format!("{sha256}.json")))
    }

    pub fn init(&self) -> Result<Config> {
        if self.root.exists() {
            reject_symlink(&self.root)?;
        }
        create_private_dir(&self.root)?;
        for name in ["datasets", "assets", "staging", "locks"] {
            create_private_dir(&self.root.join(name))?;
        }
        let config_path = self.config_path();
        if config_path.exists() {
            return config::load(&config_path);
        }
        write_atomic(&config_path, &config::encode(&Config::default())?)?;
        config::load(&config_path)
    }

    pub fn config(&self) -> Result<Config> {
        config::load(&self.config_path())
    }

    pub fn lock_mutation(&self) -> Result<MutationLock> {
        self.init()?;
        let path = self.root.join("locks/mutation.lock");
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)?;
        file.try_lock_exclusive()
            .map_err(|_| anyhow::anyhow!("E_STATE_BUSY: another mutation is running"))?;
        Ok(MutationLock(file))
    }

    pub fn active(&self) -> Result<Option<ActiveDataset>> {
        let path = self.active_path();
        if !path.exists() {
            return Ok(None);
        }
        reject_symlink(&path)?;
        let active: ActiveDataset = serde_json::from_slice(&fs::read(path)?)
            .context("E_STATE_UNSAFE: invalid active dataset selection")?;
        ensure!(
            active.schema_version == 1
                && valid_id(&active.dataset_id)
                && valid_hash(&active.source_sha256),
            "E_STATE_UNSAFE: invalid active dataset selection"
        );
        ensure!(
            self.registered(&active.dataset_id)?.is_some(),
            "E_STATE_UNSAFE: selected dataset is missing or unregistered"
        );
        Ok(Some(active))
    }

    pub fn active_validated(&self) -> Result<Option<ActiveDataset>> {
        let active = self.active()?;
        if let Some(selected) = &active {
            validate_public_tree(&self.datasets().join(&selected.dataset_id).join("public"))?;
        }
        Ok(active)
    }

    pub fn registered(&self, id: &str) -> Result<Option<PathBuf>> {
        if !valid_id(id) {
            return Ok(None);
        }
        let dataset = self.datasets().join(id);
        let metadata = dataset.join("metadata.json");
        if !metadata.exists() {
            return Ok(None);
        }
        reject_symlink(&dataset)?;
        reject_symlink(&metadata)?;
        ensure!(
            fs::read(&metadata)? == br#"{"schema_version":1}"#,
            "E_STATE_UNSAFE: invalid dataset registration"
        );
        let public = dataset.join("public");
        reject_symlink(&public)?;
        ensure!(
            public.is_dir(),
            "E_STATE_UNSAFE: registered dataset is missing public content"
        );
        Ok(Some(public))
    }

    pub fn register_staged_dataset(
        &self,
        staged_public: &Path,
        source_sha256: String,
        replace_active: bool,
    ) -> Result<ActiveDataset> {
        self.register_staged_dataset_with_io(
            staged_public,
            source_sha256,
            replace_active,
            &HostPublicationIo,
        )
    }

    fn register_staged_dataset_with_io(
        &self,
        staged_public: &Path,
        source_sha256: String,
        replace_active: bool,
        io: &impl PublicationIo,
    ) -> Result<ActiveDataset> {
        ensure!(
            valid_hash(&source_sha256),
            "E_STATE_UNSAFE: invalid source fingerprint"
        );
        let current = self.active()?;
        reject_symlink(staged_public)?;
        validate_public_tree(staged_public)?;
        let id = tree_hash(staged_public)?;
        let active = ActiveDataset {
            schema_version: 1,
            dataset_id: id.clone(),
            source_sha256,
        };
        if let Some(current) = current
            && current.dataset_id != active.dataset_id
            && !replace_active
        {
            bail!("E_REPLACE_REQUIRED: use --replace-active to select a new dataset");
        }
        let destination = self.datasets().join(&id);
        if destination.exists() {
            validate_public_tree(&destination.join("public"))?;
            ensure!(
                tree_hash(&destination.join("public"))? == id,
                "E_STATE_UNSAFE: existing immutable dataset differs"
            );
        } else {
            let container = staged_public
                .parent()
                .context("staged public directory has no parent")?;
            let staged_dataset = container.join(&id);
            io.create_dir(&staged_dataset)?;
            io.rename(staged_public, &staged_dataset.join("public"))?;
            io.write_atomic(
                &staged_dataset.join("metadata.json"),
                br#"{"schema_version":1}"#,
            )?;
            io.rename(&staged_dataset, &destination)?;
            sync_dir(&self.datasets())?;
        }
        io.write_atomic(&self.active_path(), &serde_json::to_vec_pretty(&active)?)?;
        Ok(active)
    }
}

fn absolute(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(std::env::current_dir()?.join(path))
}

fn create_private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    reject_symlink(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("E_STATE_UNSAFE: cannot inspect {}", path.display()))?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "E_STATE_UNSAFE: symlink is not allowed at {}",
        path.display()
    );
    Ok(())
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temp, path)?;
    if let Some(parent) = path.parent() {
        sync_dir(parent)?;
    }
    Ok(())
}

fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

fn valid_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn valid_hash(value: &str) -> bool {
    valid_id(value)
}

fn validate_public_tree(root: &Path) -> Result<()> {
    ensure!(
        root.join("manifest.json").is_file(),
        "E_RESOURCE_MISMATCH: dataset has no manifest"
    );
    let manifest = dataset::validate(root)?;
    let mut expected = HashSet::from([
        PathBuf::from("manifest.json"),
        PathBuf::from(&manifest.atlas),
        PathBuf::from(&manifest.heights),
    ]);
    expected.extend(
        manifest
            .regions
            .iter()
            .map(|region| PathBuf::from(&region.url)),
    );
    for notice in ["assets/NOTICE.txt", "assets/MOJANG-LICENSE.md"] {
        if root.join(notice).exists() {
            ensure!(
                fs::metadata(root.join(notice))?.len() <= 1024 * 1024,
                "E_RESOURCE_MISMATCH: oversized asset notice"
            );
            expected.insert(PathBuf::from(notice));
        }
    }
    walk(root, &mut |path| {
        ensure!(
            expected.remove(path.strip_prefix(root)?),
            "E_RESOURCE_MISMATCH: unlisted public dataset file: {}",
            path.display()
        );
        Ok(())
    })?;
    ensure!(
        expected.is_empty(),
        "E_RESOURCE_MISMATCH: missing public dataset file"
    );
    Ok(())
}

fn tree_hash(root: &Path) -> Result<String> {
    let mut records = Vec::new();
    walk(root, &mut |path| {
        let relative = path.strip_prefix(root).context("tree escaped root")?;
        let bytes = fs::read(path)?;
        records.push((
            relative.to_string_lossy().replace('\\', "/"),
            Sha256::digest(&bytes),
        ));
        Ok(())
    })?;
    records.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hash = Sha256::new();
    for (path, digest) in records {
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(digest);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn walk(root: &Path, visit: &mut impl FnMut(&Path) -> Result<()>) -> Result<()> {
    reject_symlink(root)?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "E_STATE_UNSAFE: symlink in served data"
        );
        if metadata.is_dir() {
            walk(&path, visit)?;
        } else if metadata.is_file() {
            visit(&path)?;
        } else {
            bail!("E_STATE_UNSAFE: unsupported served entry");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum FailurePoint {
        CreateStagedDataset,
        MovePublicTree,
        WriteMetadata,
        MoveImmutableDataset,
        WriteActiveSelection,
    }

    struct FailingPublicationIo(FailurePoint);

    impl FailingPublicationIo {
        fn fail(&self, point: FailurePoint) -> Result<()> {
            if self.0 == point {
                bail!("injected publication failure at {point:?}");
            }
            Ok(())
        }
    }

    impl PublicationIo for FailingPublicationIo {
        fn create_dir(&self, path: &Path) -> Result<()> {
            self.fail(FailurePoint::CreateStagedDataset)?;
            fs::create_dir(path).map_err(Into::into)
        }

        fn rename(&self, from: &Path, to: &Path) -> Result<()> {
            let point = if to.file_name().is_some_and(|name| name == "public") {
                FailurePoint::MovePublicTree
            } else {
                FailurePoint::MoveImmutableDataset
            };
            self.fail(point)?;
            fs::rename(from, to).map_err(Into::into)
        }

        fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<()> {
            let point = if path.file_name().is_some_and(|name| name == "metadata.json") {
                FailurePoint::WriteMetadata
            } else {
                FailurePoint::WriteActiveSelection
            };
            self.fail(point)?;
            write_atomic(path, bytes)
        }
    }

    fn fixture(path: &Path) {
        surface_cli::create_synthetic_fixture(path).unwrap();
    }

    #[test]
    fn publication_failures_preserve_the_previous_active_dataset() {
        for point in [
            FailurePoint::CreateStagedDataset,
            FailurePoint::MovePublicTree,
            FailurePoint::WriteMetadata,
            FailurePoint::MoveImmutableDataset,
            FailurePoint::WriteActiveSelection,
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let state = State::new(temporary.path().join("state")).unwrap();
            state.init().unwrap();

            let first = state.staging().join("first/public");
            fixture(&first);
            let selected = state
                .register_staged_dataset(&first, "a".repeat(64), false)
                .unwrap();

            let candidate = state.staging().join("candidate/public");
            fixture(&candidate);
            fs::write(candidate.join("assets/NOTICE.txt"), "different dataset").unwrap();
            let error = state
                .register_staged_dataset_with_io(
                    &candidate,
                    "b".repeat(64),
                    true,
                    &FailingPublicationIo(point),
                )
                .unwrap_err();

            assert!(error.to_string().contains("injected publication failure"));
            assert_eq!(
                state.active().unwrap().unwrap().dataset_id,
                selected.dataset_id
            );
            assert!(
                state
                    .datasets()
                    .join(selected.dataset_id)
                    .join("public")
                    .is_dir()
            );
        }
    }
}
