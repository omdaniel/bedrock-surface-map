#!/bin/sh
# Compatibility wrapper. Hook installation is explicit and never changes
# unrelated repository preferences such as pull.ff or push.default.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$root/scripts/dev.mjs" setup --install-hooks "$@"
