# Local terrain data

The viewer downloads the complete compressed surface dataset into IndexedDB.
It uses existing region objects; no prepared resolution hierarchy is required.
The camera controls local decoding and GPU residency, never which terrain files
the browser downloads. The worker receives verified local bytes and has no
network fallback.

All visible terrain and its surrounding buffer use one sample spacing: exact
blocks or a power-of-two reduction through 256×256. The renderer rejects mixed
spacings. Changing spacing retains the last complete image until the replacement
view is ready. Ordinary panning prepares neighboring regions locally. A distant
jump or resolution change can still pause terrain drawing during preparation.
Initial download and preparation are separate from warm navigation performance.

The resident map allowance is 256 MiB, including a 32 MiB working reserve. This
is logical map accounting, not total browser or driver memory. Offline and live
maps both use bounded, region-aligned height windows. The client need not hold
the world's entire decoded surface or heightfield in RAM.

## Storage and synchronization

Each dataset's compressed local storage has a separate default limit of 2 GiB. Set
`local_map.maxBytes` in `viewer-config.json` to change it. Browser quotas and
eviction policies still apply. Missing, corrupted or unwritable local data
produces an explicit error; Retry repairs it through dataset synchronization.

Synchronization has two downloads in flight and verifies each object's length
and SHA-256. It reuses unchanged content across reloads. A new live publication
downloads changed **256×256 region objects** and changed height/catalog assets
independently of the view. The server's 16×16 ingestion and existing read formats
remain unchanged. This client trades larger edit transfers for a complete,
simple local representation; it does not store a chunk-patch history.

Old files are collected only after the new publication is complete. One previous
publication remains available for in-flight reads. Concurrent tabs or unavailable
Web Locks suppress collection. The configured quota must accommodate retained
and incoming files; current data is not evicted to make room.
Offline imports at the same manifest URL share their store, so unchanged region
objects can be reused when the snapshot fingerprint changes.

Manifests, player feeds and application assets still require their normal
connections. Retaining terrain locally is not an offline application guarantee.
