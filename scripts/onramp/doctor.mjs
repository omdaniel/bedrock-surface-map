import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { probe } from "./process.mjs";

export async function diagnose(root, pins, nodePin, rustPin) {
  // Calling a rustup shim without this guard can install a missing toolchain.
  const options = {
    cwd: root,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
  };
  const checks = [];
  const add = (name, actual, valid, fix) =>
    checks.push({ name, ok: Boolean(valid), actual, fix });
  add(
    "Node",
    process.versions.node,
    process.versions.node === nodePin,
    `Select Node ${nodePin} from .node-version`,
  );
  const git = probe("git", ["--version"], options);
  add("Git", git, git, "Install Git");
  const rust = probe("rustc", ["--version"], options);
  add(
    "Rust",
    rust,
    rust?.startsWith(`rustc ${rustPin} `),
    "Install rustup, then run ./dev setup",
  );
  const targets = probe(
    "rustup",
    ["target", "list", "--installed", "--toolchain", rustPin],
    options,
  );
  add(
    "WASM target",
    targets,
    targets?.split("\n").includes("wasm32-unknown-unknown"),
    "Run ./dev setup",
  );
  const components = probe(
    "rustup",
    ["component", "list", "--installed", "--toolchain", rustPin],
    options,
  );
  add(
    "Rust checks",
    components,
    components?.includes("rustfmt-") && components?.includes("clippy-"),
    "Run ./dev setup",
  );
  for (const [name, command] of [
    ["C++ compiler", "c++"],
    ["CMake", "cmake"],
    ["Python 3", "python3"],
  ]) {
    const version =
      probe(command, ["--version"], options)?.split("\n")[0] ?? null;
    add(
      name,
      version,
      version,
      "Install the native build prerequisites in docs/GETTING_STARTED.md",
    );
  }
  const wasm = probe("wasm-bindgen", ["--version"], options);
  add(
    "wasm-bindgen",
    wasm,
    wasm === `wasm-bindgen ${pins.wasm_bindgen.version}`,
    "Run ./dev setup",
  );
  let dependencies = true;
  for (const name of ["vite", "typescript", "@playwright/test"]) {
    try {
      await access(resolve(root, "node_modules", name, "package.json"));
    } catch {
      dependencies = false;
    }
  }
  add(
    "npm dependencies",
    dependencies ? "installed" : null,
    dependencies,
    "Run ./dev setup",
  );
  for (const [name, path] of [
    ["WASM build", "web/pkg/surface_gpu.d.ts"],
    ["Synthetic map", "web/public/maps/fixture/manifest.json"],
  ]) {
    let present = true;
    try {
      await access(resolve(root, path));
    } catch {
      present = false;
    }
    add(name, present ? "prepared" : null, present, "Run ./dev setup");
  }
  return { ok: checks.every((check) => check.ok), checks };
}

export function formatDiagnosis(report) {
  return (
    report.checks
      .map(
        (check) =>
          `${check.ok ? "OK" : "MISSING"}  ${check.name}: ${check.actual?.replaceAll("\n", ", ") ?? "not installed"}${check.ok ? "" : `\n         ${check.fix}`}`,
      )
      .join("\n") +
    `\n\n${report.ok ? "Ready for development." : "Setup is incomplete; no tools were installed or changed."}`
  );
}
