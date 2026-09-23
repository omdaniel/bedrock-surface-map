use anyhow::{Context, Result, bail, ensure};
use bedrock_map::{assets, config, doctor, resources::Resources, result, server, state::State};
use clap::{Parser, Subcommand};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

const BUILD_COMMIT: &str = env!("BEDROCK_MAP_BUILD_COMMIT");

#[derive(Parser)]
#[command(
    name = "bedrock-map",
    about = "Serve immutable Bedrock Surface Map snapshots"
)]
struct Args {
    #[arg(long, global = true, env = "BEDROCK_MAP_STATE")]
    state: Option<PathBuf>,
    #[arg(long, global = true)]
    resources: Option<PathBuf>,
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(name = "internal-run", hide = true)]
    InternalRun {
        #[arg(value_enum)]
        service: bedrock_map::deploy::launch::Service,
    },
    /// Prepare an independently managed live-map deployment.
    Deploy {
        #[command(subcommand)]
        command: DeployCommand,
    },
    #[command(name = "internal-health", hide = true)]
    InternalHealth {
        #[arg(value_enum)]
        service: bedrock_map::health::Service,
    },
    Init,
    Demo {
        #[arg(long)]
        replace_active: bool,
    },
    Import {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        assets: Option<PathBuf>,
        #[arg(long, default_value = "Bedrock World")]
        name: String,
        #[arg(long)]
        replace_active: bool,
    },
    Serve {
        #[arg(long)]
        bind: Option<String>,
    },
    Status,
    Doctor {
        #[arg(long)]
        url: Option<String>,
    },
    Assets {
        #[command(subcommand)]
        command: AssetsCommand,
    },
}

#[derive(Subcommand)]
enum DeployCommand {
    /// Read-only local preflight, optionally checking this running project.
    Check {
        #[arg(long)]
        dir: PathBuf,
        #[arg(long)]
        running: bool,
        #[arg(long, requires = "running")]
        expect_live: bool,
        #[arg(long, requires = "running")]
        viewer_password_file: Option<PathBuf>,
    },
    /// Prepare one immutable snapshot and a new live store, without starting BDS.
    Prepare {
        #[arg(long)]
        dir: PathBuf,
        #[arg(long)]
        snapshot_state: PathBuf,
        #[arg(long)]
        assets: Option<PathBuf>,
    },
    /// Initialize private deployment identity and secrets; does not start services.
    Init {
        #[arg(long)]
        dir: PathBuf,
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        viewer_password_file: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum AssetsCommand {
    Verify {
        #[arg(long)]
        archive: PathBuf,
        #[arg(long)]
        expected_asset_sha256: Option<String>,
    },
    Fetch {
        #[arg(long)]
        acknowledge_asset_terms: bool,
    },
}

fn default_state() -> Result<PathBuf> {
    #[cfg(not(target_os = "macos"))]
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        let path = PathBuf::from(xdg);
        ensure!(
            path.is_absolute(),
            "E_CONFIG_INVALID: XDG_DATA_HOME must be absolute"
        );
        return Ok(path.join("bedrock-surface-map"));
    }
    let home = PathBuf::from(
        std::env::var_os("HOME").context("E_CONFIG_INVALID: HOME or --state is required")?,
    );
    #[cfg(target_os = "macos")]
    {
        Ok(home.join("Library/Application Support/bedrock-surface-map"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(home.join(".local/share/bedrock-surface-map"))
    }
}

fn resource(args: &Args) -> Result<Resources> {
    Resources::discover(args.resources.clone())
}
fn print(value: String, json_output: bool) {
    if json_output {
        println!("{value}");
    } else {
        println!(
            "{}",
            serde_json::from_str::<serde_json::Value>(&value)
                .map(|item| serde_json::to_string_pretty(&item).unwrap())
                .unwrap_or(value)
        );
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> std::process::ExitCode {
    if std::env::args_os().any(|arg| arg == "--version" || arg == "-V") {
        println!("bedrock-map {} ({BUILD_COMMIT})", env!("CARGO_PKG_VERSION"));
        return std::process::ExitCode::SUCCESS;
    }
    let json_output = std::env::args_os().any(|arg| arg == "--json");
    let args = match Args::try_parse() {
        Ok(args) => args,
        Err(error) => {
            if error.exit_code() == 0 {
                let _ = error.print();
                return std::process::ExitCode::SUCCESS;
            }
            if json_output {
                println!(
                    "{}",
                    json!({"schema_version":1,"ok":false,"command":"usage","error":{"code":"E_USAGE","message":error.to_string()}})
                );
            } else {
                let _ = error.print();
            }
            return std::process::ExitCode::from(2);
        }
    };
    let command = command_name(&args.command);
    match run(args).await {
        Ok(code) => std::process::ExitCode::from(code),
        Err(error) => {
            let code = error_code(&error);
            let response = json!({"schema_version":1,"ok":false,"command":command,"error":{"code":code,"message":format!("{error:#}"),"remediation":"Review the command input and state directory; no automatic repair was attempted."}});
            if json_output {
                println!("{response}");
            } else {
                eprintln!("{response}");
            }
            std::process::ExitCode::from(
                if matches!(
                    code,
                    "E_CONFIG_SCHEMA"
                        | "E_CONFIG_INVALID"
                        | "E_STATE_UNSAFE"
                        | "E_RESOURCE_MISMATCH"
                        | "E_NO_DATASET"
                        | "E_ASSET_MISSING"
                        | "E_ASSET_HASH"
                        | "E_ARCHIVE_INVALID"
                        | "E_WORLD_DIRECTORY_UNSUPPORTED"
                        | "E_INPUT_CHANGED"
                        | "E_IMPORT_LIMIT"
                        | "E_REPLACE_REQUIRED"
                ) {
                    2
                } else {
                    1
                },
            )
        }
    }
}

fn command_name(command: &Command) -> &'static str {
    match command {
        Command::InternalRun { .. } => "internal-run",
        Command::Deploy {
            command: DeployCommand::Prepare { .. },
        } => "deploy.prepare",
        Command::Deploy {
            command: DeployCommand::Init { .. },
        } => "deploy.init",
        Command::Deploy {
            command: DeployCommand::Check { .. },
        } => "deploy.check",
        Command::InternalHealth { .. } => "internal-health",
        Command::Init => "init",
        Command::Demo { .. } => "demo",
        Command::Import { .. } => "import",
        Command::Serve { .. } => "serve",
        Command::Status => "status",
        Command::Doctor { .. } => "doctor",
        Command::Assets {
            command: AssetsCommand::Verify { .. },
        } => "assets.verify",
        Command::Assets {
            command: AssetsCommand::Fetch { .. },
        } => "assets.fetch",
    }
}

async fn run(args: Args) -> Result<u8> {
    if let Command::Deploy { command } = &args.command {
        match command {
            DeployCommand::Check {
                dir,
                running,
                expect_live,
                viewer_password_file,
            } => {
                use bedrock_map::deploy::{check, config::Access, init};
                let (config, _) = init::load(dir)?;
                let password = if *running && config.viewer.access == Access::Password {
                    Some(init::read_password(viewer_password_file.as_deref(), false)?)
                } else {
                    ensure!(
                        viewer_password_file.is_none(),
                        "E_CONFIG_INVALID: this check does not use a viewer password"
                    );
                    None
                };
                let report = check::check(
                    dir,
                    &resource(&args)?,
                    *running,
                    *expect_live,
                    password.as_deref(),
                )
                .await?;
                let ok = report.ok();
                print(
                    serde_json::to_string(
                        &json!({"schema_version":1,"ok":ok,"command":"deploy.check","status":report.status,"checks":report.checks}),
                    )?,
                    args.json,
                );
                return Ok(if ok { 0 } else { 3 });
            }
            DeployCommand::Prepare {
                dir,
                snapshot_state,
                assets,
            } => {
                let source = State::new(snapshot_state.clone())?;
                let record = bedrock_map::deploy::prepare::prepare(
                    dir,
                    &source,
                    &resource(&args)?,
                    assets.as_deref(),
                )?;
                print(
                    result(
                        "deploy.prepare",
                        json!({"directory":dir,"status":"prepared","world_id":record.world_id,
                    "generation":record.generation,"dataset_id":record.dataset_id,"runtime_checked":false}),
                    )?,
                    args.json,
                );
            }
            DeployCommand::Init {
                dir,
                config,
                viewer_password_file,
            } => {
                use bedrock_map::deploy::{
                    config::{Access, Config},
                    init,
                    release::Release,
                };
                ensure!(
                    fs::metadata(config)?.len() <= 16 * 1024,
                    "E_CONFIG_INVALID: deployment configuration too large"
                );
                let config = Config::parse(&fs::read_to_string(config)?)?;
                let resources = resource(&args)?;
                let release = Release::load(&resources)?;
                let existing = dir.try_exists()?;
                let password = if config.viewer.access == Access::Password
                    && (!existing || viewer_password_file.is_some())
                {
                    Some(init::read_password(
                        viewer_password_file.as_deref(),
                        !existing,
                    )?)
                } else {
                    ensure!(
                        viewer_password_file.is_none(),
                        "E_CONFIG_INVALID: public access does not use a password"
                    );
                    None
                };
                let lock = init::initialize(dir, &config, &release, password.as_deref())?;
                print(
                    result(
                        "deploy.init",
                        json!({"directory":dir,"world_id":lock.world_id,"generation":lock.generation,
                    "changed":!existing,"status":"initialized","runtime_checked":false}),
                    )?,
                    args.json,
                );
            }
        }
        return Ok(0);
    }
    if let Command::InternalHealth { service } = &args.command {
        bedrock_map::health::check(*service).await?;
        return Ok(0);
    }
    if let Command::InternalRun { service } = &args.command {
        bedrock_map::deploy::launch::run(*service)?;
        unreachable!("successful launcher replaces the process");
    }
    let state = State::new(match args.state.clone() {
        Some(path) => path,
        None => default_state()?,
    })?;
    match &args.command {
        Command::InternalRun { .. } => unreachable!("handled before snapshot state resolution"),
        Command::Deploy { .. } => unreachable!("handled before snapshot state resolution"),
        Command::InternalHealth { .. } => unreachable!("handled before snapshot state resolution"),
        Command::Init => {
            let config = state.init()?;
            print(
                result("init", json!({"state":state.root,"config":config}))?,
                args.json,
            );
        }
        Command::Demo { replace_active } => {
            let _lock = state.lock_mutation()?;
            let resources = resource(&args)?;
            let fixture = resources.fixture();
            ensure!(
                fixture.join("manifest.json").is_file(),
                "E_RESOURCE_MISMATCH: bundled synthetic fixture is missing"
            );
            let active = with_operation(&state, "demo", |operation| {
                let public = operation.join("public");
                copy_tree(&fixture, &public)?;
                let source = hash_file(&public.join("manifest.json"))?;
                state.register_staged_dataset(&public, source, *replace_active)
            })?;
            print(
                result(
                    "demo",
                    json!({"dataset":active.dataset_id,"synthetic":true}),
                )?,
                args.json,
            );
        }
        Command::Import {
            input,
            assets,
            name,
            replace_active,
        } => {
            let _lock = state.lock_mutation()?;
            ensure!(
                input.is_file(),
                "E_WORLD_DIRECTORY_UNSUPPORTED: import accepts an offline .mcworld/.zip archive, not a directory"
            );
            let (active, report) = with_operation(&state, "import", |operation| {
                let public = operation.join("public");
                let asset_archive = match assets {
                    Some(archive) => {
                        let digest = assets::verify(archive, None)?;
                        bedrock_map::state::write_atomic(
                            &state.asset_record_path(&digest)?,
                            &serde_json::to_vec_pretty(
                                &json!({"schema_version":1,"provenance":"user_supplied","sha256":digest}),
                            )?,
                        )?;
                        archive.clone()
                    }
                    None => {
                        let resources = resource(&args)?;
                        state.asset_archive(&assets::managed_digest(&resources)?)?
                    }
                };
                let report = surface_cli::import_snapshot(&surface_cli::ImportOptions {
                    input_archive: input.clone(),
                    output_directory: public.clone(),
                    scratch_directory: operation.join("scratch"),
                    asset_archive,
                    display_name: name.clone(),
                    surface_only: false,
                })?;
                let source = report
                    .get("source_sha256")
                    .and_then(|item| item.as_str())
                    .context("E_ARCHIVE_INVALID: importer omitted source fingerprint")?
                    .to_owned();
                let private_report = public.join("import-report.json");
                if private_report.exists() {
                    fs::rename(&private_report, operation.join("import-report.json"))?;
                }
                let active = state.register_staged_dataset(&public, source, *replace_active)?;
                Ok((active, report))
            })?;
            print(
                result(
                    "import",
                    json!({"dataset":active.dataset_id,"report":report}),
                )?,
                args.json,
            );
        }
        Command::Serve { bind } => {
            let config = state.config()?;
            let address = config::socket_address(&config, bind.as_deref())?;
            let resources = resource(&args)?;
            resources.validate_release()?;
            resources.require_web()?;
            let _ = state
                .active_validated()?
                .context("E_NO_DATASET: run demo or import before serve")?;
            let listener = tokio::net::TcpListener::bind(address)
                .await
                .context("E_BIND: cannot bind loopback listener")?;
            let actual = listener.local_addr()?;
            let url = format!("http://{}{}", actual, config.server.base_path);
            if args.json {
                println!(
                    "{}",
                    json!({"schema_version":1,"ok":true,"command":"serve","event":"ready","url":url})
                );
            } else {
                println!("Serving snapshot at {url}");
            }
            server::serve(state, resources, config, listener).await?;
            if args.json {
                println!(
                    "{}",
                    json!({"schema_version":1,"ok":true,"command":"serve","event":"shutdown"})
                );
            }
        }
        Command::Status => {
            let config = state.config()?;
            print(
                result(
                    "status",
                    json!({"state":state.root,"config":config,"active":state.active_validated()?}),
                )?,
                args.json,
            );
        }
        Command::Doctor { url } => {
            // A packaged invocation normally discovers resources adjacent to
            // its executable. Doctor reports discovery failures as a check
            // result instead of requiring an otherwise unnecessary flag.
            let resources = resource(&args);
            let report = doctor::check(
                &state,
                resources.as_ref().map_err(|error| format!("{error:#}")),
                state.config().map_err(|error| format!("{error:#}")),
                url.as_deref(),
            )
            .await?;
            let ok = report.ok();
            print(
                serde_json::to_string(
                    &json!({"schema_version":1,"ok":ok,"command":"doctor","checks":report.checks}),
                )?,
                args.json,
            );
            return Ok(if ok { 0 } else { 3 });
        }
        Command::Assets { command } => match command {
            AssetsCommand::Verify {
                archive,
                expected_asset_sha256,
            } => {
                let found = assets::verify(archive, expected_asset_sha256.as_deref())?;
                print(
                    result(
                        "assets.verify",
                        json!({"archive":archive,"sha256":found,"provenance":"user_supplied"}),
                    )?,
                    args.json,
                );
            }
            AssetsCommand::Fetch {
                acknowledge_asset_terms,
            } => {
                ensure!(
                    *acknowledge_asset_terms,
                    "E_NETWORK: assets fetch requires --acknowledge-asset-terms"
                );
                let _lock = state.lock_mutation()?;
                let resources = resource(&args)?;
                let (archive, sha256) = assets::fetch(&state, &resources).await?;
                print(
                    result(
                        "assets.fetch",
                        json!({"archive":archive,"sha256":sha256,"provenance":"verified_mojang"}),
                    )?,
                    args.json,
                );
            }
        },
    }
    Ok(0)
}

fn with_operation<T>(
    state: &State,
    prefix: &str,
    run: impl FnOnce(&std::path::Path) -> Result<T>,
) -> Result<T> {
    let operation = state.operation(prefix)?;
    let outcome = run(operation.path());
    let cleanup = operation.close();
    match (outcome, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(value), Err(error)) => {
            eprintln!(
                "E_STATE_UNSAFE: operation completed, but private staging cleanup failed: {error}"
            );
            Ok(value)
        }
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup)) => {
            Err(error.context(format!("private staging cleanup also failed: {cleanup}")))
        }
    }
}

fn hash_file(path: &std::path::Path) -> Result<String> {
    let bytes = fs::read(path)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn copy_tree(source: &std::path::Path, target: &std::path::Path) -> Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&from, &to)?;
        } else if entry.file_type()?.is_file() {
            fs::copy(&from, &to)?;
        } else {
            bail!("E_RESOURCE_MISMATCH: unsupported bundled fixture entry");
        }
    }
    Ok(())
}
fn error_code(error: &anyhow::Error) -> &'static str {
    let message = format!("{error:#}");
    for code in [
        "E_CONFIG_SCHEMA",
        "E_CONFIG_INVALID",
        "E_STATE_UNSAFE",
        "E_STATE_BUSY",
        "E_PREPARED_DURABILITY",
        "E_RESOURCE_MISMATCH",
        "E_NO_DATASET",
        "E_ASSET_MISSING",
        "E_ASSET_HASH",
        "E_ARCHIVE_INVALID",
        "E_WORLD_DIRECTORY_UNSUPPORTED",
        "E_INPUT_CHANGED",
        "E_IMPORT_LIMIT",
        "E_REPLACE_REQUIRED",
        "E_BIND",
        "E_NETWORK",
    ] {
        if message.contains(code) {
            return code;
        }
    }
    "E_RUNTIME"
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn published_durability_failure_has_a_distinct_error_code() {
        let error = anyhow::anyhow!("E_PREPARED_DURABILITY: prepared/ was published");
        assert_eq!(error_code(&error), "E_PREPARED_DURABILITY");
    }

    #[test]
    fn committed_selection_survives_private_cleanup_failure() {
        let temporary = tempfile::tempdir().unwrap();
        let state = State::new(temporary.path().join("state")).unwrap();
        state.init().unwrap();
        let selected = with_operation(&state, "demo", |operation| {
            let public = operation.join("public");
            surface_cli::create_synthetic_fixture(&public)?;
            let selected = state.register_staged_dataset(&public, "a".repeat(64), false)?;
            let blocked = operation.join("blocked");
            fs::create_dir(&blocked)?;
            fs::write(blocked.join("retained"), b"private scratch")?;
            fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000))?;
            Ok(selected)
        })
        .unwrap();
        assert_eq!(
            state.active_validated().unwrap().unwrap().dataset_id,
            selected.dataset_id
        );
        let operations: Vec<_> = fs::read_dir(state.staging()).unwrap().collect();
        assert_eq!(operations.len(), 1);
        for operation in operations {
            let operation = operation.unwrap().path();
            fs::set_permissions(operation.join("blocked"), fs::Permissions::from_mode(0o700))
                .unwrap();
            fs::remove_dir_all(operation).unwrap();
        }
    }
}
