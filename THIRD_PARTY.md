# Third-Party Sources

## License scope

Unless otherwise noted, this repository's original application source and
documentation are licensed under [GNU AGPL version 3 only](LICENSE)
(`AGPL-3.0-only`). This includes the Rust crates, browser code, behavior packs and
project scripts. This grant does not relicense third-party software, Minecraft
assets, imported worlds or derived world data. Original demo texture artwork
retains its separate CC0 dedication below.

## Minecraft assets

Textures are downloaded locally from [Mojang's resource-pack samples](https://github.com/Mojang/bedrock-samples/tree/736072450c26a7c67f07b1661f29d9a5ebaa14b1),
pinned by commit and archive SHA-256 in `sources/mojang.json`. The source license
reserves Mojang's rights and makes the files subject to the
[Minecraft EULA](https://www.minecraft.net/en-us/eula).

The original `LICENSE.md` and a provenance notice are retained beside the local
atlas. The Mojang asset archive, atlas and imported world are NOT included in Git
or CI artifacts. This project does not grant permission to redistribute Mojang
assets. Review the EULA before publishing a map using those assets.
The synthetic test fixture uses application-generated solid colors, not Minecraft
textures.

## Public demo

The Pages demo uses an owner-approved surface-only excerpt and independently
generated procedural textures, not Mojang texture pixels. Its two named players
are fictional. Original demo texture artwork is dedicated under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/); this does not license
the terrain, Minecraft names, application source, or third-party rights. Terrain
edits are also fictional. The versioned release contains only derived map
objects and scenario metadata; no player records, world database, or server access
is provided. See [the release provenance](sources/demo.json) and
[demo maintenance](docs/PUBLIC_DEMO.md). Reviewed promotional screenshots depict
this same demo. The public demo packet and those screenshots are the explicit
exception to the otherwise private-artifact policy.

## Software

Released crates come from crates.io, resolved exactly by Cargo.lock; frontend
packages are resolved by package-lock.json. Key components:

- [bedrock-world 0.3.5](https://docs.rs/bedrock-world/0.3.5/bedrock_world/):
  offline Bedrock parsing with its Bedrock LevelDB backend.
- [wgpu 30.0.1](https://docs.rs/wgpu/30.0.1/wgpu/): native GPU test and browser WebGPU.
- [ruzstd 0.8.3](https://docs.rs/ruzstd/0.8.3/ruzstd/): pure Rust/WASM Zstandard decoding.
- wasm-bindgen 0.2.127: WASM interface generation.
- Vite, TypeScript, Lucide and Playwright: frontend, icons and tests.

Dependency licenses remain their own; inspect Cargo metadata and each npm
package's license before redistribution. No third-party executable release
archives are checked in. Gitleaks is installed from a SHA-verified release.
