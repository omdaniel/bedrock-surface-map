# Download the Live Operator Bundle

Choose this path for an HTTPS map with live player positions or terrain updates.
For a local offline map only, use the smaller [snapshot viewer](INSTALL.md).
Neither download replaces or installs your Minecraft server.

## Requirements

- A Linux AMD64 or ARM64 map host, with an Ubuntu 24.04-class environment,
  rootful Docker **28.0.4+** and Compose **2.38.2+**.
- A non-root operator with a non-root primary group and Docker access. That
  access grants administrative control of Docker; use a trusted operator account.
- A consistent [offline world export](WORLD-EXPORT.md), an HTTPS hostname, and
  administrative access to the existing Mojang Bedrock Dedicated Server.
- A BDS build compatible with the shipped packs and approval to enable the
  required Beta APIs experiment on the world. Test a disposable copy first.

Read the [compatibility matrix](COMPATIBILITY.md) before modifying a world.
ARM64 map-host support is not a claim that BDS runs natively on ARM64.
Rootless Docker and user-namespace remapping are outside the reference deployment.

## Download, Verify and Extract

[Published releases](https://github.com/omdaniel/bedrock-surface-map/releases/latest)
contain separate `operator-linux-amd64` and `operator-linux-arm64` archives.
Use the operator archive and **DEPLOYMENT_SHA256SUMS** from the same release.
The bundle contains the native runtime and its paired, digest-pinned image lock.
Do not substitute a CI candidate or a snapshot-only archive.

Run without `sudo`, in a new working directory. These commands require `curl`,
`tar` and `sha256sum`:

```sh
set -eu
umask 077
version=v0.2.0
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) arch=amd64 ;;
  Linux:aarch64|Linux:arm64) arch=arm64 ;;
  *) echo "The live bundle requires a supported Linux host."; exit 1 ;;
esac
archive="bedrock-surface-map-$version-operator-linux-$arch.tar.gz"
base="https://github.com/omdaniel/bedrock-surface-map/releases/download/$version"
mkdir "bedrock-map-live-$version"
cd "bedrock-map-live-$version"
curl --fail --location --remote-name "$base/$archive"
curl --fail --location --remote-name "$base/DEPLOYMENT_SHA256SUMS"
sha256sum --check --ignore-missing DEPLOYMENT_SHA256SUMS
tar -xzf "$archive"
cd "bedrock-surface-map-$version-operator-linux-$arch"
tar -xzf "bedrock-surface-map-$version-linux-$arch.tar.gz" --strip-components=1
./bedrock-map --help
```

Keep the adjacent `deployment-release.json` with the extracted runtime. Follow
the bundle's `INSTALL.txt` and documentation for that release. Runtime, collector
images and packs must stay paired; do not assemble a mixture of releases.

## Choose the Installation Guide

| Your setup | Continue here |
|---|---|
| itzg BDS in Docker, with an existing HTTPS proxy or tunnel | [Docker quickstart](QUICKSTART-BDS.md) |
| Crafty Controller or AMP | [Panel integration](PANELS.md) |
| Separate hosts or a map gateway managing HTTPS itself | [Deployment guide](DEPLOYMENT.md) |

The map prepares its own services and exports a server integration for you to
inspect and install. It does not silently restart Minecraft, enable experiments,
schedule backups, or manage future game-server upgrades. Existing world rules,
allowlists and game-port exposure remain the operator's responsibility.

Keep ingestion private. Only the HTTPS viewer and read APIs belong at the public
boundary; tokens and BDS module secrets never belong in browser configuration.
GitHub Pages hosts documentation, not the live collectors.
