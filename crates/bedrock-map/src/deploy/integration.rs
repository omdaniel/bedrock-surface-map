//! BDS-only, offline integration outputs. This module never writes to BDS.
use super::{files, init, prepare};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

const JSON_LIMIT: usize = 1024 * 1024;
const FILE_LIMIT: usize = 16 * 1024 * 1024;
const HTTP_MODULE: &str = "@minecraft/server-net";
const TEMPLATE_DIR: &str = "MERGE_REQUIRED_TEMPLATES";
const TEMPLATE_NOTICE: &str = "BDS only. TEMPLATE export: merge registration, module settings and separate private secret templates before copying. Compiled behavior_packs may be copied directly. Read MERGE_REQUIRED_TEMPLATES/README.txt; restart only through guarded maintenance or the server panel. No BDS files were changed.";
pub const NOTICE: &str = "BDS only. Review and copy the exported files, then restart through guarded maintenance or the server panel. Credentials require the separate private export. No BDS files, experiments or services were changed. Test Beta APIs and runtime compatibility on a backed-up test world first.";

#[derive(Serialize)]
pub struct Check {
    pub id: &'static str,
    pub target: String,
    pub status: &'static str,
    pub message: &'static str,
}

#[derive(Serialize)]
pub struct Report {
    pub world_id: String,
    pub world: String,
    pub checks: Vec<Check>,
    pub notice: &'static str,
}
impl Report {
    pub fn ok(&self) -> bool {
        self.checks.iter().all(|c| c.status == "pass")
    }
    fn check(&mut self, id: &'static str, target: String, result: Result<()>) {
        self.checks.push(Check {
            id,
            target,
            status: if result.is_ok() { "pass" } else { "fail" },
            // Neither parser errors nor actual values are safe diagnostics for secrets.
            message: if result.is_ok() {
                "matches prepared requirements"
            } else {
                "missing, unsafe, malformed or differs from prepared requirements; review locally"
            },
        });
    }
}

#[derive(Serialize)]
pub struct Export {
    pub world_id: String,
    pub world: String,
    pub mode: &'static str,
    pub files: Vec<String>,
    pub private_files: Vec<String>,
    pub notice: &'static str,
}

struct Module {
    id: String,
    settings: BTreeMap<&'static str, Value>,
    secrets: Value,
}
struct Handoff {
    world_id: String,
    packs: BTreeMap<String, Vec<u8>>,
    registration: Value,
    modules: Vec<Module>,
    credentials: Vec<Vec<u8>>,
}

fn uuid(id: &str) -> bool {
    id.len() == 36
        && id.split('-').map(str::len).eq([8, 4, 4, 4, 12])
        && id.bytes().all(|b| b == b'-' || b.is_ascii_hexdigit())
}

fn world_name(world: &str) -> Result<()> {
    ensure!(
        !world.is_empty()
            && world.len() <= 128
            && !matches!(world, "." | "..")
            && !world.ends_with([' ', '.'])
            && world
                .chars()
                .all(|c| !c.is_control() && !"<>:\"/\\|?*".contains(c)),
        "E_CONFIG_INVALID: --world must be a single safe BDS folder name (1-128 UTF-8 bytes)"
    );
    Ok(())
}

fn archive_name(name: &str) -> Result<()> {
    crate::resources::safe_relative(name)?;
    ensure!(
        name.len() <= 512
            && name.split('/').all(|part| {
                !part.is_empty()
                    && part != "."
                    && part != ".."
                    && part.len() <= 255
                    && !part.ends_with([' ', '.'])
                    && !part
                        .chars()
                        .any(|c| c.is_control() || "<>:\"|?*".contains(c))
            }),
        "E_STATE_UNSAFE: unsafe ZIP entry name"
    );
    Ok(())
}

// Reject aliases and symlinks before opening anything, including output parents.
fn safe_path(path: &Path) -> Result<PathBuf> {
    ensure!(
        !path.as_os_str().is_empty()
            && !path.components().any(|c| matches!(c, Component::ParentDir)),
        "E_STATE_UNSAFE: parent traversal or empty path"
    );
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(m) => ensure!(
                !m.file_type().is_symlink(),
                "E_STATE_UNSAFE: symlink in integration path"
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(absolute)
}

fn read(path: &Path, limit: usize) -> Result<Vec<u8>> {
    safe_path(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(path)?;
    let m = file.metadata()?;
    ensure!(
        m.is_file() && m.len() <= limit as u64,
        "E_STATE_UNSAFE: unsafe or oversized integration input"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            m.nlink() == 1,
            "E_STATE_UNSAFE: hardlinked integration input"
        );
    }
    let mut bytes = Vec::new();
    (&mut file).take(limit as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= limit,
        "E_STATE_UNSAFE: oversized integration input"
    );
    Ok(bytes)
}

fn parse(bytes: &[u8]) -> Result<Value> {
    // serde's default recursion limit stays enabled; errors can contain input values.
    serde_json::from_slice(bytes).map_err(|_| {
        anyhow::anyhow!("E_CONFIG_INVALID: malformed integration JSON (details redacted)")
    })
}
fn object(path: &Path, optional: bool) -> Result<Value> {
    safe_path(path)?;
    let value = if optional && !path.try_exists()? {
        json!({})
    } else {
        parse(&read(path, JSON_LIMIT)?)?
    };
    ensure!(
        value.is_object(),
        "E_CONFIG_INVALID: integration settings require a JSON object"
    );
    Ok(value)
}

fn installed_secrets(path: &Path) -> Result<Value> {
    safe_path(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Panels may own this file under a different service UID. Restrict
        // access without applying the deployment operator's ownership rules.
        ensure!(
            fs::symlink_metadata(path)?.permissions().mode() & 0o077 == 0,
            "E_STATE_UNSAFE: installed secrets permit group/other access (redacted)"
        );
    }
    object(path, false)
}

// Bound the immutable tree before the existing preparation validator hashes it.
fn bound_tree(root: &Path, depth: usize, count: &mut usize, size: &mut u64) -> Result<()> {
    ensure!(depth <= 32, "E_STATE_UNSAFE: integration tree too deep");
    let m = fs::symlink_metadata(root)?;
    ensure!(
        m.is_dir() && !m.file_type().is_symlink(),
        "E_STATE_UNSAFE: unsafe integration directory"
    );
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        *count += 1;
        ensure!(
            *count <= 65536,
            "E_STATE_UNSAFE: too many integration inputs"
        );
        let m = fs::symlink_metadata(&path)?;
        if m.is_dir() {
            bound_tree(&path, depth + 1, count, size)?;
        } else {
            ensure!(
                m.is_file() && !m.file_type().is_symlink(),
                "E_STATE_UNSAFE: special integration input"
            );
            *size += m.len();
            ensure!(
                *size <= 512 * 1024 * 1024,
                "E_STATE_UNSAFE: integration inputs exceed 512 MiB"
            );
        }
    }
    Ok(())
}

fn handoff(root: &Path) -> Result<Handoff> {
    safe_path(root)?;
    safe_path(&root.join("prepared"))?;
    let mut count = 0;
    let mut size = 0;
    for dir in ["public", "gateway", "bds-handoff"] {
        bound_tree(&root.join("prepared").join(dir), 0, &mut count, &mut size)?;
    }
    let record = prepare::load(root)
        .map_err(|_| anyhow::anyhow!("E_RESOURCE_MISMATCH: prepared deployment identity/inventory validation failed (details redacted)"))?;
    let (_, lock) = init::load(root).map_err(|_| {
        anyhow::anyhow!("E_RESOURCE_MISMATCH: deployment validation failed (details redacted)")
    })?;
    let dir = root.join("prepared/bds-handoff");
    let registration = parse(&read(&dir.join("world-pack-entries.json"), JSON_LIMIT)?)?;
    validate_registration(&registration)?;
    let entries = registration.as_array().unwrap();
    ensure!(
        entries.len()
            == usize::from(record.features.players) + usize::from(record.features.terrain),
        "E_RESOURCE_MISMATCH: enabled pack count differs"
    );
    let mut result = Handoff {
        world_id: record.world_id,
        packs: BTreeMap::new(),
        registration: registration.clone(),
        modules: Vec::new(),
        credentials: Vec::new(),
    };
    for name in lock.secret_sha256.keys() {
        result
            .credentials
            .push(files::read_private(&root.join("secrets").join(name), 128)?);
    }
    let mut expected = BTreeSet::from([
        "world-pack-entries.json".to_owned(),
        "README.txt".to_owned(),
    ]);
    let mut modules = BTreeSet::new();
    for entry in entries {
        let id = entry["pack_id"].as_str().unwrap();
        let pack = dir.join("packs").join(id);
        let manifest = parse(&read(&pack.join("manifest.json"), JSON_LIMIT)?)?;
        ensure!(
            manifest["header"]["uuid"] == id && manifest["header"]["version"] == entry["version"],
            "E_RESOURCE_MISMATCH: pack identity differs"
        );
        let scripts: Vec<_> = manifest["modules"]
            .as_array()
            .context("E_RESOURCE_MISMATCH: missing pack modules")?
            .iter()
            .filter(|v| v["type"] == "script")
            .collect();
        ensure!(
            scripts.len() == 1,
            "E_RESOURCE_MISMATCH: expected one script module"
        );
        let module = scripts[0]["uuid"]
            .as_str()
            .context("E_RESOURCE_MISMATCH: missing module UUID")?;
        ensure!(
            uuid(module) && module != id && modules.insert(module.to_owned()),
            "E_RESOURCE_MISMATCH: invalid or duplicate module UUID"
        );
        for (relative, hash) in &record.immutable_files {
            if let Some(name) = relative.strip_prefix(&format!("bds-handoff/packs/{id}/")) {
                crate::resources::safe_relative(name)?;
                ensure!(
                    !name
                        .split('/')
                        .any(|p| p == "secrets.json" || p.ends_with(".token")),
                    "E_STATE_UNSAFE: private file in compiled pack"
                );
                let bytes = read(&pack.join(name), FILE_LIMIT)?;
                ensure!(
                    files::digest(&bytes) == *hash,
                    "E_INPUT_CHANGED: compiled pack changed"
                );
                expected.insert(format!("packs/{id}/{name}"));
                result
                    .packs
                    .insert(format!("behavior_packs/{id}/{name}"), bytes);
            }
        }
        let mut settings = BTreeMap::new();
        for file in ["variables.json", "permissions.json"] {
            expected.insert(format!("config/{module}/{file}"));
            settings.insert(
                file,
                object(&dir.join("config").join(module).join(file), false)?,
            );
        }
        let variables = &settings["variables.json"];
        ensure!(
            variables["world_id"] == result.world_id
                && variables
                    .get("generation")
                    .is_none_or(|v| Some(v.as_str().unwrap_or("")) == record.generation.as_deref()),
            "E_RESOURCE_MISMATCH: module world/generation differs"
        );
        expected.insert(format!("config/{module}/runtime-requirements.json"));
        expected.insert(format!("config/{module}/secrets.json"));
        let secrets = object(&dir.join("config").join(module).join("secrets.json"), false)?;
        ensure!(
            secrets.as_object().unwrap().len() == 1,
            "E_RESOURCE_MISMATCH: unexpected credential keys"
        );
        for (key, value) in secrets.as_object().unwrap() {
            let name = match key.as_str() {
                "tracker_token" if record.features.players => "players.token",
                "terrain_token" if record.features.terrain => "terrain.token",
                _ => anyhow::bail!("E_RESOURCE_MISMATCH: unexpected credential key"),
            };
            ensure!(
                value.as_str().is_some_and(
                    |v| lock.secret_sha256.get(name) == Some(&files::digest(v.as_bytes()))
                ),
                "E_RESOURCE_MISMATCH: handoff credential differs (redacted)"
            );
        }
        result.modules.push(Module {
            id: module.to_owned(),
            settings,
            secrets,
        });
    }
    let actual: BTreeSet<_> = record
        .immutable_files
        .keys()
        .filter_map(|p| p.strip_prefix("bds-handoff/").map(str::to_owned))
        .collect();
    ensure!(
        actual == expected,
        "E_RESOURCE_MISMATCH: unexpected handoff inventory"
    );
    Ok(result)
}

fn validate_registration(value: &Value) -> Result<()> {
    let entries = value
        .as_array()
        .context("E_CONFIG_INVALID: pack registration requires an array")?;
    ensure!(
        entries.len() <= 1024,
        "E_CONFIG_INVALID: too many registered packs"
    );
    let mut seen = BTreeSet::new();
    for entry in entries {
        let id = entry["pack_id"]
            .as_str()
            .context("E_CONFIG_INVALID: missing pack UUID")?;
        ensure!(
            uuid(id)
                && seen.insert(id.to_ascii_lowercase())
                && entry["version"]
                    .as_array()
                    .is_some_and(|v| v.len() == 3 && v.iter().all(|n| n.as_u64().is_some())),
            "E_CONFIG_INVALID: invalid or duplicate pack registration"
        );
    }
    Ok(())
}

fn server(root: &Path, world: &str) -> Result<PathBuf> {
    let root = safe_path(root)?;
    ensure!(
        root.is_dir(),
        "E_CONFIG_INVALID: BDS root is not a directory"
    );
    let raw = read(&root.join("server.properties"), 64 * 1024)?;
    let text = std::str::from_utf8(&raw)
        .map_err(|_| anyhow::anyhow!("E_CONFIG_INVALID: invalid BDS server.properties"))?;
    let levels: Vec<_> = text
        .lines()
        .filter_map(|line| line.trim().split_once('='))
        .filter(|(k, _)| k.trim() == "level-name")
        .map(|(_, v)| v.trim())
        .collect();
    ensure!(
        levels == [world],
        "E_CONFIG_INVALID: --world must match the single level-name in BDS server.properties"
    );
    let selected = safe_path(&root.join("worlds").join(world))?;
    ensure!(
        selected.is_dir(),
        "E_CONFIG_INVALID: selected BDS world directory is missing"
    );
    Ok(root)
}

fn registration(root: Option<&Path>, world: &str) -> Result<Value> {
    let Some(root) = root else {
        return Ok(json!([]));
    };
    let path = root
        .join("worlds")
        .join(world)
        .join("world_behavior_packs.json");
    safe_path(&path)?;
    let value = if path.try_exists()? {
        parse(&read(&path, JSON_LIMIT)?)?
    } else {
        json!([])
    };
    validate_registration(&value)?;
    Ok(value)
}

// Objects merge recursively by owned keys; permission arrays retain unrelated
// module grants. Export replaces the owned server-net HTTP block separately.
fn merge(actual: &mut Value, required: &Value, permissions: bool) {
    match (actual, required) {
        (Value::Object(a), Value::Object(r)) => {
            for (key, value) in r {
                if let Some(existing) = a.get_mut(key) {
                    merge(existing, value, permissions);
                } else {
                    a.insert(key.clone(), value.clone());
                }
            }
        }
        (Value::Array(a), Value::Array(r)) if permissions => {
            for value in r {
                if !a.contains(value) {
                    a.push(value.clone());
                }
            }
        }
        (a, r) => *a = r.clone(),
    }
}

fn contains(actual: &Value, required: &Value, permissions: bool) -> bool {
    match (actual, required) {
        (Value::Object(a), Value::Object(r)) => r
            .iter()
            .all(|(key, value)| a.get(key).is_some_and(|v| contains(v, value, permissions))),
        (Value::Array(a), Value::Array(r)) if permissions => {
            r.iter().all(|value| a.contains(value))
        }
        (a, r) => a == r,
    }
}

fn destination(path: &Path, deploy: &Path, bds: Option<&Path>) -> Result<PathBuf> {
    let path = safe_path(path)?;
    let parent = path
        .parent()
        .context("E_CONFIG_INVALID: output parent required")?;
    ensure!(
        parent.is_dir() && !path.try_exists()?,
        "E_STATE_UNSAFE: output must be new, with an existing parent"
    );
    let resolved = parent.canonicalize()?.join(
        path.file_name()
            .context("E_CONFIG_INVALID: output name required")?,
    );
    ensure!(
        !resolved.starts_with(deploy.canonicalize()?)
            && bds.is_none_or(|b| !resolved.starts_with(b)),
        "E_STATE_UNSAFE: outputs must be outside deployment and BDS directories"
    );
    Ok(resolved)
}

/// Creates a new ZIP and optional separate owner-private credentials. Without
/// a server baseline, registration/settings/credentials are merge templates;
/// only compiled packs use installation paths. No installation.
pub fn export_bds(
    root: &Path,
    output: &Path,
    world: &str,
    server_dir: Option<&Path>,
    secrets_dir: Option<&Path>,
) -> Result<Export> {
    world_name(world)?;
    let handoff = handoff(root)?;
    let bds = server_dir.map(|p| server(p, world)).transpose()?;
    let template = bds.is_none();
    let prefix = if template {
        format!("{TEMPLATE_DIR}/")
    } else {
        String::new()
    };
    let output = destination(output, root, bds.as_deref())?;
    let private = secrets_dir
        .map(|p| destination(p, root, bds.as_deref()))
        .transpose()?;
    ensure!(
        private
            .as_ref()
            .is_none_or(|p| p != &output && !output.starts_with(p) && !p.starts_with(&output)),
        "E_STATE_UNSAFE: ZIP and private output must be separate"
    );
    let mut entries = handoff.packs;
    let mut registered = registration(bds.as_deref(), world)?;
    for required in handoff.registration.as_array().unwrap() {
        let list = registered.as_array_mut().unwrap();
        if let Some(existing) = list.iter_mut().find(|v| {
            v["pack_id"]
                .as_str()
                .unwrap()
                .eq_ignore_ascii_case(required["pack_id"].as_str().unwrap())
        }) {
            existing["version"] = required["version"].clone();
        } else {
            list.push(required.clone());
        }
    }
    entries.insert(
        if template {
            format!("{TEMPLATE_DIR}/world-pack-entries.json")
        } else {
            format!("worlds/{world}/world_behavior_packs.json")
        },
        serde_json::to_vec_pretty(&registered)?,
    );
    if template {
        entries.insert(format!("{TEMPLATE_DIR}/README.txt"), format!(
            "TEMPLATE EXPORT: MERGE REQUIRED\nBDS only. Target world folder: {world}\n\nCompiled behavior_packs/ directories may be copied into the server root.\nMerge world-pack-entries.json into worlds/{world}/world_behavior_packs.json by pack UUID/version, preserving unrelated packs.\nMerge config/<module-uuid>/variables.json and permissions.json into the server's corresponding module configuration by owned keys, preserving unrelated settings and module grants. Replace the owned module_permissions['@minecraft/server-net'] HTTP block exactly with the template.\nCredentials are excluded from this ZIP. If --secrets-dir was selected, merge its separate MERGE_REQUIRED_TEMPLATES/config/<module-uuid>/secrets.json by key, preserving unrelated secrets; keep installed secrets private.\nThese templates do not inspect an existing server. Use --server-dir to export merged files against its current registration/settings instead.\nReview and copy merged files, then restart through guarded maintenance or the server panel. No BDS files or experiment metadata were changed; test Beta APIs/runtime compatibility on a backed-up test world first.\n"
        ).into_bytes());
    }
    let mut secrets = BTreeMap::new();
    for module in &handoff.modules {
        for (file, required) in &module.settings {
            let relative = format!("config/{}/{file}", module.id);
            let mut actual = if let Some(bds) = &bds {
                object(&bds.join(&relative), true)?
            } else {
                json!({})
            };
            merge(&mut actual, required, *file == "permissions.json");
            if *file == "permissions.json" {
                actual["module_permissions"][HTTP_MODULE] =
                    required["module_permissions"][HTTP_MODULE].clone();
            }
            entries.insert(
                format!("{prefix}{relative}"),
                serde_json::to_vec_pretty(&actual)?,
            );
        }
        if private.is_some() {
            let relative = format!("config/{}/secrets.json", module.id);
            let mut actual = if let Some(bds) = &bds {
                object(&bds.join(&relative), true)?
            } else {
                json!({})
            };
            merge(&mut actual, &module.secrets, false);
            secrets.insert(
                format!("{prefix}{relative}"),
                serde_json::to_vec_pretty(&actual)?,
            );
        }
    }
    let mut names = BTreeSet::new();
    for (name, bytes) in &entries {
        archive_name(name)?;
        ensure!(
            names.insert(name.to_lowercase()),
            "E_STATE_UNSAFE: ambiguous ZIP entry names"
        );
        ensure!(
            handoff
                .credentials
                .iter()
                .all(|secret| !bytes.windows(secret.len()).any(|part| part == secret)),
            "E_STATE_UNSAFE: credential in nonsecret export (redacted)"
        );
    }
    // Stage both outputs before publishing. persist_noclobber/create_dir never
    // overwrite an existing destination, even if it appeared after validation.
    let mut staged = tempfile::NamedTempFile::new_in(output.parent().unwrap())?;
    {
        let mut zip = zip::ZipWriter::new(staged.as_file_mut());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for (name, bytes) in &entries {
            zip.start_file(name, options)?;
            zip.write_all(bytes)?;
        }
        zip.finish()?;
    }
    staged.as_file().sync_all()?;
    // Private directory creation is exclusive; clean up only our own directory
    // if ZIP publication fails. Never remove a pre-existing operator output.
    if let Some(private) = &private {
        files::mkdir(private)?;
        let write = (|| -> Result<()> {
            for (name, bytes) in &secrets {
                let path = private.join(name);
                fs::create_dir_all(path.parent().unwrap())?;
                files::write_new(&path, bytes)?;
            }
            files::make_private(private)?;
            Ok(())
        })();
        if let Err(error) = write {
            fs::remove_dir_all(private)?;
            return Err(error);
        }
    }
    if let Err(error) = staged.persist_noclobber(&output) {
        if let Some(private) = &private {
            fs::remove_dir_all(private)?;
        }
        return Err(error.error.into());
    }
    Ok(Export {
        world_id: handoff.world_id,
        world: world.into(),
        mode: if template { "template" } else { "merged" },
        files: entries.into_keys().collect(),
        private_files: secrets.into_keys().collect(),
        notice: if template { TEMPLATE_NOTICE } else { NOTICE },
    })
}

/// Reads only pack files and selected JSON/properties inputs; never LevelDB,
/// Docker, experiment metadata, or subprocesses. Values are never diagnostics.
pub fn check_bds(root: &Path, server_dir: &Path, world: &str) -> Result<Report> {
    world_name(world)?;
    let handoff = handoff(root)?;
    let mut report = Report {
        world_id: handoff.world_id,
        world: world.into(),
        checks: Vec::new(),
        notice: NOTICE,
    };
    let bds = server(server_dir, world);
    let valid = bds.is_ok();
    report.check(
        "bds.world",
        world.into(),
        bds.as_ref()
            .map(|_| ())
            .map_err(|_| anyhow::anyhow!("world validation failed")),
    );
    if !valid {
        return Ok(report);
    }
    let bds = bds?;
    for (relative, expected) in &handoff.packs {
        report.check(
            "bds.pack_file",
            relative.clone(),
            read(&bds.join(relative), FILE_LIMIT).and_then(|actual| {
                ensure!(actual == *expected, "pack differs");
                Ok(())
            }),
        );
    }
    let pack_dirs: BTreeSet<_> = handoff
        .packs
        .keys()
        .filter_map(|p| {
            p.strip_prefix("behavior_packs/")?
                .split_once('/')
                .map(|(id, _)| id)
        })
        .collect();
    for id in pack_dirs {
        report.check(
            "bds.pack_inventory",
            format!("behavior_packs/{id}"),
            (|| -> Result<()> {
                let dir = safe_path(&bds.join("behavior_packs").join(id))?;
                bound_tree(&dir, 0, &mut 0, &mut 0)?;
                let actual = files::inventory(&dir)?;
                let prefix = format!("behavior_packs/{id}/");
                let expected: BTreeMap<_, _> = handoff
                    .packs
                    .iter()
                    .filter_map(|(p, bytes)| {
                        p.strip_prefix(&prefix)
                            .map(|name| (name.to_owned(), files::digest(bytes)))
                    })
                    .collect();
                ensure!(actual == expected, "installed pack inventory differs");
                Ok(())
            })(),
        );
    }
    report.check(
        "bds.registration",
        format!("worlds/{world}/world_behavior_packs.json"),
        registration(Some(&bds), world).and_then(|actual| {
            ensure!(
                handoff
                    .registration
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|r| actual.as_array().unwrap().iter().any(|a| a["pack_id"]
                        .as_str()
                        .unwrap()
                        .eq_ignore_ascii_case(r["pack_id"].as_str().unwrap())
                        && a["version"] == r["version"])),
                "registration differs"
            );
            Ok(())
        }),
    );
    for module in &handoff.modules {
        for (file, required) in module
            .settings
            .iter()
            .map(|(f, v)| (*f, v))
            .chain(std::iter::once(("secrets.json", &module.secrets)))
        {
            let relative = format!("config/{}/{file}", module.id);
            let path = bds.join(&relative);
            let actual = if file == "secrets.json" {
                installed_secrets(&path)
            } else {
                object(&path, false)
            };
            report.check(
                if file == "secrets.json" {
                    "bds.secrets"
                } else {
                    "bds.settings"
                },
                relative.clone(),
                actual.and_then(|actual| {
                    ensure!(
                        contains(&actual, required, file == "permissions.json")
                            && (file != "permissions.json"
                                || actual["module_permissions"][HTTP_MODULE]
                                    == required["module_permissions"][HTTP_MODULE]),
                        "settings differ"
                    );
                    Ok(())
                }),
            );
        }
    }
    Ok(report)
}
