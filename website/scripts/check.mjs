import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const root = fileURLToPath(new URL('../.vitepress/dist/', import.meta.url));
const base = process.env.DOCS_BASE_PATH || (process.env.DOCS_SITE_URL ? new URL(process.env.DOCS_SITE_URL).pathname.replace(/\/?$/, '/') : '/');
const origin = new URL(base, 'https://docs.invalid');
const files = new Map();
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    assert(!(await lstat(absolute)).isSymbolicLink(), `Artifact symlink: ${entry.name}`);
    if (entry.isDirectory()) await walk(absolute);
    else files.set(path.relative(root, absolute).split(path.sep).join('/'), await readFile(absolute));
  }
}
await walk(root);
const documents = new Map();
let bytes = 0;
for (const [name, data] of files) {
  bytes += data.length;
  assert(/\.(?:html|js|css|json|png|svg|woff2|xml)$/.test(name), `Unexpected publication file: ${name}`);
  assert(!/(?:^|\/)(?:\.local|\.env|node_modules|worlds|db|map-data)(?:\/|$)/.test(name), `Private path: ${name}`);
  if (/\.(?:html|js|json|xml)$/.test(name)) {
    assert(!/192\.168\.68\.|danielfamilyminecraft\.com|LittleWhistle5|MsDelali|PopCello|BEGIN .*PRIVATE KEY|\/Users\/macbookpro/.test(data.toString()), `Private installation data: ${name}`);
  }
  if (name.endsWith('.html')) documents.set(name, parseHTML(data.toString()).document);
}
let checked = 0;
const failures = [];
for (const [name, document] of documents) {
  for (const element of document.querySelectorAll('[href], [src]')) {
    const href = element.getAttribute('href') ?? element.getAttribute('src');
    if (!href || /^(?:mailto:|data:|javascript:)/.test(href)) continue;
    const url = new URL(href, new URL(name, origin));
    if (url.origin !== origin.origin) continue;
    if (!url.pathname.startsWith(base)) { failures.push(`${name}: outside base ${href}`); continue; }
    let target = decodeURIComponent(url.pathname.slice(base.length));
    if (!target || target.endsWith('/')) target += 'index.html';
    if (!files.has(target)) { failures.push(`${name}: missing ${href}`); continue; }
    checked++;
    if (url.hash && documents.has(target)) {
      const id = decodeURIComponent(url.hash.slice(1));
      if (!documents.get(target).getElementById(id)) failures.push(`${name}: missing heading ${href}`);
    }
  }
}
assert.equal(failures.length, 0, failures.join('\n'));
assert(bytes < 15_000_000, `Documentation site exceeds 15 MB: ${bytes}`);
console.log(JSON.stringify({ pages: documents.size, localReferences: checked, bytes, publicInventoryChecked: true }));
