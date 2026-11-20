"""Meta health: how diverse and balanced is each game's meta, and do patches change it?

Meta Health Score (0-100, higher = healthier) = average of three components, each 0-100:

  1. Pick diversity  = effective number of heroes / roster size.
                       Effective heroes = 1 / HHI, where HHI = sum of squared pick shares
                       (the Herfindahl-Hirschman Index economists use for market concentration).
                       100% = every hero picked equally.
  2. Viable roster   = % of heroes that are realistically usable: win rate at or above the game's
                       C-tier floor (from games.json tier_bands) AND at least half of an equal pick share.
  3. Fairness        = % of all picks that go to heroes within +/-3 points of a 50% win rate.
                       Weighted by picks, since a broken hero nobody plays matters less than one
                       everyone plays.

Inputs per format:
  "matches" (Deadlock): daily wins/matches, smoothed over a 7-day rolling window.
  "rates" (Overwatch, Marvel Rivals): daily snapshots of published pick and win rates.
                       Pick shares = pick rate / sum of pick rates.

Patch effect (games with enough history): score in the 14 days before vs after each big patch,
compared with the normal 14-vs-14-day swing on dates with no big patch nearby.

Output: data/meta_health.json
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "meta_health.json"
ROLL_DAYS = 7
FAIR_BAND = 3.0          # +/- points around 50% win rate
PATCH_WINDOW = 14        # days each side
MIN_DAYS_FOR_PATCH_TEST = 60


def jload(p: Path):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def components(shares: np.ndarray, wr: np.ndarray, c_floor: float, roles: np.ndarray | None = None) -> dict:
    """All inputs aligned per hero; shares sum to 1.

    roles: for role-queue games (fixed slots per role, e.g. Overwatch 1 tank / 2 damage / 2 support),
    pass each hero's role. Diversity and viability are then measured within each role and combined,
    weighted by the role's share of picks. Otherwise unequal role pool sizes would look like
    "concentration" even if every role were perfectly balanced."""
    ok = (shares > 0) & ~np.isnan(wr)
    s, w = shares[ok], wr[ok]
    n = len(s)
    if n < 5:
        return None
    s = s / s.sum()
    hhi = float(np.sum(s ** 2))
    eff = 1 / hhi
    if roles is not None:
        r = roles[ok]
        diversity, viable_mask = 0.0, np.zeros(n, dtype=bool)
        for role in np.unique(r):
            m = r == role
            sr = s[m] / s[m].sum()
            diversity += s[m].sum() * 100 * (1 / np.sum(sr ** 2)) / m.sum()
            viable_mask[m] = (w[m] >= c_floor) & (sr >= 0.5 / m.sum())
        viable = 100 * float(np.mean(viable_mask))
    else:
        diversity = 100 * eff / n
        viable = 100 * float(np.mean((w >= c_floor) & (s >= 0.5 / n)))
    fairness = 100 * float(np.sum(s[np.abs(w - 50) <= FAIR_BAND]))
    wr_sd = float(np.sqrt(np.sum(s * (w - np.sum(s * w)) ** 2)))
    return {"score": (diversity + viable + fairness) / 3, "diversity": diversity, "viable": viable,
            "fairness": fairness, "effective_heroes": eff, "roster": n, "wr_spread_sd": wr_sd}


def series_matches(h: dict, c_floor: float) -> pd.DataFrame:
    dates = pd.to_datetime(h["dates"])
    wins = pd.DataFrame({x["name"]: x["wins"] for x in h["heroes"]}, index=dates)
    games = pd.DataFrame({x["name"]: x["matches"] for x in h["heroes"]}, index=dates)
    w7 = wins.rolling(ROLL_DAYS, min_periods=ROLL_DAYS).sum()
    m7 = games.rolling(ROLL_DAYS, min_periods=ROLL_DAYS).sum()
    rows = []
    for d in m7.index[ROLL_DAYS - 1:]:
        m = m7.loc[d].to_numpy(dtype=float)
        if m.sum() == 0:
            continue
        with np.errstate(invalid="ignore", divide="ignore"):
            wr = 100 * w7.loc[d].to_numpy(dtype=float) / m
        c = components(m / m.sum(), wr, c_floor)
        if c:
            rows.append({"date": d, **c})
    return pd.DataFrame(rows)


def series_rates(h: dict, c_floor: float, role_queue: bool = False) -> pd.DataFrame:
    rows = []
    roles = np.array([x.get("role") or "?" for x in h["heroes"]]) if role_queue else None
    for i, d in enumerate(pd.to_datetime(h["dates"])):
        pr = np.array([x["pr"][i] if x["pr"][i] is not None else 0 for x in h["heroes"]], dtype=float)
        wr = np.array([x["wr"][i] if x["wr"][i] is not None else np.nan for x in h["heroes"]], dtype=float)
        if pr.sum() == 0:
            continue
        c = components(pr / pr.sum(), wr, c_floor, roles)
        if c:
            rows.append({"date": d, **c})
    return pd.DataFrame(rows)


def patch_effects(s: pd.DataFrame, patches: list[dict], big: int) -> tuple[list, dict | None]:
    """Score 14 days before vs after each big patch, vs. the normal 14-vs-14 swing (placebo)."""
    if len(s) < MIN_DAYS_FOR_PATCH_TEST:
        return [], None
    s = s.set_index("date").sort_index()
    big_dates = sorted(pd.Timestamp(p["date"]) for p in patches if len(p.get("changes") or {}) >= big)
    one = pd.Timedelta(days=1)

    def delta(d):
        b = s.loc[d - PATCH_WINDOW * one: d - one]
        a = s.loc[d + one: d + PATCH_WINDOW * one]
        if len(b) < PATCH_WINDOW * 0.7 or len(a) < PATCH_WINDOW * 0.7:
            return None
        return {k: float(a[k].mean() - b[k].mean()) for k in ("score", "diversity", "viable", "fairness")} | \
               {"score_before": float(b["score"].mean()), "score_after": float(a["score"].mean())}

    events = []
    for p in patches:
        if len(p.get("changes") or {}) < big:
            continue
        d = pd.Timestamp(p["date"])
        r = delta(d)
        if r:
            events.append({"date": d.strftime("%Y-%m-%d"), "title": p.get("title"), "heroes_changed": len(p["changes"]), **r})

    # Placebo: dates at least one full window away from any big patch.
    placebo = []
    for d in s.index:
        if all(abs((d - b).days) > PATCH_WINDOW for b in big_dates):
            r = delta(d)
            if r:
                placebo.append(r["score"])
    noise = None
    if len(placebo) >= 20:
        noise = {"days": len(placebo), "sd": float(np.std(placebo, ddof=1)),
                 "p2_5": float(np.percentile(placebo, 2.5)), "p97_5": float(np.percentile(placebo, 97.5))}
        for e in events:
            e["beyond_noise"] = not (noise["p2_5"] <= e["score"] <= noise["p97_5"])
    events.sort(key=lambda e: e["date"], reverse=True)
    return events, noise


def r1(v):
    return None if v is None or (isinstance(v, float) and np.isnan(v)) else round(float(v), 2)


def main():
    games = jload(DATA / "games.json") or []
    out = {"generated": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ"),
           "params": {"rolling_days": ROLL_DAYS, "fair_band_pts": FAIR_BAND, "patch_window_days": PATCH_WINDOW},
           "games": []}
    for g in games:
        h = jload(DATA / g["id"] / "heroes.json")
        if not h:
            continue
        bands = g.get("tier_bands") or [54, 52, 50, 48, 46]
        c_floor = bands[3]
        role_queue = bool(g.get("role_queue"))
        s = series_rates(h, c_floor, role_queue) if h.get("format") == "rates" else series_matches(h, c_floor)
        if s.empty:
            continue
        patches = (jload(DATA / g["id"] / "patches.json") or {}).get("markers", [])
        big = g.get("big_patch_min_heroes", 10)
        events, noise = patch_effects(s, patches, big)
        latest = s.iloc[-1]
        prev = s[s["date"] <= latest["date"] - pd.Timedelta(days=30)]
        out["games"].append({
            "id": g["id"], "name": g["name"], "format": h.get("format", "matches"),
            "c_floor": c_floor, "big_patch_min_heroes": big, "role_queue": role_queue,
            "smoothing": f"{ROLL_DAYS}-day rolling" if h.get("format") != "rates" else "daily published snapshot (season to date)",
            "latest": {k: r1(latest[k]) if k != "date" else latest["date"].strftime("%Y-%m-%d") for k in latest.index},
            "change_30d": {k: r1(latest[k] - prev.iloc[-1][k]) for k in ("score", "diversity", "viable", "fairness")} if len(prev) else None,
            "series": [{"date": r.date.strftime("%Y-%m-%d"), **{k: r1(getattr(r, k)) for k in
                        ("score", "diversity", "viable", "fairness", "effective_heroes", "roster", "wr_spread_sd")}}
                       for r in s.itertuples()],
            "big_patches": [{"date": p["date"], "title": p.get("title"), "heroes_changed": len(p.get("changes") or {})}
                            for p in patches if len(p.get("changes") or {}) >= big],
            "patch_effects": [{k: r1(v) if isinstance(v, float) else v for k, v in e.items()} for e in events],
            "patch_noise": {k: r1(v) if isinstance(v, float) else v for k, v in noise.items()} if noise else None,
        })
        L = out["games"][-1]["latest"]
        print(f"{g['id']}: {len(s)} days; latest score {L['score']} (diversity {L['diversity']}, viable {L['viable']}, "
              f"fairness {L['fairness']}); {len(events)} big-patch tests")
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
