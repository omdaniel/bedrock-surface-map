//! Drain the real publisher for one synthetic terrain-fixture stage.
use anyhow::{Context, Result, bail, ensure};
use std::{
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use surface_sync::{
    lod_publish::{Publisher, Step},
    store::Store,
};

fn main() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let state = PathBuf::from(args.next().context("missing synthetic state directory")?);
    let output = PathBuf::from(args.next().context("missing LOD snapshot path")?);
    ensure!(args.next().is_none(), "unexpected fixture argument");
    let store = Arc::new(Mutex::new(Store::open(
        &state,
        "fixture-world",
        "fixture-generation",
        2_147_483_648,
    )?));
    let terrain = store.lock().unwrap().manifest()?;
    let mut publisher = Publisher::open(store.clone())?;
    for _ in 0..1024 {
        if publisher.step()? == Step::Idle {
            let store = store.lock().unwrap();
            ensure!(
                store.manifest()? == terrain,
                "publisher changed terrain root"
            );
            let lod = store.lod_manifest()?;
            lod.validate()?;
            fs::write(&output, serde_json::to_vec(&lod)?)?;
            return Ok(());
        }
    }
    bail!("synthetic LOD publisher exceeded 1024 bounded steps")
}
