//! Shared Bedrock snapshot import and synthetic fixture support.
//!
//! The legacy `surface-map` executable remains a thin command-line wrapper.
//! Higher-level operator tooling uses this crate so archive validation, surface
//! extraction and material preparation have a single implementation.

mod app;
pub mod lod;
pub use lod::{create_lod_fixture, prepare_lod};

pub use app::{
    ImportOptions, ImportReport, atomic_write, create_synthetic_fixture, hash, import_snapshot,
    prepare_asset_library, run_cli,
};
