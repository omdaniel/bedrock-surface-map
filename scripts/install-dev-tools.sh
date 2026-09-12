#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"
version=8.30.1
case "$(uname -s):$(uname -m)" in
 Darwin:arm64) platform=darwin_arm64; checksum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
 Linux:x86_64) platform=linux_x64; checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
 *) echo 'Unsupported scanner platform' >&2; exit 1 ;;
esac
dest=.sources/tools/gitleaks
mkdir -p "$dest"
archive="gitleaks_${version}_${platform}.tar.gz"
if [ ! -f "$dest/$archive" ]; then
 curl -fL --retry 3 --connect-timeout 30 --max-time 300 "https://github.com/gitleaks/gitleaks/releases/download/v$version/$archive" -o "$dest/$archive"
fi
(cd "$dest" && printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -)
tar -xzf "$dest/$archive" -C "$dest" gitleaks
chmod 0755 "$dest/gitleaks" .githooks/pre-commit .githooks/pre-push
git config --local core.hooksPath .githooks
git config --local pull.ff only
git config --local push.default simple
