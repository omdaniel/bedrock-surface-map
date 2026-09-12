# Third-Party Sources

## Minecraft assets

Textures are downloaded locally from [Mojang's resource-pack samples](https://github.com/Mojang/bedrock-samples/tree/736072450c26a7c67f07b1661f29d9a5ebaa14b1),
pinned by commit and archive SHA-256 in `sources/mojang.json`. The source license
reserves Mojang's rights and makes the files subject to the
[Minecraft EULA](https://www.minecraft.net/en-us/eula).

The original `LICENSE.md` and a provenance notice are retained beside the local
atlas. The asset archive, atlas, imported world and rendered screenshots are NOT
included in Git or CI artifacts. This private prototype does not grant permission
to redistribute Mojang assets. Review the EULA before any future public hosting.
The synthetic test fixture uses application-generated solid colors, not Minecraft
textures.

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
