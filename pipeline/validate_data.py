"""Data validation: checks every data file against rules that must hold if the data is right.

Each check is an invariant, a property true by construction, so a failure means a
bug or a bad upstream feed, not "interesting data". Examples:
  * Every match has one winner and one loser, so the pick-weighted average win rate is ~50%.
  * Pick rates must add up to the number of players per match.
  * The two loadouts / perks a hero chooses between must add up to ~100%.

Run:  python pipeline/validate_data.py          (exit code 1 if any check FAILS)
Writes data/data_health.json, a machine-readable report.
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
results = []


def check(game, area, name, ok, detail, level="FAIL"):
    status = "PASS" if ok else level
    results.append({"game": game, "area": area, "check": name, "status": status, "detail": detail})


def jload(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
    except json.JSONDecodeError as e:
        return {"__error__": str(e)}


def num(v):
    return isinstance(v, (int, float)) and not (isinstance(v, float) and (math.isnan(v) or math.isinf(v)))


def age_days(iso):
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - t).total_seconds() / 86400
    except Exception:
        return None


def validate_heroes(gid, g, h):
    dates = h.get("dates", [])
    n = len(dates)
    check(gid, "heroes", "dates sorted and unique", dates == sorted(set(dates)), f"{n} dates")
    if h.get("format") != "rates" and n > 1:   # daily match data should have no gaps
        d0 = datetime.fromisoformat(dates[0])
        missing = [d for i, d in enumerate(dates) if datetime.fromisoformat(d) != d0 + timedelta(days=i)]
        check(gid, "heroes", "no missing days", not missing, f"{len(missing)} gaps" if missing else "continuous", "WARN")
    names = [x["name"] for x in h["heroes"]]
    check(gid, "heroes", "hero names unique", len(names) == len(set(names)), f"{len(names)} heroes")
    slugs = [x["slug"] for x in h["heroes"]]
    check(gid, "heroes", "hero slugs unique", len(slugs) == len(set(slugs)), "")
    no_img = [x["name"] for x in h["heroes"] if not x.get("image")]
    check(gid, "heroes", "every hero has an image", not no_img, ", ".join(no_img) or "all present", "WARN")
    age = age_days(h.get("updated", ""))
    check(gid, "heroes", "updated within 2 days", age is not None and age < 2, f"{age:.1f} days old" if age is not None else "no timestamp", "WARN")

    if h.get("format") == "rates":
        keys = ("wr", "pr", "ban")
        bad_len = [x["name"] for x in h["heroes"] if any(len(x.get(k, [])) != n for k in keys)]
        check(gid, "heroes", "arrays aligned with dates", not bad_len, ", ".join(bad_len[:5]) or "ok")
        for i, d in enumerate(dates):
            wr = [(x["wr"][i], x["pr"][i]) for x in h["heroes"] if num(x["wr"][i]) and num(x["pr"][i])]
            out = [x["name"] for x in h["heroes"] if num(x["wr"][i]) and not 25 <= x["wr"][i] <= 75]
            check(gid, "heroes", f"{d}: win rates plausible (25-75%)", not out, ", ".join(out) or f"{len(wr)} heroes")
            bans = [x["ban"][i] for x in h["heroes"] if num(x["ban"][i])]
            check(gid, "heroes", f"{d}: rates within 0-100%", all(0 <= v <= 100 for _, v in wr) and all(0 <= b <= 100 for b in bans), "")
            sp = sum(p for _, p in wr)
            avg = sum(w * p for w, p in wr) / sp if sp else float("nan")
            # one winner and one loser per match => pick-weighted win rate ~50% (mirror matches excluded upstream)
            check(gid, "heroes", f"{d}: pick-weighted win rate ~50%", abs(avg - 50) < 1.5, f"{avg:.2f}%")
            exp = g.get("players_per_match_pct")
            if exp:
                check(gid, "heroes", f"{d}: pick rates sum to players per match", abs(sp - exp) / exp < 0.08,
                      f"sum {sp:.0f}% vs expected {exp}%", "WARN")
            else:
                results.append({"game": gid, "area": "heroes", "check": f"{d}: pick-rate sum (info)", "status": "INFO", "detail": f"{sp:.0f}%"})
    else:
        total = h["total_matches"]
        check(gid, "heroes", "totals aligned with dates", len(total) == n, f"{len(total)} vs {n}")
        bad = []
        for x in h["heroes"]:
            if len(x["wins"]) != n or len(x["matches"]) != n:
                bad.append(x["name"] + " (length)")
            elif any(w > m or w < 0 for w, m in zip(x["wins"], x["matches"])):
                bad.append(x["name"] + " (wins > matches)")
        check(gid, "heroes", "wins <= matches for every hero/day", not bad, ", ".join(bad[:5]) or "ok")
        sums_w = [sum(x["wins"][i] for x in h["heroes"]) for i in range(n)]
        sums_m = [sum(x["matches"][i] for x in h["heroes"]) for i in range(n)]
        worst = max((abs(100 * w / m - 50), dates[i]) for i, (w, m) in enumerate(zip(sums_w, sums_m)) if m)
        check(gid, "heroes", "every day: overall win rate ~50%", worst[0] < 1.0, f"worst day {worst[1]}: {50 + worst[0]:.2f}% / {50 - worst[0]:.2f}%")
        # 12 heroes per match: hero appearances / total matches ~ 12 (heroes outside the roster lower it slightly)
        ratios = [m / t for m, t in zip(sums_m, total) if t]
        lo, hi = min(ratios), max(ratios)
        check(gid, "heroes", "hero appearances per match ~12", 10.5 <= lo and hi <= 12.05, f"range {lo:.2f}-{hi:.2f}")
        recent = total[-8:-1]
        drop = total[-1] / (sum(recent) / len(recent)) if recent and sum(recent) else 1
        check(gid, "heroes", "latest day not a partial/empty bucket", drop > 0.5, f"latest {total[-1]:,} vs 7-day avg {sum(recent)/len(recent):,.0f}", "WARN")


def validate_players(gid, p):
    rows = p.get("daily", [])
    dates = [r[0] for r in rows]
    check(gid, "players", "dates unique and sorted", dates == sorted(set(dates)), f"{len(rows)} days")
    bad = [r[0] for r in rows if not (num(r[1]) and num(r[2]) and r[1] >= 0 and r[2] >= 0)]
    check(gid, "players", "no negative or missing counts", not bad, ", ".join(bad[:5]) or "ok")
    peak_lt_avg = [r[0] for r in rows if num(r[1]) and num(r[2]) and r[2] < r[1] * 0.999]
    check(gid, "players", "daily peak >= daily average", not peak_lt_avg, ", ".join(peak_lt_avg[:5]) or "ok")
    spikes = []
    for a, b in zip(rows, rows[1:]):
        da, db = datetime.fromisoformat(a[0]), datetime.fromisoformat(b[0])
        if (db - da).days == 1 and a[1] and (b[1] / a[1] > 3 or b[1] / a[1] < 1 / 3):
            spikes.append(f"{b[0]} ({a[1]:,}->{b[1]:,})")
    check(gid, "players", "no 3x day-over-day jumps", not spikes, "; ".join(spikes[:4]) or "ok", "WARN")
    lat = p.get("latest") or {}
    age = age_days(lat.get("time", "")) if lat else None
    check(gid, "players", "live reading within 3 hours", age is not None and age < 0.125, f"{age*24:.1f} h old" if age is not None else "none", "WARN")


def validate_patches(gid, pt, roster):
    if not pt:
        check(gid, "patches", "patches.json exists", False, "missing")
        return
    m = pt.get("markers", [])
    types = {"buff", "nerf", "rework", "adjustment", "new"}
    bad_type = [f"{x['date']} {k}:{v}" for x in m for k, v in (x.get("changes") or {}).items() if v not in types]
    check(gid, "patches", "change types valid", not bad_type, ", ".join(bad_type[:5]) or f"{sum(len(x.get('changes') or {}) for x in m)} changes")
    unknown = sorted({k for x in m for k in (x.get("changes") or {}) if k not in roster})
    check(gid, "patches", "every patched hero exists in the roster", not unknown, ", ".join(unknown) or "ok", "WARN")
    latest = pt.get("latest") or {}
    lch = [c.get("character") for c in latest.get("changes", [])]
    unk2 = [c for c in lch if c not in roster]
    check(gid, "patches", "latest-patch hero cards match the roster", not unk2, ", ".join(unk2) or f"{len(lch)} cards")
    future = [x["date"] for x in m if x["date"] > datetime.now(timezone.utc).strftime("%Y-%m-%d")]
    check(gid, "patches", "no patches dated in the future", not future, ", ".join(future) or "ok")
    dup = [d for d in {x["date"] for x in m} if sum(1 for y in m if y["date"] == d) > 1]
    check(gid, "patches", "one entry per patch date", not dup, ", ".join(dup) or "ok", "WARN")
    words = len((latest.get("summary") or "").split()), len((latest.get("meta_impact") or "").split())
    check(gid, "patches", "summary concise (<= ~80 / 120 words)", words[0] <= 80 and words[1] <= 120, f"{words[0]} / {words[1]} words", "WARN")


def validate_share_pairs(gid, area, groups, label):
    """groups: {hero: [[share, share], ...]}; each pair of options should sum to ~100%."""
    bad, n = [], 0
    for hero, pairs in groups.items():
        for pair in pairs:
            vals = [v for v in pair if num(v)]
            if len(vals) == len(pair) and vals:
                n += 1
                if abs(sum(vals) - 100) > 2:
                    bad.append(f"{hero} ({'+'.join(f'{v:g}' for v in vals)})")
    check(gid, area, f"{label} sum to 100%", not bad, ", ".join(bad[:5]) or f"{n} pairs checked")


def main():
    games = jload(DATA / "games.json") or []
    check("site", "config", "games.json loads", bool(games), f"{len(games)} games")
    for g in games:
        gid = g["id"]
        for f in ("heroes.json", "patches.json", "players.json", "patch-notes.curated.json", "hypotheses.md"):
            check(gid, "files", f"{f} present", (DATA / gid / f).exists(), "")
        h = jload(DATA / gid / "heroes.json")
        roster = {x["name"] for x in h["heroes"]} if h and "heroes" in h else set()
        if h and "__error__" not in h:
            validate_heroes(gid, g, h)
        p = jload(DATA / gid / "players.json")
        if p:
            validate_players(gid, p)
        validate_patches(gid, jload(DATA / gid / "patches.json"), roster)

        comps = jload(DATA / gid / "comps.curated.json")
        if comps:
            names = {n for c in comps["comps"] for k in ("tank", "damage", "support", "vanguard", "duelist", "strategist", "core") for n in c.get(k, [])}
            unk = sorted(n for n in names if n not in roster)
            check(gid, "comps", "comp heroes exist in the roster", not unk, ", ".join(unk) or f"{len(comps['comps'])} comps")
            roles = {x["name"]: (x.get("role") or "").lower() for x in h["heroes"]} if h else {}
            wrong = [f"{n} in {k}" for c in comps["comps"] for k in ("tank", "damage", "support", "vanguard", "duelist", "strategist")
                     for n in c.get(k, []) if roles.get(n) and roles[n] != k]
            check(gid, "comps", "comp heroes listed under their own role", not wrong, ", ".join(wrong[:5]) or "ok")
            core_missing = [f"{c['name']}: {n}" for c in comps["comps"] for n in c.get("core", [])
                            if not any(n in c.get(k, []) for k in ("tank", "damage", "support", "vanguard", "duelist", "strategist"))]
            check(gid, "comps", "core heroes also appear in a role slot", not core_missing, ", ".join(core_missing[:5]) or "ok", "WARN")

        perks = jload(DATA / gid / "perks.json")
        if perks:
            validate_share_pairs(gid, "perks", {k: [[p["share"] for p in v.get(t, [])] for t in ("minor", "major")] for k, v in perks["heroes"].items()},
                                 "minor/major perk pick shares")
            two = [k for k, v in perks["heroes"].items() if len(v.get("minor", [])) != 2 or len(v.get("major", [])) != 2]
            check(gid, "perks", "every hero has 2 minor + 2 major perks", not two, ", ".join(two[:5]) or f"{len(perks['heroes'])} heroes")
            missing = sorted(roster - set(perks["heroes"]))
            check(gid, "perks", "perks cover the whole roster", not missing, ", ".join(missing) or "all heroes", "WARN")

        tu = jload(DATA / gid / "teamups.json")
        if tu:
            validate_share_pairs(gid, "teamups", {k: [[l["share"] for l in v["loadouts"]]] for k, v in tu["heroes"].items()}, "team-up loadout shares")
            missing = sorted(roster - set(tu["heroes"]))
            check(gid, "teamups", "team-ups cover the whole roster", not missing, ", ".join(missing) or "all heroes", "WARN")
            unk = sorted({l["partner"] for v in tu["heroes"].values() for l in v["loadouts"]
                          if not any(re.sub(r"[^a-z]", "", l["partner"].lower()) == re.sub(r"[^a-z]", "", re.sub(r"\s*\(\w+\)$", "", n).lower()) for n in roster)})
            check(gid, "teamups", "team-up partners exist in the roster", not unk, ", ".join(unk) or "ok", "WARN")

        meta = jload(DATA / gid / "meta.json")
        if meta and "matchups" in meta:
            pairs = {(hh, m["enemy"]): m for hh, lst in meta["matchups"].items() for m in lst}
            dev = [abs(m["wr"] + pairs[(e, hh)]["wr"] - 100) for (hh, e), m in pairs.items() if (e, hh) in pairs]
            check(gid, "matchups", "A vs B and B vs A win rates sum to 100%", dev and max(dev) < 0.5, f"{len(dev)} directed pairs, max deviation {max(dev) if dev else 0:.3f}")
            bwr = [b["wr"] for lst in meta.get("builds", {}).values() for b in lst]
            check(gid, "builds", "build win rates plausible (30-70%)", all(30 <= v <= 70 for v in bwr), f"{len(bwr)} builds")
            items = meta.get("items", {})
            missing_items = {i for lst in meta.get("builds", {}).values() for b in lst for c in b["categories"] for i in c["items"] if str(i) not in items}
            check(gid, "builds", "every build item has item info", not missing_items, f"{len(missing_items)} missing" if missing_items else "ok")

        pi = jload(DATA / gid / "patch_impact.json")
        if pi:
            ok = [e for e in pi["events"] if e["status"] == "ok"]
            qs = [e["q_wr"] for e in ok if e.get("q_wr") is not None]
            check(gid, "patch_impact", "q-values within 0-1", all(0 <= q <= 1 for q in qs), f"{len(qs)} tests")
            s = pi["summary"]
            check(gid, "patch_impact", "summary counts match events",
                  s["buff"]["events"] == sum(1 for e in ok if e["type"] == "buff" and e.get("p_wr") is not None), "")

    mh = jload(DATA / "meta_health.json")
    if mh:
        for g in mh["games"]:
            vals = [v for p in g["series"] for k, v in p.items() if k in ("score", "diversity", "viable", "fairness")]
            check(g["id"], "meta_health", "scores within 0-100", all(num(v) and 0 <= v <= 100 for v in vals), f"{len(g['series'])} days")
    sql = jload(DATA / "sql" / "results.json")
    if sql:
        errs = [q["id"] for q in sql["queries"] if "error" in q]
        check("site", "sql", "every SQL query ran", not errs, ", ".join(errs) or f"{len(sql['queries'])} queries")
        empty = [q["id"] for q in sql["queries"] if q.get("row_count") == 0]
        check("site", "sql", "no SQL query returned 0 rows", not empty, ", ".join(empty) or "ok", "WARN")

    summary = {s: sum(1 for r in results if r["status"] == s) for s in ("PASS", "WARN", "FAIL", "INFO")}
    (DATA / "data_health.json").write_text(json.dumps({
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "summary": summary, "checks": results,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for r in results:
        if r["status"] != "PASS":
            print(f"{r['status']:4} {r['game']:13} {r['area']:12} {r['check']} | {r['detail']}")
    print(f"\n{summary['PASS']} passed, {summary['WARN']} warnings, {summary['FAIL']} failed, {summary['INFO']} info")
    return 1 if summary["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
