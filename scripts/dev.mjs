import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probe, run } from "./onramp/process.mjs";
import { installGitleaks, readPins } from "./onramp/tools.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [command = "doctor", ...arguments_] = process.argv.slice(2);
const offline = arguments_.includes("--offline");
const hooks = arguments_.includes("--install-hooks");
const nodePin = (await readFile(resolve(root, ".node-version"), "utf8")).trim();
const pins = await readPins(root);
const rustToolchain = await readFile(
  resolve(root, "rust-toolchain.toml"),
  "utf8",
);
const rustPin = rustToolchain.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
const cargoLock = await readFile(resolve(root, "Cargo.lock"), "utf8");
const lockedWasm = cargoLock.match(
  /\[\[package\]\]\s+name = "wasm-bindgen"\s+version = "([^"]+)"/,
)?.[1];
if (!rustPin || !lockedWasm || lockedWasm !== pins.wasm_bindgen.version)
  throw new Error("tool pins disagree with rust-toolchain.toml or Cargo.lock");
const wasmRoot = resolve(root, ".sources/tools/wasm-bindgen", lockedWasm);
const localWasm = resolve(wasmRoot, "bin/wasm-bindgen");
process.env.PATH = `${resolve(wasmRoot, "bin")}:${process.env.PATH ?? ""}`;
if (offline) {
  process.env.CARGO_NET_OFFLINE = "true";
  process.env.npm_config_offline = "true";
  process.env.RUSTUP_AUTO_INSTALL = "0";
}

function requireVersion(command, args, expected, label) {
  const value = probe(command, args);
  if (!value?.includes(expected))
    throw new Error(
      `${label} ${expected} is required; found ${value ?? "not installed"}`,
    );
}
function prerequisites() {
  requireVersion("node", ["--version"], nodePin, "Node");
  if (offline) {
    const installed = probe("rustup", ["toolchain", "list"]);
    if (
      !installed?.split("\n").some((line) => {
        const name = line.split(/\s/, 1)[0];
        return name === rustPin || name.startsWith(`${rustPin}-`);
      })
    )
      throw new Error(`Offline setup is missing Rust toolchain ${rustPin}`);
  }
  requireVersion("rustc", ["--version"], rustPin, "Rust");
  if (!probe("git", ["--version"])) throw new Error("Git is required");
}
try {
  if (command === "doctor") {
    prerequisites();
    const report = {
      node: probe("node", ["--version"]),
      rust: probe("rustc", ["--version"]),
      wasm_bindgen: probe(localWasm, ["--version"]),
      cargo_zigbuild: probe("cargo-zigbuild", ["--version"]),
      zig: probe("python-zig", ["version"]),
      synthetic_only: true,
    };
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "setup") {
    prerequisites();
    const setupEnv = process.env;
    if (offline) {
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
        rustPin,
      ]);
    }
    run("cargo", ["fetch", "--locked", ...(offline ? ["--offline"] : [])], {
      cwd: root,
      env: setupEnv,
    });
    if (!probe(localWasm, ["--version"])?.includes(lockedWasm)) {
      try {
        run(
          "cargo",
          [
            "install",
            "wasm-bindgen-cli",
            "--version",
            lockedWasm,
            "--locked",
            "--root",
            wasmRoot,
            ...(offline ? ["--offline"] : []),
          ],
          { cwd: root, env: setupEnv },
        );
      } catch (error) {
        if (offline)
          throw new Error(
            `Offline setup is missing wasm-bindgen ${lockedWasm} cache: ${error.message}`,
          );
        throw error;
      }
    }
    run("npm", ["ci", ...(offline ? ["--offline"] : [])], {
      cwd: root,
      env: setupEnv,
    });
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
    run("npm", ["run", "wasm"], { cwd: root, env: setupEnv });
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
      { cwd: root, env: setupEnv },
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
    run("npm", ["run", "release:test"], { cwd: root });
    run(
      "cargo",
      ["test", "-p", "bedrock-map", "-p", "surface-cli", "--locked"],
      { cwd: root },
    );
    if (profile === "full") {
      run("npm", ["run", "secrets:check"], { cwd: root });
      run("cargo", ["test", "--workspace", "--locked"], { cwd: root });
      run(
        "cargo",
        [
          "clippy",
          "--workspace",
          "--all-targets",
          "--locked",
          "--",
          "-D",
          "warnings",
        ],
        { cwd: root },
      );
      run(
        "cargo",
        [
          "clippy",
          "-p",
          "surface-gpu",
          "--target",
          "wasm32-unknown-unknown",
          "--locked",
          "--",
          "-D",
          "warnings",
        ],
        { cwd: root },
      );
      run("npm", ["run", "wasm"], { cwd: root });
      run("npm", ["run", "build"], { cwd: root });
      run("npm", ["run", "config:test"], { cwd: root });
      run("npm", ["run", "tracking:build"], { cwd: root });
      run("npm", ["run", "tracking:test"], { cwd: root });
      run("npm", ["run", "terrain:build"], { cwd: root });
      run("npm", ["run", "terrain:test"], { cwd: root });
      run("npm", ["run", "demo:test"], { cwd: root });
      run("npm", ["test"], { cwd: root });
      run("npm", ["run", "demo:build"], { cwd: root });
      run("node", ["scripts/audit-demo.mjs"], { cwd: root });
    } else if (profile !== "fast")
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
