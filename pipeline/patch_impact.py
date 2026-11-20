"""Did patches actually move hero win and pick rates? (Deadlock)

Question: when a hero is buffed or nerfed, does their win rate / pick rate change by more
than it normally drifts from week to week?

Method (per hero, per patch that changed them):
  1. Before vs after: match-weighted win rate in the 7 days before the patch vs the 7 days
     after (the patch day itself is skipped, since it's split between versions).
  2. Difference-in-differences: subtract the average change of heroes that were NOT changed
     anywhere near that patch. This removes meta-wide shifts (e.g. other heroes' changes,
     a new game mode) that affect everyone.
  3. Noise baseline (placebo test): run the exact same calculation on every day where the
     hero had no change within +/-14 days. That gives each hero's own distribution of
     "normal" week-over-week swings. A patch effect is judged against that, not against a
     binomial standard error. With 100k+ matches a week, binomial intervals are tiny and
     would call nearly everything significant, but real day-to-day variation (who plays the
     hero, what they face) is much larger.
  4. Empirical two-sided p-value = share of the hero's placebo swings at least as large,
     then Benjamini-Hochberg correction across all events (false discovery rate 10%).
  5. Robustness: regression-to-the-mean check (devs buff weak heroes / nerf strong ones,
     which could fake an effect). Drift vs. starting win rate is fit on placebo days and
     reported next to the raw effect.

Events are excluded when the same hero was changed again within 7 days (the effects can't
be separated), and when either window has fewer than MIN_MATCHES games.

Output: data/deadlock/patch_impact.json (read by analysis.html)
Requires pandas + numpy (see requirements.txt).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "deadlock"
WINDOW = 7            # days on each side of the patch
GUARD = 14            # placebo days must be this far from any change to the hero
MIN_MATCHES = 2000    # per window
FDR = 0.10
DIRECTIONAL = {"buff": 1, "nerf": -1}
SEED = 7


# ---------------------------------------------------------------- loading
def load_daily() -> pd.DataFrame:
    """Long table: one row per (date, hero) with wins, matches and that day's total matches."""
    doc = json.loads((DATA / "heroes.json").read_text(encoding="utf-8"))
    dates = pd.to_datetime(doc["dates"])
    total = pd.Series(doc["total_matches"], index=dates, name="total")
    frames = []
    for h in doc["heroes"]:
        frames.append(pd.DataFrame({"date": dates, "hero": h["name"], "role": h.get("role"),
                                    "wins": h["wins"], "matches": h["matches"]}))
    df = pd.concat(frames, ignore_index=True)
    df["total"] = df["date"].map(total)
    return df


def load_changes() -> pd.DataFrame:
    """One row per (patch, hero) change from the curated patch history."""
    doc = json.loads((DATA / "patches.json").read_text(encoding="utf-8"))
    rows = [{"patch_date": pd.Timestamp(m["date"]), "patch": m.get("title") or m.get("version"),
             "url": m.get("url"), "hero": hero, "type": t}
            for m in doc["markers"] for hero, t in (m.get("changes") or {}).items()]
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- core calculation
def window_rates(wide_w: pd.DataFrame, wide_m: pd.DataFrame, total: pd.Series, day: pd.Timestamp):
    """Match-weighted WR and PR for every hero in [day-W, day-1] and [day+1, day+W]."""
    one = pd.Timedelta(days=1)
    b = slice(day - WINDOW * one, day - one)
    a = slice(day + one, day + WINDOW * one)
    out = {}
    for tag, s in (("before", b), ("after", a)):
        w, m, t = wide_w.loc[s].sum(), wide_m.loc[s].sum(), total.loc[s].sum()
        out[f"wr_{tag}"] = (w / m.replace(0, np.nan)) * 100
        out[f"pr_{tag}"] = (m / t) * 100 if t else m * np.nan
        out[f"n_{tag}"] = m
    return pd.DataFrame(out)


def run():
    daily = load_daily()
    changes = load_changes()
    wide_w = daily.pivot(index="date", columns="hero", values="wins").sort_index()
    wide_m = daily.pivot(index="date", columns="hero", values="matches").sort_index()
    total = daily.drop_duplicates("date").set_index("date")["total"].sort_index()
    first, last = wide_m.index.min(), wide_m.index.max()
    one = pd.Timedelta(days=1)

    # Days on which each hero was changed (any type), to find clean windows / placebo days.
    changed_on = changes.groupby("hero")["patch_date"].apply(list).to_dict()
    def near_change(hero, day, days):
        return any(abs((day - d).days) <= days for d in changed_on.get(hero, []))

    # ---- every usable day: window rates for all heroes (reused by events and placebo)
    usable = [d for d in wide_m.index if d - WINDOW * one >= first and d + WINDOW * one <= last]
    per_day = {}
    for d in usable:
        r = window_rates(wide_w, wide_m, total, d)
        r["d_wr"] = r["wr_after"] - r["wr_before"]
        r["d_pr"] = r["pr_after"] - r["pr_before"]
        ok = (r["n_before"] >= MIN_MATCHES) & (r["n_after"] >= MIN_MATCHES)
        r = r[ok]
        # control group: heroes with no change within the window on either side
        ctrl = [h for h in r.index if not near_change(h, d, WINDOW)]
        r["ctrl_wr"] = r.loc[ctrl, "d_wr"].mean() if ctrl else np.nan
        r["ctrl_pr"] = r.loc[ctrl, "d_pr"].mean() if ctrl else np.nan
        r["n_ctrl"] = len(ctrl)
        r["did_wr"] = r["d_wr"] - r["ctrl_wr"]
        r["did_pr"] = r["d_pr"] - r["ctrl_pr"]
        per_day[d] = r

    # ---- placebo distribution per hero: days far from any change to that hero
    placebo = []
    for d, r in per_day.items():
        for h in r.index:
            if not near_change(h, d, GUARD):
                placebo.append((h, d, r.at[h, "did_wr"], r.at[h, "did_pr"], r.at[h, "wr_before"]))
    placebo = pd.DataFrame(placebo, columns=["hero", "date", "did_wr", "did_pr", "wr_before"]).dropna()

    # ---- events
    ev = []
    for c in changes.itertuples():
        d = c.patch_date
        rec = {"patch_date": d, "patch": c.patch, "url": c.url, "hero": c.hero, "type": c.type, "status": "ok"}
        if c.type == "new":
            rec["status"] = "release (no before window)"
        elif d not in per_day:
            rec["status"] = "outside data window"
        elif c.hero not in per_day[d].index:
            rec["status"] = f"fewer than {MIN_MATCHES:,} games in a window"
        elif sum(1 for x in changed_on.get(c.hero, []) if 0 < abs((x - d).days) <= WINDOW):
            rec["status"] = "changed again within 7 days"
        if rec["status"] == "ok":
            r = per_day[d].loc[c.hero]
            rec.update({k: r[k] for k in ["wr_before", "wr_after", "pr_before", "pr_after", "n_before", "n_after",
                                         "d_wr", "d_pr", "ctrl_wr", "ctrl_pr", "did_wr", "did_pr", "n_ctrl"]})
            null = placebo[placebo["hero"] == c.hero]
            rec["placebo_days"] = len(null)
            for k in ("wr", "pr"):
                vals = null[f"did_{k}"].to_numpy()
                obs = rec[f"did_{k}"]
                if len(vals) >= 30:
                    rec[f"noise_sd_{k}"] = float(np.std(vals, ddof=1))
                    rec[f"p_{k}"] = float((np.sum(np.abs(vals) >= abs(obs)) + 1) / (len(vals) + 1))
                else:
                    rec[f"noise_sd_{k}"] = rec[f"p_{k}"] = np.nan
        ev.append(rec)
    events = pd.DataFrame(ev)

    ok = events["status"].eq("ok") & events["p_wr"].notna()
    for k in ("wr", "pr"):
        events[f"q_{k}"] = np.nan
        events.loc[ok, f"q_{k}"] = bh_adjust(events.loc[ok, f"p_{k}"].to_numpy())
        events[f"sig_{k}"] = events[f"q_{k}"] <= FDR
        sign = events["type"].map(DIRECTIONAL)
        events[f"expected_{k}"] = np.sign(events[f"did_{k}"]) == sign
    return daily, events, placebo


def bh_adjust(p: np.ndarray) -> np.ndarray:
    """Benjamini-Hochberg adjusted p-values (q-values)."""
    n = len(p)
    order = np.argsort(p)
    ranked = p[order] * n / (np.arange(n) + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.minimum(q, 1)
    return out


def bootstrap_mean_ci(x: np.ndarray, reps: int = 5000, seed: int = SEED):
    x = x[~np.isnan(x)]
    if len(x) < 3:
        return (np.nan, np.nan)
    rng = np.random.default_rng(seed)
    means = rng.choice(x, size=(reps, len(x)), replace=True).mean(axis=1)
    return (float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5)))


def mean_reversion_check(events: pd.DataFrame, placebo: pd.DataFrame) -> dict:
    """Regression to the mean: devs buff weak heroes and nerf strong ones, and heroes far from
    50% may drift back anyway. Fit that drift on placebo days (no patch) and see how much of
    the measured effect it could explain."""
    beta, alpha = np.polyfit(placebo["wr_before"] - 50, placebo["did_wr"], 1)
    ok = events[events["status"].eq("ok") & events["p_wr"].notna()]
    out = {"alpha": float(alpha), "beta": float(beta)}
    for t in DIRECTIONAL:
        g = ok[ok["type"] == t]
        drift = alpha + beta * (g["wr_before"] - 50)
        out[t] = {"mean_pre_wr": float(g["wr_before"].mean()), "expected_drift": float(drift.mean()),
                  "effect_raw": float(g["did_wr"].mean()), "effect_adjusted": float((g["did_wr"] - drift).mean())}
    return out


def summarize(events: pd.DataFrame, placebo: pd.DataFrame | None = None) -> dict:
    ok = events[events["status"].eq("ok") & events["p_wr"].notna()]
    out = {}
    if placebo is not None:
        out["mean_reversion"] = mean_reversion_check(events, placebo)
    for t in ("buff", "nerf"):
        g = ok[ok["type"] == t]
        s = {"events": int(len(g))}
        for k in ("wr", "pr"):
            vals = g[f"did_{k}"].to_numpy(dtype=float)
            lo, hi = bootstrap_mean_ci(vals)
            s[k] = {
                "mean_effect": float(np.nanmean(vals)) if len(vals) else None,
                "ci95": [lo, hi],
                "median_effect": float(np.nanmedian(vals)) if len(vals) else None,
                "share_expected_direction": float(g[f"expected_{k}"].mean()) if len(g) else None,
                "significant": int(g[f"sig_{k}"].sum()),
                "significant_expected": int((g[f"sig_{k}"] & g[f"expected_{k}"]).sum()),
                "significant_opposite": int((g[f"sig_{k}"] & ~g[f"expected_{k}"]).sum()),
            }
        out[t] = s
    other = ok[~ok["type"].isin(DIRECTIONAL)]
    out["other"] = {"events": int(len(other)), "significant_wr": int(other["sig_wr"].sum()),
                    "significant_pr": int(other["sig_pr"].sum())}
    excl = events[~events["status"].eq("ok")]
    out["excluded"] = excl["status"].value_counts().to_dict()
    out["total_events"] = int(len(events))
    return out


def to_json(events: pd.DataFrame, placebo: pd.DataFrame, summary: dict, daily: pd.DataFrame) -> dict:
    def clean(v):
        if isinstance(v, (np.floating, float)):
            return None if np.isnan(v) else round(float(v), 3)
        if isinstance(v, (np.integer,)):
            return int(v)
        if isinstance(v, (np.bool_,)):
            return bool(v)
        if isinstance(v, pd.Timestamp):
            return v.strftime("%Y-%m-%d")
        return v
    cols = ["patch_date", "patch", "url", "hero", "type", "status", "wr_before", "wr_after", "pr_before", "pr_after",
            "n_before", "n_after", "d_wr", "d_pr", "ctrl_wr", "ctrl_pr", "did_wr", "did_pr", "n_ctrl", "placebo_days",
            "noise_sd_wr", "noise_sd_pr", "p_wr", "p_pr", "q_wr", "q_pr", "sig_wr", "sig_pr", "expected_wr", "expected_pr"]
    ev = events.reindex(columns=cols).sort_values(["patch_date", "hero"], ascending=[False, True])
    q = placebo["did_wr"].quantile([0.025, 0.975])
    return {
        "game": "deadlock",
        "generated": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ"),
        "data_range": [daily["date"].min().strftime("%Y-%m-%d"), daily["date"].max().strftime("%Y-%m-%d")],
        "params": {"window_days": WINDOW, "placebo_guard_days": GUARD, "min_matches": MIN_MATCHES, "fdr": FDR},
        "placebo": {"observations": int(len(placebo)), "heroes": int(placebo["hero"].nunique()),
                    "wr_p2_5": round(float(q.iloc[0]), 3), "wr_p97_5": round(float(q.iloc[1]), 3)},
        "summary": summary,
        "events": [{k: clean(v) for k, v in r.items()} for r in ev.to_dict(orient="records")],
    }


def main():
    daily, events, placebo = run()
    summary = summarize(events, placebo)
    out = to_json(events, placebo, summary, daily)
    (DATA / "patch_impact.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    b, n = summary["buff"], summary["nerf"]
    print(f"patch_impact.json: {summary['total_events']} events; "
          f"buffs n={b['events']} mean WR {b['wr']['mean_effect']:+.2f}; nerfs n={n['events']} mean WR {n['wr']['mean_effect']:+.2f}")


if __name__ == "__main__":
    main()
