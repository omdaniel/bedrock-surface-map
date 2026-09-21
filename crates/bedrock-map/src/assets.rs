use crate::{
    resources::Resources,
    state::{State, write_atomic},
};
use anyhow::{Context, Result, ensure};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MojangSource {
    repository: String,
    commit: String,
    archive_sha256: String,
    license: String,
    local_only: bool,
}

#[derive(Debug, Serialize)]
struct AssetRecord<'a> {
    schema_version: u8,
    provenance: &'a str,
    sha256: &'a str,
    source: &'a str,
    license: &'a str,
}

fn source(resources: &Resources) -> Result<MojangSource> {
    let source: MojangSource = serde_json::from_slice(
        &fs::read(resources.mojang_source())
            .context("E_RESOURCE_MISMATCH: Mojang source provenance is missing")?,
    )?;
    ensure!(
        source.archive_sha256.len() == 64
            && source
                .archive_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()),
        "E_RESOURCE_MISMATCH: invalid pinned asset digest"
    );
    ensure!(
        source.repository == "https://github.com/Mojang/bedrock-samples" && source.local_only,
        "E_RESOURCE_MISMATCH: unsupported managed asset source"
    );
    Ok(source)
}

pub fn managed_digest(resources: &Resources) -> Result<String> {
    Ok(source(resources)?.archive_sha256)
}

pub fn checksum(path: &Path) -> Result<String> {
    let mut hash = Sha256::new();
    let mut input = fs::File::open(path)?;
    std::io::copy(&mut input, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}

pub fn verify(path: &Path, expected: Option<&str>) -> Result<String> {
    ensure!(path.is_file(), "E_ASSET_MISSING: asset archive is missing");
    let actual = checksum(path)?;
    if let Some(expected) = expected {
        ensure!(
            actual == expected,
            "E_ASSET_HASH: supplied asset archive checksum differs"
        );
    }
    let temporary = tempfile::tempdir()?;
    surface_cli::prepare_asset_library(path, temporary.path())
        .context("E_ARCHIVE_INVALID: unsupported material asset archive")?;
    Ok(actual)
}

pub async fn fetch(state: &State, resources: &Resources) -> Result<(PathBuf, String)> {
    let source = source(resources)?;
    let existing = state.asset_archive(&source.archive_sha256);
    if let Ok(path) = existing {
        ensure!(
            checksum(&path)? == source.archive_sha256,
            "E_ASSET_HASH: cached material archive checksum differs"
        );
        return Ok((path, source.archive_sha256));
    }
    let url = format!(
        "https://codeload.github.com/Mojang/bedrock-samples/zip/{}",
        source.commit
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(180))
        .build()?;
    let response = client
        .get(url)
        .send()
        .await
        .context("E_NETWORK: asset download failed")?;
    ensure!(
        response.status().is_success(),
        "E_NETWORK: asset download returned {}",
        response.status()
    );
    let target = state
        .asset_archive(&source.archive_sha256)
        .unwrap_or_else(|_| {
            state
                .root
                .join("assets/archives")
                .join(format!("{}.zip", source.archive_sha256))
        });
    fs::create_dir_all(target.parent().context("asset cache parent")?)?;
    let temporary = target.with_extension(format!("part-{}", std::process::id()));
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let mut size = 0usize;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("E_NETWORK: asset download stream failed")?;
        size = size
            .checked_add(chunk.len())
            .context("E_NETWORK: asset download size overflow")?;
        ensure!(
            size <= MAX_ARCHIVE_BYTES,
            "E_NETWORK: asset archive exceeds size limit"
        );
        std::io::Write::write_all(&mut output, &chunk)?;
    }
    std::io::Write::flush(&mut output)?;
    drop(output);
    if let Err(error) = (|| -> Result<()> {
        ensure!(
            checksum(&temporary)? == source.archive_sha256,
            "E_ASSET_HASH: downloaded archive checksum differs"
        );
        verify(&temporary, Some(&source.archive_sha256))?;
        fs::rename(&temporary, &target)?;
        write_atomic(
            &state.asset_record_path(&source.archive_sha256)?,
            &serde_json::to_vec_pretty(&AssetRecord {
                schema_version: 1,
                provenance: "verified_mojang",
                sha256: &source.archive_sha256,
                source: &source.repository,
                license: &source.license,
            })?,
        )?;
        Ok(())
    })() {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok((target, source.archive_sha256))
}
