import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const website = fileURLToPath(new URL('../', import.meta.url));
export const root = path.resolve(website, '..');
export const sourceUrl = 'https://github.com/omdaniel/bedrock-surface-map/blob/main/';

// Explicit public documentation only. Never recurse into the application checkout.
export async function inventory() {
  const docs = (await readdir(path.join(root, 'docs')))
    .filter((file) => file.endsWith('.md')).sort().map((file) => `docs/${file}`);
  return [...docs, 'CONTRIBUTING.md', 'THIRD_PARTY.md', 'deploy/README.md', 'deploy/FIREWALL.md'];
}

export function transformLinks(markdown, source, pages) {
  return markdown.replace(/(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g, (match, open, href, close) => {
    if (/^(?:[a-z]+:|\/|#)/i.test(href)) return match;
    const [name, fragment] = href.split('#');
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), name));
    if (pages.has(target) || target === 'docs/media/demo.png') return match;
    return `${open}${sourceUrl}${target}${fragment ? `#${fragment}` : ''}${close}`;
  });
}

export async function prepare() {
  const destination = path.join(website, '.generated');
  const sources = await inventory();
  const pages = new Set(sources);
  await rm(destination, { recursive: true, force: true });
  for (const file of sources) {
    const output = path.join(destination, file);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, transformLinks(await readFile(path.join(root, file), 'utf8'), file, pages));
  }
  for (const file of await readdir(path.join(website, 'pages'))) {
    if (!file.endsWith('.md')) continue;
    await copyFile(path.join(website, 'pages', file), path.join(destination, file));
  }
  await mkdir(path.join(destination, 'public/docs/media'), { recursive: true });
  await copyFile(path.join(root, 'docs/media/demo.png'), path.join(destination, 'public/docs/media/demo.png'));
  console.log(`Prepared ${sources.length} canonical guides and website entry pages.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepare();
