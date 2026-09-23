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
                "modules":[{"type":"script","uuid":module}]}))
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
        let config=Config::parse(&format!("schema_version=1\nproject='fixture-map'\npublic_origin='https://map.example.test'\ningest_bind='10.20.0.10'\nbds_source_ipv4='10.20.0.20'\n[features]\nterrain={terrain}\nplayers={players}\n{viewer}")).unwrap();
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
    db.execute("UPDATE meta SET value='1' WHERE key='observation'", [])
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
fn feature_combinations_match_mounts_routes_and_world_module_ids() {
    for (terrain, players) in [(true, false), (false, true), (true, true)] {
        let f = Fixture::new(terrain, players);
        let p = f.prepare().unwrap();
        let config: Value = serde_json::from_slice(
            &fs::read(f.root.join("prepared/public/viewer-config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(config.get("terrain").is_some(), terrain);
        assert_eq!(config.get("players").is_some(), players);
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
        assert_eq!(caddy.contains("players:8110"), players);
        assert!(!caddy.contains("8081") && !caddy.contains("8082") && !caddy.contains("ingest"));
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
