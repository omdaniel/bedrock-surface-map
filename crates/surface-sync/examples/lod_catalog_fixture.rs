//! Isolated, canonical catalog epochs for tests/lod-catalog.spec.ts.
//! Run: cargo run --locked -p surface-sync --example lod_catalog_fixture
use anyhow::{Context, Result, bail, ensure};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    sync::{Arc, Mutex},
};
use surface_core::{
    Material,
    lod::*,
    terrain::{MaterialSpec, ScanDiagnostics, SurfaceChunk, TerrainObservation},
};
use surface_sync::{
    lod_publish::{Publisher, Step},
    store::{Store, hash},
};

const LIMIT: u64 = 64 * 1024 * 1024;
type Shared = Arc<Mutex<Store>>;

fn read(root: &Path, reference: &ObjectRef, limit: usize) -> Result<Vec<u8>> {
    reference.validate(limit)?;
    let path = root.join(&reference.url);
    ensure!(
        fs::metadata(&path)?.len() == reference.bytes as u64,
        "object length"
    );
    let bytes = fs::read(path)?;
    ensure!(hash(&bytes) == reference.sha256, "object hash");
    Ok(bytes)
}

fn visit(
    root: &Path,
    reference: &NodeRef,
    manifest: &LodManifest,
    materials: &[Material],
    nodes: &mut BTreeMap<TileKey, LodNode>,
) -> Result<SummaryTile> {
    ensure!(nodes.len() < 1024, "fixture graph node limit");
    let node = LodNode::decode(&read(root, &reference.index, MAX_NODE_BYTES)?)?;
    ensure!(node.key == reference.key, "node key");
    ensure!(
        nodes.insert(node.key, node.clone()).is_none(),
        "duplicate node"
    );
    let data = decompress_lod(&read(root, &node.data, MAX_TILE_BYTES)?)?;
    let heights = HeightTile::decode(&decompress_lod(&read(root, &node.height, MAX_TILE_BYTES)?)?)?;
    if node.key.level == 0 {
        let detail = DetailTile::decode(&data)?;
        ensure!(detail.key == node.key, "detail key");
        ensure!(
            heights == HeightTile::from_detail(&detail)?,
            "fine height epoch"
        );
        for reference in &node.chunks {
            let chunk = SurfaceChunk::decode(&decompress_lod(&read(
                root,
                &reference.object,
                MAX_TILE_BYTES,
            )?)?)?;
            ensure!(
                (chunk.cx, chunk.cz) == (reference.cx, reference.cz),
                "chunk key"
            );
            let ox = chunk.cx.rem_euclid(8) as usize * 16;
            let oz = chunk.cz.rem_euclid(8) as usize * 16;
            for z in 0..16 {
                ensure!(
                    detail.columns[(oz + z) * 128 + ox..(oz + z) * 128 + ox + 16]
                        == chunk.columns[z * 16..z * 16 + 16],
                    "chunk/detail epoch"
                );
            }
        }
        return SummaryTile::from_detail(&detail, materials);
    }
    let summary = SummaryTile::decode(&data)?;
    ensure!(summary.key == node.key, "summary key");
    ensure!(
        heights == HeightTile::from_summary(&summary)?,
        "coarse height epoch"
    );
    let mut children = Vec::new();
    for key in node.key.children()? {
        children.push(
            if let Some(child) = node.children.iter().find(|c| c.key == key) {
                visit(root, child, manifest, materials, nodes)?
            } else {
                let bounds = key.bounds()?;
                ensure!(
                    node.children.is_empty()
                        || bounds[2] <= manifest.bounds[0]
                        || bounds[0] >= manifest.bounds[2]
                        || bounds[3] <= manifest.bounds[1]
                        || bounds[1] >= manifest.bounds[3],
                    "missing intersecting child"
                );
                SummaryTile::absent(key, manifest.bounds)?
            },
        );
    }
    let expected = if node.children.is_empty() {
        SummaryTile::absent(node.key, manifest.bounds)?
    } else {
        SummaryTile::from_children(
            node.key,
            [&children[0], &children[1], &children[2], &children[3]],
        )?
    };
    ensure!(summary == expected, "catalog/coarse/fine epoch mismatch");
    Ok(summary)
}

fn audit(
    root: &Path,
    manifest: &LodManifest,
) -> Result<(Vec<Material>, BTreeMap<TileKey, LodNode>)> {
    manifest.validate()?;
    read(root, &manifest.atlas, MAX_ATLAS_BYTES)?;
    let mut materials = Vec::new();
    for page in &manifest.catalog {
        ensure!(page.start == materials.len(), "catalog start");
        let values: Vec<Material> =
            serde_json::from_slice(&read(root, &page.object, MAX_CATALOG_PAGE_BYTES)?)?;
        ensure!(values.len() == page.count, "catalog count");
        materials.extend(values);
    }
    ensure!(
        materials.len() == manifest.material_count,
        "catalog coverage"
    );
    let mut nodes = BTreeMap::new();
    let mut range = [i16::MAX, i16::MIN];
    for reference in &manifest.roots {
        for sample in visit(root, reference, manifest, &materials, &mut nodes)?
            .samples
            .iter()
            .filter(|s| s.flags & PRESENT != 0)
        {
            range[0] = range[0].min(sample.min_height);
            range[1] = range[1].max(sample.max_height);
        }
    }
    ensure!(range == manifest.height_range, "height range");
    Ok((materials, nodes))
}

fn snapshot(
    store: &Shared,
    publisher: &mut Publisher,
    output: &Path,
    stage: usize,
) -> Result<LodManifest> {
    let terrain = store.lock().unwrap().manifest()?;
    for _ in 0..1024 {
        if publisher.step()? == Step::Idle {
            let store = store.lock().unwrap();
            ensure!(store.manifest()? == terrain, "publisher changed terrain");
            let manifest = store.lod_manifest()?;
            audit(&store.root, &manifest)?;
            fs::write(
                output.join(format!("lod-{stage}.json")),
                serde_json::to_vec(&manifest)?,
            )?;
            fs::write(
                output.join(format!("health-{stage}.json")),
                serde_json::to_vec(&store.health(1002 + stage as u64)?)?,
            )?;
            return Ok(manifest);
        }
    }
    bail!("catalog fixture exceeded 1024 publisher steps")
}

fn main() -> Result<()> {
    ensure!(
        std::env::args_os().len() == 1,
        "this fixture takes no arguments"
    );
    let local = Path::new(".local");
    let map = local.join("terrain-fixture/map");
    ensure!(
        map.join("manifest.json").is_file(),
        "generate terrain-fixture first; this example never modifies it"
    );
    let temporary = tempfile::Builder::new()
        .prefix("lod-catalog-build-")
        .tempdir_in(local)?;
    let state = temporary.path().join("state");
    let mut initial = Store::open(&state, "fixture-world", "fixture-generation", LIMIT)?;
    initial.seed(&map, None, None)?;
    let store = Arc::new(Mutex::new(initial));
    let mut publisher = Publisher::open(store.clone())?;
    let before = snapshot(&store, &mut publisher, temporary.path(), 0)?;
    let (materials, old) = audit(&state, &before)?;
    let stone_id = materials
        .iter()
        .position(|m| m.name == "stone")
        .context("fixture stone")?;
    let sand = materials
        .iter()
        .find(|m| m.name == "sand")
        .context("fixture sand")?;
    let mut probe = None;
    for node in old.values().filter(|n| n.key.level == 0) {
        let tile =
            DetailTile::decode(&decompress_lod(&read(&state, &node.data, MAX_TILE_BYTES)?)?)?;
        for z in 4..124 {
            for x in 4..124 {
                if (z - 3..=z + 3).all(|zz| {
                    (x - 3..=x + 3).all(|xx| {
                        tile.columns[zz * 128 + xx][0] == 1
                            && tile.columns[zz * 128 + xx][2] == stone_id as i32
                    })
                }) {
                    probe = Some(
                        serde_json::json!({"x": node.key.x * 128 + x as i32, "z": node.key.z * 128 + z as i32, "height": tile.columns[z * 128 + x][1] as f64 / 16.0}),
                    );
                    break;
                }
            }
            if probe.is_some() {
                break;
            }
        }
        if probe.is_some() {
            break;
        }
    }
    let probe = probe.context("fixture must have a stone picking patch")?;
    let append = TerrainObservation {
        schema_version: 1,
        rules_version: 1,
        world_id: "fixture-world".into(),
        generation: "fixture-generation".into(),
        producer: "catalog-fixture".into(),
        started_ms: 1000,
        sequence: 1,
        scan_start_ms: 1000,
        scan_end_ms: 1001,
        materials: vec![
            MaterialSpec {
                name: "surface:unknown".into(),
                states: BTreeMap::new(),
            },
            MaterialSpec {
                name: "minecraft:gold_block".into(),
                states: BTreeMap::new(),
            },
        ],
        chunks: vec![],
        diagnostics: ScanDiagnostics::default(),
    };
    ensure!(
        !store.lock().unwrap().ingest(&append, 1002)?,
        "append changed terrain"
    );
    let mut gold = sand.clone();
    gold.name = "gold_block".into();
    gold.texture = "synthetic:gold".into();
    {
        let mut store = store.lock().unwrap();
        ensure!(
            store.connection.execute(
                "INSERT INTO templates(name,material) VALUES('gold_block',?1)",
                [serde_json::to_string(&gold)?],
            )? == 1,
            "gold template"
        );
        ensure!(store.refresh_catalog()? == 1, "appended descriptor repair");
    }
    let appended = snapshot(&store, &mut publisher, temporary.path(), 1)?;
    let (appended_materials, appended_nodes) = audit(&state, &appended)?;
    ensure!(
        appended.material_count == before.material_count + 1,
        "append count"
    );
    ensure!(
        serde_json::to_vec(&appended_materials[..materials.len()])?
            == serde_json::to_vec(&materials)?,
        "append changed descriptor prefix"
    );
    ensure!(
        before.roots == appended.roots && old == appended_nodes,
        "append rebuilt terrain"
    );

    // Modify only the template; refresh_catalog and Publisher own every root/hash.
    let mut stone = materials[stone_id].clone();
    stone.texture = "synthetic:catalog-repair".into();
    stone.uv = sand.uv;
    stone.average = [0.1, 0.8, 0.2, 1.];
    stone.approximate = true;
    {
        let mut store = store.lock().unwrap();
        ensure!(
            store.connection.execute(
                "UPDATE templates SET material=?1 WHERE name='stone'",
                [serde_json::to_string(&stone)?]
            )? == 1,
            "stone template"
        );
        ensure!(store.refresh_catalog()? == 1, "descriptor repair count");
        ensure!(
            store.lod_manifest()? == appended,
            "repair exposed unfinished LOD epoch"
        );
    }
    let changed = snapshot(&store, &mut publisher, temporary.path(), 2)?;
    let (changed_materials, changed_nodes) = audit(&state, &changed)?;
    ensure!(
        changed.material_count == appended.material_count && changed.catalog != appended.catalog,
        "descriptor publication"
    );
    ensure!(
        before.revision < appended.revision && appended.revision < changed.revision,
        "revision sequence"
    );
    ensure!(
        before.atlas == changed.atlas && before.source_sha256 == changed.source_sha256,
        "unexpected provenance/atlas change"
    );
    let mut changed_coarse = BTreeSet::new();
    for (key, node) in &appended_nodes {
        let newer = &changed_nodes[key];
        ensure!(node.height == newer.height, "descriptor changed heights");
        if key.level == 0 {
            ensure!(node == newer, "descriptor changed exact terrain");
        } else if node.data != newer.data {
            let old =
                SummaryTile::decode(&decompress_lod(&read(&state, &node.data, MAX_TILE_BYTES)?)?)?;
            let new = SummaryTile::decode(&decompress_lod(&read(
                &state,
                &newer.data,
                MAX_TILE_BYTES,
            )?)?)?;
            ensure!(
                old.samples
                    .iter()
                    .zip(&new.samples)
                    .any(|(a, b)| a.flags & PRESENT != 0
                        && a.original != b.original
                        && a.vivid != b.vivid),
                "coarse colors did not change"
            );
            changed_coarse.insert(newer.data.url.clone());
        }
    }
    ensure!(!changed_coarse.is_empty(), "missing rebuilt coarse colors");

    ensure!(
        changed.material_count < CATALOG_PAGE_SIZE,
        "fixture must start below the catalog page boundary"
    );
    let mut revisions = vec![before.revision, appended.revision, changed.revision];
    let mut previous = changed.clone();
    let mut previous_materials = changed_materials;
    for (stage, target_count) in [(3, CATALOG_PAGE_SIZE), (4, CATALOG_PAGE_SIZE + 1)] {
        let additions: Vec<MaterialSpec> = (previous.material_count..target_count)
            .map(|id| MaterialSpec {
                name: format!("minecraft:catalog_boundary_{id}"),
                states: BTreeMap::new(),
            })
            .collect();
        let mut growth = append.clone();
        growth.sequence = stage as u64 - 1;
        growth.materials.truncate(1);
        growth.materials.extend(additions.clone());
        {
            let mut store = store.lock().unwrap();
            ensure!(
                !store.ingest(&growth, 1002 + stage as u64)?,
                "boundary append changed terrain"
            );
            // As with gold, repair only new templates so Store publishes the
            // appended descriptors; Publisher owns the catalog pages and roots.
            for spec in &additions {
                let mut descriptor = sand.clone();
                descriptor.name = spec.render_name();
                descriptor.texture = format!("synthetic:{}", descriptor.name);
                ensure!(
                    store.connection.execute(
                        "INSERT INTO templates(name,material) VALUES(?1,?2)",
                        [spec.render_name(), serde_json::to_string(&descriptor)?],
                    )? == 1,
                    "boundary template"
                );
            }
            ensure!(
                store.refresh_catalog()? == additions.len(),
                "boundary descriptor repair count"
            );
            ensure!(
                store.lod_manifest()? == previous,
                "boundary append exposed unfinished LOD epoch"
            );
        }
        let grown = snapshot(&store, &mut publisher, temporary.path(), stage)?;
        let (grown_materials, grown_nodes) = audit(&state, &grown)?;
        ensure!(grown.material_count == target_count, "boundary count");
        ensure!(
            serde_json::to_vec(&grown_materials[..previous_materials.len()])?
                == serde_json::to_vec(&previous_materials)?,
            "boundary append changed existing IDs/descriptors"
        );
        for (offset, spec) in additions.iter().enumerate() {
            let descriptor = &grown_materials[previous.material_count + offset];
            ensure!(
                descriptor.key == spec.key() && descriptor.name == spec.render_name(),
                "boundary append assigned unexpected ID"
            );
        }
        ensure!(
            grown.roots == changed.roots && grown_nodes == changed_nodes,
            "boundary append rebuilt terrain"
        );
        ensure!(
            grown.atlas == changed.atlas
                && grown.source_sha256 == changed.source_sha256
                && grown.appearance_version == changed.appearance_version
                && grown.revision > previous.revision,
            "boundary append changed appearance/provenance or revision order"
        );
        ensure!(
            grown.catalog[0].start == 0 && grown.catalog[0].count == CATALOG_PAGE_SIZE,
            "boundary first page"
        );
        if stage == 3 {
            ensure!(grown.catalog.len() == 1, "boundary full page count");
        } else {
            ensure!(
                grown.catalog.len() == 2
                    && grown.catalog[0] == previous.catalog[0]
                    && grown.catalog[1].start == CATALOG_PAGE_SIZE
                    && grown.catalog[1].count == 1,
                "boundary append did not preserve the full first page"
            );
        }
        revisions.push(grown.revision);
        previous = grown;
        previous_materials = grown_materials;
    }
    let report = serde_json::json!({"probe": probe, "revisions": revisions, "nodes": old.len(), "changed_coarse": changed_coarse, "audited": ["hashes", "chunk/detail", "catalog/summary", "height/range", "append-prefix", "unchanged-fine", "catalog-page-boundary", "stable-material-ids", "unchanged-boundary-terrain"]});
    fs::write(
        temporary.path().join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    drop(publisher);
    drop(store);
    let output = local.join("lod-catalog-fixture");
    if output.exists() {
        fs::remove_dir_all(&output)?;
    }
    fs::rename(temporary.path(), &output)?;
    println!("Audited native catalog fixture: {}", output.display());
    Ok(())
}
