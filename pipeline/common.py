"""Shared helpers for the data pipeline (standard library only — no installs needed)."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
USER_AGENT = "hero-meta-tracker/1.0 (student data project)"


def get_json(url: str, retries: int = 3, timeout: int = 120):
    """GET a URL and parse JSON, retrying on transient errors (5xx, timeouts)."""
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code < 500 and e.code != 429:
                raise
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, obj, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def slugify(name: str) -> str:
    out = "".join(c.lower() if c.isalnum() else "-" for c in name.replace("&", "and"))
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")
