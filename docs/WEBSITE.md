# Welcome Site and Documentation

The [welcome site](https://omdaniel.github.io/bedrock-surface-map/) and
[interactive demo](https://omdaniel.github.io/bedrock-surface-map/demo/) are
static GitHub Pages content. GitHub remains the source, issue and release home.
Neither site connects to a private Minecraft server. The documentation works
without WebGPU; the interactive demo requires it.

## Edit and Preview

Use Node.js 26.8.1 from `.node-version`. Website work needs no Rust toolchain,
world archive, downloaded game textures or application build:

```sh
npm --prefix website ci
npm --prefix website run dev
```

Open the loopback URL printed by VitePress. Edit canonical guides in `docs/`,
`CONTRIBUTING.md`, `THIRD_PARTY.md`, or the deployment references. After editing
one of those source files, restart `dev` to refresh the generated copy. Website
entry pages live in `website/pages/`, the theme in `website/.vitepress/theme/`,
and navigation in `website/.vitepress/config.ts`.

The preparation script stages an explicit list of Markdown files and approved
demo screenshots from `docs/media/` into ignored `website/.generated/`. It never
copies a developer's map directory. Links to repository source/configuration
files point to GitHub; documentation links stay within the site. Do not edit
generated Markdown or HTML.

The homepage is a text index for users and developers with captioned feature
thumbnails. Screenshots show only the public demo's fictional players and
simulated activity. Add reviewed images to the explicit screenshot list in
`website/scripts/prepare.mjs`; other files in `docs/media/` are not copied.

## Check a Change

```sh
npm --prefix website test
npm --prefix website run build
npm --prefix website run test:browser
```

Browser checks use installed Google Chrome locally and Playwright Chromium in
CI. They cover reader paths, local search, direct-page reloads and desktop/mobile
layouts; mobile emulation does not establish physical iPad performance.
The build checks every generated local link and heading, the approved publication
inventory and private-data markers. The browser renderer is unchanged by this build.

To reproduce the Pages mount path:

```sh
DOCS_BASE_PATH=/bedrock-surface-map/ npm --prefix website run build
DOCS_BASE_PATH=/bedrock-surface-map/ npm --prefix website run test:browser
```

`DOCS_SITE_URL` optionally supplies the canonical site URL for sitemap generation;
`DOCS_BASE_PATH` controls the mount path explicitly. Build and preview/test must
use the same path. The default is `/` for local work.

## Publishing

The checked `main` workflow combines the documentation build with the independently
validated public demo at `demo/`, then deploys a single Pages artifact. The
documentation job runs independently of Rust/native packaging; publishing still
requires successful source/demo checks. The static site contains no collector,
ingestion endpoint, private configuration or real player data.

Repository Settings → Pages uses **GitHub Actions** as its source. The existing
`github-pages` environment controls deployment. GitHub provides HTTPS and the
repository's publishing credentials. Release packages and the live
map on an operator's server are independent of website publication.

For rollback, revert the website change on a branch, run its checks and merge the
revert. The checked `main` workflow publishes the restored content. Do not overwrite
the Pages artifact manually or point a documentation preview at production feeds.

VitePress 1.6.4 and its dependencies are pinned in the separate website lockfile.
The Vite override selects a patched build-tool version; it does not alter the
application's Vite dependency. Keep both root and subpath checks when updating it.
