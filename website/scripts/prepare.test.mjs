import assert from 'node:assert/strict';
import test from 'node:test';
import { inventory, transformLinks } from './prepare.mjs';

test('keeps canonical guides local and directs source files to GitHub', () => {
  const pages = new Set(['docs/INSTALL.md', 'CONTRIBUTING.md']);
  const input = '[Install](INSTALL.md#download-and-run) [Contribute](../CONTRIBUTING.md) [Example](../examples/viewer.json) [License](../LICENSE)';
  assert.equal(transformLinks(input, 'docs/START.md', pages), '[Install](INSTALL.md#download-and-run) [Contribute](../CONTRIBUTING.md) [Example](https://github.com/omdaniel/bedrock-surface-map/blob/main/examples/viewer.json) [License](https://github.com/omdaniel/bedrock-surface-map/blob/main/LICENSE)');
});
test('leaves external links, headings, code-only paths and the approved screenshot alone', () => {
  const input = '[Web](https://example.com) [Here](#heading) `../LICENSE` ![Map](media/demo.png)';
  assert.equal(transformLinks(input, 'docs/START.md', new Set()), input);
});
test('publication inventory contains only explicit documentation', async () => {
  const files = await inventory();
  assert(files.includes('docs/INSTALL.md'));
  assert(files.every((file) => file.endsWith('.md')));
  assert(!files.some((file) => /AGENTS|\.local|web\/public|worlds/.test(file)));
});
