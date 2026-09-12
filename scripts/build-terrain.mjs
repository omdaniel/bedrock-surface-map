import { execFileSync } from "node:child_process";
import { mkdir, readFile, copyFile, writeFile } from "node:fs/promises";
const output = ".local/terrain/pack";
await mkdir(`${output}/scripts`, { recursive: true });
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "terrain/pack/tsconfig.json"],
  { stdio: "inherit" },
);
const rules = JSON.parse(await readFile("terrain/rules.json", "utf8"));
await writeFile(
  `${output}/scripts/rules.js`,
  `export default ${JSON.stringify(rules)};\n`,
);
await copyFile("terrain/pack/manifest.json", `${output}/manifest.json`);
console.log(`Built terrain pack at ${output}; no credentials included.`);
