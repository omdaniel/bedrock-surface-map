import { spawnSync } from "node:child_process";
import { mkdir, copyFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
for (const kind of ["pack", "probe"]) {
  const target = resolve(`.local/tracking/${kind}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-p",
      `tracking/${kind}/tsconfig.json`,
      "--outDir",
      resolve(target, "scripts"),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  await copyFile(
    `tracking/${kind}/manifest.json`,
    resolve(target, "manifest.json"),
  );
  console.log(
    `Built server-only ${kind}: .local/tracking/${kind} (no credentials)`,
  );
}
