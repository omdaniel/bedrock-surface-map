import { createHash } from "node:crypto";
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
for (const name of (await readdir(output))
  .filter((name) => name.endsWith(".tar.gz"))
  .sort()) {
  const digest = createHash("sha256")
    .update(await readFile(resolve(output, name)))
    .digest("hex");
  sums.push(`${digest}  ${name}`);
}
await writeFile(resolve(output, "SHA256SUMS"), sums.join("\n") + "\n");
