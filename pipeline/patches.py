"""Build data/deadlock/patches.json — the patch summary + chart markers.

Inputs
  data/deadlock/patch-notes.curated.json   Hand-written analysis (edit this file!):
      latest_patch  - summary, meta impact, per-hero changes + playstyle impact
      patch_history - dated patches with {hero: buff|nerf|rework|adjustment|new}
  Deadlock API /v2/patches + /v1/patches/big-days - official changelog feed, used to
      catch patches that aren't in the curated file yet (shown as generic markers).

Run after editing the curated file:  python pipeline/patches.py
"""
from __future__ import annotations

from datetime import date, datetime

from common import DATA, get_json, now_iso, read_json, write_json

API = "https://api.deadlock-api.com"
CURATED = DATA / "deadlock" / "patch-notes.curated.json"
OUT = DATA / "deadlock" / "patches.json"
MATCH_WINDOW_DAYS = 2


def _d(s: str) -> date:
    return datetime.fromisoformat(s.replace("Z", "+00:00")[:19]).date() if "T" in s else date.fromisoformat(s[:10])


def official_feed():
    """Return [{date, title, url, source, big}] from the API; empty list if the API is down."""
    try:
        feed = get_json(f"{API}/v2/patches")
        big = {_d(x) for x in get_json(f"{API}/v1/patches/big-days")}
    except Exception as e:  # keep the site buildable offline
        print(f"warning: official patch feed unavailable ({e})")
        return []
    out = []
    for e in feed:
        title = (e.get("title") or "").strip()
        is_patch = e.get("source") == "forum" or any(w in title.lower() for w in ("update", "patch", "hotfix"))
        if not is_patch:
            continue
        d = _d(e["pub_date"])
        out.append({"date": d.isoformat(), "title": title, "url": e.get("link"),
                    "source": e.get("source"), "big": d in big})
    return out


def main():
    curated = read_json(CURATED)
    if curated is None:
        raise SystemExit(f"Missing {CURATED}")
    roster = {h["name"] for h in (read_json(DATA / "deadlock" / "heroes.json", {}) or {}).get("heroes", [])}

    markers = []
    for p in curated.get("patch_history", []):
        markers.append({
            "date": p["date"][:10], "version": p.get("version"), "title": p.get("title") or p.get("version"),
            "url": p.get("url"), "changes": p.get("changes", {}), "curated": True,
        })

    # Add official-feed patches that the curated history doesn't cover yet.
    curated_dates = [_d(m["date"]) for m in markers]
    for f in official_feed():
        fd = _d(f["date"])
        if any(abs((fd - cd).days) <= MATCH_WINDOW_DAYS for cd in curated_dates):
            continue
        markers.append({"date": f["date"], "version": None, "title": f["title"], "url": f["url"],
                        "changes": {}, "curated": False, "big": f["big"]})
        curated_dates.append(fd)

    markers.sort(key=lambda m: m["date"], reverse=True)

    # Sanity-check hero names against the live roster.
    if roster:
        names = {c["character"] for c in curated.get("latest_patch", {}).get("changes", [])}
        for m in markers:
            names |= set(m["changes"])
        unknown = sorted(n for n in names if n not in roster)
        if unknown:
            print(f"warning: hero names not in current roster: {unknown}")

    write_json(OUT, {
        "game": "deadlock",
        "updated": now_iso(),
        "latest": curated.get("latest_patch"),
        "markers": markers,
    })
    print(f"patches.json: latest={curated.get('latest_patch', {}).get('version')} markers={len(markers)}")


if __name__ == "__main__":
    main()
