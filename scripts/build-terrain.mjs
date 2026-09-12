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
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "terrain/probe/tsconfig.json"],
  { stdio: "inherit" },
);
await mkdir(".local/terrain/probe/scripts", { recursive: true });
let probe = await readFile(
  ".local/terrain/probe-build/terrain/probe/src/main.js",
  "utf8",
);
probe = probe.replaceAll("../../pack/src/", "./");
await writeFile(".local/terrain/probe/scripts/main.js", probe);
for (const file of ["core.js", "rules.js"])
  await copyFile(
    `${output}/scripts/${file}`,
    `.local/terrain/probe/scripts/${file}`,
  );
await copyFile(
  "terrain/probe/manifest.json",
  ".local/terrain/probe/manifest.json",
);
