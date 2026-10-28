# Install the Server Packs Through a Panel

The panel continues managing Bedrock. The map runs as a separate Linux service
using a verified operator bundle. You need access to BDS's `behavior_packs`,
selected world's registration, and module-specific `config` directory. A hosting
plan that blocks server scripting or outbound `server-net` requests cannot run
this integration. Realms is outside its scope.

Prepare the map using the [Docker quickstart](QUICKSTART-BDS.md) or [deployment
reference](DEPLOYMENT.md). Both feeds use Beta APIs; obtain approval and a verified
backup before enabling experiments on a persistent world. Use a disposable world
for initial acceptance. Never upload an entire older world to install an update
to these packs.

**Beta APIs is a world experiment**, not a `server.properties` switch. If it is
not enabled, use a consistent exported copy in a Bedrock client, enable it under
the world's Experiments settings, and export that copy for isolated testing.
Adopting that world on a persistent server requires its own backup and maintenance
window. The pack exporter does not change `level.dat`. Follow [Microsoft's world
experiment guidance](https://learn.microsoft.com/en-us/minecraft/creator/documents/experimentalfeaturestoggle?view=minecraft-bedrock-stable);
removing the packs does not undo experimental status.

## Prepare the Files

Where the map operator can read the existing BDS directory:

```sh
./bedrock-map deploy export-bds --dir ./map-deploy \
  --server-dir /path/to/bds --world 'Bedrock level' \
  --output ./bedrock-map-bds.zip --secrets-dir ./bedrock-map-bds-private
```

This produces a ZIP with pack files and settings merged against the inspected
installation. It preserves unrelated world registrations and settings, while
replacing this integration's required values and its exact HTTP destination
policy. Credentials are in the separate private directory. Export reads files;
it does not install, stop or restart the server.

If the map host cannot read the BDS directory, omit `--server-dir`. This exports
compiled packs and clearly named configuration templates/registration fragments.
Merge those through the panel instead of replacing existing JSON files. Existing
pack header UUIDs and script-module UUIDs are different: use the generated paths.
Module configuration goes in `config/<script-module-uuid>`, never `config/default`.

## Crafty Controller

1. Select the intended Bedrock server. Take and verify its backup, then stop it
   using Crafty's server controls.
2. Open that server's **Files** view. Upload `bedrock-map-bds.zip` to the BDS root
   and use its extraction action. Crafty accepts ZIP uploads; it does not upload
   whole directories directly. For a template export, follow its README and merge
   the supplied registration/configuration fragments using the editor.
3. Transfer the separate private `config/<module>/secrets.json` files using the
   panel's file tools or its documented SFTP connection. Preserve other secret
   keys when performing a template merge. Keep these files owner-readable only;
   do not store the private export in a public download directory.
4. Check that the packs are directly under `behavior_packs/<pack-uuid>` with a
   `manifest.json` at that level. Remove the uploaded ZIP after inspection; do
   not leave an extra nested server directory around the extracted files.
5. When shell access is available, run the checker below. Start through Crafty,
   then inspect its console and the map's running status.

Use Crafty's file tools to preserve its server ownership. See [Crafty's file
manager documentation](https://docs.craftycontrol.com/pages/user-guide/file-manager/).

## AMP

1. Select the Bedrock instance, verify its backup and stop it in AMP.
2. In the instance's **File Manager**, upload and extract the nonsecret ZIP in
   the BDS root. For a template export, merge the supplied JSON fragments in the
   corresponding files instead of overwriting them.
3. Transfer the separate private credentials through AMP's file manager or SFTP,
   preserving existing unrelated keys and owner-only permissions. AMP's tools
   maintain the instance's filesystem ownership; avoid copying files as an
   unrelated host user.
4. Verify the paths and settings, then start from AMP and check its console.

These are AMP's documented file-transfer conventions; see [its add-on installation
guide](https://discourse.cubecoders.com/t/adding-add-ons-to-a-minecraft-bedrock-server/29000).
This project does not require an AMP plugin or change the panel's launch command.

File-manager uploads may use broader default permissions. Before starting BDS,
use the panel's permission controls or a shell under the BDS service account to
set each installed `config/<module-uuid>/secrets.json` to mode `0600`. Keep the
BDS service account as owner. If the hosting plan provides neither mechanism,
ask its administrator to set these permissions; the checker rejects group/world
readable credentials.

## Verify the Installation

On a host/account with permission to read the prepared deployment and BDS files:

```sh
./bedrock-map deploy check-bds --dir ./map-deploy \
  --server-dir /path/to/bds --world 'Bedrock level'
./bedrock-map deploy check --dir ./map-deploy --running --expect-live
```

The first command checks installed files, registrations, module settings and
credentials without printing their values or opening LevelDB. Exit `3` means
installed requirements failed; the JSON report identifies their paths. It cannot
prove the already-running server has reloaded the files. Restart through the
panel and require fresh collector observations. Keep the exporter/checker and
server packs from the same application release.

Finally, join with an ordinary Bedrock client, select your marker in the map and
make a small surface edit. Server startup, real-client acceptance and browser
performance are distinct checks; see [compatibility](COMPATIBILITY.md).
