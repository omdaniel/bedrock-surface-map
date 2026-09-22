use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn valid_hash(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn owner() -> Result<(u32, u32)> {
    #[cfg(unix)]
    {
        // These process identity queries take no pointers and cannot fail.
        let ids = unsafe { (libc::geteuid(), libc::getegid()) };
        ensure!(
            ids.0 != 0 && ids.1 != 0,
            "E_STATE_UNSAFE: run deployment commands as a non-root operator with a non-root group"
        );
        Ok(ids)
    }
    #[cfg(not(unix))]
    {
        anyhow::bail!("E_CONFIG_INVALID: deployment requires a Unix host")
    }
}
pub fn private_metadata(path: &Path, directory: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path).with_context(|| {
        format!(
            "E_STATE_UNSAFE: missing deployment input {}",
            path.display()
        )
    })?;
    ensure!(
        !metadata.file_type().is_symlink()
            && if directory {
                metadata.is_dir()
            } else {
                metadata.is_file()
            },
        "E_STATE_UNSAFE: deployment inputs must be ordinary files/directories"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let (uid, gid) = owner()?;
        ensure!(
            metadata.uid() == uid
                && metadata.gid() == gid
                && metadata.permissions().mode() & 0o777 == if directory { 0o700 } else { 0o600 },
            "E_STATE_UNSAFE: deployment input ownership/mode differs: {}",
            path.display()
        );
        if !directory {
            ensure!(
                metadata.nlink() == 1,
                "E_STATE_UNSAFE: hardlinked private deployment file"
            );
        }
    }
    Ok(())
}
pub fn mkdir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
pub fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}
pub fn read_private(path: &Path, limit: usize) -> Result<Vec<u8>> {
    private_metadata(path, false)?;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= limit,
        "E_STATE_UNSAFE: oversized deployment input"
    );
    Ok(bytes)
}
