#![cfg(unix)]
use bedrock_map::{
    deploy::{
        config::Config,
        init, integration, prepare,
        release::{Image, Release},
    },
    resources::Resources,
    state::State,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
};

const PACK: &str = "f65ed125-b319-4a16-975a-f7556db11360";
const MODULE: &str = "9b918705-25a3-430e-9a4f-c4cd7abbfcda";
const OTHER: &str = "01234567-89ab-cdef-0123-456789abcdef";
const WORLD: &str = "Fixture World";
const TEMPLATES: &str = "MERGE_REQUIRED_TEMPLATES";

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn inventory(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                out.insert(
                    path.strip_prefix(root).unwrap().to_str().unwrap().into(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}
fn write_json(path: &Path, value: Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}
fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn unzip(path: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let mut files = BTreeMap::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).unwrap();
        assert!(entry.enclosed_name().is_some());
        assert_eq!(entry.unix_mode().unwrap() & 0o170000, 0o100000);
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        assert!(files.insert(entry.name().into(), bytes).is_none());
    }
    files
}

struct Fixture {
    _temp: tempfile::TempDir,
    base: PathBuf,
    deploy: PathBuf,
    bds: PathBuf,
    source: State,
    resources: Resources,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        // macOS /var is an OS alias; integration rejects symlink path components.
        let base = temp.path().canonicalize().unwrap();
        let deploy = base.join("deploy");
        let source = State::new(base.join("snapshot")).unwrap();
        source.init().unwrap();
        let public = source.staging().join("candidate/public");
        surface_cli::create_synthetic_fixture(&public).unwrap();
        let mut manifest: surface_core::MapManifest =
            serde_json::from_value(read_json(&public.join("manifest.json"))).unwrap();
        for m in manifest.materials.iter_mut().skip(1) {
            m.key = json!([format!("minecraft:{}", m.name.to_lowercase()), {}]).to_string();
        }
        manifest.catalog_version = digest(&serde_json::to_vec(&manifest.materials).unwrap());
        manifest.source_sha256 = digest(b"synthetic BDS integration fixture");
        fs::write(
            public.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        source
            .register_staged_dataset(&public, manifest.source_sha256, false)
            .unwrap();
        let package = base.join("package");
        let resource_root = package.join("share/bedrock-surface-map");
        fs::create_dir_all(resource_root.join("web")).unwrap();
        fs::write(
            resource_root.join("web/index.html"),
            "<title>Synthetic</title>",
        )
        .unwrap();
        write_json(
            &resource_root.join("packs/tracking/manifest.json"),
            json!({
                "header":{"uuid":PACK,"version":[1,0,4]}, "modules":[{"type":"script","uuid":MODULE}],
                "dependencies":[{"module_name":"@minecraft/server","version":"2.9.0"},{"module_name":"@minecraft/server-net","version":"1.0.0-beta"},{"module_name":"@minecraft/server-admin","version":"1.0.0-beta"}]
            }),
        );
        fs::create_dir_all(resource_root.join("packs/tracking/scripts")).unwrap();
        fs::write(
            resource_root.join("packs/tracking/scripts/main.js"),
            "// synthetic compiled fixture\n",
        )
        .unwrap();
        let common =
            serde_json::to_vec(&json!({"schema_version":1,"commit":"a".repeat(40),"files":[]}))
                .unwrap();
        fs::create_dir_all(resource_root.join("provenance")).unwrap();
        fs::write(
            resource_root.join("provenance/common-manifest.json"),
            &common,
        )
        .unwrap();
        let files: Vec<_> = inventory(&package)
            .into_iter()
            .map(|(path, bytes)| json!({"path":path,"bytes":bytes.len(),"sha256":digest(&bytes)}))
            .collect();
        write_json(
            &package.join("release-manifest.json"),
            json!({"schema_version":1,"application_version":env!("CARGO_PKG_VERSION"),"commit":"a".repeat(40),"target":"x86_64-unknown-linux-musl","files":files}),
        );
        let image = |name: &str| Image {
            repository: format!("registry.example.test/{name}"),
            index_digest: format!("sha256:{}", "a".repeat(64)),
            manifests: BTreeMap::from([
                ("amd64".into(), format!("sha256:{}", "b".repeat(64))),
                ("arm64".into(), format!("sha256:{}", "c".repeat(64))),
            ]),
        };
        let release = Release {
            schema_version: 1,
            application_version: env!("CARGO_PKG_VERSION").into(),
            commit: "a".repeat(40),
            common_sha256: digest(&common),
            registry_verified: true,
            runtime: image("runtime"),
            gateway: image("gateway"),
        };
        write_json(
            &package.join("deployment-release.json"),
            serde_json::to_value(&release).unwrap(),
        );
        let config = Config::parse("schema_version=1\nproject='fixture-map'\npublic_origin='https://map.example.test'\ningest_bind='10.20.0.10'\nbds_source_ipv4='10.20.0.20'\n[features]\nplayers=true\n[viewer]\naccess='public'\nacknowledge_public_locations=true\n").unwrap();
        init::initialize(&deploy, &config, &release, None).unwrap();
        let resources = Resources::discover(Some(resource_root)).unwrap();
        prepare::prepare(&deploy, &source, &resources, None).unwrap();
        let bds = base.join("bds");
        fs::create_dir_all(bds.join("worlds").join(WORLD)).unwrap();
        fs::write(
            bds.join("server.properties"),
            format!("# synthetic\nlevel-name={WORLD}\n"),
        )
        .unwrap();
        // A trap: these must remain opaque; no experiment or live database reads.
        fs::create_dir_all(bds.join("worlds").join(WORLD).join("db")).unwrap();
        fs::write(
            bds.join("worlds").join(WORLD).join("db/LOCK"),
            "do not open",
        )
        .unwrap();
        Self {
            _temp: temp,
            base,
            deploy,
            bds,
            source,
            resources,
        }
    }
    fn export(&self, name: &str, merged: bool, private: bool) -> (PathBuf, PathBuf) {
        let zip = self.base.join(format!("{name}.zip"));
        let secrets = self.base.join(format!("{name}-private"));
        let report = integration::export_bds(
            &self.deploy,
            &zip,
            WORLD,
            merged.then_some(self.bds.as_path()),
            private.then_some(secrets.as_path()),
        )
        .unwrap();
        assert_eq!(report.mode, if merged { "merged" } else { "template" });
        (zip, secrets)
    }
    fn install_fixture(&self) {
        let (zip, private) = self.export("installed", true, true);
        self.install_export(&zip, &private);
    }
    fn install_export(&self, zip: &Path, private: &Path) {
        for (relative, bytes) in unzip(zip).into_iter().chain(inventory(private)) {
            let path = self.bds.join(&relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            if relative.ends_with("/secrets.json") {
                fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
    }
    fn module(&self, file: &str) -> PathBuf {
        self.bds.join("config").join(MODULE).join(file)
    }
    fn registration(&self) -> PathBuf {
        self.bds
            .join("worlds")
            .join(WORLD)
            .join("world_behavior_packs.json")
    }
}

#[test]
fn zip_inventory_private_credentials_and_idempotent_preparation() {
    let f = Fixture::new();
    write_json(
        &f.registration(),
        json!([{"pack_id":OTHER,"version":[1,2,3]}]),
    );
    write_json(&f.module("variables.json"), json!({"custom":"unrelated"}));
    write_json(
        &f.module("secrets.json"),
        json!({"other_secret":"unrelated-private-value"}),
    );
    let before = inventory(&f.bds);
    let prepared = inventory(&f.deploy);
    let (zip, private) = f.export("first", false, true);
    let files = unzip(&zip);
    assert_eq!(
        files.keys().cloned().collect::<Vec<_>>(),
        [
            format!("{TEMPLATES}/README.txt"),
            format!("{TEMPLATES}/config/{MODULE}/permissions.json"),
            format!("{TEMPLATES}/config/{MODULE}/variables.json"),
            format!("{TEMPLATES}/world-pack-entries.json"),
            format!("behavior_packs/{PACK}/manifest.json"),
            format!("behavior_packs/{PACK}/scripts/main.js"),
        ]
    );
    assert!(
        files
            .keys()
            .all(|p| !p.starts_with("worlds/") && !p.starts_with("config/"))
    );
    assert!(
        inventory(&private)
            .keys()
            .all(|p| p.starts_with(&format!("{TEMPLATES}/")))
    );
    let readme = std::str::from_utf8(&files[&format!("{TEMPLATES}/README.txt")]).unwrap();
    assert!(readme.contains("MERGE REQUIRED") && readme.contains(WORLD));
    assert_eq!(
        serde_json::from_slice::<Value>(&files[&format!("{TEMPLATES}/world-pack-entries.json")])
            .unwrap(),
        json!([{"pack_id":PACK,"version":[1,0,4]}])
    );
    let token = fs::read(f.deploy.join("secrets/players.token")).unwrap();
    for (name, bytes) in &files {
        assert!(!name.contains("secrets") && !name.contains(".token"));
        assert!(!bytes.windows(token.len()).any(|v| v == token));
    }
    assert_eq!(
        read_json(&private.join(format!("{TEMPLATES}/config/{MODULE}/secrets.json")))["tracker_token"]
            .as_str()
            .unwrap()
            .as_bytes(),
        token
    );
    assert_eq!(
        fs::metadata(&private).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for name in inventory(&private).keys() {
        let path = private.join(name);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    let (second, omitted) = f.export("second", false, false);
    assert!(!omitted.exists());
    assert_eq!(fs::read(zip).unwrap(), fs::read(second).unwrap());
    prepare::prepare(&f.deploy, &f.source, &f.resources, None).unwrap();
    assert_eq!(inventory(&f.bds), before);
    assert_eq!(inventory(&f.deploy), prepared);
}

#[test]
fn merged_registration_settings_and_secrets_preserve_unrelated_values() {
    let f = Fixture::new();
    write_json(
        &f.registration(),
        json!([{"pack_id":OTHER,"version":[9,8,7],"keep":true},{"pack_id":PACK,"version":[0,0,1],"extra":"kept"}]),
    );
    write_json(
        &f.module("variables.json"),
        json!({"world_id":"old","custom":{"keep":1}}),
    );
    write_json(
        &f.module("permissions.json"),
        json!({"allowed_modules":["custom/module"],"module_permissions":{"custom/module":{"keep":true},"@minecraft/server-net":{"allowed_uris":["*","http://custom.example.test"],"force_tls":true,"custom":42,"max_body_bytes":1}},"custom":true}),
    );
    write_json(
        &f.module("secrets.json"),
        json!({"tracker_token":"old-owned-token","other_secret":"unrelated-secret-kept"}),
    );
    let before = inventory(&f.bds);
    let (zip, private) = f.export("merge", true, true);
    let files = unzip(&zip);
    let entries: Value =
        serde_json::from_slice(&files[&format!("worlds/{WORLD}/world_behavior_packs.json")])
            .unwrap();
    assert_eq!(
        entries[0],
        json!({"pack_id":OTHER,"version":[9,8,7],"keep":true})
    );
    assert_eq!(entries[1]["version"], json!([1, 0, 4]));
    assert_eq!(entries[1]["extra"], "kept");
    let variables: Value =
        serde_json::from_slice(&files[&format!("config/{MODULE}/variables.json")]).unwrap();
    assert_eq!(variables["custom"], json!({"keep":1}));
    assert_ne!(variables["world_id"], "old");
    let permissions: Value =
        serde_json::from_slice(&files[&format!("config/{MODULE}/permissions.json")]).unwrap();
    assert!(
        permissions["allowed_modules"]
            .as_array()
            .unwrap()
            .contains(&json!("custom/module"))
    );
    assert_eq!(
        permissions["module_permissions"]["custom/module"],
        json!({"keep":true})
    );
    let prepared_permissions = read_json(&f.deploy.join(format!(
        "prepared/bds-handoff/config/{MODULE}/permissions.json"
    )));
    assert_eq!(permissions["custom"], true);
    assert_eq!(
        permissions["module_permissions"]["@minecraft/server-net"],
        prepared_permissions["module_permissions"]["@minecraft/server-net"]
    );
    assert_eq!(
        read_json(&private.join(format!("config/{MODULE}/secrets.json")))["other_secret"],
        "unrelated-secret-kept"
    );
    assert!(files.values().all(|bytes| {
        !bytes
            .windows(b"unrelated-secret-kept".len())
            .any(|v| v == b"unrelated-secret-kept")
    }));
    assert_eq!(inventory(&f.bds), before);
    f.install_fixture();
    assert!(
        integration::check_bds(&f.deploy, &f.bds, WORLD)
            .unwrap()
            .ok()
    );
    let (again, _) = f.export("again", true, true);
    assert_eq!(unzip(&zip), unzip(&again));
}

#[test]
fn checker_reports_missing_mismatched_and_secret_failures_without_values() {
    let f = Fixture::new();
    f.install_fixture();
    let before = inventory(&f.bds);
    let pass = integration::check_bds(&f.deploy, &f.bds, WORLD).unwrap();
    assert!(pass.ok());
    assert_eq!(inventory(&f.bds), before);
    let cli = Command::new(env!("CARGO_BIN_EXE_bedrock-map"))
        .env("PATH", "")
        .args(["--json", "deploy", "check-bds", "--dir"])
        .arg(&f.deploy)
        .arg("--server-dir")
        .arg(&f.bds)
        .args(["--world", WORLD])
        .output()
        .unwrap();
    assert!(cli.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&cli.stdout).unwrap()["ok"],
        true
    );
    let unexpected = f
        .bds
        .join(format!("behavior_packs/{PACK}/scripts/unexpected.js"));
    fs::write(&unexpected, b"// unknown executable input").unwrap();
    assert!(
        integration::check_bds(&f.deploy, &f.bds, WORLD)
            .unwrap()
            .checks
            .iter()
            .any(|c| c.id == "bds.pack_inventory" && c.status == "fail")
    );
    fs::remove_file(unexpected).unwrap();
    fs::remove_file(f.bds.join(format!("behavior_packs/{PACK}/manifest.json"))).unwrap();
    fs::write(
        f.bds.join(format!("behavior_packs/{PACK}/scripts/main.js")),
        "changed-private-value",
    )
    .unwrap();
    write_json(
        &f.registration(),
        json!([{"pack_id":PACK,"version":[0,0,1]}]),
    );
    write_json(
        &f.module("secrets.json"),
        json!({"tracker_token":"NEVER_PRINT_THIS_SECRET"}),
    );
    write_json(
        &f.module("variables.json"),
        json!({"world_id":"NEVER_PRINT_THIS_WORLD"}),
    );
    let result = integration::check_bds(&f.deploy, &f.bds, WORLD).unwrap();
    assert!(!result.ok());
    for id in [
        "bds.pack_file",
        "bds.registration",
        "bds.settings",
        "bds.secrets",
    ] {
        assert!(
            result
                .checks
                .iter()
                .any(|c| c.id == id && c.status == "fail")
        );
    }
    let printed = serde_json::to_string(&result).unwrap();
    assert!(!printed.contains("NEVER_PRINT") && !printed.contains("changed-private"));
    fs::remove_file(f.module("secrets.json")).unwrap();
    assert!(
        !integration::check_bds(&f.deploy, &f.bds, WORLD)
            .unwrap()
            .ok()
    );
    fs::write(
        f.module("secrets.json"),
        b"{\"tracker_token\": NEVER_PRINT_INVALID_JSON}",
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_bedrock-map"))
        .args(["--json", "deploy", "check-bds", "--dir"])
        .arg(&f.deploy)
        .arg("--server-dir")
        .arg(&f.bds)
        .args(["--world", WORLD])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    let printed = String::from_utf8(output.stdout).unwrap();
    assert!(!printed.contains("NEVER_PRINT"));
    assert!(serde_json::from_str::<Value>(&printed).is_ok());
}

#[test]
fn checker_requires_exact_owned_http_policy_and_preserves_other_settings() {
    let f = Fixture::new();
    f.install_fixture();
    let path = f.module("permissions.json");
    let mut required = read_json(&path);
    required["custom"] = json!({"keep":true});
    required["module_permissions"]["custom/module"] = json!({"keep":true});
    write_json(&path, required.clone());
    assert!(
        integration::check_bds(&f.deploy, &f.bds, WORLD)
            .unwrap()
            .ok()
    );
    for (key, value) in [
        (
            "allowed_uris",
            json!([
                required["module_permissions"]["@minecraft/server-net"]["allowed_uris"][0],
                "http://custom.example.test"
            ]),
        ),
        ("allowed_uris", json!(["*"])),
        ("force_tls", json!(true)),
        ("force_tls", json!(false)),
        ("custom", json!(42)),
    ] {
        let mut changed = required.clone();
        changed["module_permissions"]["@minecraft/server-net"][key] = value;
        write_json(&path, changed);
        let before = fs::read(&path).unwrap();
        let report = integration::check_bds(&f.deploy, &f.bds, WORLD).unwrap();
        assert!(!report.ok());
        assert!(report.checks.iter().any(|c| c.id == "bds.settings"
            && c.target.ends_with("permissions.json")
            && c.status == "fail"));
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    write_json(&path, required);
    assert!(
        integration::check_bds(&f.deploy, &f.bds, WORLD)
            .unwrap()
            .ok()
    );
}

#[test]
fn checker_requires_installed_secrets_to_exclude_group_and_other_access() {
    let f = Fixture::new();
    f.install_fixture();
    let path = f.module("secrets.json");
    let bytes = fs::read(&path).unwrap();
    let token = read_json(&path)["tracker_token"]
        .as_str()
        .unwrap()
        .to_owned();
    for mode in [
        0o600, 0o400, 0o640, 0o604, 0o620, 0o602, 0o610, 0o601, 0o644, 0o666,
    ] {
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        let report = integration::check_bds(&f.deploy, &f.bds, WORLD).unwrap();
        assert_eq!(report.ok(), mode & 0o077 == 0, "mode {mode:o}");
        assert!(report.checks.iter().any(|c| c.id == "bds.secrets"
            && c.status == if mode & 0o077 == 0 { "pass" } else { "fail" }));
        assert!(!serde_json::to_string(&report).unwrap().contains(&token));
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            mode
        );
    }
}

#[test]
fn unicode_world_names_export_and_check_without_bds_writes() {
    let f = Fixture::new();
    let world = "世界 – Communauté 🌍";
    fs::rename(
        f.bds.join("worlds").join(WORLD),
        f.bds.join("worlds").join(world),
    )
    .unwrap();
    fs::write(
        f.bds.join("server.properties"),
        format!("level-name={world}\n"),
    )
    .unwrap();
    let before = inventory(&f.bds);
    let zip = f.base.join("unicode.zip");
    let private = f.base.join("unicode-private");
    let report =
        integration::export_bds(&f.deploy, &zip, world, Some(&f.bds), Some(&private)).unwrap();
    assert_eq!(report.world, world);
    assert!(unzip(&zip).contains_key(&format!("worlds/{world}/world_behavior_packs.json")));
    assert_eq!(inventory(&f.bds), before);
    f.install_export(&zip, &private);
    let installed = inventory(&f.bds);
    let report = integration::check_bds(&f.deploy, &f.bds, world).unwrap();
    assert!(report.ok());
    assert_eq!(report.world, world);
    assert_eq!(inventory(&f.bds), installed);
}

#[test]
fn wrong_world_paths_symlinks_overwrites_and_modified_preparation_are_refused() {
    let f = Fixture::new();
    let output = f.base.join("new.zip");
    for world in [
        "",
        "../Fixture World",
        "/absolute",
        "a\\b",
        "a/b",
        ".",
        "..",
        "trailing.",
        "trailing ",
        "a<b",
        "a>b",
        "a:b",
        "a\"b",
        "a|b",
        "a?b",
        "a*b",
        "世界\n",
        "世界\0",
        "世界\u{7f}",
    ] {
        assert!(integration::export_bds(&f.deploy, &output, world, Some(&f.bds), None).is_err());
        assert!(integration::export_bds(&f.deploy, &output, world, None, None).is_err());
        assert!(integration::check_bds(&f.deploy, &f.bds, world).is_err());
        assert!(!output.exists());
    }
    assert!(
        integration::export_bds(&f.deploy, &output, "wrong-world", Some(&f.bds), None).is_err()
    );
    assert!(
        !integration::check_bds(&f.deploy, &f.bds, "wrong-world")
            .unwrap()
            .ok()
    );
    assert!(
        integration::export_bds(&f.deploy, &f.bds.join("new.zip"), WORLD, Some(&f.bds), None)
            .is_err()
    );
    assert!(
        integration::export_bds(&f.deploy, &f.deploy.join("new.zip"), WORLD, None, None).is_err()
    );
    let (zip, private) = f.export("exists", false, true);
    let old = fs::read(&zip).unwrap();
    assert!(integration::export_bds(&f.deploy, &zip, WORLD, None, None).is_err());
    assert!(integration::export_bds(&f.deploy, &output, WORLD, None, Some(&private)).is_err());
    assert!(!output.exists());
    assert_eq!(fs::read(zip).unwrap(), old);
    let alias = f.base.join("alias");
    symlink(&f.bds, &alias).unwrap();
    assert!(integration::export_bds(&f.deploy, &output, WORLD, Some(&alias), None).is_err());
    fs::create_dir_all(f.bds.join("config")).unwrap();
    symlink(&private, f.bds.join("config").join(MODULE)).unwrap();
    assert!(integration::export_bds(&f.deploy, &output, WORLD, Some(&f.bds), None).is_err());
    fs::write(
        f.deploy
            .join(format!("prepared/bds-handoff/packs/{PACK}/scripts/main.js")),
        b"tampered",
    )
    .unwrap();
    assert!(integration::export_bds(&f.deploy, &output, WORLD, None, None).is_err());
}

#[test]
fn malformed_bounded_and_duplicate_configuration_is_rejected_without_secret_echo() {
    let f = Fixture::new();
    let output = f.base.join("new.zip");
    let private = f.base.join("new-private");
    for bytes in [
        b"{\"tracker_token\": SECRET_IN_PARSE_ERROR}".to_vec(),
        b"[]".to_vec(),
        vec![b' '; 1024 * 1024 + 1],
        format!("{}0{}", "[".repeat(150), "]".repeat(150)).into_bytes(),
    ] {
        fs::create_dir_all(f.module("secrets.json").parent().unwrap()).unwrap();
        fs::write(f.module("secrets.json"), bytes).unwrap();
        let error =
            integration::export_bds(&f.deploy, &output, WORLD, Some(&f.bds), Some(&private))
                .err()
                .unwrap();
        assert!(!format!("{error:#}").contains("SECRET_IN_PARSE_ERROR"));
        assert!(!output.exists() && !private.exists());
    }
    fs::remove_file(f.module("secrets.json")).unwrap();
    for registration in [
        json!({}),
        json!([{"pack_id":"../unsafe","version":[1,0,0]}]),
        json!([{"pack_id":OTHER,"version":[1,0,0]},{"pack_id":OTHER,"version":[1,0,0]}]),
    ] {
        write_json(&f.registration(), registration);
        assert!(integration::export_bds(&f.deploy, &output, WORLD, Some(&f.bds), None).is_err());
        assert!(!output.exists());
    }
}

#[test]
fn cli_export_is_explicit_private_and_independent_of_resources_or_docker() {
    let f = Fixture::new();
    let before = inventory(&f.bds);
    for merged in [false, true] {
        let mode = if merged { "merged" } else { "template" };
        let output = f.base.join(format!("cli-{mode}.zip"));
        let private = f.base.join(format!("cli-{mode}-private"));
        let mut command = Command::new(env!("CARGO_BIN_EXE_bedrock-map"));
        command
            .env("PATH", "")
            .args(["--json", "deploy", "export-bds", "--dir"])
            .arg(&f.deploy)
            .arg("--output")
            .arg(&output)
            .args(["--world", WORLD]);
        if merged {
            command.arg("--server-dir").arg(&f.bds);
        }
        let cli = command.arg("--secrets-dir").arg(&private).output().unwrap();
        assert!(
            cli.status.success(),
            "{}",
            String::from_utf8_lossy(&cli.stdout)
        );
        let report: Value = serde_json::from_slice(&cli.stdout).unwrap();
        assert_eq!(report["ok"], true);
        assert_eq!(report["mode"], mode);
        assert!(report["notice"].as_str().unwrap().contains("BDS only"));
        let prefix = if merged {
            String::new()
        } else {
            format!("{TEMPLATES}/")
        };
        assert_eq!(
            report["private_files"],
            json!([format!("{prefix}config/{MODULE}/secrets.json")])
        );
        let files = unzip(&output);
        assert!(files.keys().all(|p| !p.contains("secrets")));
        assert_eq!(
            files.contains_key(&format!("worlds/{WORLD}/world_behavior_packs.json")),
            merged
        );
        assert_eq!(
            files.contains_key(&format!("config/{MODULE}/variables.json")),
            merged
        );
        if !merged {
            assert!(report["notice"].as_str().unwrap().contains("TEMPLATE"));
            assert!(
                files
                    .keys()
                    .all(|p| !p.starts_with("worlds/") && !p.starts_with("config/"))
            );
            assert!(
                inventory(&private)
                    .keys()
                    .all(|p| !p.starts_with("worlds/") && !p.starts_with("config/"))
            );
        }
        assert!(
            private
                .join(format!("{prefix}config/{MODULE}/secrets.json"))
                .is_file()
        );
        assert_eq!(inventory(&f.bds), before);
    }
}
