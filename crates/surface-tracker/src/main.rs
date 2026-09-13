use std::{
    env,
    net::SocketAddr,
    time::{Duration, Instant},
};
use surface_tracker::{App, ingest_router, read_router};

async fn terminate() {
    #[cfg(unix)]
    {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler")
            .recv()
            .await;
    }
    #[cfg(not(unix))]
    std::future::pending::<()>().await;
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = std::fs::read_to_string(env::var("TRACKER_TOKEN_FILE")?)?;
    let app = App::new(
        env::var("TRACKER_WORLD_ID")?,
        token.trim().as_bytes().to_vec(),
        env::var("TRACKER_DISABLED").as_deref() == Ok("true"),
    )?;
    let ingest: SocketAddr = env::var("TRACKER_INGEST_BIND")
        .unwrap_or("127.0.0.1:8081".into())
        .parse()?;
    let read: SocketAddr = env::var("TRACKER_READ_BIND")
        .unwrap_or("127.0.0.1:8110".into())
        .parse()?;
    let a = tokio::net::TcpListener::bind(ingest).await?;
    let b = tokio::net::TcpListener::bind(read).await?;
    let store = app.store.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            store.lock().unwrap().view(Instant::now());
        }
    });
    eprintln!("surface-tracker ready; position payloads and credentials are not logged");
    tokio::select! {
        result = axum::serve(a, ingest_router(app.clone())) => result?,
        result = axum::serve(b, read_router(app)) => result?,
        _ = tokio::signal::ctrl_c() => (),
        _ = terminate() => (),
    }
    Ok(())
}
