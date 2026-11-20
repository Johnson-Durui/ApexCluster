from __future__ import annotations

import hashlib
from pathlib import Path


def implementation_sha256() -> str:
    root = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*.py"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\n")
        digest.update(path.read_bytes())
    return digest.hexdigest()
