use anyhow::{Context, Result, bail, ensure};
use bedrock_map::{config, doctor, resources::Resources, result, server, state::State};
use clap::{Parser, Subcommand};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

#[derive(Parser)]
#[command(
    name = "bedrock-map",
    about = "Serve immutable Bedrock Surface Map snapshots"
)]
struct Args {
    #[arg(long, env = "BEDROCK_MAP_STATE")]
    state: Option<PathBuf>,
    #[arg(long)]
    resources: Option<PathBuf>,
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Init,
    Demo {
        #[arg(long)]
        replace_active: bool,
    },
    Import {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        assets: PathBuf,
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
    let home = std::env::var_os("HOME").context("HOME is required when --state is not supplied")?;
    let home = PathBuf::from(home);
    #[cfg(target_os = "macos")]
    {
        Ok(home.join("Library/Application Support/bedrock-surface-map"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("bedrock-surface-map"))
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
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!(
                "{}",
                json!({"schema_version":1,"ok":false,"error":{"code": error_code(&error),"message":format!("{error:#}"),"remediation":"Review the command input and state directory; no automatic repair was attempted."}})
            );
            if format!("{error:#}").contains("E_CONFIG")
                || format!("{error:#}").contains("E_STATE")
                || format!("{error:#}").contains("E_RESOURCE")
            {
                std::process::ExitCode::from(2)
            } else {
                std::process::ExitCode::FAILURE
            }
        }
    }
}

async fn run() -> Result<()> {
    let args = Args::parse();
    let state = State::new(args.state.clone().unwrap_or(default_state()?))?;
    match &args.command {
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
            let operation = state.staging().join(format!("demo-{}", std::process::id()));
            let public = operation.join("public");
            copy_tree(&fixture, &public)?;
            let source = hash_file(&public.join("manifest.json"))?;
            let active = state.register_staged_dataset(&public, source, *replace_active)?;
            let _ = fs::remove_dir_all(operation);
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
            let operation = state
                .staging()
                .join(format!("import-{}", std::process::id()));
            fs::create_dir(&operation)?;
            let public = operation.join("public");
            let report = surface_cli::import_snapshot(&surface_cli::ImportOptions {
                input_archive: input.clone(),
                output_directory: public.clone(),
                scratch_directory: operation.join("scratch"),
                asset_archive: assets.clone(),
                display_name: name.clone(),
                surface_only: false,
            });
            match report {
                Ok(report) => {
                    let source = report
                        .get("source_sha256")
                        .and_then(|item| item.as_str())
                        .context("E_ARCHIVE_INVALID: importer omitted source fingerprint")?
                        .to_owned();
                    let active = state.register_staged_dataset(&public, source, *replace_active)?;
                    let _ = fs::remove_dir_all(operation);
                    print(
                        result(
                            "import",
                            json!({"dataset":active.dataset_id,"report":report}),
                        )?,
                        args.json,
                    );
                }
                Err(error) => {
                    let _ = fs::remove_dir_all(operation);
                    return Err(error);
                }
            }
        }
        Command::Serve { bind } => {
            let config = state.config()?;
            let address = config::socket_address(&config, bind.as_deref())?;
            let resources = resource(&args)?;
            let _ = state
                .active()?
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
                    json!({"state":state.root,"config":config,"active":state.active()?}),
                )?,
                args.json,
            );
        }
        Command::Doctor { url } => {
            let config = state.config()?;
            let resources = args
                .resources
                .as_ref()
                .map(|_| resource(&args))
                .transpose()?;
            let report = doctor::check(&state, resources.as_ref(), &config);
            if let Some(url) = url {
                ensure!(
                    url.starts_with("http://127.0.0.1:") || url.starts_with("http://[::1]:"),
                    "E_CONFIG_INVALID: doctor URL must use loopback"
                );
            }
            print(result("doctor", report)?, args.json);
        }
        Command::Assets { command } => match command {
            AssetsCommand::Verify {
                archive,
                expected_asset_sha256,
            } => {
                let found = hash_file(archive)?;
                if let Some(expected) = expected_asset_sha256 {
                    ensure!(
                        expected == &found,
                        "E_ASSET_HASH: supplied asset archive checksum differs"
                    );
                }
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
                bail!(
                    "E_NETWORK: managed asset fetching is not implemented yet; provide --assets to import instead"
                );
            }
        },
    }
    Ok(())
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
