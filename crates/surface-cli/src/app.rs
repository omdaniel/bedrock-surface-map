#[path = "assets.rs"]
mod assets;
use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::Instant,
};
use surface_core::*;

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Sample {
        #[arg(long)]
        input: PathBuf,
        #[arg(long, allow_hyphen_values = true)]
        x: i32,
        #[arg(long, allow_hyphen_values = true)]
        z: i32,
    },
    AssetLibrary {
        #[arg(long, default_value = ".local/assets/bedrock-samples.zip")]
        assets: PathBuf,
        #[arg(long, default_value = ".local/terrain/library")]
        output: PathBuf,
    },
    Import {
        #[arg(long)]
        input: PathBuf,
        #[arg(long, default_value = "web/public/maps/world")]
        output: PathBuf,
        #[arg(long, default_value = ".local/assets/bedrock-samples.zip")]
        assets: PathBuf,
        /// Bounded region-only export for live-map repair; no whole-world height array.
        #[arg(long)]
        surface_only: bool,
        #[arg(long, default_value = "Bedrock World")]
        name: String,
    },
    Inspect {
        path: PathBuf,
    },
    Benchmark {
        path: PathBuf,
    },
    Fixture {
        #[arg(long, default_value = "web/public/maps/fixture")]
        output: PathBuf,
    },
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn file_hash(path: &Path) -> Result<String> {
    let mut h = Sha256::new();
    let mut f = fs::File::open(path)?;
    let mut b = [0; 65536];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    if path.exists() && fs::read(path)? == data {
        return Ok(());
    }
    fs::create_dir_all(path.parent().context("missing parent")?)?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    fs::rename(tmp, path)?;
    Ok(())
}

/// Parameters for a complete, read-only offline snapshot import.
///
/// Callers own both output and scratch directories. The importer makes its
/// scratch tree private before extracting an offline world, independent of a
/// checkout-local `.local` directory or the caller's umask.
#[derive(Debug, Clone)]
pub struct ImportOptions {
    pub input_archive: PathBuf,
    pub output_directory: PathBuf,
    pub scratch_directory: PathBuf,
    pub asset_archive: PathBuf,
    pub display_name: String,
    pub surface_only: bool,
}

pub type ImportReport = serde_json::Value;

pub fn prepare_asset_library(assets: &Path, output: &Path) -> Result<serde_json::Value> {
    assets::library(assets, output)
}

fn central_entry_count(path: &Path, start: u64) -> Result<usize> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut count = 0usize;
    loop {
        let mut signature = [0u8; 4];
        file.read_exact(&mut signature)?;
        if signature != [0x50, 0x4b, 0x01, 0x02] {
            break;
        }
        let mut header = [0u8; 42];
        file.read_exact(&mut header)?;
        let name = u16::from_le_bytes([header[24], header[25]]) as u64;
        let extra = u16::from_le_bytes([header[26], header[27]]) as u64;
        let comment = u16::from_le_bytes([header[28], header[29]]) as u64;
        file.seek(SeekFrom::Current((name + extra + comment) as i64))?;
        count += 1;
        ensure!(count <= 100_000, "archive entry limit");
    }
    Ok(count)
}

fn unpack(input: &Path, cache: &Path) -> Result<()> {
    ensure!(
        matches!(
            input.extension().and_then(|s| s.to_str()),
            Some("zip" | "mcworld")
        ),
        "input must be an offline .mcworld/.zip archive"
    );
    let mut zip = zip::ZipArchive::new(fs::File::open(input)?)?;
    // zip's name index discards duplicate records; compare against the physical directory.
    ensure!(
        central_entry_count(input, zip.central_directory_start())? == zip.len(),
        "duplicate or inconsistent archive entries"
    );
    ensure!(zip.len() <= 100000, "archive entry limit");
    let mut total = 0u64;
    let mut names = std::collections::BTreeSet::new();
    for i in 0..zip.len() {
        let mut e = zip.by_index(i)?;
        let name = e.enclosed_name().context("unsafe archive path")?;
        ensure!(
            !name.as_os_str().is_empty() && !e.name().contains('\\'),
            "unsafe archive path"
        );
        ensure!(names.insert(name.clone()), "duplicate archive entry");
        ensure!(
            e.unix_mode()
                .map(|m| m & 0o170000 != 0o120000)
                .unwrap_or(true),
            "symlink in archive"
        );
        total = total
            .checked_add(e.size())
            .context("archive size overflow")?;
        ensure!(
            total <= 2 * 1024 * 1024 * 1024 && e.size() <= 512 * 1024 * 1024,
            "archive expansion limit"
        );
        if e.is_dir() {
            continue;
        }
        let p = cache.join(name);
        fs::create_dir_all(p.parent().unwrap())?;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(p)?;
        let actual = std::io::copy(&mut (&mut e).take(512 * 1024 * 1024 + 1), &mut f)?;
        ensure!(actual == e.size(), "archive length mismatch");
    }
    ensure!(
        cache.join("db/CURRENT").is_file() && cache.join("level.dat").is_file(),
        "world files must be at archive root"
    );
    Ok(())
}

fn create_private_directory(path: &Path) -> Result<()> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path)?;
        ensure!(
            !metadata.file_type().is_symlink() && metadata.is_dir(),
            "scratch directory must be a real directory"
        );
    } else {
        fs::create_dir_all(path)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn publish(
    output: &Path,
    mut regions: Vec<SurfaceRegion>,
    materials: Vec<Material>,
    source: String,
    spawn: [i32; 3],
    atlas: String,
    name: &str,
) -> Result<MapManifest> {
    regions.sort_by_key(|r| (r.rz, r.rx));
    ensure!(!regions.is_empty(), "empty map");
    let bounds = [
        regions.iter().map(|r| r.rx * 256).min().unwrap(),
        regions.iter().map(|r| r.rz * 256).min().unwrap(),
        regions.iter().map(|r| (r.rx + 1) * 256).max().unwrap(),
        regions.iter().map(|r| (r.rz + 1) * 256).max().unwrap(),
    ];
    let w = (bounds[2] - bounds[0]) as usize;
    let h = (bounds[3] - bounds[1]) as usize;
    ensure!(
        w.checked_mul(h).is_some_and(|n| n <= 16 * 1024 * 1024),
        "map exceeds prototype shadow field limit (16 million columns)"
    );
    let mut heights = vec![MISSING_HEIGHT; w * h];
    let mut refs = Vec::new();
    let mut range = [i16::MAX, i16::MIN];
    for r in regions {
        for z in 0..256 {
            for x in 0..256 {
                let i = z * 256 + x;
                let value = r.heights[i];
                if r.coverage[i] != 0 {
                    range[0] = range[0].min(value);
                    range[1] = range[1].max(value);
                    heights[((r.rz * 256 - bounds[1]) as usize + z) * w
                        + (r.rx * 256 - bounds[0]) as usize
                        + x] = value;
                }
            }
        }
        let raw = encode_region(&r)?;
        let packed = zstd::encode_all(raw.as_slice(), 3)?;
        ensure!(
            decode_region(&decompress(&packed, MAX_DECOMPRESSED)?)? == r,
            "region verification failed"
        );
        let sha = hash(&packed);
        let url = format!("regions/{sha}.bsm.zst");
        atomic_write(&output.join(&url), &packed)?;
        refs.push(RegionRef {
            rx: r.rx,
            rz: r.rz,
            url,
            sha256: sha,
            bytes: packed.len(),
            columns: r.coverage.iter().map(|v| *v as usize).sum(),
        });
    }
    let raw: Vec<u8> = heights.iter().flat_map(|v| v.to_le_bytes()).collect();
    let packed = zstd::encode_all(raw.as_slice(), 3)?;
    let sha = hash(&packed);
    let height_url = format!("heights/{sha}.i16.zst");
    atomic_write(&output.join(&height_url), &packed)?;
    let catalog_version = hash(&serde_json::to_vec(&materials)?);
    let manifest=MapManifest { format_version:VERSION,name:name.into(),bounds,spawn,source_sha256:source,catalog_version,materials,atlas,regions:refs,heights:height_url,heights_sha256:sha,height_range:range,approximations:vec!["Vanilla biome tint palette; no exact climate interpolation".into(),"Canopy surfaces are opaque; complex stairs/fences/glass use top-surface approximations".into(),"Water and thin overlays retain one support layer; no arbitrary multilayer transparency".into()] };
    atomic_write(
        &output.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest)?,
    )?;
    Ok(manifest)
}

fn peak_rss_bytes() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // getrusage initializes the complete structure on success.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return 0;
    }
    let rss = unsafe { usage.assume_init() }.ru_maxrss as u64;
    if cfg!(target_os = "macos") {
        rss
    } else {
        rss * 1024
    }
}

fn stream_publish(
    cache: &Path,
    input: &Path,
    output: &Path,
    assets: &Path,
    source: String,
    start: Instant,
    name: &str,
) -> Result<serde_json::Value> {
    let mut refs = Vec::new();
    let mut bounds = [i32::MAX, i32::MAX, i32::MIN, i32::MIN];
    let mut range = [i16::MAX, i16::MIN];
    let extracted = bedrock_adapter::extract_stream(cache, |r| {
        bounds[0] = bounds[0].min(r.rx * 256);
        bounds[1] = bounds[1].min(r.rz * 256);
        bounds[2] = bounds[2].max((r.rx + 1) * 256);
        bounds[3] = bounds[3].max((r.rz + 1) * 256);
        for (&coverage, &height) in r.coverage.iter().zip(&r.heights) {
            if coverage == 1 {
                range[0] = range[0].min(height);
                range[1] = range[1].max(height);
            }
        }
        let packed = zstd::encode_all(encode_region(&r)?.as_slice(), 3)?;
        ensure!(
            decode_region(&decompress(&packed, MAX_DECOMPRESSED)?)? == r,
            "streamed region verification failed"
        );
        let sha = hash(&packed);
        let url = format!("regions/{sha}.bsm.zst");
        atomic_write(&output.join(&url), &packed)?;
        refs.push(RegionRef {
            rx: r.rx,
            rz: r.rz,
            url,
            sha256: sha,
            bytes: packed.len(),
            columns: r.coverage.iter().filter(|&&v| v == 1).count(),
        });
        Ok(())
    })?;
    let extraction_seconds = start.elapsed().as_secs_f64();
    let mut materials = extracted.materials;
    let (atlas, unsupported) = assets::prepare(assets, output, &mut materials)?;
    ensure!(
        file_hash(input)? == source,
        "E_INPUT_CHANGED: input snapshot changed during extraction"
    );
    let report = serde_json::json!({"source_sha256":source,"source_unchanged":true,"surface_only":true,"chunks":extracted.chunks,"regions":refs.len(),"extraction_seconds":extraction_seconds,"total_seconds":start.elapsed().as_secs_f64(),"peak_rss_bytes":peak_rss_bytes(),"verified_samples":extracted.verified_samples,"unsupported_materials":unsupported});
    let manifest = MapManifest {
        format_version: 1,
        name: name.into(),
        bounds,
        spawn: extracted.spawn,
        source_sha256: source,
        catalog_version: hash(&serde_json::to_vec(&materials)?),
        materials,
        atlas,
        regions: refs,
        heights: String::new(),
        heights_sha256: String::new(),
        height_range: range,
        approximations: vec![
            "Region-only repair input; not a directly viewable offline manifest".into(),
        ],
    };
    atomic_write(
        &output.join("manifest.json"),
        &serde_json::to_vec(&manifest)?,
    )?;
    atomic_write(
        &output.join("import-report.json"),
        &serde_json::to_vec(&report)?,
    )?;
    Ok(report)
}

/// Import an offline `.mcworld` or ZIP snapshot into an explicitly supplied
/// output directory. The input is verified before and after extraction.
pub fn import_snapshot(options: &ImportOptions) -> Result<ImportReport> {
    import_snapshot_inner(options, || Ok(()))
}

fn import_snapshot_inner(
    options: &ImportOptions,
    after_unpack: impl FnOnce() -> Result<()>,
) -> Result<ImportReport> {
    ensure!(
        !options.display_name.is_empty()
            && options.display_name.chars().count() <= 128
            && !options.display_name.chars().any(char::is_control),
        "invalid map name"
    );
    let start = Instant::now();
    let source = file_hash(&options.input_archive)?;
    create_private_directory(&options.scratch_directory)?;
    let cache = options.scratch_directory.join("world");
    ensure!(
        !cache.exists(),
        "scratch world directory already exists; use an operation-owned empty scratch directory"
    );
    fs::create_dir(&cache)?;
    create_private_directory(&cache)?;
    unpack(&options.input_archive, &cache)?;
    after_unpack()?;
    if options.surface_only {
        return stream_publish(
            &cache,
            &options.input_archive,
            &options.output_directory,
            &options.asset_archive,
            source,
            start,
            &options.display_name,
        );
    }
    let extracted = bedrock_adapter::extract(&cache)?;
    let extracted_seconds = start.elapsed().as_secs_f64();
    let chunks = extracted.chunks;
    let verified_samples = extracted.verified_samples;
    let mut materials = extracted.materials;
    let (atlas, unsupported) = assets::prepare(
        &options.asset_archive,
        &options.output_directory,
        &mut materials,
    )?;
    ensure!(
        file_hash(&options.input_archive)? == source,
        "E_INPUT_CHANGED: input snapshot changed during extraction"
    );
    let manifest = publish(
        &options.output_directory,
        extracted.regions.into_values().collect(),
        materials,
        source,
        extracted.spawn,
        atlas,
        &options.display_name,
    )?;
    let columns: usize = manifest.regions.iter().map(|r| r.columns).sum();
    let bytes: usize = manifest.regions.iter().map(|r| r.bytes).sum();
    let report = serde_json::json!({
        "source_sha256":manifest.source_sha256,
        "chunks":chunks,
        "regions":manifest.regions.len(),
        "surface_columns":columns,
        "region_bytes":bytes,
        "bytes_per_column":bytes as f64/columns as f64,
        "extraction_seconds":extracted_seconds,
        "total_seconds":start.elapsed().as_secs_f64(),
        "peak_rss_bytes":peak_rss_bytes(),
        "verified_samples":verified_samples,
        "unsupported_materials":unsupported,
        "materials":manifest.materials.len(),
        "source_unchanged":true
    });
    atomic_write(
        &options.output_directory.join("import-report.json"),
        &serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

/// Create the synthetic fixture used by development and packaged smoke tests.
pub fn create_synthetic_fixture(output: &Path) -> Result<()> {
    let mut r = SurfaceRegion::empty(-1, -1);
    for z in 0..256 {
        for x in 0..256 {
            let i = z * 256 + x;
            r.coverage[i] = 1;
            r.heights[i] = ((x / 32 + z / 64) * 16) as i16;
            r.materials[i] = 1 + (x / 64 % 2) as u32;
            if x > 190 && z > 150 {
                r.materials[i] = 3;
                r.water_depth[i] = 4;
                r.supports[i] = 2;
            }
            if x == 100 && z == 100 {
                r.heights[i] += 160;
            }
            if (128..160).contains(&x) && (32..64).contains(&z) {
                r.heights[i] = if x < 144 { 16 } else { 0 };
                r.materials[i] = 4;
            }
            if (24..64).contains(&x) && (24..64).contains(&z) {
                r.heights[i] = if (32..56).contains(&x) && (32..56).contains(&z) {
                    64
                } else {
                    0
                };
                r.materials[i] = 4;
            }
        }
    }
    let mut materials = vec![];
    for (name, color) in [
        ("Unknown", [255, 0, 255, 255]),
        ("Grass", [90, 160, 64, 255]),
        ("Stone", [155, 158, 160, 255]),
        ("Water", [38, 125, 194, 255]),
        ("Sand", [225, 209, 163, 255]),
    ] {
        materials.push(Material {
            key: name.into(),
            name: name.into(),
            texture: name.into(),
            tint: if name == "Water" { 3 } else { 0 },
            approximate: false,
            uv: [0.; 4],
            average: color.map(|value| value as f32 / 255.),
        });
    }
    let atlas = assets::synthetic(output, &mut materials)?;
    publish(
        output,
        vec![r],
        materials,
        "synthetic-fixture-v1".into(),
        [-128, 4, -128],
        atlas,
        "Synthetic Fixture",
    )?;
    Ok(())
}

pub fn run_cli() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!(
                "{}",
                serde_json::json!({"ok":false,"error":format!("{e:#}")})
            );
            std::process::ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    match Args::parse().command {
        Command::Sample { input, x, z } => {
            let source = file_hash(&input)?;
            let (chunk, materials, verified_samples) = with_private_operation(|operation| {
                let cache = operation.join("world");
                create_private_directory(&cache)?;
                unpack(&input, &cache)?;
                let extracted = bedrock_adapter::extract_chunk(&cache, x, z)?;
                let region = extracted
                    .regions
                    .values()
                    .next()
                    .context("sample region missing")?;
                let chunk = terrain::SurfaceChunk::from_region(region, x, z)?;
                let mut materials = vec![terrain::MaterialSpec {
                    name: "surface:unknown".into(),
                    states: Default::default(),
                }];
                for material in extracted.materials.iter().skip(1) {
                    materials.push(terrain::MaterialSpec::from_saved_key(&material.key)?);
                }
                ensure!(file_hash(&input)? == source, "sample input changed");
                Ok((chunk, materials, extracted.verified_samples))
            })?;
            println!(
                "{}",
                serde_json::json!({"source_sha256":source,"chunk":chunk,"materials":materials,"verified_samples":verified_samples})
            );
        }
        Command::AssetLibrary { assets, output } => {
            let result = assets::library(&assets, &output)?;
            println!(
                "{}",
                serde_json::json!({"materials":result["materials"].as_array().map(Vec::len),"unsupported":result["unsupported"].as_array().map(Vec::len),"atlas":result["atlas"]})
            );
        }
        Command::Import {
            input,
            output,
            assets,
            surface_only,
            name,
        } => {
            let report = with_private_operation(|operation| {
                import_snapshot(&ImportOptions {
                    input_archive: input,
                    output_directory: output,
                    scratch_directory: operation.join("scratch"),
                    asset_archive: assets,
                    display_name: name,
                    surface_only,
                })
            })?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::Inspect { path } => {
            let m: MapManifest = serde_json::from_slice(&fs::read(path)?)?;
            println!("{}", serde_json::to_string_pretty(&m)?);
        }
        Command::Benchmark { path } => {
            let m: MapManifest = serde_json::from_slice(&fs::read(&path)?)?;
            let base = path.parent().unwrap();
            let start = Instant::now();
            let mut columns = 0;
            for r in &m.regions {
                let packed = fs::read(base.join(&r.url))?;
                ensure!(hash(&packed) == r.sha256, "region checksum mismatch");
                let raw = decompress(&packed, MAX_DECOMPRESSED)?;
                let region = decode_region(&raw)?;
                columns += region.coverage.iter().filter(|v| **v == 1).count();
            }
            println!(
                "{}",
                serde_json::json!({"regions":m.regions.len(),"columns":columns,"decode_seconds":start.elapsed().as_secs_f64()})
            );
        }
        Command::Fixture { output } => {
            create_synthetic_fixture(&output)?;
        }
    }
    Ok(())
}

fn with_private_operation<T>(run: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    let operation = tempfile::Builder::new().prefix("surface-map-").tempdir()?;
    let result = run(operation.path());
    let cleanup = operation.close();
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(error)) => {
            Err(error).context("private operation completed but scratch cleanup failed")
        }
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup)) => {
            Err(error.context(format!("private scratch cleanup also failed: {cleanup}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bedrock_world::{
        BedrockWorld, ChunkPos, Dimension, LevelDatDocument, McStructureFile,
        McStructurePaletteEntry, McStructurePlacement, McStructureRotation, McStructureSize,
        OpenOptions, WriteGuard, write_level_dat_document,
    };

    fn add_tree_to_zip(archive: &mut zip::ZipWriter<fs::File>, root: &Path, current: &Path) {
        for entry in fs::read_dir(current).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                add_tree_to_zip(archive, root, &path);
                continue;
            }
            let relative = path.strip_prefix(root).unwrap().to_string_lossy();
            archive
                .start_file(relative, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(&fs::read(path).unwrap()).unwrap();
        }
    }

    fn write_test_asset_archive(path: &Path) {
        const SOURCE: &str = "736072450c26a7c67f07b1661f29d9a5ebaa14b1";
        let prefix = format!("bedrock-samples-{SOURCE}/");
        let mut archive = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        archive
            .start_file(format!("{prefix}LICENSE.md"), options)
            .unwrap();
        archive.write_all(b"fixture license\n").unwrap();
        archive
            .start_file(format!("{prefix}resource_pack/blocks.json"), options)
            .unwrap();
        archive
            .write_all(br#"{"grass":{"textures":"grass"}}"#)
            .unwrap();
        archive
            .start_file(
                format!("{prefix}resource_pack/textures/terrain_texture.json"),
                options,
            )
            .unwrap();
        archive
            .write_all(br#"{"texture_data":{"grass":{"textures":"textures/blocks/grass"}}}"#)
            .unwrap();
        let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([70, 170, 80, 255]));
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        archive
            .start_file(
                format!("{prefix}resource_pack/textures/blocks/grass.png"),
                options,
            )
            .unwrap();
        archive.write_all(&png.into_inner()).unwrap();
        archive.finish().unwrap();
    }

    fn write_generated_mcworld(path: &Path) {
        let root = path.with_extension("world");
        fs::create_dir_all(root.join("db")).unwrap();
        drop(
            bedrock_leveldb::Db::open(root.join("db"), bedrock_leveldb::OpenOptions::default())
                .unwrap(),
        );
        fs::write(root.join("levelname.txt"), "Generated test world\n").unwrap();
        let mut level = bedrock_world::NbtTag::Compound(Default::default());
        if let bedrock_world::NbtTag::Compound(values) = &mut level {
            values.insert("SpawnX".into(), bedrock_world::NbtTag::Int(-8));
            values.insert("SpawnY".into(), bedrock_world::NbtTag::Int(64));
            values.insert("SpawnZ".into(), bedrock_world::NbtTag::Int(-8));
        }
        write_level_dat_document(&root.join("level.dat"), &LevelDatDocument::new(10, level))
            .unwrap();

        let world = BedrockWorld::open_typed_blocking(
            &root,
            OpenOptions {
                read_only: false,
                ..OpenOptions::default()
            },
        )
        .unwrap();
        let size = McStructureSize::new(16, 1, 16).unwrap();
        let mut structure = McStructureFile::new_air(size, [-16, 64, -16]).unwrap();
        structure.palette.push(McStructurePaletteEntry {
            name: "minecraft:grass".into(),
            states: Default::default(),
            version: Some(1),
        });
        structure.primary_indices.fill(1);
        let anchor = ChunkPos {
            x: -1,
            z: -1,
            dimension: Dimension::Overworld,
        };
        structure
            .write_to_world_blocking(
                &world,
                McStructurePlacement {
                    source_anchor: anchor,
                    target_anchor: anchor,
                    origin_y: 64,
                    rotation: McStructureRotation::None,
                    mirror_x: false,
                    mirror_z: false,
                },
                &WriteGuard::confirmed(root.clone(), "generated parser fixture"),
                |_| {},
            )
            .unwrap();
        drop(world);

        let mut archive = zip::ZipWriter::new(fs::File::create(path).unwrap());
        add_tree_to_zip(&mut archive, &root, &root);
        archive.finish().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "explicit CI fixture generation; writes only to BEDROCK_MAP_FIXTURE_DIR"]
    fn ci_generate_world_fixture() {
        let output = PathBuf::from(
            std::env::var("BEDROCK_MAP_FIXTURE_DIR").expect("fixture directory required"),
        );
        fs::create_dir_all(&output).unwrap();
        write_generated_mcworld(&output.join("generated.mcworld"));
        write_test_asset_archive(&output.join("assets.zip"));
    }
    #[test]
    fn reject_live_directory() {
        assert!(unpack(Path::new("/tmp/world"), Path::new("/tmp/no-write")).is_err());
    }
    #[test]
    fn hash_known() {
        assert_eq!(
            hash(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
    #[test]
    fn rejects_archive_traversal_and_symlinks() {
        let temp = std::env::temp_dir().join(format!("surface-zip-test-{}", std::process::id()));
        fs::create_dir_all(&temp).unwrap();
        for (i, name) in ["../escape", "/absolute", "safe/../../escape", "bad\\path"]
            .iter()
            .enumerate()
        {
            let path = temp.join(format!("bad{i}.zip"));
            let mut z = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            z.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"x").unwrap();
            z.finish().unwrap();
            assert!(unpack(&path, &temp.join(format!("out{i}"))).is_err());
        }
        let path = temp.join("symlink.zip");
        let mut z = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        z.add_symlink(
            "link",
            "../outside",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        z.finish().unwrap();
        assert!(unpack(&path, &temp.join("symlink-out")).is_err());
        let path = temp.join("duplicate.zip");
        let mut z = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for name in ["one", "two"] {
            z.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"x").unwrap();
        }
        z.finish().unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let names: Vec<_> = bytes
            .windows(3)
            .enumerate()
            .filter_map(|(index, window)| (window == b"two").then_some(index))
            .collect();
        assert_eq!(names.len(), 2);
        for index in names {
            bytes[index..index + 3].copy_from_slice(b"one");
        }
        fs::write(&path, bytes).unwrap();
        let error = unpack(&path, &temp.join("duplicate-out")).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("duplicate or inconsistent archive entries"),
            "{error:#}"
        );
        let path = temp.join("oversized.zip");
        let mut z = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        z.start_file("big", zip::write::SimpleFileOptions::default())
            .unwrap();
        z.write_all(b"x").unwrap();
        z.finish().unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let central = bytes
            .windows(4)
            .position(|window| window == [0x50, 0x4b, 0x01, 0x02])
            .unwrap();
        bytes[central + 24..central + 28]
            .copy_from_slice(&(512_u32 * 1024 * 1024 + 1).to_le_bytes());
        fs::write(&path, bytes).unwrap();
        let error = unpack(&path, &temp.join("oversized-out")).unwrap_err();
        assert!(
            error.to_string().contains("archive expansion limit"),
            "{error:#}"
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn imports_generated_leveldb_mcworld_with_checked_assets() {
        let temp = std::env::temp_dir().join(format!(
            "surface-generated-world-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&temp).unwrap();
        let archive = temp.join("generated.mcworld");
        let assets = temp.join("assets.zip");
        write_generated_mcworld(&archive);
        write_test_asset_archive(&assets);

        let report = import_snapshot(&ImportOptions {
            input_archive: archive,
            output_directory: temp.join("output"),
            scratch_directory: temp.join("scratch"),
            asset_archive: assets,
            display_name: "Generated fixture".into(),
            surface_only: false,
        })
        .unwrap();
        assert_eq!(report["regions"], 1);
        assert_eq!(report["surface_columns"], 256);
        let manifest: MapManifest =
            serde_json::from_slice(&fs::read(temp.join("output/manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest.bounds, [-256, -256, 0, 0]);
        assert_eq!(manifest.regions.len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(temp.join("scratch"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(temp.join("scratch/world"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn changed_input_after_unpack_cannot_publish_a_manifest() {
        let temporary = tempfile::tempdir().unwrap();
        let archive = temporary.path().join("generated.mcworld");
        let assets = temporary.path().join("assets.zip");
        let output = temporary.path().join("output");
        write_generated_mcworld(&archive);
        write_test_asset_archive(&assets);
        let error = import_snapshot_inner(
            &ImportOptions {
                input_archive: archive.clone(),
                output_directory: output.clone(),
                scratch_directory: temporary.path().join("scratch"),
                asset_archive: assets,
                display_name: "Changed fixture".into(),
                surface_only: false,
            },
            || {
                fs::OpenOptions::new()
                    .append(true)
                    .open(&archive)?
                    .write_all(b"changed after extraction")?;
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("E_INPUT_CHANGED"), "{error:#}");
        assert!(!output.join("manifest.json").exists());
    }
}
