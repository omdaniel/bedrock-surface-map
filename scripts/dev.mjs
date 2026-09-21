import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { probe, run } from "./onramp/process.mjs";
import { installGitleaks, readPins } from "./onramp/tools.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const [command = "doctor", ...arguments_] = process.argv.slice(2);
const offline = arguments_.includes("--offline");
const hooks = arguments_.includes("--install-hooks");
const nodePin = (await readFile(resolve(root, ".node-version"), "utf8")).trim();
const pins = await readPins(root);

function requireVersion(command, args, expected, label) {
  const value = probe(command, args);
  if (!value?.includes(expected))
    throw new Error(
      `${label} ${expected} is required; found ${value ?? "not installed"}`,
    );
}
function prerequisites() {
  requireVersion("node", ["--version"], nodePin, "Node");
  requireVersion("rustc", ["--version"], "1.92.0", "Rust");
  if (!probe("git", ["--version"])) throw new Error("Git is required");
}
async function cached(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`Offline setup is missing ${label}: ${path}`);
  }
}

try {
  if (command === "doctor") {
    prerequisites();
    const report = {
      node: probe("node", ["--version"]),
      rust: probe("rustc", ["--version"]),
      wasm_bindgen: probe("wasm-bindgen", ["--version"]),
      cargo_zigbuild: probe("cargo-zigbuild", ["--version"]),
      zig: probe("python-zig", ["version"]),
      synthetic_only: true,
    };
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "setup") {
    prerequisites();
    if (offline) {
      await cached(resolve(root, "node_modules"), "npm dependencies");
      if (!probe("wasm-bindgen", ["--version"])?.includes("0.2.127"))
        throw new Error("Offline setup is missing wasm-bindgen 0.2.127");
      if (
        !probe("rustup", ["target", "list", "--installed"])?.includes(
          "wasm32-unknown-unknown",
        )
      )
        throw new Error("Offline setup is missing wasm32-unknown-unknown");
    } else {
      run("rustup", [
        "target",
        "add",
        "wasm32-unknown-unknown",
        "--toolchain",
        "1.92.0",
      ]);
      if (!probe("wasm-bindgen", ["--version"])?.includes("0.2.127"))
        run("cargo", [
          "install",
          "wasm-bindgen-cli",
          "--version",
          "0.2.127",
          "--locked",
        ]);
      run("npm", ["ci"], { cwd: root });
    }
    // The scanner is project-local. It does not change Git configuration unless
    // the caller separately asks to install the optional hook path.
    const scanner = await installGitleaks(root, pins, offline);
    if (hooks) {
      const existing = probe("git", [
        "config",
        "--local",
        "--get",
        "core.hooksPath",
      ]);
      if (existing && existing !== ".githooks")
        throw new Error(
          `Existing repository hook path is not project-owned: ${existing}`,
        );
      run("git", ["config", "--local", "core.hooksPath", ".githooks"], {
        cwd: root,
      });
      console.log(`Installed project hooks with ${scanner}`);
    }
    run("npm", ["run", "wasm"], { cwd: root });
    run(
      "cargo",
      [
        "run",
        "--release",
        "--locked",
        "-p",
        "surface-cli",
        "--",
        "fixture",
        "--output",
        "web/public/maps/fixture",
      ],
      { cwd: root },
    );
    console.log(
      `Developer setup complete with ${scanner}. No Minecraft assets were downloaded.`,
    );
  } else if (command === "demo") {
    run("npm", ["run", "dev", "--", "--host", "127.0.0.1"], {
      cwd: root,
      env: { ...process.env, SURFACE_MAP: "maps/fixture/manifest.json" },
    });
  } else if (command === "check") {
    const profile = arguments_[arguments_.indexOf("--profile") + 1] ?? "fast";
    run("cargo", ["fmt", "--all", "--check"], { cwd: root });
    run("npm", ["run", "format:check"], { cwd: root });
    run("npm", ["run", "check"], { cwd: root });
    run(
      "cargo",
      ["test", "-p", "bedrock-map", "-p", "surface-cli", "--locked"],
      { cwd: root },
    );
    if (profile === "full")
      run("cargo", ["test", "--workspace", "--locked"], { cwd: root });
    else if (profile !== "fast")
      throw new Error(`Unknown check profile: ${profile}`);
  } else if (command === "package") {
    const target = arguments_[arguments_.indexOf("--target") + 1];
    if (!target) throw new Error("package requires --target <triple>");
    requireVersion(
      "cargo-zigbuild",
      ["--version"],
      pins.cargo_zigbuild.version,
      "cargo-zigbuild",
    );
    requireVersion("python-zig", ["version"], pins.zig.version, "Zig");
    const zig = probe("which", ["python-zig"]);
    run("node", ["scripts/release/build-package.mjs", target], {
      cwd: root,
      env: { ...process.env, CARGO_ZIGBUILD_ZIG_PATH: zig },
    });
  } else throw new Error(`Unknown dev command: ${command}`);
} catch (error) {
  console.error(`dev: ${error.message}`);
  process.exitCode = 2;
}
