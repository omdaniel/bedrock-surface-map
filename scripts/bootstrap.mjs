import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["scripts/dev.mjs", "setup"], {
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
