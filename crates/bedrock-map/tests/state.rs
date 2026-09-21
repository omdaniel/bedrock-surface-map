use bedrock_map::{config, dataset, state::State};
use std::fs;

fn fixture(path: &std::path::Path) {
    surface_cli::create_synthetic_fixture(path).unwrap();
}

fn sha() -> String {
    "a".repeat(64)
}

#[test]
fn init_is_idempotent_and_rejects_newer_schema() {
    let temp = tempfile::tempdir().unwrap();
    let state = State::new(temp.path().join("map state")).unwrap();
    assert_eq!(state.init().unwrap().schema_version, 1);
    assert_eq!(state.init().unwrap().server.bind, "127.0.0.1:8080");
    fs::write(
        state.config_path(),
        "schema_version = 2\n[server]\nbind = '127.0.0.1:8080'\nbase_path = '/'\n",
    )
    .unwrap();
    assert!(
        state
            .init()
            .unwrap_err()
            .to_string()
            .contains("E_CONFIG_SCHEMA")
    );
}

#[test]
fn base_path_is_canonical_and_loopback_is_required() {
    assert!(config::validate_base_path("/map/").is_ok());
    for invalid in ["map/", "/map", "/map/../x/", "/map/%2f/", "/map\\x/"] {
        assert!(config::validate_base_path(invalid).is_err(), "{invalid}");
    }
}

#[test]
fn a_failed_replacement_leaves_the_active_dataset_selected() {
    let temp = tempfile::tempdir().unwrap();
    let state = State::new(temp.path().join("state")).unwrap();
    state.init().unwrap();
    let first = state.staging().join("first/public");
    fixture(&first);
    let active = state.register_staged_dataset(&first, sha(), false).unwrap();
    let second = state.staging().join("second/public");
    fixture(&second);
    fs::write(second.join("assets/NOTICE.txt"), "different dataset").unwrap();
    let error = state
        .register_staged_dataset(&second, "b".repeat(64), false)
        .unwrap_err();
    assert!(error.to_string().contains("E_REPLACE_REQUIRED"));
    assert_eq!(
        state.active().unwrap().unwrap().dataset_id,
        active.dataset_id
    );
    assert_eq!(fs::read_dir(state.datasets()).unwrap().count(), 1);
}

#[test]
fn concurrent_mutation_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let state = State::new(temp.path().join("state")).unwrap();
    let _first = state.lock_mutation().unwrap();
    assert!(
        state
            .lock_mutation()
            .unwrap_err()
            .to_string()
            .contains("E_STATE_BUSY")
    );
}

#[test]
fn registration_rejects_corrupt_and_incomplete_public_datasets() {
    for case in [
        "surface-only",
        "missing-region",
        "changed-height",
        "bad-atlas",
        "bad-material",
        "extra-report",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let state = State::new(temp.path().join("state")).unwrap();
        state.init().unwrap();
        let public = state.staging().join("candidate/public");
        fixture(&public);
        let manifest_path = public.join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        match case {
            "surface-only" => manifest["heights"] = "".into(),
            "missing-region" => {
                fs::remove_file(public.join(manifest["regions"][0]["url"].as_str().unwrap()))
                    .unwrap();
            }
            "changed-height" => {
                let height = public.join(manifest["heights"].as_str().unwrap());
                fs::write(height, b"bad").unwrap();
            }
            "bad-atlas" => manifest["atlas"] = "../outside.png".into(),
            "bad-material" => manifest["materials"] = serde_json::json!([]),
            "extra-report" => {
                fs::write(public.join("import-report.json"), b"private").unwrap();
            }
            _ => unreachable!(),
        }
        fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(
            state
                .register_staged_dataset(&public, sha(), false)
                .is_err(),
            "{case}"
        );
        assert!(state.active().unwrap().is_none(), "{case}");
    }
}

#[test]
fn runtime_validation_detects_modified_immutable_objects() {
    let temp = tempfile::tempdir().unwrap();
    let state = State::new(temp.path().join("state")).unwrap();
    state.init().unwrap();
    let public = state.staging().join("candidate/public");
    fixture(&public);
    let selected = state
        .register_staged_dataset(&public, sha(), false)
        .unwrap();
    let public = state.datasets().join(selected.dataset_id).join("public");
    let manifest = dataset::validate(&public).unwrap();
    fs::write(public.join(&manifest.regions[0].url), b"tampered").unwrap();
    assert!(state.active_validated().is_err());
}
