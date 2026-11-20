"""Concurrent-player history on Steam, per game.

data/<game>/players.json holds daily rows: [date, average, peak, readings]
(readings = null for days imported from a history source).

  python pipeline/players.py record [game ...]
      Takes one live Steam reading per game (all games if none given) and folds it
      into today's row. A GitHub Action runs this every hour.

  python pipeline/players.py import-steamdb <csv> [game]
      Backfill from a SteamDB CSV export (https://steamdb.info/app/<appid>/charts/).

  python pipeline/players.py import-steamcharts <game>
      Backfill from SteamCharts' public chart data (works for games SteamCharts tracks;
      Overwatch yes, Deadlock no).

Days already covered by live readings are never overwritten by an import.
"""
from __future__ import annotations

import csv
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from common import DATA, get_json, now_iso, read_json, write_json

GAMES = {
    "deadlock": 1422450,
    "overwatch": 2357570,
}
STEAM_CURRENT = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid={appid}"
STEAM_CHARTS = "https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/"
STEAMCHARTS_DATA = "https://steamcharts.com/app/{appid}/chart-data.json"


def out_path(game):
    return DATA / game / "players.json"


def load(game):
    return read_json(out_path(game), default=None) or {
        "game": game,
        "steam_appid": GAMES[game],
        "metric": "Concurrent players on Steam",
        "sources": [],
        "daily": [],
        "latest": None,
    }


def save(game, doc):
    doc["daily"].sort(key=lambda r: r[0])
    doc["updated"] = now_iso()
    write_json(out_path(game), doc, compact=True)


def add_source(doc, name):
    if name not in doc["sources"]:
        doc["sources"].append(name)


def live_reading(appid, charts_cache):
    """Current players + Steam rank. Tries the per-app endpoint, then the top-100 chart
    (some apps, e.g. Deadlock, aren't served by the per-app endpoint)."""
    if charts_cache.get("ranks") is None:
        try:
            charts_cache["ranks"] = get_json(STEAM_CHARTS).get("response", {}).get("ranks", [])
        except Exception:
            charts_cache["ranks"] = []
    row = next((r for r in charts_cache["ranks"] if r.get("appid") == appid), None)
    rank = row.get("rank") if row else None
    try:
        data = get_json(STEAM_CURRENT.format(appid=appid)).get("response", {})
        if data.get("result") == 1 and data.get("player_count") is not None:
            return int(data["player_count"]), rank
    except Exception:
        pass
    if row:
        return int(row["concurrent_in_game"]), rank
    return None, None


def record(games):
    charts_cache = {}
    now = datetime.now(timezone.utc)
    day = now.strftime("%Y-%m-%d")
    for game in games:
        players, rank = live_reading(GAMES[game], charts_cache)
        if players is None:
            print(f"{game}: no live reading available right now; skipped.")
            continue
        doc = load(game)
        add_source(doc, "Steam Web API (hourly live readings)")
        rows = {r[0]: r for r in doc["daily"]}
        r = rows.get(day)
        if r is None or r[3] is None:          # new day, or replacing an imported value
            rows[day] = [day, players, players, 1]
        else:
            _, avg, peak, n = r
            rows[day] = [day, round((avg * n + players) / (n + 1)), max(peak, players), n + 1]
        doc["daily"] = list(rows.values())
        doc["latest"] = {"time": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                         "players": players, "steam_rank": rank}
        save(game, doc)
        print(f"{game}: recorded {players:,} players for {day}" + (f" (Steam rank #{rank})" if rank else ""))


def merge_history(game, per_day, source):
    """per_day: {date: (avg, peak)}. Live-recorded days are kept."""
    doc = load(game)
    add_source(doc, source)
    rows = {r[0]: r for r in doc["daily"]}
    added = 0
    for day, (avg, peak) in per_day.items():
        if day in rows and rows[day][3] is not None:
            continue
        rows[day] = [day, round(avg), round(peak), None]
        added += 1
    doc["daily"] = list(rows.values())
    save(game, doc)
    print(f"{game}: imported {added} days; players.json now has {len(doc['daily'])} days.")


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


def import_steamdb(path: str, game: str):
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
    merge_history(game, {
        d: ((sum(v["avgs"]) / len(v["avgs"])) if v["avgs"] else sum(v["vals"]) / len(v["vals"]), max(v["vals"]))
        for d, v in per_day.items()
    }, "SteamDB export (historical backfill)")


def import_steamcharts(game: str):
    points = get_json(STEAMCHARTS_DATA.format(appid=GAMES[game]))
    if not points:
        raise SystemExit(f"SteamCharts has no data for {game}.")
    per_day = defaultdict(list)
    for ms, players in points:
        if players is not None:
            per_day[datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d")].append(players)
    # SteamCharts' oldest points are monthly averages; recent ones are ~hourly readings.
    merge_history(game, {d: (sum(v) / len(v), max(v)) for d, v in per_day.items()},
                  "SteamCharts (historical backfill)")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "record":
        record(args[1:] or list(GAMES))
    elif len(args) >= 2 and args[0] == "import-steamdb":
        import_steamdb(args[1], args[2] if len(args) > 2 else "deadlock")
    elif len(args) >= 2 and args[0] == "import-steamcharts":
        import_steamcharts(args[1])
    else:
        print(__doc__)
        sys.exit(1)
