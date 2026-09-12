#!/usr/bin/env python3
import pathlib
import subprocess
import sys

bad = []
for name in subprocess.check_output(['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).decode().split('\0'):
    if not name:
        continue
    p = pathlib.PurePosixPath(name)
    if any(part in {'.local', '.sources', 'node_modules', 'target', 'maps', 'pkg', 'test-results'} for part in p.parts) or p.suffix.lower() in {'.mcworld', '.ldb', '.zip', '.wasm', '.pem', '.key'} or p.name.startswith('.env'):
        bad.append(name)
    size = int(subprocess.check_output(['git', 'cat-file', '-s', ':' + name]))
    if size > 1024 * 1024:
        bad.append(name + ' exceeds 1 MiB')
if bad:
    sys.exit('Forbidden staged artifacts: ' + ', '.join(bad))
