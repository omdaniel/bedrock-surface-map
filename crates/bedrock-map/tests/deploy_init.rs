#![cfg(unix)]
use bedrock_map::deploy::{
    config::{Access, Config},
    init,
    release::{Image, Release},
};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
};

fn config() -> Config {
    Config::parse("schema_version=1\nproject='fixture-map'\npublic_origin='https://map.example.test'\ningest_bind='10.20.0.10'\nbds_source_ipv4='10.20.0.20'\n[features]\nterrain=true\nplayers=true\n").unwrap()
}
fn release() -> Release {
    // Structural fixtures only, never publication or execution evidence.
    let image = |name: &str| Image {
        repository: format!("registry.example.test/{name}"),
        index_digest: format!("sha256:{}", "a".repeat(64)),
        manifests: BTreeMap::from([
            ("amd64".into(), format!("sha256:{}", "b".repeat(64))),
            ("arm64".into(), format!("sha256:{}", "c".repeat(64))),
        ]),
    };
    Release {
        schema_version: 1,
        application_version: env!("CARGO_PKG_VERSION").into(),
        commit: "a".repeat(40),
        common_sha256: "b".repeat(64),
        registry_verified: true,
        runtime: image("runtime"),
        gateway: image("gateway"),
    }
}
fn password() -> String {
    "synthetic-only-password".into()
}
fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
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
#[test]
fn repeat_init_preserves_every_byte_and_independent_secrets() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("deployment");
    let c = config();
    let r = release();
    let first = init::initialize(&root, &c, &r, Some(&password())).unwrap();
    let before = tree(&root);
    let second = init::initialize(&root, &c, &r, None).unwrap();
    assert_eq!(first, second);
    assert_eq!(before, tree(&root));
    assert_ne!(
        before["secrets/terrain.token"],
        before["secrets/players.token"]
    );
    assert_eq!(
        fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for path in before.keys() {
        let meta = fs::metadata(root.join(path)).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!((meta.uid(), meta.gid()), (first.uid, first.gid));
    }
    assert!(!before.values().any(|v| {
        v.windows(password().len())
            .any(|b| b == password().as_bytes())
    }));
    let mut other = c.clone();
    other.world_id = Some("other-world".into());
    assert!(init::initialize(&root, &other, &r, None).is_err());
    assert!(init::initialize(&root, &c, &r, Some("different-password")).is_err());
    assert_eq!(before, tree(&root));
}
#[test]
fn missing_or_modified_secrets_never_regenerate() {
    for case in [
        "missing", "contents", "mode", "symlink", "hardlink", "extra",
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("deployment");
        let c = config();
        let r = release();
        init::initialize(&root, &c, &r, Some(&password())).unwrap();
        let token = root.join("secrets/players.token");
        match case {
            "missing" => fs::remove_file(&token).unwrap(),
            "contents" => fs::write(&token, "d".repeat(64)).unwrap(),
            "mode" => fs::set_permissions(&token, fs::Permissions::from_mode(0o644)).unwrap(),
            "symlink" => {
                fs::remove_file(&token).unwrap();
                std::os::unix::fs::symlink("terrain.token", &token).unwrap();
            }
            "hardlink" => {
                fs::hard_link(&token, tmp.path().join("alias")).unwrap();
            }
            "extra" => fs::write(root.join("secrets/extra"), "unexpected").unwrap(),
            _ => unreachable!(),
        }
        assert!(init::load(&root).is_err(), "{case}");
        assert!(
            init::initialize(&root, &c, &r, Some(&password())).is_err(),
            "{case}"
        );
        if case == "missing" {
            assert!(!token.exists());
        }
        if case == "contents" {
            assert_eq!(fs::read_to_string(token).unwrap(), "d".repeat(64));
        }
    }
}
#[test]
fn public_and_feed_combinations_have_no_disabled_secrets() {
    for (terrain, players) in [(true, false), (false, true), (true, true)] {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("deployment");
        let mut c = config();
        c.features.terrain = terrain;
        c.features.players = players;
        c.viewer.access = Access::Public;
        c.viewer.acknowledge_public_locations = true;
        let lock = init::initialize(&root, &c, &release(), None).unwrap();
        assert_eq!(lock.generation.is_some(), terrain);
        assert_eq!(root.join("secrets/terrain.token").exists(), terrain);
        assert_eq!(root.join("secrets/players.token").exists(), players);
        assert!(!root.join("secrets/viewer.hash").exists());
        init::load(&root).unwrap();
    }
}
#[test]
fn invalid_input_and_unpublished_images_write_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("deployment");
    let mut c = config();
    c.public_origin = "https://map.example.test/path".into();
    assert!(init::initialize(&root, &c, &release(), Some(&password())).is_err());
    assert!(!root.exists());
    let mut r = release();
    r.registry_verified = false;
    assert!(init::initialize(&root, &config(), &r, Some(&password())).is_err());
    assert!(!root.exists());
    for invalid in [
        "short".to_owned(),
        "a".repeat(73),
        "password\nwith-control".into(),
    ] {
        assert!(init::initialize(&root, &config(), &release(), Some(&invalid)).is_err());
        assert!(!root.exists());
    }
    fs::create_dir(&root).unwrap();
    fs::write(root.join("unrelated"), "leave alone").unwrap();
    assert!(init::initialize(&root, &config(), &release(), Some(&password())).is_err());
    assert_eq!(
        fs::read_to_string(root.join("unrelated")).unwrap(),
        "leave alone"
    );
}
#[test]
fn release_rejects_missing_architecture_or_mutable_image() {
    let mut r = release();
    r.runtime.manifests.remove("arm64");
    assert!(r.validate().is_err());
    let mut r = release();
    r.runtime.repository = "registry.example.test/runtime:latest".into();
    assert!(r.validate().is_err());
    let mut r = release();
    r.runtime.index_digest = "latest".into();
    assert!(r.validate().is_err());
}
#[test]
fn password_file_is_private_bounded_and_not_an_argument_value() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("password");
    fs::write(&file, format!("{}\n", password())).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(init::read_password(Some(&file), false).unwrap(), password());
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(init::read_password(Some(&file), false).is_err());
}

#[test]
fn cli_init_is_independent_of_home_snapshot_state_and_plaintext_arguments() {
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::process::Command;
    let tmp = tempfile::tempdir().unwrap();
    let package = tmp.path().join("package");
    let resources = package.join("share/bedrock-surface-map");
    fs::create_dir_all(resources.join("web")).unwrap();
    fs::create_dir_all(resources.join("provenance")).unwrap();
    let web = b"<title>synthetic deployment fixture</title>";
    let common =
        serde_json::to_vec(&json!({"schema_version":1,"commit":"a".repeat(40),"files":[]}))
            .unwrap();
    fs::write(resources.join("web/index.html"), web).unwrap();
    fs::write(resources.join("provenance/common-manifest.json"), &common).unwrap();
    let record = |path: &str, bytes: &[u8]| json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))});
    fs::write(package.join("release-manifest.json"),serde_json::to_vec(&json!({
        "schema_version":1,"application_version":env!("CARGO_PKG_VERSION"),"commit":"a".repeat(40),
        "target":"x86_64-unknown-linux-musl","files":[record("share/bedrock-surface-map/web/index.html",web),
            record("share/bedrock-surface-map/provenance/common-manifest.json",&common)]
    })).unwrap()).unwrap();
    let mut r = release();
    r.common_sha256 = format!("{:x}", Sha256::digest(&common));
    fs::write(
        package.join("deployment-release.json"),
        serde_json::to_vec(&r).unwrap(),
    )
    .unwrap();
    let input = tmp.path().join("input.toml");
    fs::write(&input, toml::to_string(&config()).unwrap()).unwrap();
    let pass = tmp.path().join("private-password");
    fs::write(&pass, password()).unwrap();
    fs::set_permissions(&pass, fs::Permissions::from_mode(0o600)).unwrap();
    let root = tmp.path().join("deployment");
    let command = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_bedrock-map"));
        command
            .env_remove("HOME")
            .env_remove("BEDROCK_MAP_STATE")
            .env_remove("XDG_DATA_HOME")
            .arg("--json")
            .arg("--resources")
            .arg(&resources)
            .args(["deploy", "init", "--dir"])
            .arg(&root)
            .arg("--config")
            .arg(&input);
        command
    };
    let first = command()
        .arg("--viewer-password-file")
        .arg(&pass)
        .output()
        .unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stdout)
    );
    let initial: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(initial["command"], "deploy.init");
    assert_eq!(initial["changed"], true);
    assert_eq!(initial["running"], false);
    let before = tree(&root);
    let second = command().output().unwrap();
    assert!(second.status.success());
    let repeated: Value = serde_json::from_slice(&second.stdout).unwrap();
    assert_eq!(repeated["changed"], false);
    assert_eq!(before, tree(&root));
    assert!(!String::from_utf8_lossy(&first.stdout).contains(&password()));
    let bad = command()
        .args(["--viewer-password", "do-not-accept"])
        .output()
        .unwrap();
    assert_eq!(bad.status.code(), Some(2));
    let mut mismatch = r;
    mismatch.common_sha256 = "d".repeat(64);
    fs::write(
        package.join("deployment-release.json"),
        serde_json::to_vec(&mismatch).unwrap(),
    )
    .unwrap();
    let invalid = command().output().unwrap();
    assert_eq!(invalid.status.code(), Some(2));
    assert_eq!(before, tree(&root));
}
