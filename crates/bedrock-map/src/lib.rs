//! Native operator runtime for Bedrock Surface Map.
//!
//! Snapshot serving remains loopback-only. Deployment orchestration has a
//! separate configuration and never manages a running Bedrock world.

pub mod assets;
pub mod config;
pub mod dataset;
pub mod deploy;
pub mod doctor;
pub mod health;
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
