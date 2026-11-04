# Prepare a World Export

The importer accepts an offline Bedrock `.mcworld` or ZIP archive. It opens a
private extracted copy read-only; it never reads a running server's LevelDB.
Keep your original backup separately from the derived map.

## Choose a Consistent Copy

- **Minecraft client:** where your edition offers **Export World**, close the
  world and export it as `.mcworld` from its world settings. Export availability
  depends on platform; console worlds are not directly accessible to this tool.
- **Dedicated server:** use a verified, consistent backup from your existing
  server maintenance process. The straightforward option is a clean server stop,
  a complete copy of the selected world directory, and a normal restart. Archive
  the copy after the game is running again. Do not ZIP the active database.
- **Hosting panel:** obtain its consistent world backup, then extract a private
  copy locally and locate the selected world's `level.dat` and `db` directory.
  A whole-server backup is not necessarily an import-ready world archive.

On BDS, `level-name` in `server.properties` selects `worlds/<level-name>/`.
Use your panel/service's maintenance procedure. This guide does not run stop,
restore or world-modifying commands for you.

## Check the Archive Layout

World files must be at the archive root, without an enclosing world-name folder:

```text
my-world.mcworld
├── level.dat
├── levelname.txt       (if present)
└── db/
    ├── CURRENT
    └── …all database files from the same copy
```

Keep the complete copied world, not just the files illustrated above. To archive
an already consistent copy on a machine with `zip` installed:

```sh
cd /path/to/private/offline-world-copy
zip -r /path/to/private/my-world.zip .
unzip -l /path/to/private/my-world.zip
```

Verify that the listing contains `level.dat` and `db/CURRENT` directly at root.
Renaming a Java world ZIP to `.mcworld` does not convert its format. Compressed
server backups such as `.tar.gz` must be unpacked and the correct Bedrock world
repackaged as ZIP first.

## Import and Verify

Follow [snapshot installation](INSTALL.md#import-your-world), or seed the
[live operator bundle](OPERATOR-INSTALL.md). The app explicitly acquires texture
assets under their own terms before import. A synthetic demo needs no Mojang
assets.

The importer rejects malformed paths, symlinks and excessive expansion, verifies
database checksums, and reports unsupported materials instead of hiding them.
Only derived surface fields are served. Raw world archives can contain private
player records: keep them out of Git, public issues and web roots.

See [import limits and diagnostics](IMPORT.md) for supported sizes, validation
and unresolved-material reporting. A failed import leaves the selected packaged
snapshot unchanged.
