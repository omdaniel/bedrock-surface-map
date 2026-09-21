use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
};

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_bedrock-map")
}

fn package(root: &Path) -> std::path::PathBuf {
    let resources = root.join("package/share/bedrock-surface-map");
    let web = resources.join("web");
    fs::create_dir_all(&web).unwrap();
    fs::write(web.join("index.html"), "<title>fixture</title>").unwrap();
    surface_cli::create_synthetic_fixture(&resources.join("fixtures/surface-v1")).unwrap();
    fn walk(root: &Path, directory: &Path, files: &mut Vec<Value>) {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &entry.path(), files);
            } else {
                let bytes = fs::read(entry.path()).unwrap();
                files.push(
                    json!({"path":entry.path().strip_prefix(root).unwrap().to_str().unwrap(),
                    "bytes":bytes.len(),"sha256":format!("{:x}", Sha256::digest(bytes))}),
                );
            }
        }
    }
    let mut files = Vec::new();
    walk(&root.join("package"), &resources, &mut files);
    fs::write(
        root.join("package/release-manifest.json"),
        serde_json::to_vec(&json!({
            "schema_version":1,"application_version":"0.1.0","commit":"a".repeat(40),
            "target":"x86_64-unknown-linux-musl","files":files
        }))
        .unwrap(),
    )
    .unwrap();
    resources
}

fn command(state: &Path, resources: &Path) -> Command {
    let mut cmd = Command::new(binary());
    cmd.env_remove("HOME")
        .arg("--json")
        .arg("--state")
        .arg(state)
        .arg("--resources")
        .arg(resources);
    cmd
}

fn output(mut cmd: Command, expected: i32) -> Value {
    let out = cmd.output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(expected),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn unrelated_response(state: &Path, resources: &Path, response: &'static str) -> Value {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let task = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let mut request = [0u8; 1024];
        let _ = stream.read(&mut request).unwrap();
        stream.write_all(response.as_bytes()).unwrap();
    });
    let mut cmd = command(state, resources);
    cmd.arg("doctor")
        .arg("--url")
        .arg(format!("http://{address}/"));
    let result = output(cmd, 3);
    task.join().unwrap();
    result
}

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn doctor_reports_failures_and_probes_only_a_real_ready_service() {
    let temp = tempfile::tempdir().unwrap();
    let state = temp.path().join("state with spaces é");
    let resources = package(temp.path());
    let mut cmd = command(&state, &resources);
    cmd.arg("doctor");
    let failed = output(cmd, 3);
    assert_eq!(failed["ok"], false);
    assert_eq!(failed["checks"][0]["status"], "fail");
    let mut cmd = command(&state, &resources);
    cmd.arg("init");
    assert_eq!(output(cmd, 0)["ok"], true);
    let mut environment_state = Command::new(binary());
    environment_state
        .env_remove("HOME")
        .env("BEDROCK_MAP_STATE", &state)
        .arg("--json")
        .arg("status");
    assert_eq!(output(environment_state, 0)["ok"], true);
    let mut explicit_wins = command(&state, &resources);
    explicit_wins
        .env("BEDROCK_MAP_STATE", temp.path().join("not-selected"))
        .arg("status");
    assert_eq!(output(explicit_wins, 0)["ok"], true);
    let mut cmd = command(&state, &resources);
    cmd.arg("doctor");
    assert_eq!(output(cmd, 3)["ok"], false);
    let mut cmd = command(&state, &resources);
    cmd.arg("demo");
    assert_eq!(output(cmd, 0)["ok"], true);
    let mut cmd = command(&state, &resources);
    cmd.arg("doctor");
    assert_eq!(output(cmd, 0)["ok"], true);
    fs::write(resources.join("web/index.html"), "corrupted").unwrap();
    let mut cmd = command(&state, &resources);
    cmd.arg("doctor");
    assert_eq!(output(cmd, 3)["ok"], false);
    fs::write(resources.join("web/index.html"), "<title>fixture</title>").unwrap();

    let mut cmd = command(&state, &resources);
    cmd.arg("doctor").arg("--url").arg("http://127.0.0.1:1/");
    let closed = output(cmd, 3);
    assert_eq!(closed["ok"], false);
    assert_eq!(
        closed["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "readiness-url")
            .unwrap()["status"],
        "fail"
    );
    for url in [
        "http://example.org:80/",
        "http://user:pass@127.0.0.1:1/",
        "http://127.0.0.1:1/wrong/",
        "not-a-url",
    ] {
        let mut cmd = command(&state, &resources);
        cmd.arg("doctor").arg("--url").arg(url);
        let out = cmd.output().unwrap();
        assert_eq!(
            out.status.code(),
            Some(2),
            "{url}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let fake_ok = unrelated_response(
        &state,
        &resources,
        "HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"ready\":true}",
    );
    assert_eq!(fake_ok["ok"], false);
    let redirect = unrelated_response(
        &state,
        &resources,
        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    assert_eq!(redirect["ok"], false);
    let mut server = command(&state, &resources);
    server
        .arg("serve")
        .arg("--bind")
        .arg("127.0.0.1:0")
        .stdout(Stdio::piped());
    let mut server = Server(server.spawn().unwrap());
    let mut line = String::new();
    BufReader::new(server.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["event"], "ready");
    let mut cmd = command(&state, &resources);
    cmd.arg("doctor")
        .arg("--url")
        .arg(ready["url"].as_str().unwrap());
    assert_eq!(output(cmd, 0)["ok"], true);
}

#[test]
fn failed_import_does_not_leave_private_staging_or_change_selection() {
    let temp = tempfile::tempdir().unwrap();
    let state = temp.path().join("state");
    let resources = package(temp.path());
    let mut cmd = command(&state, &resources);
    cmd.arg("demo");
    let selected = output(cmd, 0)["dataset"].as_str().unwrap().to_owned();
    let archive = temp.path().join("fake.mcworld");
    fs::write(&archive, b"not a world").unwrap();
    let mut cmd = command(&state, &resources);
    cmd.arg("import")
        .arg("--input")
        .arg(&archive)
        .arg("--assets")
        .arg(temp.path().join("missing.zip"));
    assert!(!cmd.output().unwrap().status.success());
    assert_eq!(fs::read_dir(state.join("staging")).unwrap().count(), 0);
    let mut cmd = command(&state, &resources);
    cmd.arg("status");
    assert_eq!(output(cmd, 0)["active"]["dataset_id"], selected);
}
