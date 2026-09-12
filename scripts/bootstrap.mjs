import { spawnSync } from "node:child_process";
function run(c, a) {
  const r = spawnSync(c, a, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
run("rustup", [
  "toolchain",
  "install",
  "1.92.0",
  "--profile",
  "minimal",
  "--component",
  "rustfmt,clippy",
]);
run("rustup", [
  "target",
  "add",
  "wasm32-unknown-unknown",
  "--toolchain",
  "1.92.0",
]);
const v = spawnSync("wasm-bindgen", ["--version"], { encoding: "utf8" });
if (!v.stdout?.includes("0.2.127"))
  run("cargo", [
    "+1.92.0",
    "install",
    "wasm-bindgen-cli",
    "--version",
    "0.2.127",
    "--locked",
  ]);
run("npm", ["ci"]);
run("sh", ["scripts/install-dev-tools.sh"]);
run("npm", ["run", "assets"]);
run("npm", ["run", "wasm"]);
