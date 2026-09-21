import { spawnSync } from "node:child_process";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    cwd: options.cwd,
    env: options.env,
  });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status ?? "an error"}`);
  return result.stdout ?? "";
}

export function probe(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: options.cwd,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}
