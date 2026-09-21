import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const [target, native, common] = process.argv.slice(2);
if (!target || !native || !common)
  throw Error("usage: reproducible.mjs <target> <native-dir> <common-dir>");
const staging = await mkdtemp(join(tmpdir(), "bedrock-map-reproducible-"));
try {
  const outputs = ["first", "second"].map((name) => resolve(staging, name));
  for (const output of outputs) {
    execFileSync(
      process.execPath,
      [
        "scripts/release/assemble.mjs",
        target,
        resolve(native),
        resolve(common),
        output,
      ],
      { stdio: "inherit" },
    );
  }
  const archives = outputs.map((output) =>
    execFileSync("find", [output, "-name", "*.tar.gz", "-type", "f"], {
      encoding: "utf8",
    }).trim(),
  );
  const digests = await Promise.all(
    archives.map(async (archive) =>
      createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    ),
  );
  if (digests[0] !== digests[1])
    throw Error(`non-reproducible archive: ${digests.join(" != ")}`);
  console.log(JSON.stringify({ ok: true, target, sha256: digests[0] }));
} finally {
  await rm(staging, { recursive: true, force: true });
}
