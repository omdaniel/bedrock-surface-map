//! Single-owner, resumable publication of immutable LOD trees.
use crate::{
    lod_build::{self, BuiltNode},
    lod_queue::{self, LeafCursor},
    store::{Objects, Store, hash, meta, now_ms, object, set_meta},
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use surface_core::{Material, lod::*};

const CATALOG_LIMIT: usize = MAX_CATALOG_PAGE_BYTES * 256;

#[derive(Clone, Serialize, Deserialize)]
struct Source {
    world: String,
    generation: String,
    name: String,
    bounds: [i32; 4],
    spawn: [i32; 3],
    source_sha256: String,
    catalog: ObjectRef,
    atlas: ObjectRef,
    legacy_revision: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct BatchContext {
    source: Source,
    previous_bounds: Option<[i32; 4]>,
    previous_roots: Vec<NodeRef>,
    previous_catalog: Option<ObjectRef>,
    previous_material_count: usize,
    revision: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Progress {
    batch: i64,
    phase: String,
    leaf_cursor: Option<(u64, i32, i32)>,
    node_cursor: Option<(u8, i32, i32)>,
    appearance_changed: bool,
    catalog_start: usize,
}

struct Catalog {
    batch: i64,
    materials: Vec<Material>,
}

pub struct Publisher {
    store: Arc<Mutex<Store>>,
    root: PathBuf,
    _lease: File,
    catalog: Option<Catalog>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Idle,
    Working,
    Published(u64),
}

fn optional_meta<T: for<'a> Deserialize<'a>>(db: &Connection, key: &str) -> Result<Option<T>> {
    db.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .optional()?
    .map(|value| Ok(serde_json::from_str(&value)?))
    .transpose()
}

fn read(root: &Path, reference: &ObjectRef, limit: usize) -> Result<Vec<u8>> {
    reference.validate(limit)?;
    let name = reference
        .url
        .strip_prefix("objects/")
        .context("object namespace")?;
    ensure!(crate::store::valid_object_name(name), "object path");
    let file = File::open(root.join("objects").join(name))?;
    ensure!(
        file.metadata()?.len() == reference.bytes as u64,
        "object length mismatch"
    );
    let mut bytes = Vec::with_capacity(reference.bytes);
    file.take(reference.bytes as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() == reference.bytes && hash(&bytes) == reference.sha256,
        "object checksum mismatch"
    );
    Ok(bytes)
}

fn source(value: &serde_json::Value) -> Result<Source> {
    let result = Source {
        world: serde_json::from_value(value["world_id"].clone())?,
        generation: serde_json::from_value(value["generation"].clone())?,
        name: serde_json::from_value(value["name"].clone())?,
        bounds: serde_json::from_value(value["bounds"].clone())?,
        spawn: serde_json::from_value(value["spawn"].clone())?,
        source_sha256: serde_json::from_value(value["source_sha256"].clone())?,
        catalog: serde_json::from_value(value["catalog"].clone())?,
        atlas: serde_json::from_value(value["atlas"].clone())?,
        legacy_revision: serde_json::from_value(value["revision"].clone())?,
    };
    validate_bounds(result.bounds)?;
    result.catalog.validate(CATALOG_LIMIT)?;
    result.atlas.validate(MAX_ATLAS_BYTES)?;
    Ok(result)
}

fn intersects(a: [i32; 4], b: [i32; 4]) -> bool {
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}
fn intersection(a: [i32; 4], b: [i32; 4]) -> Option<[i32; 4]> {
    intersects(a, b).then(|| {
        [
            a[0].max(b[0]),
            a[1].max(b[1]),
            a[2].min(b[2]),
            a[3].min(b[3]),
        ]
    })
}

fn schedule(db: &Connection, batch: i64, mut key: TileKey, level: u8) -> Result<()> {
    loop {
        db.execute(
            "INSERT INTO lod_work(batch,level,x,z,absent) VALUES(?1,?2,?3,?4,0)
            ON CONFLICT(batch,level,z,x) DO UPDATE SET absent=0",
            params![batch, key.level, key.x, key.z],
        )?;
        if key.level >= level {
            break;
        }
        key = key.parent()?;
    }
    Ok(())
}

fn node(db: &Connection, batch: i64, key: TileKey) -> Result<Option<NodeRef>> {
    let staged: Option<Option<String>> = db
        .query_row(
            "SELECT index_ref FROM lod_work WHERE batch=?1 AND level=?2 AND x=?3 AND z=?4",
            params![batch, key.level, key.x, key.z],
            |r| r.get(0),
        )
        .optional()?;
    let value = match staged {
        Some(value) => value,
        None => db
            .query_row(
                "SELECT index_ref FROM lod_nodes WHERE level=?1 AND x=?2 AND z=?3",
                params![key.level, key.x, key.z],
                |r| r.get(0),
            )
            .optional()?,
    };
    value
        .map(|v| {
            Ok(NodeRef {
                key,
                index: serde_json::from_str(&v)?,
            })
        })
        .transpose()
}

fn current_node(db: &Connection, key: TileKey) -> Result<Option<NodeRef>> {
    let value: Option<String> = db
        .query_row(
            "SELECT index_ref FROM lod_nodes WHERE level=?1 AND x=?2 AND z=?3",
            params![key.level, key.x, key.z],
            |r| r.get(0),
        )
        .optional()?;
    value
        .map(|v| {
            Ok(NodeRef {
                key,
                index: serde_json::from_str(&v)?,
            })
        })
        .transpose()
}

impl Publisher {
    pub fn open(store: Arc<Mutex<Store>>) -> Result<Self> {
        let root = store
            .lock()
            .map_err(|_| anyhow::anyhow!("store lock"))?
            .root
            .clone();
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lease = options.open(root.join("lod-publisher.lock"))?;
        lease
            .try_lock()
            .map_err(|_| anyhow::anyhow!("LOD publisher already active or lock unavailable"))?;
        {
            let mut store = store.lock().map_err(|_| anyhow::anyhow!("store lock"))?;
            let tx = store
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS lod_nodes(
                level INTEGER NOT NULL,x INTEGER NOT NULL,z INTEGER NOT NULL,
                index_ref TEXT NOT NULL,node TEXT NOT NULL,lo INTEGER,hi INTEGER,
                PRIMARY KEY(level,z,x)) WITHOUT ROWID;
                CREATE TABLE IF NOT EXISTS lod_work(
                batch INTEGER NOT NULL,level INTEGER NOT NULL,x INTEGER NOT NULL,z INTEGER NOT NULL,
                absent INTEGER NOT NULL DEFAULT 0,index_ref TEXT,node TEXT,lo INTEGER,hi INTEGER,
                PRIMARY KEY(batch,level,z,x)) WITHOUT ROWID;
                CREATE INDEX IF NOT EXISTS lod_work_pending ON lod_work(batch,level,z,x)
                    WHERE index_ref IS NULL;
                CREATE TABLE IF NOT EXISTS lod_catalog(batch INTEGER NOT NULL,start INTEGER NOT NULL,
                reference TEXT NOT NULL,PRIMARY KEY(batch,start)) WITHOUT ROWID;")?;
            if !optional_meta::<bool>(&tx, "lod_bootstrapped")?.unwrap_or(false) {
                // Initial conversion only. Ordinary publication freezes by ID
                // rotation and never copies the current chunk table.
                tx.execute("INSERT INTO lod_queue_chunks(queue_id,cx,cz,leaf_x,leaf_z,sha256,bytes,observation_revision,first_ms,last_ms)
                    SELECT (SELECT pending_id FROM lod_queue_state WHERE singleton=1),cx,cz,
                    (cx-CASE WHEN cx<0 THEN 7 ELSE 0 END)/8,
                    (cz-CASE WHEN cz<0 THEN 7 ELSE 0 END)/8,hash,bytes,
                    CAST((SELECT value FROM meta WHERE key='observation') AS INTEGER),?1,?1 FROM chunks
                    WHERE true ON CONFLICT(queue_id,cz,cx) DO NOTHING", [now_ms() as i64])?;
                set_meta(&tx, "lod_bootstrapped", &true)?;
            }
            tx.commit()?;
        }
        Ok(Self {
            store,
            root,
            _lease: lease,
            catalog: None,
        })
    }

    pub async fn run(mut self) {
        let mut failures = 0u32;
        loop {
            let health_store = self.store.clone();
            let result = tokio::task::spawn_blocking(move || {
                let result = self.step();
                (self, result)
            })
            .await;
            let Ok((publisher, result)) = result else {
                if let Ok(store) = health_store.lock() {
                    let _ = set_meta(&store.connection, "lod_error", &"publisher-stopped");
                }
                return;
            };
            self = publisher;
            let pause = match result {
                Ok(Step::Idle) => {
                    failures = 0;
                    Duration::from_millis(250)
                }
                Ok(_) => {
                    failures = 0;
                    Duration::from_millis(1)
                }
                Err(_) => {
                    failures = failures.saturating_add(1);
                    if let Ok(store) = self.store.lock() {
                        let _ =
                            set_meta(&store.connection, "lod_error", &"publication-unavailable");
                    }
                    Duration::from_secs((1u64 << failures.min(5)).min(30))
                }
            };
            tokio::time::sleep(pause).await;
        }
    }

    /// One bounded scheduling/build unit. Codec work and source reads happen
    /// outside the shared ingestion mutex; only metadata and installation use it.
    pub fn step(&mut self) -> Result<Step> {
        let (batch, context) = {
            let mut store = self
                .store
                .lock()
                .map_err(|_| anyhow::anyhow!("store lock"))?;
            let tx = store
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(batch) = lod_queue::active_batch(&tx)? {
                let context = serde_json::from_str::<BatchContext>(&batch.context_json)?;
                (batch, context)
            } else {
                let Some(manifest) = optional_meta::<serde_json::Value>(&tx, "manifest")? else {
                    return Ok(Step::Idle);
                };
                let current = source(&manifest)?;
                let stamp = hash(&serde_json::to_vec(&current)?);
                if optional_meta::<String>(&tx, "lod_source_stamp")?.as_ref() == Some(&stamp)
                    && lod_queue::stats(&tx, now_ms())?.pending_chunks == 0
                {
                    self.catalog = None;
                    return Ok(Step::Idle);
                }
                let previous = optional_meta::<LodManifest>(&tx, "lod_manifest")?;
                if let Some(previous) = &previous {
                    previous.validate()?;
                    ensure!(
                        previous.generation == current.generation
                            && previous.world_id.as_deref() == Some(&current.world),
                        "LOD dataset identity mismatch"
                    );
                }
                let context = BatchContext {
                    source: current,
                    previous_bounds: previous.as_ref().map(|p| p.bounds),
                    previous_roots: previous
                        .as_ref()
                        .map(|p| p.roots.clone())
                        .unwrap_or_default(),
                    previous_catalog: optional_meta(&tx, "lod_catalog_source")?,
                    previous_material_count: previous
                        .as_ref()
                        .map(|p| p.material_count)
                        .unwrap_or(0),
                    revision: previous
                        .as_ref()
                        .map(|p| p.revision)
                        .unwrap_or(0)
                        .checked_add(1)
                        .context("LOD revision exhausted")?,
                };
                let batch = lod_queue::freeze_metadata(
                    &tx,
                    meta(&tx, "observation")?,
                    &serde_json::to_string(&context)?,
                    now_ms(),
                )?
                .context("publication batch")?;
                set_meta(
                    &tx,
                    "lod_progress",
                    &Progress {
                        batch: batch.id,
                        phase: "catalog".into(),
                        leaf_cursor: None,
                        node_cursor: None,
                        appearance_changed: false,
                        catalog_start: 0,
                    },
                )?;
                tx.commit()?;
                (batch, context)
            }
        };
        if self.catalog.as_ref().is_none_or(|c| c.batch != batch.id) {
            let raw = read(&self.root, &context.source.catalog, CATALOG_LIMIT)?;
            let materials: Vec<Material> = serde_json::from_slice(&raw)?;
            validate_materials(&materials)?;
            self.catalog = Some(Catalog {
                batch: batch.id,
                materials,
            });
        }
        let materials = &self.catalog.as_ref().unwrap().materials;
        let mut progress: Progress = {
            let store = self
                .store
                .lock()
                .map_err(|_| anyhow::anyhow!("store lock"))?;
            meta(&store.connection, "lod_progress")?
        };
        ensure!(progress.batch == batch.id, "publication progress mismatch");
        match progress.phase.as_str() {
            "catalog" => {
                if progress.catalog_start == 0 {
                    progress.appearance_changed = match &context.previous_catalog {
                        Some(old) if materials.len() >= context.previous_material_count => {
                            hash(&serde_json::to_vec(
                                &materials[..context.previous_material_count],
                            )?) != old.sha256
                        }
                        Some(_) => true,
                        None => false,
                    };
                }
                if progress.catalog_start < materials.len() {
                    let start = progress.catalog_start;
                    let mut count = 0;
                    let mut size = 2;
                    for material in materials.iter().skip(start).take(CATALOG_PAGE_SIZE) {
                        let length = serde_json::to_vec(material)?.len();
                        ensure!(
                            length + 2 <= MAX_CATALOG_PAGE_BYTES,
                            "material descriptor byte limit"
                        );
                        let next = size + length + usize::from(count > 0);
                        if next > MAX_CATALOG_PAGE_BYTES {
                            break;
                        }
                        size = next;
                        count += 1;
                    }
                    let raw = serde_json::to_vec(&materials[start..start + count])?;
                    let mut store = self
                        .store
                        .lock()
                        .map_err(|_| anyhow::anyhow!("store lock"))?;
                    let Store {
                        connection,
                        root,
                        limit,
                        used,
                        data_version,
                    } = &mut *store;
                    let tx =
                        connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    ensure!(
                        lod_queue::active_batch(&tx)?.is_some_and(|b| b.id == batch.id),
                        "publication batch changed"
                    );
                    let pages: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM lod_catalog WHERE batch=?1",
                        [batch.id],
                        |row| row.get(0),
                    )?;
                    ensure!(pages < 256, "LOD v1 catalog page limit");
                    let objects = Objects {
                        root,
                        used,
                        limit: *limit,
                    };
                    objects.refresh(&tx, data_version)?;
                    let reference = object(&objects, &raw, "json")?;
                    let reference = CatalogPageRef {
                        start,
                        count,
                        object: serde_json::from_value(serde_json::to_value(reference)?)?,
                    };
                    read(root, &reference.object, MAX_CATALOG_PAGE_BYTES)?;
                    tx.execute(
                        "INSERT OR REPLACE INTO lod_catalog VALUES(?1,?2,?3)",
                        params![batch.id, start as i64, serde_json::to_string(&reference)?],
                    )?;
                    progress.catalog_start += count;
                    set_meta(&tx, "lod_progress", &progress)?;
                    tx.commit()?;
                    return Ok(Step::Working);
                }
                progress.phase = "queue".into();
            }
            "queue" => {
                let mut store = self
                    .store
                    .lock()
                    .map_err(|_| anyhow::anyhow!("store lock"))?;
                let tx = store
                    .connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)?;
                let after = progress
                    .leaf_cursor
                    .map(|(first_enqueued_ms, x, z)| LeafCursor {
                        first_enqueued_ms,
                        x,
                        z,
                    });
                let leaves = lod_queue::leaf_page(&tx, batch.id, after, 64)?;
                let roots = root_keys(context.source.bounds)?;
                for leaf in &leaves {
                    schedule(&tx, batch.id, leaf.key, roots[0].level)?;
                    progress.leaf_cursor = Some((leaf.first_enqueued_ms, leaf.key.x, leaf.key.z));
                }
                if leaves.is_empty() {
                    for root in roots {
                        schedule(&tx, batch.id, root, root.level)?;
                    }
                    progress.phase = "scan".into();
                }
                set_meta(&tx, "lod_progress", &progress)?;
                tx.commit()?;
                return Ok(Step::Working);
            }
            "scan" => {
                if context.previous_bounds == Some(context.source.bounds)
                    && !progress.appearance_changed
                {
                    progress.phase = "build".into();
                } else {
                    let mut store = self
                        .store
                        .lock()
                        .map_err(|_| anyhow::anyhow!("store lock"))?;
                    let tx = store
                        .connection
                        .transaction_with_behavior(TransactionBehavior::Immediate)?;
                    let cursor = progress
                        .node_cursor
                        .map(|(l, x, z)| (i32::from(l), x, z))
                        .unwrap_or((-1, 0, 0));
                    let mut statement=tx.prepare("SELECT level,x,z FROM lod_nodes WHERE (level,z,x)>(?1,?2,?3) ORDER BY level,z,x LIMIT 64")?;
                    let keys = statement
                        .query_map(params![cursor.0, cursor.2, cursor.1], |r| {
                            Ok(TileKey {
                                level: r.get(0)?,
                                x: r.get(1)?,
                                z: r.get(2)?,
                            })
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    drop(statement);
                    let root_level = root_keys(context.source.bounds)?[0].level;
                    for key in &keys {
                        let coverage_changed = context
                            .previous_bounds
                            .and_then(|b| intersection(key.bounds().ok()?, b))
                            != intersection(key.bounds()?, context.source.bounds);
                        if intersects(key.bounds()?, context.source.bounds)
                            && (coverage_changed || progress.appearance_changed && key.level == 0)
                        {
                            schedule(&tx, batch.id, *key, root_level)?;
                        }
                        progress.node_cursor = Some((key.level, key.x, key.z));
                    }
                    if keys.is_empty() {
                        progress.phase = "build".into();
                    }
                    set_meta(&tx, "lod_progress", &progress)?;
                    tx.commit()?;
                    return Ok(Step::Working);
                }
            }
            "build" => {
                let job = {
                    let store = self
                        .store
                        .lock()
                        .map_err(|_| anyhow::anyhow!("store lock"))?;
                    store.connection.query_row("SELECT level,x,z,absent FROM lod_work WHERE batch=?1 AND index_ref IS NULL ORDER BY level,z,x LIMIT 1",[batch.id],|r|Ok((TileKey{level:r.get(0)?,x:r.get(1)?,z:r.get(2)?},r.get::<_,bool>(3)?))).optional()?
                };
                let Some((key, absent)) = job else {
                    return self.publish(batch.id, &context);
                };
                let built = if absent {
                    lod_build::build_absent(key, context.source.bounds)?
                } else if key.level == 0 {
                    let (base, changes) = {
                        let store = self
                            .store
                            .lock()
                            .map_err(|_| anyhow::anyhow!("store lock"))?;
                        let base = current_node(&store.connection, key)?;
                        let changes = lod_queue::changed_refs(&store.connection, batch.id, key)?
                            .into_iter()
                            .map(|c| ChunkRef {
                                cx: c.cx,
                                cz: c.cz,
                                object: c.object_ref(),
                            })
                            .collect::<Vec<_>>();
                        (base, changes)
                    };
                    lod_build::build_leaf(
                        key,
                        base.as_ref(),
                        &changes,
                        context.source.bounds,
                        materials,
                        &mut |r| read(&self.root, r, MAX_TILE_BYTES),
                    )?
                } else {
                    let mut children = Vec::new();
                    let mut waiting = false;
                    {
                        let mut store = self
                            .store
                            .lock()
                            .map_err(|_| anyhow::anyhow!("store lock"))?;
                        let tx = store
                            .connection
                            .transaction_with_behavior(TransactionBehavior::Immediate)?;
                        for child in key.children()? {
                            if !intersects(child.bounds()?, context.source.bounds) {
                                continue;
                            }
                            if let Some(reference) = node(&tx, batch.id, child)? {
                                children.push(reference);
                                continue;
                            }
                            let contains_old_root = context.previous_roots.iter().any(|r| {
                                child.level >= r.key.level
                                    && intersects(child.bounds().unwrap(), r.key.bounds().unwrap())
                            });
                            tx.execute("INSERT OR IGNORE INTO lod_work(batch,level,x,z,absent) VALUES(?1,?2,?3,?4,?5)",params![batch.id,child.level,child.x,child.z,child.level>0 && !contains_old_root])?;
                            waiting = true;
                        }
                        tx.commit()?;
                    }
                    if waiting {
                        return Ok(Step::Working);
                    }
                    lod_build::build_parent(
                        key,
                        &children,
                        context.source.bounds,
                        materials,
                        &mut |r| read(&self.root, r, MAX_TILE_BYTES),
                    )?
                };
                self.install(batch.id, &built)?;
                return Ok(Step::Working);
            }
            _ => anyhow::bail!("unknown publication phase"),
        }
        let store = self
            .store
            .lock()
            .map_err(|_| anyhow::anyhow!("store lock"))?;
        set_meta(&store.connection, "lod_progress", &progress)?;
        Ok(Step::Working)
    }

    fn install(&self, batch: i64, built: &BuiltNode) -> Result<()> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| anyhow::anyhow!("store lock"))?;
        let Store {
            connection,
            root,
            limit,
            used,
            data_version,
        } = &mut *store;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure!(
            lod_queue::active_batch(&tx)?.is_some_and(|b| b.id == batch),
            "publication batch changed"
        );
        let objects = Objects {
            root,
            used,
            limit: *limit,
        };
        objects.refresh(&tx, data_version)?;
        for item in &built.objects {
            let extension = if item.reference.url.ends_with(".json") {
                "json"
            } else {
                "zst"
            };
            let reference = object(&objects, &item.bytes, extension)?;
            ensure!(
                reference.sha256 == item.reference.sha256,
                "installed node hash mismatch"
            );
            read(root, &item.reference, MAX_TILE_BYTES)?;
        }
        let mut range: Option<(i16, i16)> = None;
        for sample in &built.summary.samples {
            if sample.flags & PRESENT != 0 {
                range = Some(
                    range
                        .map(|(lo, hi)| (lo.min(sample.min_height), hi.max(sample.max_height)))
                        .unwrap_or((sample.min_height, sample.max_height)),
                );
            }
        }
        let key = built.node.key;
        tx.execute("UPDATE lod_work SET index_ref=?1,node=?2,lo=?3,hi=?4 WHERE batch=?5 AND level=?6 AND x=?7 AND z=?8",
            params![serde_json::to_string(&built.reference.index)?,serde_json::to_string(&built.node)?,range.map(|r|r.0),range.map(|r|r.1),batch,key.level,key.x,key.z])?;
        tx.commit()?;
        Ok(())
    }

    fn publish(&self, batch: i64, context: &BatchContext) -> Result<Step> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| anyhow::anyhow!("store lock"))?;
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure!(
            lod_queue::active_batch(&tx)?.is_some_and(|b| b.id == batch),
            "publication batch changed"
        );
        let unfinished: i64 = tx.query_row(
            "SELECT COUNT(*) FROM lod_work WHERE batch=?1 AND index_ref IS NULL",
            [batch],
            |r| r.get(0),
        )?;
        ensure!(unfinished == 0, "unfinished LOD publication");
        let mut roots = Vec::new();
        let mut range: Option<(i16, i16)> = None;
        for key in root_keys(context.source.bounds)? {
            roots.push(node(&tx, batch, key)?.context("missing ready root")?);
            let (lo, hi): (Option<i16>, Option<i16>) = tx.query_row(
                "SELECT lo,hi FROM lod_work WHERE batch=?1 AND level=?2 AND x=?3 AND z=?4",
                params![batch, key.level, key.x, key.z],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if let (Some(lo), Some(hi)) = (lo, hi) {
                range = Some(
                    range
                        .map(|(a, b)| (a.min(lo), b.max(hi)))
                        .unwrap_or((lo, hi)),
                );
            }
        }
        let mut statement =
            tx.prepare("SELECT reference FROM lod_catalog WHERE batch=?1 ORDER BY start")?;
        let catalog = statement
            .query_map([batch], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str::<CatalogPageRef>(&r?)?))
            .collect::<Result<Vec<_>>>()?;
        drop(statement);
        let materials = self
            .catalog
            .as_ref()
            .context("publication catalog")?
            .materials
            .len();
        let source = &context.source;
        let manifest = LodManifest {
            format_version: 1,
            kind: "surface-lod".into(),
            name: source.name.clone(),
            bounds: source.bounds,
            spawn: source.spawn,
            source_sha256: source.source_sha256.clone(),
            generation: source.generation.clone(),
            world_id: Some(source.world.clone()),
            revision: context.revision,
            appearance_version: APPEARANCE_VERSION.into(),
            height_range: range.map(|(a, b)| [a, b]).unwrap_or([0, 0]),
            atlas: source.atlas.clone(),
            catalog,
            material_count: materials,
            roots,
        };
        manifest.encode()?;
        tx.execute("INSERT INTO lod_nodes(level,x,z,index_ref,node,lo,hi) SELECT level,x,z,index_ref,node,lo,hi FROM lod_work WHERE batch=?1
            ON CONFLICT(level,z,x) DO UPDATE SET index_ref=excluded.index_ref,node=excluded.node,lo=excluded.lo,hi=excluded.hi",[batch])?;
        set_meta(&tx, "lod_manifest", &manifest)?;
        set_meta(&tx, "lod_catalog_source", &source.catalog)?;
        set_meta(&tx, "lod_source_stamp", &hash(&serde_json::to_vec(source)?))?;
        set_meta(&tx, "lod_source_revision", &source.legacy_revision)?;
        set_meta(&tx, "lod_published_ms", &now_ms())?;
        set_meta(&tx, "lod_error", &"")?;
        tx.execute("DELETE FROM lod_work WHERE batch=?1", [batch])?;
        tx.execute("DELETE FROM lod_catalog WHERE batch=?1", [batch])?;
        lod_queue::complete(&tx, batch)?;
        tx.commit()?;
        Ok(Step::Published(manifest.revision))
    }
}

/// Add current and staged hierarchy pins to the existing GC mark set. Caller
/// holds the writer transaction through marking and deletion.
pub(crate) fn visit_pins(
    db: &Connection,
    mut visit: impl FnMut(&serde_json::Value) -> Result<()>,
) -> Result<()> {
    if optional_meta::<bool>(db, "lod_bootstrapped")?.unwrap_or(false) {
        for table in ["lod_nodes", "lod_work"] {
            let mut statement = db.prepare(&format!(
                "SELECT index_ref,node FROM {table} WHERE index_ref IS NOT NULL"
            ))?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                for i in 0..2 {
                    visit(&serde_json::from_str(&row.get::<_, String>(i)?)?)?;
                }
            }
        }
        let mut statement = db.prepare("SELECT reference FROM lod_catalog")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            visit(&serde_json::from_str(&row.get::<_, String>(0)?)?)?;
        }
        if let Some(batch) = lod_queue::active_batch(db)? {
            visit(&serde_json::from_str(&batch.context_json)?)?;
        }
        for key in ["lod_manifest", "lod_catalog_source"] {
            if let Some(value) = optional_meta::<serde_json::Value>(db, key)? {
                visit(&value)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn health(db: &Connection, now: u64) -> Result<serde_json::Value> {
    let queue = lod_queue::stats(db, now)?;
    let active = lod_queue::active_batch(db)?;
    let active_since = if let Some(batch) = &active {
        let first: Option<i64> = db.query_row(
            "SELECT MIN(first_ms) FROM lod_queue_leaves WHERE queue_id=?1",
            [batch.id],
            |row| row.get(0),
        )?;
        Some(
            first
                .map(u64::try_from)
                .transpose()?
                .unwrap_or(batch.frozen_ms),
        )
    } else {
        None
    };
    let oldest = queue
        .oldest_pending_ms
        .into_iter()
        .chain(active_since)
        .min();
    let pending_age = oldest.map(|time| now.saturating_sub(time));
    let published: Option<LodManifest> = optional_meta(db, "lod_manifest")?;
    let source_revision: u64 = meta(db, "revision")?;
    let published_source: u64 = optional_meta(db, "lod_source_revision")?.unwrap_or(0);
    let revision_lag = source_revision.saturating_sub(published_source);
    let error: String = optional_meta(db, "lod_error")?.unwrap_or_default();
    let status = if meta::<bool>(db, "disabled")? {
        "disabled"
    } else if !error.is_empty() || pending_age.is_some_and(|age| age > 30_000) {
        "degraded"
    } else if published.is_none() {
        "starting"
    } else if revision_lag > 0 || active.is_some() || queue.pending_chunks > 0 {
        "updating"
    } else {
        "live"
    };
    Ok(serde_json::json!({
        "status": status,
        "revision": published.map(|m| m.revision),
        "source_revision": source_revision,
        "published_source_revision": published_source,
        "revision_lag": revision_lag,
        "pending_chunks": queue.pending_chunks,
        "pending_leaves": queue.pending_leaves,
        "pending_age_ms": pending_age,
        "active_batch": active.map(|b| b.id),
        "last_published_ms": optional_meta::<u64>(db, "lod_published_ms")?,
        "reason": if error.is_empty() { None } else { Some(error) },
    }))
}
