//! Native, snapshot-only operator runtime for Bedrock Surface Map.
//!
//! This crate intentionally has no live-BDS, tracking, or terrain-ingest
//! dependency. It serves verified immutable snapshot data from operator state.

pub mod assets;
pub mod config;
pub mod doctor;
pub mod resources;
pub mod server;
pub mod state;

use anyhow::Result;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct CommandResult<T: Serialize> {
    pub schema_version: u8,
    pub ok: bool,
    pub command: String,
    #[serde(flatten)]
    pub value: T,
}

pub fn result<T: Serialize>(command: impl Into<String>, value: T) -> Result<String> {
    Ok(serde_json::to_string(&CommandResult {
        schema_version: 1,
        ok: true,
        command: command.into(),
        value,
    })?)
}
