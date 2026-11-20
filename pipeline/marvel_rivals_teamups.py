"""Marvel Rivals team-up loadouts: which ones each hero actually uses.

Since Season 9 every hero has two team-up loadouts and picks one before the match.

  Usage share (how often each loadout is picked): rivalsdata.com/team-ups
      Grandmaster+ ranked matches, current season. The only public source of real
      loadout choices; it doesn't offer an all-ranks view.
  Loadout text + ranked win rate with that partner (all ranks): rivalsheroes.com/heroes/<hero>

Neither site has a public API, so their server-rendered pages are parsed. Anything that
fails to parse is left as null and the site shows what it has.

Output: data/marvel-rivals/teamups.json
"""
from __future__ import annotations

import html
import re
import time

from common import DATA, get_text, now_iso, read_json, write_json

USAGE_URL = "https://rivalsdata.com/team-ups"
HERO_URL = "https://rivalsheroes.com/heroes/{slug}"
OUT = DATA / "marvel-rivals" / "teamups.json"


def tokens(page: str):
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", page, flags=re.S)
    t = html.unescape(re.sub(r"<[^>]+>", "|", t))
    return [s.strip() for s in re.sub(r"\s+", " ", t).split("|") if s.strip()]


def key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\s*\(\w+\)\s*$", "", name).lower())


def num(s: str):
    s = s.replace(",", "").replace("%", "").replace("−", "-")
    try:
        return float(s)
    except ValueError:
        return None


def parse_usage():
    """{hero key: {"games": n, "loadouts": [{partner, loadout, share, wr_delta, games}]}}"""
    tok = tokens(get_text(USAGE_URL))
    season = next((t for t in tok[:80] if re.fullmatch(r"Season \d+(?:\.\d+)?", t)), None)
    rank = next((t for t in tok[:120] if t.endswith("+") and t[:-1].isalpha()), None)
    out, cur = {}, None
    k = 0
    while k < len(tok) - 8:
        if k + 3 < len(tok) and tok[k + 3] == "Pickrate" and cur is not None:     # loadout row
            cur["loadouts"].append({
                "partner": tok[k], "loadout": tok[k + 1], "share": num(tok[k + 2]),
                "wr_delta": num(tok[k + 4]) if tok[k + 5] == "WR" else None,
                "games": int(num(tok[k + 7])) if tok[k + 8] == "Games" and num(tok[k + 7]) is not None else None,
            })
            k += 9
            continue
        if tok[k + 2] == "Games" and re.fullmatch(r"[\d,]+", tok[k + 1]) and not re.fullmatch(r"[\d,·]+", tok[k]):
            cur = {"games": int(num(tok[k + 1])), "loadouts": []}
            out[key(tok[k])] = cur
            k += 3
            continue
        k += 1
    return out, season, rank


def parse_hero_page(page_slug: str):
    """Loadout descriptions + ranked win rate with the partner (all ranks) from rivalsheroes."""
    tok = tokens(get_text(HERO_URL.format(slug=page_slug)))
    try:
        start = next(i for i, t in enumerate(tok) if t.startswith("Team-Ups and Best Teammates"))
    except StopIteration:
        return {}
    end = next((i for i in range(start + 1, len(tok)) if tok[i] == "Counters"), min(len(tok), start + 400))
    sec = tok[start:end]
    loadouts = {}
    for i, t in enumerate(sec):
        if t != "Partner:" or i < 1 or i + 2 >= len(sec):
            continue
        name, partner, desc = sec[i - 1], sec[i + 1], sec[i + 2]
        info = {"partner": partner, "description": desc, "wr_with_partner": None, "wr_delta_all": None, "matches_with_partner": None}
        # "Ranked win rate with |X|:|54.2|%|(|+|5.1|vs |X|'s|49.1|% overall, |5,104|matches)"
        window = sec[i + 3:i + 20]
        if "Ranked win rate with" in window:
            j = window.index("Ranked win rate with")
            nums = [w for w in window[j:] if num(w) is not None]
            signs = [w for w in window[j:] if w in ("+", "-", "−")]
            if len(nums) >= 2:
                info["wr_with_partner"] = num(nums[0])
                d = num(nums[1])
                info["wr_delta_all"] = -d if signs and signs[0] in ("-", "−") else d
            m = next((w for w in window[j:] if re.fullmatch(r"[\d,]+", w) and "," in w or (w.isdigit() and int(w) > 100)), None)
            info["matches_with_partner"] = int(m.replace(",", "")) if m else None
        loadouts[name] = info
    return loadouts


def main():
    heroes = read_json(DATA / "marvel-rivals" / "heroes.json")
    if not heroes:
        raise SystemExit("Run marvel_rivals_heroes.py first.")
    previous = (read_json(OUT) or {}).get("heroes", {})
    try:
        usage, season, rank = parse_usage()
    except Exception as e:
        print(f"warning: rivalsdata usage unavailable ({e})")
        usage, season, rank = {}, None, None

    page_cache, out, matched = {}, {}, 0
    for h in heroes["heroes"]:
        ps = h.get("page_slug") or h["slug"]
        if ps not in page_cache:
            try:
                page_cache[ps] = parse_hero_page(ps)
            except Exception as e:
                print(f"warning: rivalsheroes {ps}: {e}")
                page_cache[ps] = None
            time.sleep(0.8)  # be polite
        details = page_cache[ps]
        u = usage.get(key(h["name"]))
        if u is None and details is None:
            if h["name"] in previous:
                out[h["name"]] = previous[h["name"]]
            continue
        rows = {}
        for lo in (u or {}).get("loadouts", []):
            rows[lo["loadout"]] = {"loadout": lo["loadout"], "partner": lo["partner"], "share": lo["share"],
                                   "wr_delta_gm": lo["wr_delta"], "games_gm": lo["games"]}
        for name, d in (details or {}).items():
            r = rows.setdefault(name, {"loadout": name, "partner": d["partner"], "share": None, "wr_delta_gm": None, "games_gm": None})
            r.update({"description": d["description"], "wr_with_partner": d["wr_with_partner"],
                      "wr_delta_all": d["wr_delta_all"], "matches_with_partner": d["matches_with_partner"]})
        if u:
            matched += 1
        out[h["name"]] = {
            "games_gm": (u or {}).get("games"),
            "loadouts": sorted(rows.values(), key=lambda r: -(r["share"] or 0)),
        }

    write_json(OUT, {
        "game": "marvel-rivals",
        "updated": now_iso(),
        "usage_label": f"Loadout pick share · {rank or 'Grandmaster+'} ranked · {season or 'current season'}",
        "sources": {"usage": "rivalsdata.com", "details": "rivalsheroes.com"},
        "heroes": out,
    })
    print(f"teamups.json: {len(out)} heroes, {matched} with usage shares ({rank}, {season})")


if __name__ == "__main__":
    main()
