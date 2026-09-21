import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [destination, ...sources] = process.argv.slice(2);
if (!destination || sources.length < 2) {
  throw Error(
    "usage: node ci/collect-release.mjs <destination> <target-dist> <target-dist>",
  );
}
const output = resolve(destination);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const source of sources.map((source) => resolve(source))) {
  for (const name of await readdir(source)) {
    if (!name.endsWith(".tar.gz")) continue;
    const target = resolve(output, name);
    try {
      await cp(resolve(source, name), target, { errorOnExist: true });
    } catch (error) {
      if (name.endsWith("-source.tar.gz")) {
        const existing = await readFile(target);
        const duplicate = await readFile(resolve(source, name));
        if (!existing.equals(duplicate))
          throw Error(`source archive differs between target jobs: ${name}`);
        continue;
      }
      throw error;
    }
  }
}
const sums = [];
const archives = (await readdir(output))
  .filter((name) => name.endsWith(".tar.gz"))
  .sort();
for (const name of archives) {
  const digest = createHash("sha256")
    .update(await readFile(resolve(output, name)))
    .digest("hex");
  sums.push(`${digest}  ${name}`);
}
await writeFile(resolve(output, "SHA256SUMS"), sums.join("\n") + "\n");

const commonManifests = archives
  .filter((name) => name.includes("-linux-"))
  .map((name) => ({
    name,
    bytes: embeddedCommonManifest(resolve(output, name)),
  }));
if (commonManifests.length !== 2)
  throw Error("candidate must contain exactly two Linux architecture archives");
const [firstManifest, ...remainingManifests] = commonManifests;
for (const manifest of remainingManifests) {
  if (!firstManifest.bytes.equals(manifest.bytes))
    throw Error(
      `common resource manifest differs between ${firstManifest.name} and ${manifest.name}`,
    );
}
await writeFile(
  resolve(output, "COMMON_RESOURCES_SHA256"),
  `${createHash("sha256").update(firstManifest.bytes).digest("hex")}  provenance/common-manifest.json\n`,
);

function embeddedCommonManifest(archive) {
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter((entry) => entry.endsWith("/provenance/common-manifest.json"));
  if (entries.length !== 1)
    throw Error(`${archive} must contain exactly one common resource manifest`);
  return execFileSync("tar", ["-xOzf", archive, entries[0]]);
}
