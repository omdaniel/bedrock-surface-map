import { cp, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const docs = path.join(root, 'website/.vitepress/dist');
const demo = path.join(root, '.local/demo-dist');
const output = path.join(root, '.local/pages-dist');
assert((await readFile(path.join(docs, 'index.html'), 'utf8')).includes('whole world to explore'));
assert((await readFile(path.join(demo, 'index.html'), 'utf8')).includes('/bedrock-surface-map/demo/assets/'), 'Build the demo for its published subpath');
const config = JSON.parse(await readFile(path.join(demo, 'viewer-config.json'), 'utf8'));
assert.deepEqual(config, { players: null, demo: { scenario: 'showcase/scenario.json', poster: 'demo-poster.png' } });
// Each input has its own build/audit gate. Reject links before copying either tree.
async function rejectLinks(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    assert(!(await lstat(file)).isSymbolicLink(), `Artifact symlink: ${file}`);
    if (entry.isDirectory()) await rejectLinks(file);
  }
}
await rejectLinks(docs);
await rejectLinks(demo);
await rm(output, { force: true, recursive: true });
await mkdir(output, { recursive: true });
await cp(docs, output, { recursive: true });
await cp(demo, path.join(output, 'demo'), { recursive: true });
console.log('Assembled checked documentation at / and the public demo at /demo/.');
