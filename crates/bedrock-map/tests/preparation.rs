use bedrock_map::{
    dataset,
    preparation::{DEFAULT_LOD_MAX_BYTES, prepare_lod},
    state::State,
};
use std::fs;

#[test]
fn explicit_preparation_and_standalone_registration_are_atomic_and_inventory_only() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("input");
    surface_cli::create_synthetic_fixture(&input).unwrap();
    fs::write(input.join("private.json"), "must not be served").unwrap();
    let state = State::new(temp.path().join("state")).unwrap();
    assert!(prepare_lod(&state, &input, 1, false).is_err());
    assert!(state.active().unwrap().is_none());
    assert!(!input.join("lod.json").exists());
    let active = prepare_lod(&state, &input, DEFAULT_LOD_MAX_BYTES, false).unwrap();
    let public = state.registered(&active.dataset_id).unwrap().unwrap();
    assert!(!public.join("private.json").exists());
    assert!(!input.join("lod.json").exists());
    let lod = dataset::validate_lod(&public).unwrap().unwrap();
    let standalone = temp.path().join("standalone");
    for path in &lod.files {
        fs::create_dir_all(standalone.join(path).parent().unwrap()).unwrap();
        fs::copy(public.join(path), standalone.join(path)).unwrap();
    }
    fs::write(standalone.join("private.sqlite3"), "private fixture").unwrap();
    let next = prepare_lod(&state, &standalone, DEFAULT_LOD_MAX_BYTES, true).unwrap();
    let output = state.registered(&next.dataset_id).unwrap().unwrap();
    assert!(!output.join("manifest.json").exists());
    assert!(!output.join("private.sqlite3").exists());
    assert_eq!(
        fs::read(output.join("lod.json")).unwrap(),
        fs::read(standalone.join("lod.json")).unwrap()
    );
    assert_eq!(
        prepare_lod(&state, &standalone, DEFAULT_LOD_MAX_BYTES, false)
            .unwrap()
            .dataset_id,
        next.dataset_id
    );
    fs::write(standalone.join(&lod.root.roots[0].index.url), "corrupt").unwrap();
    assert!(prepare_lod(&state, &standalone, DEFAULT_LOD_MAX_BYTES, true).is_err());
    assert_eq!(
        state.active_validated().unwrap().unwrap().dataset_id,
        next.dataset_id
    );
}

#[test]
fn native_registration_rejects_unlisted_files_and_wrong_lod_identity() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("input");
    surface_cli::create_synthetic_fixture(&input).unwrap();
    let state = State::new(temp.path().join("state")).unwrap();
    state.init().unwrap();
    surface_cli::lod::prepare_lod(&input.join("manifest.json"), &input).unwrap();
    fs::write(input.join("secret.txt"), "private").unwrap();
    assert!(
        state
            .register_staged_dataset(&input, "a".repeat(64), false)
            .is_err()
    );
    fs::remove_file(input.join("secret.txt")).unwrap();
    let mut lod = dataset::validate_lod(&input).unwrap().unwrap().root;
    lod.source_sha256 = "b".repeat(64);
    fs::write(input.join("lod.json"), lod.encode().unwrap()).unwrap();
    assert!(dataset::inventory(&input).is_err());
}

#[cfg(unix)]
#[test]
fn optional_descriptor_symlinks_are_errors_even_if_dangling() {
    let temp = tempfile::tempdir().unwrap();
    surface_cli::create_synthetic_fixture(temp.path()).unwrap();
    std::os::unix::fs::symlink("missing-private-file", temp.path().join("lod.json")).unwrap();
    assert!(dataset::inventory(temp.path()).is_err());
}
