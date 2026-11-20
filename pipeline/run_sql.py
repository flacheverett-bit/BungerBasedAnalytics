"""Run every analysis in analysis/sql/*.sql against the DuckDB warehouse.

Each .sql file starts with a header:
    -- title: ...
    -- question: ...
    -- techniques: ...
    -- why: ...
followed by the query. Results, with a one-line takeaway computed from the result rows,
go to data/sql/results.json for the site's SQL page.

Run after build_warehouse.py:  python pipeline/run_sql.py
"""
from __future__ import annotations

import json
import math
import time
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SQL_DIR = ROOT / "analysis" / "sql"
DB = ROOT / "data" / "warehouse.duckdb"
OUT = ROOT / "data" / "sql" / "results.json"
MAX_ROWS = 60


def parse(path: Path):
    meta, body = {}, []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not body and line.startswith("-- ") and ":" in line:
            k, v = line[3:].split(":", 1)
            if k.strip() in ("title", "question", "techniques", "why"):
                meta[k.strip()] = v.strip()
                continue
        body.append(line)
    return meta, "\n".join(body).strip()


# One-line, data-driven takeaways. They're recomputed every run, so they stay true as data changes.
def t01(df):
    g = df.groupby("game").head(1)
    return "Most-patched: " + "; ".join(
        f"{r.game}: {r.hero} ({r.total_changes} changes, {r.nerfs} nerfs / {r.buffs} buffs)" for r in g.itertuples()) + "."

def t02(df):
    top = df.sort_values("win_rate_30d", ascending=False).iloc[0]
    return f"Best 30-day win rate overall: {top.hero} ({top.role}) at {top.win_rate_30d:.1f}% over {top.matches_30d:,.0f} games."

def t03(df):
    by = df.groupby("game").size().to_dict()
    fast = (df["days_between"] <= 7).sum()
    return (f"{len(df)} reversals within 30 days (" + ", ".join(f"{g}: {n}" for g, n in by.items()) +
            f"); {fast} were reversed within a week.")

def t04(df):
    if df.empty:
        return "Not enough daily player history around big patches yet."
    up = (df["pct_change"] > 0).mean()
    best = df.loc[df["pct_change"].idxmax()]
    return (f"Players rose in the week after {up:.0%} of big patches (median change {df['pct_change'].median():+.1f}%). "
            f"Biggest jump: {best['game']}, {best['title']} ({best['pct_change']:+.1f}%).")

def t05(df):
    parts = []
    for g, d in df.groupby("game"):
        hi, lo = d.loc[d["pct_vs_week_average"].idxmax()], d.loc[d["pct_vs_week_average"].idxmin()]
        parts.append(f"{g}: busiest {hi.weekday} ({hi.pct_vs_week_average:+.0f}%), quietest {lo.weekday} ({lo.pct_vs_week_average:+.0f}%)")
    return "; ".join(parts) + "."

def t06(df):
    a, b = df.iloc[0], df.iloc[-1]
    flat = abs(b.diversity_pct_of_roster - a.diversity_pct_of_roster) < 2
    return (f"Effective heroes went from {a.effective_heroes} ({a.month}) to {b.effective_heroes} ({b.month}), but relative to "
            f"roster size diversity moved only from {a.diversity_pct_of_roster}% to {b.diversity_pct_of_roster}%"
            + (": the rise comes from new heroes being added, not from a more balanced meta." if flat else "."))

def t07(df):
    return " ".join(f"{r.game}: ban vs. win-rate correlation {r.corr_ban_vs_win:+.2f}, most banned {r.most_banned} ({r.top_ban_rate:.0f}%)."
                    for r in df.itertuples()) + " Bans track perception more than results."

def t08(df):
    if df.empty:
        return "No hero's less-popular loadout outperforms the popular one."
    r = df.iloc[0]
    return (f"{len(df)} heroes have an underused loadout that wins more often. Biggest gap: {r.hero}'s {r.other_loadout} "
            f"({r.other_share_pct:.0f}% usage) wins {r.other_loadout_edge:+.1f} pts more than {r.popular_loadout}.")

def t09(df):
    r = df.iloc[0]
    ok = r.pairs_failing_0_5pt_tolerance == 0
    return (f"{'PASS' if ok else 'CHECK'}: {int(r.hero_pairs_checked)} matchup pairs; average deviation {r.avg_deviation_pts} pts, "
            f"max {r.max_deviation_pts} pts, {int(r.pairs_failing_0_5pt_tolerance)} outside a 0.5-pt tolerance.")

def t10(df):
    unexplained = (df["explained_by"].str.startswith("no patch")).sum()
    top = df.iloc[0]
    return (f"Top riser: {top.hero} ({top.change_pts:+.2f} pts). {unexplained} of {len(df)} movers had no patch in the window. "
            "Moves of about ±1 point are within normal weekly noise (see the Patch impact analysis).")

TAKEAWAYS = {"01": t01, "02": t02, "03": t03, "04": t04, "05": t05, "06": t06, "07": t07, "08": t08, "09": t09, "10": t10}


def jsonable(v):
    if v is None:
        return None
    if isinstance(v, float):
        return None if math.isnan(v) else round(v, 4)
    if isinstance(v, (pd.Timestamp, datetime, date)):
        return v.strftime("%Y-%m-%d")
    if hasattr(v, "item"):
        return jsonable(v.item())
    return v


def main():
    con = duckdb.connect(str(DB), read_only=True)
    tables = con.execute("SELECT table_name, estimated_size FROM duckdb_tables() ORDER BY table_name").fetchall()
    results = []
    for path in sorted(SQL_DIR.glob("*.sql")):
        meta, sql = parse(path)
        qid = path.name[:2]
        t0 = time.perf_counter()
        try:
            df = con.execute(sql).df()
            ms = (time.perf_counter() - t0) * 1000
            try:
                takeaway = TAKEAWAYS[qid](df) if qid in TAKEAWAYS and not df.empty else None
            except Exception as e:  # a takeaway must never break the run
                takeaway = None
                print(f"warning: takeaway {path.name}: {e}")
            results.append({
                "id": path.stem, "file": f"analysis/sql/{path.name}", **meta, "sql": sql,
                "columns": list(df.columns), "row_count": len(df),
                "rows": [[jsonable(v) for v in row] for row in df.head(MAX_ROWS).itertuples(index=False)],
                "runtime_ms": round(ms, 1), "takeaway": takeaway,
            })
            print(f"{path.name}: {len(df)} rows in {ms:.0f} ms")
        except Exception as e:
            results.append({"id": path.stem, "file": f"analysis/sql/{path.name}", **meta, "sql": sql, "error": str(e)})
            print(f"ERROR {path.name}: {e}")
    con.close()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "engine": f"DuckDB {duckdb.__version__}",
        "tables": [{"name": t, "rows": n} for t, n in tables],
        "queries": results,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
