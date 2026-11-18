"""Concurrent-player history for Deadlock.

Two inputs feed data/deadlock/players.json (daily rows: date, average, peak, readings):

  python pipeline/players.py record
      Takes one live reading from Steam's official charts API and folds it into
      today's row. A GitHub Action runs this every hour.

  python pipeline/players.py import-steamdb data/raw/steamdb_chart_1422450.csv
      One-time backfill from the CSV you can download at
      https://steamdb.info/app/1422450/charts/ (download button under the chart).
      Days already covered by live readings are kept as-is.
"""
from __future__ import annotations

import csv
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from common import DATA, get_json, now_iso, read_json, write_json

STEAM_APPID = 1422450
STEAM_CHARTS = "https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/"
OUT = DATA / "deadlock" / "players.json"


def load():
    return read_json(OUT, default=None) or {
        "game": "deadlock",
        "steam_appid": STEAM_APPID,
        "metric": "Concurrent players on Steam",
        "sources": [],
        "daily": [],   # [date, avg, peak, readings]  readings = null for imported rows
        "latest": None,
    }


def save(doc):
    doc["daily"].sort(key=lambda r: r[0])
    doc["updated"] = now_iso()
    write_json(OUT, doc, compact=True)


def add_source(doc, name):
    if name not in doc["sources"]:
        doc["sources"].append(name)


def record():
    data = get_json(STEAM_CHARTS)
    ranks = data.get("response", {}).get("ranks", [])
    row = next((r for r in ranks if r.get("appid") == STEAM_APPID), None)
    if row is None:
        print("Deadlock is not in Steam's top-100 concurrent list right now; no reading recorded.")
        return
    players = int(row["concurrent_in_game"])
    now = datetime.now(timezone.utc)
    day = now.strftime("%Y-%m-%d")

    doc = load()
    add_source(doc, "Steam Web API (hourly live readings)")
    rows = {r[0]: r for r in doc["daily"]}
    r = rows.get(day)
    if r is None or r[3] is None:          # new day, or replacing an imported estimate
        rows[day] = [day, players, players, 1]
    else:
        _, avg, peak, n = r
        rows[day] = [day, round((avg * n + players) / (n + 1)), max(peak, players), n + 1]
    doc["daily"] = list(rows.values())
    doc["latest"] = {"time": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                     "players": players, "steam_rank": row.get("rank")}
    save(doc)
    print(f"Recorded {players:,} players for {day} (Steam rank #{row.get('rank')})")


def _parse_date(s: str):
    s = s.strip().replace("Z", "")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%m/%d/%Y %H:%M", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    if s.isdigit():  # unix seconds or ms
        v = int(s)
        return datetime.fromtimestamp(v / 1000 if v > 10**11 else v, timezone.utc)
    raise ValueError(f"Unrecognized date: {s!r}")


def import_steamdb(path: str):
    p = Path(path)
    with p.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        cols = [c.strip() for c in reader.fieldnames or []]
        date_col = next((c for c in reader.fieldnames if "date" in c.lower() or "time" in c.lower()), reader.fieldnames[0])
        players_col = next((c for c in reader.fieldnames if c.strip().lower() == "players"), None)
        avg_col = next((c for c in reader.fieldnames if "average" in c.lower()), None)
        if players_col is None:
            players_col = next(c for c in reader.fieldnames if c != date_col and c != avg_col)
        per_day = defaultdict(lambda: {"vals": [], "avgs": []})
        for row in reader:
            raw = (row.get(players_col) or "").strip()
            if not raw:
                continue
            day = _parse_date(row[date_col]).strftime("%Y-%m-%d")
            per_day[day]["vals"].append(float(raw))
            a = (row.get(avg_col) or "").strip() if avg_col else ""
            if a:
                per_day[day]["avgs"].append(float(a))
    print(f"CSV columns: {cols} -> date={date_col!r}, players={players_col!r}, average={avg_col!r}")

    doc = load()
    add_source(doc, "SteamDB export (historical backfill)")
    rows = {r[0]: r for r in doc["daily"]}
    added = 0
    for day, v in per_day.items():
        if day in rows and rows[day][3] is not None:   # live data wins
            continue
        vals = v["vals"]
        avg = sum(v["avgs"]) / len(v["avgs"]) if v["avgs"] else sum(vals) / len(vals)
        rows[day] = [day, round(avg), round(max(vals)), None]
        added += 1
    doc["daily"] = list(rows.values())
    save(doc)
    print(f"Imported {added} days from {p.name}; players.json now has {len(doc['daily'])} days.")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "record":
        record()
    elif len(sys.argv) >= 3 and sys.argv[1] == "import-steamdb":
        import_steamdb(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)
