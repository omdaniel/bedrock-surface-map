//! Bounded, storage-independent LOD construction from a frozen publication batch.
//! Callers install the returned immutable objects before publishing their references.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write};
use surface_core::{
    Material,
    lod::{
        ChunkRef, DetailTile, HeightTile, LodNode, MAX_NODE_BYTES, MAX_TILE_BYTES, NodeRef,
        OUTSIDE_COLUMN, ObjectRef, SummaryTile, TileKey, decompress_lod, validate_bounds,
    },
    terrain::{SurfaceChunk, UNKNOWN},
};

const MAX_CHUNK_BYTES: usize = 32 * 1024;

pub struct EncodedObject {
    pub reference: ObjectRef,
    pub bytes: Vec<u8>,
}

pub struct BuiltNode {
    pub node: LodNode,
    pub reference: NodeRef,
    /// Data, heights, then index. No source chunks are duplicated here.
    pub objects: [EncodedObject; 3],
    pub summary: SummaryTile,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn encoded(bytes: Vec<u8>, extension: &str) -> EncodedObject {
    let sha256 = hash(&bytes);
    EncodedObject {
        reference: ObjectRef {
            url: format!("objects/{sha256}.{extension}"),
            sha256,
            bytes: bytes.len(),
        },
        bytes,
    }
}

fn packed(raw: &[u8]) -> Result<EncodedObject> {
    ensure!(raw.len() <= MAX_TILE_BYTES, "decoded LOD byte limit");
    let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3)?;
    encoder.include_checksum(true)?;
    encoder.write_all(raw)?;
    let bytes = encoder.finish()?;
    ensure!(
        decompress_lod(&bytes)? == raw,
        "LOD compression verification"
    );
    Ok(encoded(bytes, "zst"))
}

/// The reader must bound its allocation by the validated reference size. Checks
/// here also reject wrong content from caches, stale files, or partial writes.
fn read(
    reference: &ObjectRef,
    limit: usize,
    reader: &mut impl FnMut(&ObjectRef) -> Result<Vec<u8>>,
) -> Result<Vec<u8>> {
    reference.validate(limit)?;
    let bytes = reader(reference)?;
    ensure!(
        bytes.len() == reference.bytes && hash(&bytes) == reference.sha256,
        "LOD source length or hash mismatch"
    );
    Ok(bytes)
}

fn read_node(
    reference: &NodeRef,
    reader: &mut impl FnMut(&ObjectRef) -> Result<Vec<u8>>,
) -> Result<LodNode> {
    reference.key.validate()?;
    let node = LodNode::decode(&read(&reference.index, MAX_NODE_BYTES, reader)?)?;
    ensure!(node.key == reference.key, "LOD node key mismatch");
    Ok(node)
}

fn finish(
    summary: SummaryTile,
    raw: Vec<u8>,
    height: HeightTile,
    children: Vec<NodeRef>,
    chunks: Vec<ChunkRef>,
) -> Result<BuiltNode> {
    let data = packed(&raw)?;
    let height = packed(&height.encode()?)?;
    let node = LodNode {
        key: summary.key,
        data: data.reference.clone(),
        height: height.reference.clone(),
        children,
        chunks,
    };
    let index = encoded(node.encode()?, "json");
    let reference = NodeRef {
        key: summary.key,
        index: index.reference.clone(),
    };
    Ok(BuiltNode {
        node,
        reference,
        objects: [data, height, index],
        summary,
    })
}

fn intersects(a: [i32; 4], b: [i32; 4]) -> bool {
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

/// Replace complete chunks in one exact leaf. `changes` belongs to the frozen
/// batch, not the mutable current chunk table. Base fields without chunk refs
/// remain intact, supporting prepared offline snapshots.
pub fn build_leaf(
    key: TileKey,
    base: Option<&NodeRef>,
    changes: &[ChunkRef],
    bounds: [i32; 4],
    materials: &[Material],
    reader: &mut impl FnMut(&ObjectRef) -> Result<Vec<u8>>,
) -> Result<BuiltNode> {
    validate_bounds(bounds)?;
    let mut tile = DetailTile::unknown(key)?;
    ensure!(intersects(key.bounds()?, bounds), "leaf outside dataset");
    ensure!(changes.len() <= 64, "leaf change limit");
    let mut chunks = BTreeMap::new();
    if let Some(reference) = base {
        ensure!(reference.key == key, "base leaf key mismatch");
        let node = read_node(reference, reader)?;
        tile = DetailTile::decode(&decompress_lod(&read(&node.data, MAX_TILE_BYTES, reader)?)?)?;
        ensure!(tile.key == key, "base detail key mismatch");
        for chunk in node.chunks {
            chunks.insert((chunk.cz, chunk.cx), chunk);
        }
    }
    let mut incoming = BTreeMap::new();
    for chunk in changes {
        ensure!(
            chunk.cx.div_euclid(8) == key.x && chunk.cz.div_euclid(8) == key.z,
            "chunk outside leaf"
        );
        chunk.object.validate(MAX_CHUNK_BYTES)?;
        ensure!(
            incoming
                .insert((chunk.cz, chunk.cx), chunk.clone())
                .is_none(),
            "duplicate changed chunk"
        );
    }
    chunks.extend(incoming);
    // Reload retained source chunks as well: growing bounds may uncover columns
    // masked OUTSIDE in the previously published exact tile.
    for reference in chunks.values() {
        let bytes = read(&reference.object, MAX_CHUNK_BYTES, reader)?;
        let raw = surface_core::decompress_with_window_limit(
            &bytes,
            MAX_CHUNK_BYTES,
            MAX_TILE_BYTES as u64,
        )?;
        let chunk = SurfaceChunk::decode(&raw)?;
        ensure!(
            (chunk.cx, chunk.cz) == (reference.cx, reference.cz),
            "chunk payload key mismatch"
        );
        chunk.validate(materials.len(), false)?;
        let x = chunk.cx.rem_euclid(8) as usize * 16;
        let z = chunk.cz.rem_euclid(8) as usize * 16;
        for row in 0..16 {
            let start = (z + row) * 128 + x;
            tile.columns[start..start + 16]
                .copy_from_slice(&chunk.columns[row * 16..row * 16 + 16]);
        }
    }
    let origin = key.bounds()?;
    for (i, column) in tile.columns.iter_mut().enumerate() {
        let x = origin[0] + (i % 128) as i32;
        let z = origin[1] + (i / 128) as i32;
        if x < bounds[0] || x >= bounds[2] || z < bounds[1] || z >= bounds[3] {
            *column = OUTSIDE_COLUMN;
        } else if column[0] == 3 {
            *column = UNKNOWN;
        }
    }
    let summary = SummaryTile::from_detail(&tile, materials)?;
    let raw = tile.encode()?;
    let height = HeightTile::from_detail(&tile)?;
    finish(
        summary,
        raw,
        height,
        Vec::new(),
        chunks.into_values().collect(),
    )
}

/// Build an internal node from the complete, frozen child set. Every child
/// intersecting the dataset requires a reference, including explicitly unknown
/// tiles. A failed or omitted download cannot manufacture sparse absence.
pub fn build_parent(
    key: TileKey,
    children: &[NodeRef],
    bounds: [i32; 4],
    materials: &[Material],
    reader: &mut impl FnMut(&ObjectRef) -> Result<Vec<u8>>,
) -> Result<BuiltNode> {
    validate_bounds(bounds)?;
    let keys = key.children()?;
    ensure!(intersects(key.bounds()?, bounds), "parent outside dataset");
    ensure!(children.len() <= 4, "parent child limit");
    let mut references = BTreeMap::new();
    for reference in children {
        ensure!(reference.key.parent()? == key, "unrelated child");
        ensure!(
            references
                .insert(reference.key, reference.clone())
                .is_none(),
            "duplicate child"
        );
    }
    let mut summaries = Vec::with_capacity(4);
    let mut ordered = Vec::with_capacity(4);
    for child in keys {
        if let Some(reference) = references.remove(&child) {
            ensure!(intersects(child.bounds()?, bounds), "child outside dataset");
            let node = read_node(&reference, reader)?;
            let bytes = decompress_lod(&read(&node.data, MAX_TILE_BYTES, reader)?)?;
            let summary = if child.level == 0 {
                SummaryTile::from_detail(&DetailTile::decode(&bytes)?, materials)?
            } else {
                SummaryTile::decode(&bytes)?
            };
            ensure!(summary.key == child, "child data key mismatch");
            summaries.push(summary);
            ordered.push(reference);
        } else {
            ensure!(
                !intersects(child.bounds()?, bounds),
                "missing dataset child"
            );
            summaries.push(SummaryTile::absent(child, bounds)?);
        }
    }
    let summary = SummaryTile::from_children(
        key,
        [&summaries[0], &summaries[1], &summaries[2], &summaries[3]],
    )?;
    let raw = summary.encode()?;
    let height = HeightTile::from_summary(&summary)?;
    finish(summary, raw, height, ordered, Vec::new())
}

/// Terminal unknown/outside coverage, only for an area whose absence the frozen
/// source index establishes. Never use this as an error or download fallback.
pub fn build_absent(key: TileKey, bounds: [i32; 4]) -> Result<BuiltNode> {
    ensure!(key.level > 0, "terminal summary requires coarse level");
    ensure!(
        intersects(key.bounds()?, bounds),
        "terminal outside dataset"
    );
    let summary = SummaryTile::absent(key, bounds)?;
    let raw = summary.encode()?;
    let height = HeightTile::from_summary(&summary)?;
    finish(summary, raw, height, Vec::new(), Vec::new())
}
