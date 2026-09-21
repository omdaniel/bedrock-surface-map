"""List archive members without extracting them (build-time audit only)."""

import json
import sys
import tarfile

members = []
with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive:
        if len(members) >= 10000:
            raise ValueError("release archive entry limit exceeded")
        members.append(
            {
                "name": member.name,
                "type": "file" if member.isfile() else "dir" if member.isdir() else "other",
            }
        )
print(json.dumps(members))
