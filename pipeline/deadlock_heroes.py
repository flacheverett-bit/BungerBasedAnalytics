"""Fetch real daily hero win/pick data for Deadlock from the community Deadlock API.

Source: https://api.deadlock-api.com  (match data collected by deadlock-api.com;
covers a large sample of public matches, not every match played).

Output: data/deadlock/heroes.json
  dates          - one entry per complete UTC day
  total_matches  - matches tracked that day (sum of hero appearances / 12 players)
  heroes[i].wins / .matches - daily arrays aligned with `dates`

Win rate  = wins / matches               (per hero, per day)
Pick rate = matches / total_matches      (% of matches the hero appeared in)
Rates are computed in the browser so the site can apply rolling averages.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from common import DATA, get_json, now_iso, slugify, write_json

API = "https://api.deadlock-api.com"
DAYS = 400            # a bit more than 12 months so "Last 12 months" is always full
PLAYERS_PER_MATCH = 12


def fetch_roster():
    heroes = get_json(f"{API}/v1/assets/heroes")
    # Newly released heroes can stay flagged in_development for weeks, so those are
    # kept here and later dropped in main() unless they have recent matches.
    active = [h for h in heroes if h.get("player_selectable") and not h.get("disabled")]
    roster = {}
    for h in active:
        desc = h.get("description") or {}
        imgs = h.get("images") or {}
        roster[h["id"]] = {
            "id": h["id"],
            "name": h["name"],
            "slug": slugify(h["name"]),
            "role": (h.get("hero_type") or "").title() or None,
            "tagline": desc.get("role"),
            "playstyle": desc.get("playstyle"),
            "image": imgs.get("icon_image_small_webp") or imgs.get("icon_image_small"),
            "card_image": imgs.get("icon_hero_card_webp") or imgs.get("icon_hero_card"),
            "_in_development": bool(h.get("in_development")),
        }
    return roster


def main():
    roster = fetch_roster()
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = today - timedelta(days=DAYS)
    rows = get_json(
        f"{API}/v1/analytics/hero-stats?bucket=start_time_day"
        f"&min_unix_timestamp={int(start.timestamp())}&max_unix_timestamp={int(today.timestamp())}",
        timeout=300,
    )

    # Keep only complete days (drop today's partial bucket).
    buckets = sorted({r["bucket"] for r in rows if r["bucket"] < today.timestamp()})
    idx = {b: i for i, b in enumerate(buckets)}
    dates = [datetime.fromtimestamp(b, timezone.utc).strftime("%Y-%m-%d") for b in buckets]
    n = len(buckets)

    hero_matches_per_day = [0] * n
    series = {}
    for r in rows:
        i = idx.get(r["bucket"])
        if i is None:
            continue
        hero_matches_per_day[i] += r["matches"]
        if r["hero_id"] not in roster:
            continue
        s = series.setdefault(r["hero_id"], {"wins": [0] * n, "matches": [0] * n, "totals": [0] * 6})
        s["wins"][i] = r["wins"]
        s["matches"][i] = r["matches"]
        if i >= n - 30:  # last-30-day per-match averages
            t = s["totals"]
            t[0] += r["matches"]; t[1] += r["total_kills"]; t[2] += r["total_deaths"]
            t[3] += r["total_assists"]; t[4] += r["total_net_worth"]; t[5] += r["total_player_damage"]

    total_matches = [round(x / PLAYERS_PER_MATCH) for x in hero_matches_per_day]

    heroes = []
    for hid, meta in sorted(roster.items(), key=lambda kv: kv[1]["name"]):
        s = series.get(hid)
        if not s:
            continue
        in_dev = meta.pop("_in_development")
        if in_dev and sum(s["matches"][-14:]) < 1000:   # test-only hero, not actually live
            continue
        m, k, d, a, nw, dmg = s["totals"]
        heroes.append({
            **meta,
            "wins": s["wins"],
            "matches": s["matches"],
            "last30": {
                "matches": m,
                "kills": round(k / m, 2) if m else None,
                "deaths": round(d / m, 2) if m else None,
                "assists": round(a / m, 2) if m else None,
                "souls": round(nw / m) if m else None,
                "hero_damage": round(dmg / m) if m else None,
            },
        })

    write_json(DATA / "deadlock" / "heroes.json", {
        "game": "deadlock",
        "updated": now_iso(),
        "source": "deadlock-api.com (community match data, all game modes)",
        "source_url": "https://deadlock-api.com",
        "pick_rate_definition": "Share of tracked matches the hero appeared in (12 heroes per match).",
        "dates": dates,
        "total_matches": total_matches,
        "heroes": heroes,
    }, compact=True)
    print(f"heroes.json: {len(heroes)} heroes x {n} days ({dates[0]} -> {dates[-1]})")


if __name__ == "__main__":
    main()
