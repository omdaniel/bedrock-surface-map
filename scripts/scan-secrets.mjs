import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installGitleaks, readPins } from "./onramp/tools.mjs";
import { run } from "./onramp/process.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const scanner = await installGitleaks(root, await readPins(root));
run(scanner, ["git", ".", "--no-banner", "--redact", "--timeout", "120"], {
  cwd: resolve(root),
});
