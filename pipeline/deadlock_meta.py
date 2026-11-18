"""Matchups, popular builds and core items for every Deadlock hero (last 30 days).

Source: https://api.deadlock-api.com
  /v1/analytics/hero-counter-stats   hero-vs-enemy win rates (same match, any lane)
  /v1/analytics/hero-build-stats     how often each in-game build was played, and its win rate
  /v1/builds?build_id=...            the build's item list
  /v1/analytics/item-stats?hero_id=  per-hero item purchase rate, win rate, average buy time

Output: data/deadlock/meta.json
"""
from __future__ import annotations

import re
import time

from common import DATA, get_json, now_iso, read_json, write_json

API = "https://api.deadlock-api.com"
WINDOW_DAYS = 30
TOP_BUILDS = 3
MIN_BUILD_MATCHES = 500
MIN_MATCHUP_MATCHES = 1000
CORE_PER_PHASE = 6
PHASES = [("Early game", 0, 10 * 60), ("Mid game", 10 * 60, 25 * 60), ("Late game", 25 * 60, 10**9)]


def clean_category(name: str) -> str:
    """'#Citadel_HeroBuilds_LateGame' -> 'Late Game'; 'Laning Phase.' -> 'Laning Phase'."""
    if not name:
        return "Items"
    name = name.strip()
    if name.startswith("#"):
        name = re.sub(r"^#Citadel_HeroBuilds_", "", name)
        name = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name).replace("_", " ")
    return name.rstrip(".").strip() or "Items"


def main():
    heroes_doc = read_json(DATA / "deadlock" / "heroes.json")
    if not heroes_doc:
        raise SystemExit("Run deadlock_heroes.py first.")
    heroes = {h["id"]: h for h in heroes_doc["heroes"]}
    since = int(time.time()) - WINDOW_DAYS * 86400

    # ---- items (shop upgrades only) ----
    items = {}
    for it in get_json(f"{API}/v1/assets/items"):
        if it.get("type") == "upgrade" and it.get("shopable"):
            items[it["id"]] = {
                "name": it["name"],
                "image": it.get("shop_image_webp") or it.get("shop_image") or it.get("image_webp"),
                "slot": it.get("item_slot_type"),
                "tier": it.get("item_tier"),
                "cost": it.get("cost"),
            }

    # ---- counters ----
    rows = get_json(f"{API}/v1/analytics/hero-counter-stats?min_unix_timestamp={since}", timeout=300)
    totals = {}
    for r in rows:
        t = totals.setdefault(r["hero_id"], [0, 0])
        t[0] += r["wins"]; t[1] += r["matches_played"]
    matchups = {}
    for r in rows:
        h, e = heroes.get(r["hero_id"]), heroes.get(r["enemy_hero_id"])
        if not h or not e or r["matches_played"] < MIN_MATCHUP_MATCHES:
            continue
        base = totals[r["hero_id"]][0] / totals[r["hero_id"]][1]
        wr = r["wins"] / r["matches_played"]
        matchups.setdefault(h["name"], []).append({
            "enemy": e["name"], "wr": round(wr * 100, 2), "delta": round((wr - base) * 100, 2),
            "matches": r["matches_played"],
        })
    for lst in matchups.values():
        lst.sort(key=lambda m: m["delta"])

    # ---- popular builds ----
    stats = get_json(f"{API}/v1/analytics/hero-build-stats?min_unix_timestamp={since}"
                     f"&min_matches={MIN_BUILD_MATCHES}", timeout=300)
    by_hero = {}
    for s in stats:
        if s["hero_id"] in heroes:
            by_hero.setdefault(s["hero_id"], []).append(s)
    builds = {}
    for hid, lst in by_hero.items():
        lst.sort(key=lambda s: s["matches"], reverse=True)
        out = []
        for s in lst:
            if len(out) >= TOP_BUILDS:
                break
            try:
                found = get_json(f"{API}/v1/builds?build_id={s['hero_build_id']}&only_latest=true")
            except Exception as e:  # one missing build shouldn't sink the run
                print(f"warning: build {s['hero_build_id']}: {e}")
                continue
            if not found:
                continue
            b = found[0]["hero_build"]
            cats = []
            for c in (b.get("details") or {}).get("mod_categories", []):
                ids = [m["ability_id"] for m in c.get("mods", []) if m.get("ability_id") in items]
                if ids:
                    cats.append({"name": clean_category(c.get("name")), "items": ids})
            if not cats:
                continue
            out.append({
                "id": s["hero_build_id"], "name": (b.get("name") or "Untitled build").strip(),
                "matches": s["matches"], "players": s.get("players"),
                "wr": round(100 * s["wins"] / s["matches"], 2), "categories": cats,
            })
        builds[heroes[hid]["name"]] = out

    # ---- core items by phase ----
    core = {}
    for hid, h in heroes.items():
        hero_matches = sum(h["matches"][-WINDOW_DAYS:]) or 1
        try:
            st = get_json(f"{API}/v1/analytics/item-stats?hero_id={hid}&min_unix_timestamp={since}", timeout=300)
        except Exception as e:
            print(f"warning: item stats for {h['name']}: {e}")
            continue
        phases = []
        for label, lo, hi in PHASES:
            picks = [
                {"item": x["item_id"], "buy_rate": round(100 * x["matches"] / hero_matches, 1),
                 "wr": round(100 * x["wins"] / x["matches"], 1), "buy_min": round(x["avg_buy_time_s"] / 60, 1)}
                for x in st
                if x["item_id"] in items and x["matches"] >= 200 and lo <= x["avg_buy_time_s"] < hi
            ]
            picks.sort(key=lambda p: p["buy_rate"], reverse=True)
            phases.append({"phase": label, "items": picks[:CORE_PER_PHASE]})
        core[h["name"]] = phases
        time.sleep(0.4)  # stay well under the shared analytics rate limit

    used = {i for b in builds.values() for x in b for c in x["categories"] for i in c["items"]}
    used |= {p["item"] for ph in core.values() for x in ph for p in x["items"]}
    write_json(DATA / "deadlock" / "meta.json", {
        "game": "deadlock",
        "updated": now_iso(),
        "window_days": WINDOW_DAYS,
        "source": "deadlock-api.com",
        "items": {str(i): items[i] for i in sorted(used)},
        "matchups": matchups,
        "builds": builds,
        "core_items": core,
    }, compact=True)
    print(f"meta.json: {len(matchups)} heroes with matchups, {sum(len(b) for b in builds.values())} builds, "
          f"{len(core)} core-item lists, {len(used)} items")


if __name__ == "__main__":
    main()
