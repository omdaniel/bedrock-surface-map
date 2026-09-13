use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use surface_sync::{
    http::{App, ingest_router, read_router},
    store::{Boundary, Store, now_ms},
};

#[derive(Parser)]
struct Args {
    #[arg(long, env = "TERRAIN_STATE", default_value = ".local/terrain/state")]
    state: PathBuf,
    #[arg(long, env = "TERRAIN_WORLD_ID")]
    world: String,
    #[arg(long, env = "TERRAIN_GENERATION")]
    generation: String,
    #[arg(long, env = "TERRAIN_STORE_LIMIT", default_value_t = 2147483648)]
    limit: u64,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Observe {
        #[arg(long)]
        input: PathBuf,
    },
    Manifest,
    RefreshCatalog,
    Chunk {
        #[arg(long, allow_hyphen_values = true)]
        x: i32,
        #[arg(long, allow_hyphen_values = true)]
        z: i32,
    },
    Serve {
        #[arg(long, env = "TERRAIN_TOKEN_FILE")]
        token_file: PathBuf,
        #[arg(long, env = "TERRAIN_INGEST_BIND", default_value = "127.0.0.1:8082")]
        ingest: String,
        #[arg(long, env = "TERRAIN_READ_BIND", default_value = "127.0.0.1:8111")]
        read: String,
    },
    Seed {
        #[arg(long)]
        map: PathBuf,
        #[arg(long)]
        library: Option<PathBuf>,
        #[arg(long)]
        boundary: Option<PathBuf>,
    },
    Boundary,
    Status,
    Gc,
    Disable {
        #[arg(long, default_value = "operator-disabled")]
        reason: String,
    },
    Enable,
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut store = Store::open(&args.state, &args.world, &args.generation, args.limit)?;
    match args.command {
        Command::Observe { input } => {
            let bytes = std::fs::read(input)?;
            anyhow::ensure!(
                bytes.len() <= surface_core::terrain::MAX_REQUEST_BYTES,
                "observation size"
            );
            let observation = serde_json::from_slice(&bytes)?;
            println!("changed={}", store.ingest(&observation, now_ms())?);
        }
        Command::Manifest => println!("{}", store.manifest()?),
        Command::RefreshCatalog => println!(
            "{}",
            serde_json::json!({"updated_materials":store.refresh_catalog()?})
        ),
        Command::Chunk { x, z } => {
            let hash: String = store.connection.query_row(
                "SELECT hash FROM chunks WHERE cx=?1 AND cz=?2",
                rusqlite::params![x, z],
                |r| r.get(0),
            )?;
            let bytes = store.object(&format!("{hash}.zst"))?;
            let chunk = surface_core::terrain::SurfaceChunk::decode(&surface_core::decompress(
                &bytes, 32768,
            )?)?;
            println!("{}", serde_json::to_string(&chunk)?);
        }
        Command::Serve {
            token_file,
            ingest,
            read,
        } => {
            let token = std::fs::read_to_string(token_file)?;
            let app = App::new(store, token.trim().as_bytes().to_vec(), args.world)?;
            let a = tokio::net::TcpListener::bind(ingest).await?;
            let b = tokio::net::TcpListener::bind(read).await?;
            let gc = app.store.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(600));
                loop {
                    interval.tick().await;
                    let gc = gc.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Ok(mut s) = gc.lock()
                            && s.gc(now_ms()).is_err()
                        {
                            s.error("cleanup-failed");
                        }
                    })
                    .await;
                }
            });
            eprintln!("surface-sync ready; terrain payloads and credentials are not logged");
            tokio::select! { result=axum::serve(a,ingest_router(app.clone()))=>result?,result=axum::serve(b,read_router(app))=>result?,_ = tokio::signal::ctrl_c()=>(),_ = terminate()=>() }
        }
        Command::Seed {
            map,
            library,
            boundary,
        } => {
            let boundary = boundary
                .map(|p| -> Result<Boundary> { Ok(serde_json::from_slice(&std::fs::read(p)?)?) })
                .transpose()?;
            println!(
                "{}",
                store.seed(&map, library.as_deref(), boundary.as_ref())?
            );
        }
        Command::Boundary => println!("{}", serde_json::to_string(&store.boundary()?)?),
        Command::Status => println!("{}", store.health(now_ms())?),
        Command::Gc => println!("removed {} unreferenced objects", store.gc(now_ms())?),
        Command::Disable { reason } => store.disable(true, &reason)?,
        Command::Enable => store.disable(false, "starting")?,
    }
    Ok(())
}
async fn terminate() {
    #[cfg(unix)]
    {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM")
            .recv()
            .await;
    }
    #[cfg(not(unix))]
    std::future::pending::<()>().await;
}
