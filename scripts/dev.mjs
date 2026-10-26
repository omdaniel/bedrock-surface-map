import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probe, run } from "./onramp/process.mjs";
import { installGitleaks, platform, readPins } from "./onramp/tools.mjs";
import {
  checkSteps,
  fixtureSteps,
  help,
  invocation,
} from "./onramp/commands.mjs";
import { diagnose, formatDiagnosis } from "./onramp/doctor.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function main() {
  // Validate the complete invocation before probing tools or running any work.
  const { command, values, tail } = invocation(process.argv.slice(2));
  if (command === "help") return console.log(help);
  const offline = Boolean(values.offline);
  const nodePin = (
    await readFile(resolve(root, ".node-version"), "utf8")
  ).trim();
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
    throw new Error(
      "tool pins disagree with rust-toolchain.toml or Cargo.lock",
    );
  const wasmRoot = resolve(root, ".sources/tools/wasm-bindgen", lockedWasm);
  const localWasm = resolve(wasmRoot, "bin/wasm-bindgen");
  process.env.PATH = `${resolve(wasmRoot, "bin")}:${process.env.PATH ?? ""}`;
  if (offline) {
    process.env.CARGO_NET_OFFLINE = "true";
    process.env.npm_config_offline = "true";
    process.env.RUSTUP_AUTO_INSTALL = "0";
  }
  const inspect = (cmd, args) => probe(cmd, args, { cwd: root });
  const execute = (steps) => {
    for (const [cmd, ...args] of steps) {
      console.log(`\n> ${cmd} ${args.join(" ")}`);
      run(cmd, args, {
        cwd: root,
        env: { ...process.env, DEMO_SELF_SERVE: "1" },
      });
    }
  };
  function requireVersion(cmd, args, expected, label) {
    const version = inspect(cmd, args);
    if (!version?.includes(expected))
      throw Error(
        `${label} ${expected} is required; found ${version ?? "not installed"}`,
      );
  }
  if (command === "doctor") {
    const report = await diagnose(root, pins, nodePin, rustPin);
    console.log(
      values.json ? JSON.stringify(report, null, 2) : formatDiagnosis(report),
    );
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (process.versions.node !== nodePin)
    throw Error(
      `Node ${nodePin} is required; found ${process.versions.node}. See .node-version.`,
    );
  if (command === "setup") {
    const host = platform();
    if (!pins.gitleaks.archives[host])
      throw Error(`No verified Gitleaks archive for ${host}`);
    if (!inspect("git", ["--version"])) throw Error("Git is required");
    if (values["install-hooks"]) {
      const existing = inspect("git", [
        "config",
        "--local",
        "--get",
        "core.hooksPath",
      ]);
      if (existing && existing !== ".githooks")
        throw Error(
          `Existing repository hook path is not project-owned: ${existing}`,
        );
    }
    if (offline) {
      const installed = inspect("rustup", ["toolchain", "list"]);
      if (
        !installed?.split("\n").some((line) => {
          const name = line.split(/\s/, 1)[0];
          return name === rustPin || name.startsWith(`${rustPin}-`);
        })
      )
        throw Error(`Offline setup is missing Rust toolchain ${rustPin}`);
      if (
        !inspect("rustup", ["target", "list", "--installed"])?.includes(
          "wasm32-unknown-unknown",
        )
      )
        throw Error("Offline setup is missing wasm32-unknown-unknown");
    } else {
      execute([
        [
          "rustup",
          "toolchain",
          "install",
          rustPin,
          "--profile",
          "minimal",
          "--component",
          "rustfmt,clippy",
          "--target",
          "wasm32-unknown-unknown",
        ],
      ]);
    }
    requireVersion("rustc", ["--version"], rustPin, "Rust");
    execute([
      ["cargo", "fetch", "--locked", ...(offline ? ["--offline"] : [])],
    ]);
    if (inspect(localWasm, ["--version"]) !== `wasm-bindgen ${lockedWasm}`) {
      execute([
        [
          "cargo",
          "install",
          "wasm-bindgen-cli",
          "--version",
          lockedWasm,
          "--locked",
          "--root",
          wasmRoot,
          ...(offline ? ["--offline"] : []),
        ],
      ]);
    }
    execute([["npm", "ci", ...(offline ? ["--offline"] : [])]]);
    const scanner = await installGitleaks(root, pins, offline);
    if (values["install-hooks"]) {
      execute([["git", "config", "--local", "core.hooksPath", ".githooks"]]);
      console.log(`Installed project hooks with ${scanner}`);
    }
    execute([["npm", "run", "wasm"], fixtureSteps[0]]);
    console.log(
      "Developer setup complete. Run ./dev demo. No Minecraft assets were downloaded.",
    );
  } else if (command === "demo") {
    run(
      "npm",
      [
        "run",
        "dev",
        "--",
        "--host",
        "127.0.0.1",
        ...(values.port ? ["--port", values.port, "--strictPort"] : []),
      ],
      {
        cwd: root,
        env: { ...process.env, SURFACE_MAP: "maps/fixture/manifest.json" },
      },
    );
  } else if (command === "fixtures") {
    execute(fixtureSteps);
  } else if (command === "test") {
    execute([
      ["npm", "run", "wasm"],
      ...fixtureSteps,
      ["npx", "--no-install", "playwright", "test", ...tail],
    ]);
  } else if (command === "check") {
    execute(checkSteps(values.profile));
  } else if (command === "package") {
    requireVersion(
      "cargo-zigbuild",
      ["--version"],
      pins.cargo_zigbuild.version,
      "cargo-zigbuild",
    );
    requireVersion("python-zig", ["version"], pins.zig.version, "Zig");
    run("node", ["scripts/release/build-package.mjs", values.target], {
      cwd: root,
      env: {
        ...process.env,
        CARGO_ZIGBUILD_ZIG_PATH: inspect("which", ["python-zig"]),
      },
    });
  }
}

main().catch((error) => {
  console.error(`dev: ${error.message}`);
  process.exitCode = 2;
});
