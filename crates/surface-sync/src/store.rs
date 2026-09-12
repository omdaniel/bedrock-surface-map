use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use surface_core::{
    MapManifest, Material, SurfaceRegion, decode_region, decompress, encode_live_region,
    terrain::{MaterialSpec, SurfaceChunk, TerrainObservation, valid_id},
};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ObjectRef {
    pub url: String,
    pub sha256: String,
    pub bytes: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegionIndex {
    pub rx: i32,
    pub rz: i32,
    pub surface: ObjectRef,
    pub heights: ObjectRef,
    pub chunks: BTreeMap<String, ObjectRef>,
    pub columns: usize,
    pub height_range: [i16; 2],
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LiveRegion {
    pub rx: i32,
    pub rz: i32,
    pub index: ObjectRef,
    #[serde(flatten)]
    pub data: RegionIndex,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Boundary {
    pub world_id: String,
    pub generation: String,
    pub observation: u64,
    pub created_ms: u64,
}

pub struct Store {
    pub connection: Connection,
    pub root: PathBuf,
    pub limit: u64,
}

fn meta<T: for<'a> Deserialize<'a>>(db: &Connection, key: &str) -> Result<T> {
    let value: String = db.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))?;
    Ok(serde_json::from_str(&value)?)
}
fn set_meta(db: &Connection, key: &str, value: &impl Serialize) -> Result<()> {
    db.execute("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,serde_json::to_string(value)?])?;
    Ok(())
}
fn object(root: &Path, bytes: &[u8], extension: &str) -> Result<ObjectRef> {
    let sha256 = hash(bytes);
    let name = format!("{sha256}.{extension}");
    let path = root.join("objects").join(&name);
    if !path.exists() {
        let tmp = root
            .join("objects")
            .join(format!(".{name}.{}.part", std::process::id()));
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(tmp, &path)?;
        File::open(root.join("objects"))?.sync_all()?;
    } else {
        ensure!(hash(&fs::read(&path)?) == sha256, "existing object corrupt");
    }
    Ok(ObjectRef {
        url: format!("objects/{name}"),
        sha256,
        bytes: bytes.len(),
    })
}
fn load(root: &Path, name: &str) -> Result<Vec<u8>> {
    ensure!(valid_object_name(name), "invalid object name");
    let data = fs::read(root.join("objects").join(name))?;
    ensure!(hash(&data) == name[..64], "object checksum mismatch");
    Ok(data)
}
pub fn valid_object_name(name: &str) -> bool {
    name.len() >= 68
        && name
            .bytes()
            .take(64)
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && matches!(name.get(64..), Some(".zst" | ".json" | ".png" | ".txt"))
}

fn placeholder() -> Material {
    Material {
        key: "unknown".into(),
        name: "Unknown".into(),
        texture: "unknown".into(),
        tint: 0,
        approximate: true,
        uv: [0.; 4],
        average: [1., 0., 1., 1.],
    }
}
fn material_name(spec: &MaterialSpec) -> String {
    let mut name = spec.name.trim_start_matches("minecraft:").to_string();
    for (old, property, suffix) in [
        ("stone", "stone_type", ""),
        ("dirt", "dirt_type", ""),
        ("sand", "sand_type", ""),
        ("leaves", "old_leaf_type", "_leaves"),
        ("leaves2", "new_leaf_type", "_leaves"),
        ("log", "old_log_type", "_log"),
        ("log2", "new_log_type", "_log"),
        ("planks", "wood_type", "_planks"),
    ] {
        if name == old
            && let Some(Value::String(v)) = spec.states.get(property)
        {
            name = format!("{v}{suffix}");
        }
    }
    name
}

fn intern(db: &Connection, spec: &MaterialSpec) -> Result<u32> {
    if spec.name == "surface:unknown" {
        return Ok(0);
    }
    let key = spec.key();
    if let Some(id) = db
        .query_row("SELECT id FROM materials WHERE key=?1", [&key], |r| {
            r.get(0)
        })
        .optional()?
    {
        return Ok(id);
    }
    let id: u32 = db.query_row("SELECT COALESCE(MAX(id),0)+1 FROM materials", [], |r| {
        r.get(0)
    })?;
    ensure!(id < 65536, "material catalog limit");
    let name = material_name(spec);
    let source: Option<String> = db
        .query_row(
            "SELECT material FROM templates WHERE name=?1",
            [&name],
            |r| r.get(0),
        )
        .optional()?;
    let mut material = if let Some(s) = source {
        serde_json::from_str(&s)?
    } else {
        placeholder()
    };
    material.key = key.clone();
    material.name = name.clone();
    material.tint = if name.contains("water") {
        3
    } else if name.contains("leaves") {
        2
    } else if [
        "grass",
        "grass_block",
        "short_grass",
        "tallgrass",
        "tall_grass",
        "fern",
        "large_fern",
        "vine",
    ]
    .contains(&name.as_str())
    {
        1
    } else {
        0
    };
    material.approximate |= name.contains("stairs")
        || name.contains("fence")
        || name.contains("glass")
        || name == "leaf_litter";
    db.execute(
        "INSERT INTO materials(id,key,material) VALUES(?1,?2,?3)",
        params![id, key, serde_json::to_string(&material)?],
    )?;
    Ok(id)
}

fn save_chunk(db: &Connection, root: &Path, c: &SurfaceChunk, observed: u64) -> Result<bool> {
    c.validate(65536, false)?;
    let packed = zstd::encode_all(c.encode()?.as_slice(), 3)?;
    let reference = object(root, &packed, "zst")?;
    let old: Option<String> = db
        .query_row(
            "SELECT hash FROM chunks WHERE cx=?1 AND cz=?2",
            params![c.cx, c.cz],
            |r| r.get(0),
        )
        .optional()?;
    db.execute("INSERT INTO chunks(cx,cz,hash,bytes,observed) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(cx,cz) DO UPDATE SET hash=excluded.hash,bytes=excluded.bytes,observed=excluded.observed",params![c.cx,c.cz,reference.sha256,reference.bytes as i64,observed as i64])?;
    Ok(old.as_deref() != Some(reference.sha256.as_str()))
}

fn publish_region(db: &Connection, root: &Path, rx: i32, rz: i32) -> Result<()> {
    let mut r = SurfaceRegion::empty(rx, rz);
    let mut refs = BTreeMap::new();
    let mut statement=db.prepare("SELECT cx,cz,hash,bytes FROM chunks WHERE cx>=?1 AND cx<?2 AND cz>=?3 AND cz<?4 ORDER BY cz,cx")?;
    let rows = statement.query_map(params![rx * 16, rx * 16 + 16, rz * 16, rz * 16 + 16], |r| {
        Ok((
            r.get::<_, i32>(0)?,
            r.get::<_, i32>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)? as usize,
        ))
    })?;
    for row in rows {
        let (cx, cz, sha256, bytes) = row?;
        let name = format!("{sha256}.zst");
        let raw = decompress(&load(root, &name)?, 32768)?;
        SurfaceChunk::decode(&raw)?.apply(&mut r)?;
        refs.insert(
            format!("{cx},{cz}"),
            ObjectRef {
                url: format!("objects/{name}"),
                sha256,
                bytes,
            },
        );
    }
    let packed = zstd::encode_all(encode_live_region(&r)?.as_slice(), 3)?;
    let surface = object(root, &packed, "zst")?;
    let heights = r
        .heights
        .iter()
        .zip(&r.coverage)
        .flat_map(|(h, c)| if *c == 1 { *h } else { i16::MIN }.to_le_bytes())
        .collect::<Vec<_>>();
    let heights = object(root, &zstd::encode_all(heights.as_slice(), 3)?, "zst")?;
    let mut range = [i16::MAX, i16::MIN];
    let mut columns = 0;
    for (height, coverage) in r.heights.iter().zip(&r.coverage) {
        if *coverage == 1 {
            range[0] = range[0].min(*height);
            range[1] = range[1].max(*height);
        }
        if *coverage != 0 {
            columns += 1;
        }
    }
    if range[0] > range[1] {
        range = [0, 0];
    }
    let index = RegionIndex {
        rx,
        rz,
        surface,
        heights,
        chunks: refs,
        columns,
        height_range: range,
    };
    let index_ref = object(root, &serde_json::to_vec(&index)?, "json")?;
    db.execute("INSERT INTO regions(rx,rz,data,index_ref) VALUES(?1,?2,?3,?4) ON CONFLICT(rx,rz) DO UPDATE SET data=excluded.data,index_ref=excluded.index_ref",params![rx,rz,serde_json::to_string(&index)?,serde_json::to_string(&index_ref)?])?;
    Ok(())
}

fn publish_root(db: &Connection, root: &Path, dirty: &BTreeSet<(i32, i32)>) -> Result<()> {
    if dirty.is_empty() {
        return Ok(());
    }
    for &(rx, rz) in dirty {
        publish_region(db, root, rx, rz)?;
    }
    let revision: u64 = meta(db, "revision")?;
    set_meta(db, "revision", &(revision + 1))?;
    let mut regions = Vec::new();
    let mut bounds = [i32::MAX, i32::MAX, i32::MIN, i32::MIN];
    let mut range = [i16::MAX, i16::MIN];
    let mut s = db.prepare("SELECT rx,rz,data,index_ref FROM regions ORDER BY rz,rx")?;
    let rows = s.query_map([], |r| {
        Ok((
            r.get::<_, i32>(0)?,
            r.get::<_, i32>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (rx, rz, data, index) = row?;
        let data: RegionIndex = serde_json::from_str(&data)?;
        let index: ObjectRef = serde_json::from_str(&index)?;
        bounds[0] = bounds[0].min(rx * 256);
        bounds[1] = bounds[1].min(rz * 256);
        bounds[2] = bounds[2].max(rx * 256 + 256);
        bounds[3] = bounds[3].max(rz * 256 + 256);
        range[0] = range[0].min(data.height_range[0]);
        range[1] = range[1].max(data.height_range[1]);
        // Chunk hashes live in the regional index, not the polled root.
        regions.push(json!({"rx":rx,"rz":rz,"index":index,"surface":data.surface,"heights":data.heights,"columns":data.columns,"height_range":data.height_range}));
    }
    let mut s = db.prepare("SELECT material FROM materials ORDER BY id")?;
    let materials = s
        .query_map([], |r| r.get::<_, String>(0))?
        .map(|s| Ok(serde_json::from_str::<Material>(&s?)?))
        .collect::<Result<Vec<_>>>()?;
    let catalog = object(root, &serde_json::to_vec(&materials)?, "json")?;
    let manifest = json!({"format_version":2,"world_id":meta::<String>(db,"world_id")?,"generation":meta::<String>(db,"generation")?,"revision":revision+1,"rules_version":1,
        "name":meta::<String>(db,"name")?,"bounds":bounds,"spawn":meta::<[i32;3]>(db,"spawn")?,"source_sha256":meta::<String>(db,"source_sha256")?,"catalog":catalog,"atlas":meta::<ObjectRef>(db,"atlas")?,"regions":regions,"height_range":range});
    set_meta(db, "manifest", &manifest)?;
    Ok(())
}

impl Store {
    pub fn open(root: &Path, world: &str, generation: &str, limit: u64) -> Result<Self> {
        ensure!(
            valid_id(world) && valid_id(generation),
            "invalid configured identity"
        );
        fs::create_dir_all(root.join("objects"))?;
        let db = Connection::open(root.join("current.sqlite3"))?;
        db.busy_timeout(std::time::Duration::from_secs(10))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192;
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS materials(id INTEGER PRIMARY KEY,key TEXT UNIQUE NOT NULL,material TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS templates(name TEXT PRIMARY KEY,material TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS producers(id TEXT PRIMARY KEY,started INTEGER NOT NULL,sequence INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS chunks(cx INTEGER,cz INTEGER,hash TEXT NOT NULL,bytes INTEGER NOT NULL,observed INTEGER NOT NULL,PRIMARY KEY(cx,cz));
            CREATE TABLE IF NOT EXISTS regions(rx INTEGER,rz INTEGER,data TEXT NOT NULL,index_ref TEXT NOT NULL,PRIMARY KEY(rx,rz));")?;
        if meta::<String>(&db, "world_id").is_err() {
            for (key, value) in [
                ("world_id", json!(world)),
                ("generation", json!(generation)),
                ("revision", json!(0)),
                ("observation", json!(0)),
                ("producer", json!("")),
                ("producer_started", json!(0)),
                ("producer_floor", json!(0)),
                ("last_sample_ms", json!(0)),
                ("last_repair_ms", json!(0)),
                ("disabled", json!(false)),
                ("status_reason", json!("starting")),
                ("diagnostics", json!({})),
            ] {
                set_meta(&db, key, &value)?;
            }
            db.execute(
                "INSERT INTO materials VALUES(0,'unknown',?1)",
                [serde_json::to_string(&placeholder())?],
            )?;
        }
        ensure!(
            meta::<String>(&db, "world_id")? == world
                && meta::<String>(&db, "generation")? == generation,
            "dataset identity mismatch; use a new state directory for another generation"
        );
        Ok(Self {
            connection: db,
            root: root.to_owned(),
            limit,
        })
    }
    pub fn ingest(&mut self, observation: &TerrainObservation, now: u64) -> Result<bool> {
        observation.validate()?;
        ensure!(
            observation.scan_end_ms <= now + 30000 && observation.started_ms <= now + 30000,
            "future observation"
        );
        self.ensure_space()?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        ensure!(
            !meta::<bool>(&tx, "disabled")?,
            "terrain deliberately disabled"
        );
        ensure!(
            meta::<String>(&tx, "world_id")? == observation.world_id
                && meta::<String>(&tx, "generation")? == observation.generation,
            "wrong dataset"
        );
        let current: String = meta(&tx, "producer")?;
        let start: u64 = meta(&tx, "producer_started")?;
        let floor: u64 = meta(&tx, "producer_floor")?;
        ensure!(
            observation.started_ms >= floor,
            "producer predates reconciliation fence"
        );
        let known: Option<(u64, u64)> = tx
            .query_row(
                "SELECT started,sequence FROM producers WHERE id=?1",
                [&observation.producer],
                |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64)),
            )
            .optional()?;
        if let Some((started, sequence)) = known {
            ensure!(
                current == observation.producer
                    && started == observation.started_ms
                    && observation.sequence > sequence,
                "stale producer or sequence"
            );
        } else {
            ensure!(
                observation.started_ms > start || current.is_empty(),
                "older producer"
            );
            set_meta(&tx, "producer", &observation.producer)?;
            set_meta(&tx, "producer_started", &observation.started_ms)?;
        }
        let accepted: u64 = meta(&tx, "observation")?;
        let accepted = accepted + 1;
        let ids = observation
            .materials
            .iter()
            .map(|m| intern(&tx, m))
            .collect::<Result<Vec<_>>>()?;
        let mut dirty = BTreeSet::new();
        for source in &observation.chunks {
            let mut chunk = source.clone();
            chunk.remap(&ids)?;
            if save_chunk(&tx, &self.root, &chunk, accepted)? {
                dirty.insert((chunk.cx.div_euclid(16), chunk.cz.div_euclid(16)));
            }
        }
        tx.execute("INSERT INTO producers(id,started,sequence) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence",params![observation.producer,observation.started_ms as i64,observation.sequence as i64])?;
        // Keep a bounded replay tombstone set; timestamp fencing also rejects older boots.
        tx.execute("DELETE FROM producers WHERE id NOT IN (SELECT id FROM producers ORDER BY started DESC LIMIT 64)",[])?;
        set_meta(&tx, "observation", &accepted)?;
        set_meta(&tx, "last_sample_ms", &now)?;
        set_meta(&tx, "diagnostics", &observation.diagnostics)?;
        set_meta(&tx, "status_reason", &"live")?;
        publish_root(&tx, &self.root, &dirty)?;
        tx.commit()?;
        Ok(!dirty.is_empty())
    }

    pub fn boundary(&mut self) -> Result<Boundary> {
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let b = Boundary {
            world_id: meta(&tx, "world_id")?,
            generation: meta(&tx, "generation")?,
            observation: meta(&tx, "observation")?,
            created_ms: now_ms(),
        };
        set_meta(&tx, "producer_floor", &b.created_ms)?;
        set_meta(&tx, "boundary", &b)?;
        tx.commit()?;
        Ok(b)
    }

    pub fn seed(
        &mut self,
        map: &Path,
        library: Option<&Path>,
        boundary: Option<&Boundary>,
    ) -> Result<Value> {
        let manifest: MapManifest = serde_json::from_slice(&fs::read(map.join("manifest.json"))?)?;
        ensure!(
            manifest.format_version == 1,
            "seed requires a verified offline manifest"
        );
        self.ensure_space()?;
        let initial = meta::<Value>(&self.connection, "manifest").is_err();
        ensure!(
            initial || boundary.is_some(),
            "existing dataset requires a reconciliation boundary"
        );
        let (templates, atlas_path) = if let Some(lib) = library {
            let data: Value = serde_json::from_slice(&fs::read(lib.join("library.json"))?)?;
            let templates: Vec<Material> = serde_json::from_value(data["materials"].clone())?;
            (
                templates,
                lib.join(data["atlas"].as_str().context("atlas path")?),
            )
        } else {
            (manifest.materials.clone(), map.join(&manifest.atlas))
        };
        let atlas = object(&self.root, &fs::read(atlas_path)?, "png")?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if let Some(b) = boundary {
            ensure!(
                b.world_id == meta::<String>(&tx, "world_id")?
                    && b.generation == meta::<String>(&tx, "generation")?,
                "wrong repair dataset"
            );
        }
        if initial {
            set_meta(&tx, "name", &manifest.name)?;
            set_meta(&tx, "spawn", &manifest.spawn)?;
            set_meta(&tx, "atlas", &atlas)?;
            for template in templates {
                tx.execute(
                    "INSERT OR IGNORE INTO templates VALUES(?1,?2)",
                    params![template.name, serde_json::to_string(&template)?],
                )?;
            }
            let sentinel: Option<String> = tx
                .query_row(
                    "SELECT material FROM templates WHERE name='Unknown'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(s) = sentinel {
                tx.execute("UPDATE materials SET material=?1 WHERE id=0", [s])?;
            }
        }
        set_meta(&tx, "source_sha256", &manifest.source_sha256)?;
        let mut ids = vec![0];
        for m in manifest.materials.iter().skip(1) {
            ids.push(intern(&tx, &MaterialSpec::from_saved_key(&m.key)?)?);
        }
        let mut dirty = BTreeSet::new();
        let mut changed = 0;
        let mut skipped = 0;
        let mut checked = 0;
        for reference in &manifest.regions {
            ensure!(
                Path::new(&reference.url)
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_))),
                "unsafe import asset path"
            );
            let packed = fs::read(map.join(&reference.url))?;
            ensure!(
                hash(&packed) == reference.sha256,
                "import checksum mismatch"
            );
            let region = decode_region(&decompress(&packed, surface_core::MAX_DECOMPRESSED)?)?;
            ensure!(
                region.rx == reference.rx && region.rz == reference.rz,
                "region coordinate mismatch"
            );
            for z in 0..16 {
                for x in 0..16 {
                    let mut chunk =
                        SurfaceChunk::from_region(&region, region.rx * 16 + x, region.rz * 16 + z)?;
                    if chunk.columns.iter().all(|c| c[0] == 0) {
                        continue;
                    }
                    checked += 1;
                    let seen: Option<u64> = tx
                        .query_row(
                            "SELECT observed FROM chunks WHERE cx=?1 AND cz=?2",
                            params![chunk.cx, chunk.cz],
                            |r| Ok(r.get::<_, i64>(0)? as u64),
                        )
                        .optional()?;
                    if boundary.is_some_and(|b| seen.is_some_and(|v| v > b.observation)) {
                        skipped += 1;
                        continue;
                    }
                    chunk.remap(&ids)?;
                    if save_chunk(
                        &tx,
                        &self.root,
                        &chunk,
                        boundary.map_or(0, |b| b.observation),
                    )? {
                        dirty.insert((region.rx, region.rz));
                        changed += 1;
                    }
                }
            }
        }
        ensure!(checked > 0, "empty repair import");
        publish_root(&tx, &self.root, &dirty)?;
        set_meta(&tx, "last_repair_ms", &now_ms())?;
        tx.commit()?;
        Ok(json!({"checked":checked,"changed":changed,"newer_live_preserved":skipped}))
    }
    pub fn manifest(&self) -> Result<Value> {
        meta(&self.connection, "manifest")
    }
    pub fn object(&self, name: &str) -> Result<Vec<u8>> {
        load(&self.root, name)
    }
    pub fn health(&self, now: u64) -> Result<Value> {
        let sample: u64 = meta(&self.connection, "last_sample_ms")?;
        let disabled: bool = meta(&self.connection, "disabled")?;
        let age = now.saturating_sub(sample);
        let reason: String = meta(&self.connection, "status_reason")?;
        let status = if disabled {
            "disabled"
        } else if sample == 0 {
            "starting"
        } else if age > 30000 {
            "stale"
        } else if reason != "live" {
            "degraded"
        } else {
            "live"
        };
        Ok(
            json!({"schema_version":1,"world_id":meta::<String>(&self.connection,"world_id")?,"generation":meta::<String>(&self.connection,"generation")?,"status":status,"reason":reason,"sample_age_ms":if sample>0 {Some(age)} else {None},"revision":meta::<u64>(&self.connection,"revision")?,"last_repair_ms":meta::<u64>(&self.connection,"last_repair_ms")?,"diagnostics":meta::<Value>(&self.connection,"diagnostics")?,"rules_version":1,"pack_version":"1.0.0"}),
        )
    }
    pub fn disable(&self, disabled: bool, reason: &str) -> Result<()> {
        set_meta(&self.connection, "disabled", &disabled)?;
        set_meta(&self.connection, "status_reason", &reason)?;
        Ok(())
    }
    pub fn error(&self, reason: &str) {
        let _ = set_meta(&self.connection, "status_reason", &reason);
    }
    pub fn ensure_space(&self) -> Result<()> {
        let mut total = 0u64;
        for entry in fs::read_dir(self.root.join("objects"))? {
            total = total.saturating_add(entry?.metadata()?.len());
        }
        ensure!(
            total.saturating_add(8 * 1024 * 1024) < self.limit,
            "derived store capacity exceeded"
        );
        Ok(())
    }
    pub fn gc(&mut self, now: u64) -> Result<usize> {
        // Hold the writer lock through marking and deletion, including CLI repair writers.
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut reachable = BTreeSet::new();
        fn collect(v: &Value, keys: &mut BTreeSet<String>) {
            match v {
                Value::String(s) => {
                    if let Some(n) = s.strip_prefix("objects/") {
                        keys.insert(n.to_string());
                    }
                }
                Value::Array(a) => {
                    for v in a {
                        collect(v, keys);
                    }
                }
                Value::Object(o) => {
                    for v in o.values() {
                        collect(v, keys);
                    }
                }
                _ => {}
            }
        }
        if let Ok(m) = meta::<Value>(&tx, "manifest") {
            collect(&m, &mut reachable);
        }
        let mut s = tx.prepare("SELECT data,index_ref FROM regions")?;
        for row in s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (data, index) = row?;
            collect(&serde_json::from_str(&data)?, &mut reachable);
            collect(&serde_json::from_str(&index)?, &mut reachable);
        }
        drop(s);
        let mut removed = 0;
        for entry in fs::read_dir(self.root.join("objects"))? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let modified = entry
                .metadata()?
                .modified()?
                .duration_since(UNIX_EPOCH)?
                .as_millis() as u64;
            if !reachable.contains(&name) && now.saturating_sub(modified) > 3600000 {
                fs::remove_file(entry.path())?;
                removed += 1;
            }
        }
        tx.commit()?;
        Ok(removed)
    }
}
