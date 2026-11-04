use super::{APPEARANCE_VERSION, MAX_TILE_BYTES, TileKey, root_keys, validate_bounds};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_NODE_BYTES: usize = 64 * 1024;
pub const MAX_DESCRIPTOR_BYTES: usize = 64 * 1024;
pub const MAX_CATALOG_PAGE_BYTES: usize = 64 * 1024;
pub const MAX_ATLAS_BYTES: usize = 32 * 1024 * 1024;
pub const CATALOG_PAGE_SIZE: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectRef {
    pub url: String,
    pub sha256: String,
    pub bytes: usize,
}

impl ObjectRef {
    pub fn validate(&self, limit: usize) -> Result<()> {
        ensure!(self.bytes > 0 && self.bytes <= limit, "object byte limit");
        ensure!(
            self.sha256.len() == 64
                && self
                    .sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "invalid SHA-256"
        );
        ensure!(
            !self.url.is_empty()
                && self.url.len() <= 512
                && self
                    .url
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"/_-.".contains(&c))
                && self
                    .url
                    .split('/')
                    .all(|p| !p.is_empty() && p != "." && p != ".."),
            "object URL must be root-relative local path"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeRef {
    pub key: TileKey,
    pub index: ObjectRef,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRef {
    pub cx: i32,
    pub cz: i32,
    #[serde(flatten)]
    pub object: ObjectRef,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LodNode {
    pub key: TileKey,
    pub data: ObjectRef,
    pub height: ObjectRef,
    pub children: Vec<NodeRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chunks: Vec<ChunkRef>,
}

impl LodNode {
    pub fn validate(&self) -> Result<()> {
        self.key.validate()?;
        self.data.validate(MAX_TILE_BYTES)?;
        self.height.validate(MAX_TILE_BYTES)?;
        ensure!(
            self.children.len() <= 4 && (self.key.level > 0 || self.children.is_empty()),
            "invalid node children"
        );
        let mut seen = BTreeSet::new();
        for child in &self.children {
            ensure!(
                child.key.parent()? == self.key && seen.insert(child.key),
                "duplicate or unrelated child"
            );
            child.index.validate(MAX_NODE_BYTES)?;
        }
        ensure!(
            self.chunks.len() <= 64 && (self.key.level == 0 || self.chunks.is_empty()),
            "invalid chunk references"
        );
        let mut seen = BTreeSet::new();
        for c in &self.chunks {
            ensure!(
                c.cx.div_euclid(8) == self.key.x
                    && c.cz.div_euclid(8) == self.key.z
                    && seen.insert((c.cx, c.cz)),
                "duplicate or unrelated chunk"
            );
            c.object.validate(MAX_TILE_BYTES)?;
        }
        Ok(())
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec(self)?;
        ensure!(bytes.len() <= MAX_NODE_BYTES, "node JSON limit");
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure!(bytes.len() <= MAX_NODE_BYTES, "node JSON limit");
        let node: Self = serde_json::from_slice(bytes)?;
        node.validate()?;
        Ok(node)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogPageRef {
    pub start: usize,
    pub count: usize,
    #[serde(flatten)]
    pub object: ObjectRef,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LodManifest {
    pub format_version: u32,
    pub kind: String,
    pub name: String,
    pub bounds: [i32; 4],
    pub spawn: [i32; 3],
    pub source_sha256: String,
    pub generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_id: Option<String>,
    pub revision: u64,
    pub appearance_version: String,
    pub height_range: [i16; 2],
    pub atlas: ObjectRef,
    pub catalog: Vec<CatalogPageRef>,
    pub material_count: usize,
    pub roots: Vec<NodeRef>,
}

impl LodManifest {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.format_version == 1
                && self.kind == "surface-lod"
                && self.appearance_version == APPEARANCE_VERSION,
            "unsupported LOD descriptor version"
        );
        validate_bounds(self.bounds)?;
        ensure!(
            !self.name.is_empty()
                && self.name.encode_utf16().count() <= 256
                && !self.generation.is_empty()
                && self.generation.encode_utf16().count() <= 128
                && self.source_sha256.len() == 64
                && self
                    .source_sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "invalid LOD identity"
        );
        ensure!(
            self.world_id
                .as_ref()
                .is_none_or(|s| !s.is_empty() && s.encode_utf16().count() <= 80),
            "invalid world identity"
        );
        ensure!(
            self.revision <= 9_007_199_254_740_991,
            "revision exceeds JSON integer precision"
        );
        ensure!(
            self.height_range[0] > i16::MIN && self.height_range[0] <= self.height_range[1],
            "invalid descriptor height range"
        );
        ensure!(
            self.material_count > 0 && self.material_count <= 65536,
            "catalog size limit"
        );
        self.atlas.validate(MAX_ATLAS_BYTES)?;
        let mut next = 0;
        ensure!(self.catalog.len() <= 256, "catalog page limit");
        for page in &self.catalog {
            ensure!(
                page.start == next && page.count > 0 && page.count <= CATALOG_PAGE_SIZE,
                "catalog page range"
            );
            page.object.validate(MAX_CATALOG_PAGE_BYTES)?;
            next += page.count;
        }
        ensure!(next == self.material_count, "incomplete material catalog");
        let expected = root_keys(self.bounds)?.into_iter().collect::<BTreeSet<_>>();
        ensure!(
            self.roots.len() <= 4 && self.roots.len() == expected.len(),
            "root count mismatch"
        );
        let mut seen = BTreeSet::new();
        for root in &self.roots {
            root.key.validate()?;
            root.index.validate(MAX_NODE_BYTES)?;
            ensure!(
                expected.contains(&root.key) && seen.insert(root.key),
                "invalid root key"
            );
        }
        Ok(())
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec_pretty(self)?;
        ensure!(bytes.len() <= MAX_DESCRIPTOR_BYTES, "descriptor JSON limit");
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure!(bytes.len() <= MAX_DESCRIPTOR_BYTES, "descriptor JSON limit");
        let manifest: Self = serde_json::from_slice(bytes)?;
        manifest.validate()?;
        Ok(manifest)
    }
}
