# Snapshot Import

The adapter is pinned to released `bedrock-world = 0.3.5`, using its
`backend-bedrock-leveldb` feature. No development-branch dependency is used.
`read_only: true` selects the backend's read-only open with paranoid checksum
checks. Only an unpacked private copy of an offline archive is opened.

```sh
cargo run --release --locked -p surface-cli -- import \
  --input /path/to/your-offline-snapshot.mcworld
cargo run --release --locked -p surface-cli -- benchmark \
  web/public/maps/world/manifest.json
cargo run --release --locked -p surface-cli -- inspect \
  web/public/maps/world/manifest.json
```

Run `node scripts/assets.mjs` first to acquire the pinned Mojang resource-pack samples.
`--output` sets the derived directory and `--name` its display name; defaults are
`web/public/maps/world` and `Bedrock World`. Set the viewer's `map` configuration
to the served manifest path when using another location.
The private extraction scratch directory is under `.local/worlds` (its parent
has mode 0700). Successful imports remove their scratch copy. Failed imports
retain it for local diagnosis; it is ignored by Git and never served by Vite.

ZIP safeguards reject path traversal, absolute paths, backslashes, duplicate
names and symlinks, and limit input to 100,000 entries, 512 MiB per entry and
2 GiB total uncompressed data. Files are created exclusively. Live directories
are not supported. Each database query batch contains at most 32 chunks and
uses the parser's fixed two-worker pool. The complete retained surface is held
in memory; this is not an unbounded parallel world decode.

All available Overworld chunk positions are enumerated; absent columns remain
explicitly uncovered. Malformed chunks abort the import instead of becoming air.
Every sixteenth batch samples the center surface column of each chunk against
an independent raw block lookup. The original archive's SHA-256 is checked
again before publication. Only surface block states, biome IDs and world spawn
are published: no inventories, player records or block-entity payloads.

Content-hashed region objects and height data are completed before atomic
manifest replacement. Re-importing identical data reuses those files. A browser
session using the offline format pins one manifest and its catalog; reload to
adopt a new offline import. This also invalidates all shadows and overviews.
The separate [live-terrain pipeline](TERRAIN-SYNC.md) publishes chunk replacements
without reloading; importing an archive alone does not enable that integration.

`import-report.json` and stdout report coverage, compressed size, source hash,
timings, peak process RSS, sampled verification count and unresolved materials.
Errors have a nonzero exit code and JSON stderr summary. Compiler time and the
initial asset download are not included in import timings.

The offline export is limited to 65,536 chunks and a bounding rectangle
of at most 16 million columns. It carries a whole-dataset heightfield for shadows.
For live-map repair, `--surface-only` uses bounded region streaming instead of
building that heightfield; its output is repair input, not a directly viewable
offline manifest. Live maps and the public demo use region-aligned height windows
and a bounded resident cache, including offscreen shadow margins. Unknown terrain
outside the dataset cannot cast a known shadow.
