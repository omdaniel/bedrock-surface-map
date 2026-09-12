import { spawnSync } from "node:child_process";
function run(command, args) {
  const r = spawnSync(command, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
run("cargo", [
  "build",
  "--release",
  "--locked",
  "-p",
  "surface-gpu",
  "--target",
  "wasm32-unknown-unknown",
]);
run("wasm-bindgen", [
  "--target",
  "web",
  "--out-dir",
  "web/pkg",
  "--out-name",
  "surface_gpu",
  "target/wasm32-unknown-unknown/release/surface_gpu.wasm",
]);
