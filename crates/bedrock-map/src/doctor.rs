use crate::{config::Config, resources::Resources, state::State};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub status: &'static str,
    pub severity: &'static str,
    pub message: String,
    pub remediation: Option<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct Doctor {
    pub checks: Vec<Check>,
}

pub fn check(state: &State, resources: Result<&Resources, String>, config: &Config) -> Doctor {
    let mut checks = vec![Check {
        id: "state",
        status: "pass",
        severity: "required",
        message: "State configuration is valid.".into(),
        remediation: None,
    }];
    checks.push(Check {
        id: "loopback-bind",
        status: "pass",
        severity: "required",
        message: format!("Snapshot server is configured for {}.", config.server.bind),
        remediation: None,
    });
    checks.push(match state.active() {
        Ok(Some(active)) => Check {
            id: "dataset",
            status: "pass",
            severity: "required",
            message: format!("Selected immutable dataset {}.", active.dataset_id),
            remediation: None,
        },
        Ok(None) => Check {
            id: "dataset",
            status: "fail",
            severity: "required",
            message: "No dataset is selected.".into(),
            remediation: Some("Run bedrock-map demo or import a snapshot."),
        },
        Err(error) => Check {
            id: "dataset",
            status: "fail",
            severity: "required",
            message: error.to_string(),
            remediation: Some("Repair the state directory manually; doctor never mutates it."),
        },
    });
    checks.push(match resources {
        Ok(resources) if resources.require_web().is_ok() => Check {
            id: "resources",
            status: "pass",
            severity: "required",
            message: "Packaged viewer resources are available.".into(),
            remediation: None,
        },
        Ok(_) => Check {
            id: "resources",
            status: "fail",
            severity: "required",
            message: "Packaged viewer resources are unavailable.".into(),
            remediation: Some(
                "Use a complete release or provide --resources for a development package.",
            ),
        },
        Err(error) => Check {
            id: "resources",
            status: "fail",
            severity: "required",
            message: format!("Packaged viewer resources could not be discovered: {error}"),
            remediation: Some(
                "Use a complete release or provide --resources for a development package.",
            ),
        },
    });
    checks.push(Check {
        id: "browser-webgpu",
        status: "unknown",
        severity: "informational",
        message: "A native server check cannot prove browser WebGPU rendering.".into(),
        remediation: Some("Run the browser acceptance test separately."),
    });
    checks.push(Check {
        id: "live-services",
        status: "not_applicable",
        severity: "informational",
        message: "This snapshot runtime has no live player or terrain ingest service.".into(),
        remediation: None,
    });
    Doctor { checks }
}
