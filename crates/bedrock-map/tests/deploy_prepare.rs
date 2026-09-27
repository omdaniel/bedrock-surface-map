#![cfg(unix)]
#[path = "support/deploy_gateway.rs"]
mod gateway;
use bedrock_map::{
    deploy::{
        config::Config,
        init, launch, prepare,
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
    io::Write,
    path::{Path, PathBuf},
};

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn inventory(root: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                out.insert(
                    path.strip_prefix(root).unwrap().to_str().unwrap().into(),
                    digest(&fs::read(path).unwrap()),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    source: State,
    resources: Resources,
    assets: PathBuf,
}
impl Fixture {
    fn new(terrain: bool, players: bool) -> Self {
        Self::with_access(terrain, players, false)
    }
    fn with_access(terrain: bool, players: bool, public_access: bool) -> Self {
        Self::with_options(terrain, players, public_access, None, None)
    }
    fn with_options(
        terrain: bool,
        players: bool,
        public_access: bool,
        quota: Option<u64>,
        identity: Option<(&str, &str)>,
    ) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("deploy");
        let source = State::new(temp.path().join("snapshot")).unwrap();
        source.init().unwrap();
        let public = source.staging().join("candidate/public");
        surface_cli::create_synthetic_fixture(&public).unwrap();
        let mut manifest: surface_core::MapManifest =
            serde_json::from_slice(&fs::read(public.join("manifest.json")).unwrap()).unwrap();
        // A semantic fixture with Bedrock material keys, not an acceptance claim
        // for the parser. Native acceptance also imports the generated MCWorld.
        for m in manifest.materials.iter_mut().skip(1) {
            m.key = json!([format!("minecraft:{}", m.name.to_lowercase()), {}]).to_string();
        }
        manifest.catalog_version = digest(&serde_json::to_vec(&manifest.materials).unwrap());
        manifest.source_sha256 = digest(b"synthetic deployment surface");
        fs::write(
            public.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        source
            .register_staged_dataset(&public, manifest.source_sha256, false)
            .unwrap();
        let package = temp.path().join("package");
        let resource_root = package.join("share/bedrock-surface-map");
        fs::create_dir_all(resource_root.join("web")).unwrap();
        fs::create_dir_all(resource_root.join("provenance")).unwrap();
        fs::write(
            resource_root.join("web/index.html"),
            "<title>Fixture</title>",
        )
        .unwrap();
        fs::write(
            resource_root.join("web/viewer-config.json"),
            b"{\"map\":\"packaged-default-only\"}",
        )
        .unwrap();
        for (name, header, module) in [
            (
                "tracking",
                "f65ed125-b319-4a16-975a-f7556db11360",
                "9b918705-25a3-430e-9a4f-c4cd7abbfcda",
            ),
            (
                "terrain",
                "c6d731eb-4fe4-48fc-af70-dd559de7693b",
                "4e163ad8-5c87-4738-9173-96e3d7cb5b2e",
            ),
        ] {
            let pack = resource_root.join("packs").join(name);
            fs::create_dir_all(pack.join("scripts")).unwrap();
            fs::write(
                pack.join("manifest.json"),
                serde_json::to_vec(&json!({"header":{"uuid":header,"version":[1,0,4]},
                "modules":[{"type":"script","uuid":module}],
                "dependencies":[
                    {"module_name":"@minecraft/server","version":"2.9.0"},
                    {"module_name":"@minecraft/server-net","version":"1.0.0-beta"},
                    {"module_name":"@minecraft/server-admin","version":"1.0.0-beta"}
                ]}))
                .unwrap(),
            )
            .unwrap();
            fs::write(
                pack.join("scripts/main.js"),
                "// synthetic pack fixture; not executable Bedrock evidence\n",
            )
            .unwrap();
        }
        let common =
            serde_json::to_vec(&json!({"schema_version":1,"commit":"a".repeat(40),"files":[]}))
                .unwrap();
        fs::write(
            resource_root.join("provenance/common-manifest.json"),
            &common,
        )
        .unwrap();
        let files:Vec<_>=inventory(&package).into_iter().map(|(p,h)|json!({"bytes":fs::metadata(package.join(&p)).unwrap().len(),"path":p,"sha256":h})).collect();
        fs::write(
            package.join("release-manifest.json"),
            serde_json::to_vec(
                &json!({"schema_version":1,"application_version":env!("CARGO_PKG_VERSION"),
            "commit":"a".repeat(40),"target":"x86_64-unknown-linux-musl","files":files}),
            )
            .unwrap(),
        )
        .unwrap();
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
        fs::write(
            package.join("deployment-release.json"),
            serde_json::to_vec(&release).unwrap(),
        )
        .unwrap();
        let viewer = if public_access {
            "[viewer]\naccess='public'\nacknowledge_public_locations=true\n"
        } else {
            ""
        };
        let quota = quota
            .map(|limit| format!("terrain_store_limit_bytes={limit}\n"))
            .unwrap_or_default();
        let identity = identity
            .map(|(world, generation)| format!("world_id='{world}'\ngeneration='{generation}'\n"))
            .unwrap_or_default();
        let config=Config::parse(&format!("schema_version=1\nproject='fixture-map'\npublic_origin='https://map.example.test'\ningest_bind='10.20.0.10'\nbds_source_ipv4='10.20.0.20'\n{quota}{identity}[features]\nterrain={terrain}\nplayers={players}\n[terrain_pack]\nview_distance=4\nscan_budget_ms=4\n{viewer}")).unwrap();
        init::initialize(
            &root,
            &config,
            &release,
            (!public_access).then_some("synthetic-only-password"),
        )
        .unwrap();
        let assets = temp.path().join("assets.zip");
        asset_fixture(&assets);
        Self {
            _temp: temp,
            root,
            source,
            resources: Resources::discover(Some(resource_root)).unwrap(),
            assets,
        }
    }
    fn prepare(&self) -> anyhow::Result<prepare::Preparation> {
        let terrain = init::load(&self.root)?.0.features.terrain;
        prepare::prepare(
            &self.root,
            &self.source,
            &self.resources,
            terrain.then_some(self.assets.as_path()),
        )
    }
    fn select_v2(&self, world: &str, generation: &str) {
        let active = self.source.active_validated().unwrap().unwrap();
        let input = self.source.registered(&active.dataset_id).unwrap().unwrap();
        let export = self._temp.path().join("v2-export");
        let mut store =
            surface_sync::store::Store::open(&export, world, generation, 1 << 30).unwrap();
        store.seed(&input, None, None).unwrap();
        let manifest = store.manifest().unwrap();
        fs::write(
            export.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let files = bedrock_map::dataset::validate_inventory(&export).unwrap();
        let operation = self.source.operation("prepare-lod").unwrap();
        let public = operation.path().join("public");
        fs::create_dir_all(&public).unwrap();
        for path in files {
            let destination = public.join(&path);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::copy(export.join(path), destination).unwrap();
        }
        let registered = std::process::Command::new(env!("CARGO_BIN_EXE_bedrock-map"))
            .args(["--json", "--state"])
            .arg(&self.source.root)
            .args(["register", "--snapshot"])
            .arg(&public)
            .arg("--replace-active")
            .output()
            .unwrap();
        assert!(
            registered.status.success(),
            "{} {}",
            String::from_utf8_lossy(&registered.stdout),
            String::from_utf8_lossy(&registered.stderr)
        );
        assert_eq!(
            self.source
                .active_validated()
                .unwrap()
                .unwrap()
                .source_sha256,
            active.source_sha256
        );
    }
}

#[test]
fn v2_deployment_preserves_existing_identity_and_configured_store_quota() {
    let quota = 8 * 1024 * 1024 * 1024;
    let f = Fixture::with_options(
        true,
        true,
        false,
        Some(quota),
        Some(("fixture-world", "fixture-generation")),
    );
    let lock = init::load(&f.root).unwrap().1;
    assert_eq!(lock.generation.as_deref(), Some("fixture-generation"));
    f.select_v2(&lock.world_id, lock.generation.as_deref().unwrap());
    let initial = f.source.active_validated().unwrap().unwrap();
    let unprepared = inventory(&f.source.root);
    let prepare_lod = |budget: &str| {
        std::process::Command::new(env!("CARGO_BIN_EXE_bedrock-map"))
            .args(["--json", "--state"])
            .arg(&f.source.root)
            .args([
                "prepare-lod",
                "--replace-active",
                "--max-output-bytes",
                budget,
            ])
            .output()
            .unwrap()
    };
    assert!(!prepare_lod("1").status.success());
    assert_eq!(inventory(&f.source.root), unprepared);
    assert_eq!(
        f.source.active_validated().unwrap().unwrap().dataset_id,
        initial.dataset_id
    );
    let prepared = prepare_lod("2147483648");
    assert!(
        prepared.status.success(),
        "{} {}",
        String::from_utf8_lossy(&prepared.stdout),
        String::from_utf8_lossy(&prepared.stderr)
    );
    let selected = f.source.active_validated().unwrap().unwrap();
    assert_ne!(selected.dataset_id, initial.dataset_id);
    assert_eq!(selected.source_sha256, initial.source_sha256);
    let before = inventory(&f.source.root);
    let p = f.prepare().unwrap();
    assert_eq!(p.terrain_store_limit_bytes, quota);
    assert_eq!(p.world_id, lock.world_id);
    assert_eq!(p.generation, lock.generation);
    let common = fs::read(f.resources.root.join("provenance/common-manifest.json")).unwrap();
    launch::validate_marker(&p, &"a".repeat(40), &common).unwrap();
    let command = launch::terrain_command(&p).unwrap();
    let args: Vec<_> = command.get_args().map(|s| s.to_str().unwrap()).collect();
    assert!(args.windows(2).any(|a| a == ["--limit", "8589934592"]));
    assert!(
        args.windows(2)
            .any(|a| a == ["--generation", "fixture-generation"])
    );
    assert_eq!(prepare::load(&f.root).unwrap(), p);
    assert_eq!(f.prepare().unwrap(), p);
    assert_eq!(inventory(&f.source.root), before);
    launch::validate_store(&f.root.join("prepared/terrain/current.sqlite3"), &p).unwrap();
    let viewer: Value = serde_json::from_slice(
        &fs::read(f.root.join("prepared/public/viewer-config.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        viewer["terrain"]["lod_url"],
        "/api/v1/worlds/fixture-world/terrain/lod.json"
    );
    assert_eq!(viewer["terrain"]["generation"], "fixture-generation");
    assert_eq!(
        viewer["lod_identity"],
        json!({
            "world_id":"fixture-world", "generation":"fixture-generation"
        })
    );
}

#[test]
fn v2_snapshot_identity_is_emitted_without_enabling_terrain() {
    let f = Fixture::new(false, true);
    let lock = init::load(&f.root).unwrap().1;
    assert!(lock.generation.is_none());
    f.select_v2(&lock.world_id, "snapshot-generation");
    let p = f.prepare().unwrap();
    let viewer: Value = serde_json::from_slice(
        &fs::read(f.root.join("prepared/public/viewer-config.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        viewer["lod_identity"],
        json!({
            "world_id":lock.world_id, "generation":"snapshot-generation"
        })
    );
    assert!(viewer["lod_url"].as_str().unwrap().starts_with("maps/"));
    assert!(viewer.get("terrain").is_none());
    assert_eq!(viewer["players"]["world_id"], lock.world_id);
    assert!(viewer["players"].get("generation").is_none());
    assert!(p.seed_files.is_empty());
    assert!(!f.root.join("prepared/terrain").exists());
    assert!(
        !fs::read_to_string(f.root.join("prepared/gateway/Caddyfile"))
            .unwrap()
            .contains("/terrain/")
    );
}

#[test]
fn v2_deployment_rejects_snapshot_generation_mismatch_before_publication() {
    let f = Fixture::new(true, false);
    let lock = init::load(&f.root).unwrap().1;
    f.select_v2(&lock.world_id, "other-generation");
    let before = inventory(&f.source.root);
    assert!(
        f.prepare()
            .unwrap_err()
            .to_string()
            .contains("snapshot world/generation")
    );
    assert!(!f.root.join("prepared").exists());
    assert_eq!(inventory(&f.source.root), before);
}

#[test]
fn terrain_store_quota_failure_leaves_no_published_preparation() {
    let f = Fixture::with_options(true, false, false, Some(1), None);
    let before = inventory(&f.source.root);
    assert!(
        f.prepare()
            .unwrap_err()
            .to_string()
            .contains("capacity exceeded")
    );
    assert!(!f.root.join("prepared").exists());
    assert!(!fs::read_dir(f.root.join("work")).unwrap().any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("prepare-")
    }));
    assert_eq!(inventory(&f.source.root), before);
}

#[test]
fn missing_preparation_quota_defaults_to_two_gib() {
    let f = Fixture::new(true, false);
    let p = f.prepare().unwrap();
    let marker = f.root.join("prepared/preparation.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .remove("terrain_store_limit_bytes");
    fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(prepare::load(&f.root).unwrap(), p);
    assert_eq!(p.terrain_store_limit_bytes, 2 * 1024 * 1024 * 1024);
    let mut invalid = p;
    invalid.terrain_store_limit_bytes = 0;
    assert!(launch::terrain_command(&invalid).is_err());
    let common = fs::read(f.resources.root.join("provenance/common-manifest.json")).unwrap();
    assert!(launch::validate_marker(&invalid, &"a".repeat(40), &common).is_err());
    invalid.terrain_store_limit_bytes = 8 * 1024 * 1024 * 1024;
    fs::write(&marker, serde_json::to_vec(&invalid).unwrap()).unwrap();
    assert!(
        prepare::load(&f.root)
            .unwrap_err()
            .to_string()
            .contains("quota differs")
    );
}
fn asset_fixture(path: &Path) {
    let mut archive = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let prefix = "bedrock-samples-736072450c26a7c67f07b1661f29d9a5ebaa14b1";
    for (name, bytes) in [
        ("LICENSE.md", b"Synthetic test assets only\n".as_slice()),
        (
            "resource_pack/blocks.json",
            br#"{"grass":{"textures":"grass"}}"#,
        ),
        (
            "resource_pack/textures/terrain_texture.json",
            br#"{"texture_data":{"grass":{"textures":"textures/blocks/grass"}}}"#,
        ),
    ] {
        archive
            .start_file(
                format!("{prefix}/{name}"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all(bytes).unwrap();
    }
    let mut image = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(1, 1, image::Rgba([60, 150, 70, 255]))
        .write_to(&mut image, image::ImageFormat::Png)
        .unwrap();
    archive
        .start_file(
            format!("{prefix}/resource_pack/textures/blocks/grass.png"),
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    archive.write_all(&image.into_inner()).unwrap();
    archive.finish().unwrap();
}

#[test]
fn killed_preparation_never_selects_partial_state() {
    use std::{
        os::unix::process::ExitStatusExt,
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };
    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let fixture = Fixture::new(true, true);
    let before = inventory(&fixture.source.root);
    let mut child = ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_bedrock-map"))
            .arg("--json")
            .arg("--resources")
            .arg(&fixture.resources.root)
            .args(["deploy", "prepare", "--dir"])
            .arg(&fixture.root)
            .arg("--snapshot-state")
            .arg(&fixture.source.root)
            .arg("--assets")
            .arg(&fixture.assets)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "prepare must reach private staging before termination"
        );
        if fs::read_dir(fixture.root.join("work"))
            .unwrap()
            .any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("prepare-")
            })
        {
            child.0.kill().unwrap();
            break;
        }
        assert!(
            Instant::now() < deadline,
            "bounded preparation interruption"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(child.0.wait().unwrap().signal(), Some(libc::SIGKILL));
    assert!(!fixture.root.join("prepared").exists());
    assert_eq!(inventory(&fixture.source.root), before);
    assert!(
        fixture
            .prepare()
            .unwrap_err()
            .to_string()
            .contains("E_STATE_RECOVERY_REQUIRED")
    );
    // Recovery removes only the abandoned operation, never selected state.
    for entry in fs::read_dir(fixture.root.join("work")).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name().to_string_lossy().starts_with("prepare-") {
            fs::remove_dir_all(entry.path()).unwrap();
        }
    }
    fixture.prepare().unwrap();
    assert_eq!(inventory(&fixture.source.root), before);
}

#[test]
fn preparation_preserves_source_and_repeats_without_reseeding() {
    let f = Fixture::new(true, true);
    let before = inventory(&f.source.root);
    let first = f.prepare().unwrap();
    let prepared = inventory(&f.root.join("prepared"));
    let second = f.prepare().unwrap();
    assert_eq!(first, second);
    assert_eq!(prepared, inventory(&f.root.join("prepared")));
    assert_eq!(before, inventory(&f.source.root));
    launch::validate_store(&f.root.join("prepared/terrain/current.sqlite3"), &first).unwrap();
    let common = fs::read(f.resources.root.join("provenance/common-manifest.json")).unwrap();
    launch::validate_marker(&first, &"a".repeat(40), &common).unwrap();
    assert!(launch::validate_marker(&first, &"b".repeat(40), &common).is_err());
    for token in ["players", "terrain"] {
        let token = fs::read_to_string(f.root.join(format!("secrets/{token}.token"))).unwrap();
        for path in inventory(&f.root.join("prepared/public")).keys() {
            let bytes = fs::read(f.root.join("prepared/public").join(path)).unwrap();
            assert!(
                !bytes
                    .windows(token.len())
                    .any(|part| part == token.as_bytes())
            );
        }
    }
    assert_eq!(fs::read_dir(f.root.join("work")).unwrap().count(), 1);
}

#[test]
fn interrupted_private_scratch_is_reported_without_selecting_or_deleting_it() {
    let f = Fixture::new(true, true);
    let before = inventory(&f.source.root);
    let abandoned = f.root.join("work/prepare-interrupted");
    fs::create_dir(&abandoned).unwrap();
    fs::write(
        abandoned.join("partial.sqlite3"),
        b"incomplete private state",
    )
    .unwrap();
    let error = f.prepare().unwrap_err().to_string();
    assert!(error.contains("E_STATE_RECOVERY_REQUIRED"));
    assert!(!f.root.join("prepared").exists());
    assert!(abandoned.join("partial.sqlite3").exists());
    assert_eq!(before, inventory(&f.source.root));
    fs::remove_dir_all(abandoned).unwrap();
    f.prepare().unwrap();
}

#[test]
fn failed_preparation_does_not_publish_partial_state() {
    for case in ["bad-assets", "bad-pack", "invalid-seed-key"] {
        let f = Fixture::new(true, true);
        let before = inventory(&f.source.root);
        match case {
            "bad-assets" => fs::write(&f.assets, "not zip").unwrap(),
            "bad-pack" => {
                let pack = f.resources.root.join("packs/tracking/manifest.json");
                fs::write(&pack, b"{\"header\":{},\"modules\":[]}").unwrap();
                let path = f.resources.release_manifest();
                let mut release: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                let bytes = fs::read(&pack).unwrap();
                for file in release["files"].as_array_mut().unwrap() {
                    if file["path"] == "share/bedrock-surface-map/packs/tracking/manifest.json" {
                        file["bytes"] = json!(bytes.len());
                        file["sha256"] = digest(&bytes).into();
                    }
                }
                fs::write(path, serde_json::to_vec(&release).unwrap()).unwrap();
            }
            "invalid-seed-key" => {
                // Use the ordinary rendered fixture unchanged: its display keys
                // must not be accepted as Bedrock material identities.
                let public = f.source.staging().join("rendered/public");
                surface_cli::create_synthetic_fixture(&public).unwrap();
                let mut m: surface_core::MapManifest =
                    serde_json::from_slice(&fs::read(public.join("manifest.json")).unwrap())
                        .unwrap();
                m.source_sha256 = digest(b"rendered-only fixture");
                fs::write(
                    public.join("manifest.json"),
                    serde_json::to_vec(&m).unwrap(),
                )
                .unwrap();
                f.source
                    .register_staged_dataset(&public, m.source_sha256, true)
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(f.prepare().is_err(), "{case}");
        assert!(!f.root.join("prepared").exists());
        assert!(
            fs::read_dir(f.root.join("work"))
                .unwrap()
                .all(|e| e.unwrap().file_name() == "prepare.lock")
        );
        if case != "invalid-seed-key" {
            assert_eq!(before, inventory(&f.source.root));
        }
    }
}

#[test]
#[ignore = "requires the generated parser fixtures in BEDROCK_MAP_FIXTURE_DIR; never uses a real world"]
fn prepare_imported_generated_world() {
    let inputs = PathBuf::from(
        std::env::var_os("BEDROCK_MAP_FIXTURE_DIR").expect("generated fixture directory required"),
    );
    let f = Fixture::new(true, true);
    let operation = f.source.operation("import").unwrap();
    let public = operation.path().join("public");
    let report = surface_cli::import_snapshot(&surface_cli::ImportOptions {
        input_archive: inputs.join("generated.mcworld"),
        output_directory: public.clone(),
        scratch_directory: operation.path().join("scratch"),
        asset_archive: inputs.join("assets.zip"),
        display_name: "Generated parser fixture".into(),
        surface_only: false,
    })
    .unwrap();
    if public.join("import-report.json").exists() {
        fs::remove_file(public.join("import-report.json")).unwrap();
    }
    let source = report["source_sha256"].as_str().unwrap().to_owned();
    f.source
        .register_staged_dataset(&public, source.clone(), true)
        .unwrap();
    operation.close().unwrap();
    fs::copy(inputs.join("assets.zip"), &f.assets).unwrap();
    let before = inventory(&f.source.root);
    let first = f.prepare().unwrap();
    let second = f.prepare().unwrap();
    assert_eq!(first, second);
    assert_eq!(first.source_sha256, source);
    assert_eq!(before, inventory(&f.source.root));
    launch::validate_store(&f.root.join("prepared/terrain/current.sqlite3"), &first).unwrap();
}

#[test]
fn active_live_store_and_changed_assets_refuse_another_prepare() {
    let f = Fixture::new(true, true);
    let prepared = f.prepare().unwrap();
    let database = f.root.join("prepared/terrain/current.sqlite3");
    let db = rusqlite::Connection::open(&database).unwrap();
    db.execute(
        "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='observation'",
        [],
    )
    .unwrap();
    drop(db);
    let live = inventory(&f.root.join("prepared/terrain"));
    assert!(f.prepare().is_err());
    assert_eq!(live, inventory(&f.root.join("prepared/terrain")));
    launch::validate_store(&database, &prepared).unwrap();
    // SQLite read-only startup validation may allocate WAL shared-memory files;
    // the store's logical data and immutable objects remain unchanged.
    let after_probe = inventory(&f.root.join("prepared/terrain"));
    assert!(
        live.iter()
            .all(|(path, hash)| after_probe.get(path) == Some(hash))
    );
    fs::write(&f.assets, "changed").unwrap();
    assert!(f.prepare().is_err());
    assert_eq!(after_probe, inventory(&f.root.join("prepared/terrain")));
}

#[test]
fn firewall_recipe_is_scoped_syntactically_valid_and_never_automatically_applied() {
    for (terrain, players) in [(true, false), (false, true), (true, true)] {
        let f = Fixture::new(terrain, players);
        let path = f.root.join("firewall-review.sh");
        let script = fs::read_to_string(&path).unwrap();
        assert!(
            std::process::Command::new("sh")
                .arg("-n")
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        let usage = std::process::Command::new("sh")
            .arg(&path)
            .output()
            .unwrap();
        assert_eq!(usage.status.code(), Some(2));
        assert!(String::from_utf8(usage.stderr).unwrap().contains("Usage:"));
        assert!(script.contains("--ctdir ORIGINAL --ctorigdst 10.20.0.10 --ctorigdstport"));
        assert!(script.contains("! -s 10.20.0.20"));
        assert_eq!(script.contains("18082"), terrain);
        assert_eq!(script.contains("18081"), players);
        for forbidden in [
            "--flush",
            " -F ",
            " -P ",
            "iptables-restore",
            "ufw ",
            "0.0.0.0/0",
        ] {
            assert!(!script.contains(forbidden));
        }
        assert!(script.contains("--comment 'bedrock-map:fixture-map'"));
        fs::write(&path, format!("{script}\n# changed\n")).unwrap();
        assert!(init::load(&f.root).is_err());
    }
}

#[test]
fn feature_combinations_match_mounts_routes_and_world_module_ids() {
    for (terrain, players) in [(true, false), (false, true), (true, true)] {
        let f = Fixture::with_options(
            terrain,
            players,
            false,
            None,
            terrain.then_some(("world-80818082", "fixture-generation")),
        );
        let p = f.prepare().unwrap();
        let config: Value = serde_json::from_slice(
            &fs::read(f.root.join("prepared/public/viewer-config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(config.get("terrain").is_some(), terrain);
        assert_eq!(config.get("players").is_some(), players);
        let static_lod = format!("maps/{}/lod.json", p.dataset_id);
        assert_eq!(config["lod_url"], static_lod);
        assert!(config.get("lod_identity").is_none());
        assert!(f.root.join("prepared/public").join(&static_lod).is_file());
        assert!(
            p.immutable_files
                .contains_key(&format!("public/{static_lod}"))
        );
        if terrain {
            assert_eq!(
                config["terrain"]["lod_url"],
                format!("/api/v1/worlds/{}/terrain/lod.json", p.world_id)
            );
            let db = rusqlite::Connection::open_with_flags(
                f.root.join("prepared/terrain/current.sqlite3"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let encoded: String = db
                .query_row(
                    "SELECT value FROM meta WHERE key='lod_manifest'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let lod: surface_core::lod::LodManifest = serde_json::from_str(&encoded).unwrap();
            lod.validate().unwrap();
            assert_eq!(lod.world_id.as_deref(), Some(p.world_id.as_str()));
            assert_eq!(Some(lod.generation), p.generation);
            assert!(p.seed_files.contains_key("current.sqlite3"));
            for root in lod.roots {
                assert_eq!(p.seed_files.get(&root.index.url), Some(&root.index.sha256));
            }
        }
        if players {
            assert_eq!(config["players"]["source_sha256"], p.source_sha256);
            assert_eq!(config["players"]["poll_interval_ms"], 100);
        }
        let compose: Value =
            serde_json::from_slice(&fs::read(f.root.join("compose.yaml")).unwrap()).unwrap();
        assert_eq!(compose["services"].get("terrain").is_some(), terrain);
        assert_eq!(compose["services"].get("players").is_some(), players);
        let caddy = fs::read_to_string(f.root.join("prepared/gateway/Caddyfile")).unwrap();
        assert_eq!(caddy.contains("terrain:8111"), terrain);
        assert_eq!(caddy.contains("manifest\\.json|lod\\.json|status"), terrain);
        assert_eq!(caddy.contains("players:8110"), players);
        let upstreams: Vec<_> = caddy
            .lines()
            .filter_map(|line| {
                let mut words = line.split_whitespace();
                (words.next() == Some("reverse_proxy")).then(|| words.next().unwrap())
            })
            .collect();
        let expected: Vec<_> = [(players, "players:8110"), (terrain, "terrain:8111")]
            .into_iter()
            .filter_map(|(enabled, address)| enabled.then_some(address))
            .collect();
        assert_eq!(upstreams, expected);
        assert!(!caddy.contains("ingest"));
        for service in compose["services"].as_object().unwrap().values() {
            assert!(service.get("depends_on").is_none());
            assert_eq!(service["read_only"], true);
            assert!(
                service["ports"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|port| port["target"] != 8110 && port["target"] != 8111)
            );
            assert!(
                service["volumes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|mount| mount["bind"]["create_host_path"] == false)
            );
        }
        let handoff = f.root.join("prepared/bds-handoff");
        let entries: Value =
            serde_json::from_slice(&fs::read(handoff.join("world-pack-entries.json")).unwrap())
                .unwrap();
        assert_eq!(
            entries.as_array().unwrap().len(),
            usize::from(terrain) + usize::from(players)
        );
        if terrain {
            let variables: Value = serde_json::from_slice(
                &fs::read(
                    handoff.join("config/4e163ad8-5c87-4738-9173-96e3d7cb5b2e/variables.json"),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(variables["view_distance"], 4);
            assert_eq!(variables["scan_budget_ms"], 4);
        }
        if players {
            let module = handoff.join("config/9b918705-25a3-430e-9a4f-c4cd7abbfcda");
            let variables: Value =
                serde_json::from_slice(&fs::read(module.join("variables.json")).unwrap()).unwrap();
            assert_eq!(
                variables["collector_url"],
                "http://10.20.0.10:18081/ingest/v1/snapshot"
            );
            let secrets: Value =
                serde_json::from_slice(&fs::read(module.join("secrets.json")).unwrap()).unwrap();
            let permissions: Value =
                serde_json::from_slice(&fs::read(module.join("permissions.json")).unwrap())
                    .unwrap();
            let requirements: Value = serde_json::from_slice(
                &fs::read(module.join("runtime-requirements.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                requirements["script_module_id"],
                "9b918705-25a3-430e-9a4f-c4cd7abbfcda"
            );
            assert_eq!(requirements["dependencies"].as_array().unwrap().len(), 3);
            assert_eq!(permissions["allowed_modules"].as_array().unwrap().len(), 3);
            assert_eq!(
                permissions["module_permissions"]["@minecraft/server-net"]["allowed_uris"],
                json!([variables["collector_url"]])
            );
            assert_eq!(
                secrets["tracker_token"],
                fs::read_to_string(f.root.join("secrets/players.token")).unwrap()
            );
            assert!(
                handoff
                    .join("packs/f65ed125-b319-4a16-975a-f7556db11360/manifest.json")
                    .exists()
            );
        }
    }
}

#[test]
fn local_check_is_read_only_and_does_not_contact_bds_or_start_services() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new(true, true);
    f.prepare().unwrap();
    let bin = f._temp.path().join("fake-bin");
    fs::create_dir(&bin).unwrap();
    let docker = bin.join("docker");
    fs::write(&docker,b"#!/bin/sh\ncase \"$1 $2\" in\n'info --format') printf '%s\\n' '{\"OSType\":\"linux\",\"ServerVersion\":\"28.0.4\",\"SecurityOptions\":[]}' ;;\n'compose version') printf '%s\\n' '2.38.2' ;;\n'compose --project-directory') test \"$6 $7\" = 'config --quiet' ;;\n*) exit 88 ;;\nesac\n").unwrap();
    fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
    let before = inventory(&f.root);
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_bedrock-map"))
        .args(["--json", "--resources"])
        .arg(&f.resources.root)
        .args(["deploy", "check", "--dir"])
        .arg(&f.root)
        .env("PATH", &bin)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["status"], "prepared");
    assert_eq!(report["checks"][2]["status"], "unknown");
    assert_eq!(inventory(&f.root), before);
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_bedrock-map"))
        .args(["--json", "deploy", "check", "--expect-live", "--dir"])
        .arg(&f.root)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(inventory(&f.root), before);
}

#[test]
#[ignore = "requires a separately SHA-verified Caddy binary in CADDY_VALIDATOR; parses only, does not start servers"]
fn generated_caddy_configuration_parses() {
    let binary = std::env::var_os("CADDY_VALIDATOR").expect("verified Caddy binary required");
    for (terrain, players) in [(true, false), (false, true), (true, true)] {
        let f = Fixture::new(terrain, players);
        f.prepare().unwrap();
        let gateway = f.root.join("prepared/gateway");
        let config = fs::read_to_string(gateway.join("Caddyfile"))
            .unwrap()
            .replace("/etc/bedrock-map", gateway.to_str().unwrap());
        let path = f._temp.path().join("Caddyfile-test");
        fs::write(&path, config).unwrap();
        let output = std::process::Command::new(&binary)
            .args(["adapt", "--config"])
            .arg(path)
            .args(["--adapter", "caddyfile"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let adapted: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(adapted["admin"]["disabled"], true);
    }
}
