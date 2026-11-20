"""Daily snapshot of Overwatch hero win / pick / ban rates from Blizzard's official stats page.

Source: https://overwatch.blizzard.com/en-us/rates/
Slice tracked: Competitive Role Queue, PC (mouse & keyboard), Americas, all ranks.

Blizzard only publishes current numbers (no history), so each run appends today's
snapshot to data/overwatch/heroes.json. History grows one point per day.

Output format ("rates"): dates[] plus, per hero, wr[] / pr[] / ban[] aligned with dates
(null where the hero had no data that day).
"""
from __future__ import annotations

import html
import json
import re
from datetime import datetime, timezone

from common import DATA, get_text, now_iso, read_json, write_json

QUERY = {"input": "PC", "map": "all-maps", "region": "Americas", "role": "All", "rq": "1", "tier": "All"}
SLICE = "Competitive · Role Queue · PC · Americas · All ranks"
URL = "https://overwatch.blizzard.com/en-us/rates/?" + "&".join(f"{k}={v}" for k, v in QUERY.items())
OUT = DATA / "overwatch" / "heroes.json"


def fetch_rows():
    page = get_text(URL)
    m = re.search(r'allrows="([^"]+)"', page)
    if not m:
        raise RuntimeError("Blizzard rates page layout changed: 'allrows' not found")
    rows = json.loads(html.unescape(m.group(1)))
    if len(rows) < 30:
        raise RuntimeError(f"Only {len(rows)} heroes parsed; refusing to save a partial snapshot")
    return rows


def main():
    rows = fetch_rows()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    doc = read_json(OUT) or {
        "game": "overwatch", "format": "rates", "dates": [], "heroes": [],
        "source": "Blizzard official hero statistics", "source_url": URL, "slice": SLICE,
        "pick_rate_definition": "Blizzard's pick rate: share of games (in this slice) the hero was played in.",
    }
    dates = doc["dates"]
    if today in dates:
        i = dates.index(today)
    else:
        dates.append(today)
        i = len(dates) - 1
        for h in doc["heroes"]:
            for k in ("wr", "pr", "ban"):
                h[k].append(None)

    by_id = {h["id"]: h for h in doc["heroes"]}
    for r in rows:
        c, meta = r["cells"], r["hero"]
        h = by_id.get(r["id"])
        if h is None:  # new hero: pad history with nulls
            h = {"id": r["id"], "slug": r["id"], "wr": [None] * len(dates), "pr": [None] * len(dates), "ban": [None] * len(dates)}
            doc["heroes"].append(h)
            by_id[r["id"]] = h
        h.update({
            "name": c["name"],
            "role": (meta.get("role") or "").title() or None,
            "subrole": (meta.get("subrole") or "").title() or None,
            "image": meta.get("portrait"),
            "card_image": meta.get("portrait"),
        })
        h["wr"][i] = c.get("winrate")
        h["pr"][i] = c.get("pickrate")
        h["ban"][i] = c.get("banrate")

    doc["heroes"].sort(key=lambda h: h["name"])
    doc["updated"] = now_iso()
    write_json(OUT, doc, compact=True)
    print(f"overwatch heroes.json: {len(rows)} heroes, snapshot {today}, {len(dates)} day(s) of history")


if __name__ == "__main__":
    main()
