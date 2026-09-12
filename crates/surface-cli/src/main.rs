mod assets;
use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
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
    Import {
        #[arg(long)]
        input: PathBuf,
        #[arg(long, default_value = "web/public/maps/bedrock-survival")]
        output: PathBuf,
        #[arg(long, default_value = ".local/assets/bedrock-samples.zip")]
        assets: PathBuf,
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

fn unpack(input: &Path, cache: &Path) -> Result<()> {
    ensure!(
        matches!(
            input.extension().and_then(|s| s.to_str()),
            Some("zip" | "mcworld")
        ),
        "input must be an offline .mcworld/.zip archive"
    );
    let mut zip = zip::ZipArchive::new(fs::File::open(input)?)?;
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

fn publish(
    output: &Path,
    mut regions: Vec<SurfaceRegion>,
    materials: Vec<Material>,
    source: String,
    spawn: [i32; 3],
    atlas: String,
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
    let manifest=MapManifest { format_version:VERSION,name:"Bedrock Survival".into(),bounds,spawn,source_sha256:source,catalog_version,materials,atlas,regions:refs,heights:height_url,heights_sha256:sha,height_range:range,approximations:vec!["Vanilla biome tint palette; no exact climate interpolation".into(),"Canopy surfaces are opaque; complex stairs/fences/glass use top-surface approximations".into(),"Water and thin overlays retain one support layer; no arbitrary multilayer transparency".into()] };
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

fn main() -> std::process::ExitCode {
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
        Command::Import {
            input,
            output,
            assets,
        } => {
            let start = Instant::now();
            let source = file_hash(&input)?;
            let cache = PathBuf::from(format!(".local/worlds/{source}-{}", std::process::id()));
            fs::create_dir_all(&cache)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(".local", fs::Permissions::from_mode(0o700))?;
            }
            unpack(&input, &cache)?;
            let extracted = bedrock_adapter::extract(&cache)?;
            let extracted_seconds = start.elapsed().as_secs_f64();
            let chunks = extracted.chunks;
            let verified_samples = extracted.verified_samples;
            let mut materials = extracted.materials;
            let (atlas, unsupported) = assets::prepare(&assets, &output, &mut materials)?;
            ensure!(
                file_hash(&input)? == source,
                "input snapshot changed during extraction"
            );
            let m = publish(
                &output,
                extracted.regions.into_values().collect(),
                materials,
                source,
                extracted.spawn,
                atlas,
            )?;
            let columns: usize = m.regions.iter().map(|r| r.columns).sum();
            let bytes: usize = m.regions.iter().map(|r| r.bytes).sum();
            let report = serde_json::json!({"source_sha256":m.source_sha256,"chunks":chunks,"regions":m.regions.len(),"surface_columns":columns,"region_bytes":bytes,"bytes_per_column":bytes as f64/columns as f64,"extraction_seconds":extracted_seconds,"total_seconds":start.elapsed().as_secs_f64(),"peak_rss_bytes":peak_rss_bytes(),"verified_samples":verified_samples,"unsupported_materials":unsupported,"materials":m.materials.len(),"source_unchanged":true});
            atomic_write(
                &output.join("import-report.json"),
                &serde_json::to_vec_pretty(&report)?,
            )?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            fs::remove_dir_all(&cache)?;
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
                }
            }
            let mut ms = vec![];
            for (name, color) in [
                ("Unknown", [255, 0, 255, 255]),
                ("Grass", [90, 160, 64, 255]),
                ("Stone", [155, 158, 160, 255]),
                ("Water", [38, 125, 194, 255]),
                ("Sand", [225, 209, 163, 255]),
            ] {
                ms.push(Material {
                    key: name.into(),
                    name: name.into(),
                    texture: name.into(),
                    tint: if name == "Water" { 3 } else { 0 },
                    approximate: false,
                    uv: [0.; 4],
                    average: color.map(|v| v as f32 / 255.),
                });
            }
            let atlas = assets::synthetic(&output, &mut ms)?;
            publish(
                &output,
                vec![r],
                ms,
                "synthetic-fixture-v1".into(),
                [-128, 4, -128],
                atlas,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
        fs::remove_dir_all(temp).unwrap();
    }
}
