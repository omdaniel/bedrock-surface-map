import { execFileSync } from "node:child_process";
import { mkdir, readdir, cp } from "node:fs/promises";
import { resolve } from "node:path";

const [target, outputArg] = process.argv.slice(2);
if (!target || !outputArg) throw Error("usage: build-native.mjs <target> <output>");
const output = resolve(outputArg);
const packages = ["bedrock-map", "surface-cli", "surface-sync", "surface-tracker"];
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], { encoding: "utf8" }));
const binaries = new Map();
for (const pkg of metadata.packages) {
  for (const artifact of pkg.targets) {
    if (artifact.kind.includes("bin")) binaries.set(pkg.name, artifact.name);
  }
}
for (const packageName of packages) {
  if (!binaries.has(packageName)) throw Error(`Cargo metadata has no binary for ${packageName}`);
}
execFileSync("cargo", ["zigbuild", "--release", "--locked", "--target", target, ...packages.flatMap((name) => ["-p", name])], { stdio: "inherit" });
await mkdir(output, { recursive: true, mode: 0o700 });
for (const packageName of packages) {
  const binary = binaries.get(packageName);
  await cp(resolve("target", target, "release", binary), resolve(output, binary));
}
console.log(JSON.stringify({ target, binaries: Object.fromEntries(binaries) }));
