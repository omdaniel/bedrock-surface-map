import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installGitleaks, readPins } from "./onramp/tools.mjs";
import { run } from "./onramp/process.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--staged"))
  throw new Error("Usage: node scripts/scan-secrets.mjs [--staged]");
const staged = args[0] === "--staged";
const root = fileURLToPath(new URL("..", import.meta.url));
const scanner = await installGitleaks(root, await readPins(root));
run(
  scanner,
  [
    ...(staged ? ["protect", "--staged"] : ["git", "."]),
    "--no-banner",
    "--redact",
    "--timeout",
    "120",
  ],
  { cwd: resolve(root) },
);
