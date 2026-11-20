"""Load everything the site collects into one DuckDB database for SQL analysis.

Output
  data/warehouse.duckdb   (rebuilt from scratch each run; not committed, it's derived)
  data/exports/*.csv      one CSV per table (committed; handy for Tableau / Power BI / Excel)

Schema (every table has a `game` column: deadlock | overwatch | marvel-rivals)
  heroes          game, hero, slug, role
  hero_daily      game, date, hero, wins, matches, win_rate, pick_rate, ban_rate
                  Deadlock: real daily wins/matches. Overwatch / Marvel Rivals: daily snapshots of
                  published rates (season-to-date), so wins are null.
  daily_totals    game, date, total_matches            (Deadlock: matches tracked per day)
  patches         game, patch_date, title, version, url, heroes_changed
  patch_changes   game, patch_date, hero, change_type  (buff | nerf | rework | adjustment | new)
  players_daily   game, date, avg_players, peak_players, live_readings (null = imported history)
  matchups        game, hero, enemy, win_rate, delta_vs_avg, matches   (Deadlock, last 30 days)
  teamups         game, hero, loadout, partner, usage_share, games_gm, wr_with_partner, wr_delta_all
  perks           game, hero, tier, perk, pro_share                    (Overwatch)
  patch_impact    game, patch_date, hero, change_type, did_wr, did_pr, noise_sd_wr, q_wr, significant
"""
from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DB = DATA / "warehouse.duckdb"
EXPORTS = DATA / "exports"
GAMES = ["deadlock", "overwatch", "marvel-rivals"]


def jload(path: Path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def build_frames() -> dict[str, pd.DataFrame]:
    heroes, daily, totals, patches, changes, players = [], [], [], [], [], []
    matchups, teamups, perks, impact = [], [], [], []

    for g in GAMES:
        h = jload(DATA / g / "heroes.json")
        if h:
            dates = pd.to_datetime(h["dates"]).date
            if h.get("format") == "rates":
                for x in h["heroes"]:
                    heroes.append({"game": g, "hero": x["name"], "slug": x["slug"], "role": x.get("role")})
                    for i, d in enumerate(dates):
                        if x["wr"][i] is None:
                            continue
                        m = x.get("matches", [None] * len(dates))[i] if x.get("matches") else None
                        daily.append({"game": g, "date": d, "hero": x["name"], "wins": None, "matches": m,
                                      "win_rate": x["wr"][i], "pick_rate": x["pr"][i], "ban_rate": x["ban"][i]})
            else:  # Deadlock: wins / matches per day
                total = h["total_matches"]
                for i, d in enumerate(dates):
                    totals.append({"game": g, "date": d, "total_matches": total[i]})
                for x in h["heroes"]:
                    heroes.append({"game": g, "hero": x["name"], "slug": x["slug"], "role": x.get("role")})
                    for i, d in enumerate(dates):
                        m = x["matches"][i]
                        if not m:
                            continue
                        daily.append({"game": g, "date": d, "hero": x["name"], "wins": x["wins"][i], "matches": m,
                                      "win_rate": 100 * x["wins"][i] / m,
                                      "pick_rate": 100 * m / total[i] if total[i] else None, "ban_rate": None})

        p = jload(DATA / g / "patches.json")
        for m in (p or {}).get("markers", []):
            pd_ = pd.Timestamp(m["date"]).date()
            patches.append({"game": g, "patch_date": pd_, "title": m.get("title"), "version": m.get("version"),
                            "url": m.get("url"), "heroes_changed": len(m.get("changes") or {})})
            for hero, t in (m.get("changes") or {}).items():
                changes.append({"game": g, "patch_date": pd_, "hero": hero, "change_type": t})

        pl = jload(DATA / g / "players.json")
        for d, avg, peak, n in (pl or {}).get("daily", []):
            players.append({"game": g, "date": pd.Timestamp(d).date(), "avg_players": avg, "peak_players": peak, "live_readings": n})

    meta = jload(DATA / "deadlock" / "meta.json") or {}
    for hero, lst in meta.get("matchups", {}).items():
        for m in lst:
            matchups.append({"game": "deadlock", "hero": hero, "enemy": m["enemy"], "win_rate": m["wr"],
                             "delta_vs_avg": m["delta"], "matches": m["matches"]})

    tu = jload(DATA / "marvel-rivals" / "teamups.json") or {}
    for hero, v in tu.get("heroes", {}).items():
        for l in v.get("loadouts", []):
            teamups.append({"game": "marvel-rivals", "hero": hero, "loadout": l["loadout"], "partner": l["partner"],
                            "usage_share": l.get("share"), "games_gm": l.get("games_gm"),
                            "wr_with_partner": l.get("wr_with_partner"), "wr_delta_all": l.get("wr_delta_all")})

    pk = jload(DATA / "overwatch" / "perks.json") or {}
    for hero, v in pk.get("heroes", {}).items():
        for tier in ("minor", "major"):
            for x in v.get(tier, []):
                perks.append({"game": "overwatch", "hero": hero, "tier": tier, "perk": x["name"], "pro_share": x.get("share")})

    pi = jload(DATA / "deadlock" / "patch_impact.json") or {}
    for e in pi.get("events", []):
        if e.get("status") != "ok":
            continue
        impact.append({"game": "deadlock", "patch_date": pd.Timestamp(e["patch_date"]).date(), "hero": e["hero"],
                       "change_type": e["type"], "did_wr": e.get("did_wr"), "did_pr": e.get("did_pr"),
                       "noise_sd_wr": e.get("noise_sd_wr"), "q_wr": e.get("q_wr"), "significant": bool(e.get("sig_wr"))})

    return {
        "heroes": pd.DataFrame(heroes), "hero_daily": pd.DataFrame(daily), "daily_totals": pd.DataFrame(totals),
        "patches": pd.DataFrame(patches), "patch_changes": pd.DataFrame(changes), "players_daily": pd.DataFrame(players),
        "matchups": pd.DataFrame(matchups), "teamups": pd.DataFrame(teamups), "perks": pd.DataFrame(perks),
        "patch_impact": pd.DataFrame(impact),
    }


def main():
    frames = build_frames()
    if DB.exists():
        DB.unlink()
    EXPORTS.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB))
    for name, df in frames.items():
        if df.empty:
            continue
        for c in ("date", "patch_date"):
            if c in df.columns:
                df[c] = pd.to_datetime(df[c])
        con.register("df_view", df)
        con.execute(f"CREATE TABLE {name} AS SELECT * FROM df_view")
        con.unregister("df_view")
        for c in ("date", "patch_date"):
            if c in df.columns:
                con.execute(f"ALTER TABLE {name} ALTER COLUMN {c} TYPE DATE")
        con.execute(f"COPY {name} TO '{(EXPORTS / (name + '.csv')).as_posix()}' (HEADER, DELIMITER ',')")
    summary = con.execute("""
        SELECT table_name, estimated_size AS rows FROM duckdb_tables() ORDER BY table_name""").fetchall()
    con.close()
    print("warehouse.duckdb:", ", ".join(f"{t} ({n:,})" for t, n in summary))


if __name__ == "__main__":
    main()
