"""Daily snapshot of Marvel Rivals hero win / pick / ban rates.

Source: https://rivalsheroes.com/heroes/stats  (Competitive, all ranks, current season;
season-to-date numbers from ranked matches, mirror matches excluded). There's no official
stats API, so the server-rendered table is parsed. Like Overwatch, only current numbers are
published, so each run appends today's snapshot and history grows one point per day.

Hero portraits are downloaded once into assets/img/marvel-rivals/ so the site doesn't
hot-link another site's images.

Output: data/marvel-rivals/heroes.json  ("rates" format: dates[] + per-hero wr/pr/ban arrays)
"""
from __future__ import annotations

import html
import re
import urllib.request
from datetime import datetime, timezone

from common import BROWSER_UA, DATA, ROOT, get_text, now_iso, read_json, write_json

BASE = "https://rivalsheroes.com"
URL = f"{BASE}/heroes/stats"
SLICE = "Competitive · All ranks · current season to date"
OUT = DATA / "marvel-rivals" / "heroes.json"
ICONS = ROOT / "assets" / "img" / "marvel-rivals"
ROLES = ("Vanguard", "Duelist", "Strategist")


def cells(row: str):
    return [html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", c))).strip()
            for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]


def pct(s: str):
    m = re.match(r"([\d.]+)%", s)
    return float(m.group(1)) if m else None


def fetch_rows():
    page = get_text(URL)
    season = re.search(r"Season\s*\|?\s*(\d+(?:\.\d+)?)", re.sub(r"<[^>]+>", "|", page))
    out = []
    for row in re.findall(r"<tr.*?</tr>", page, re.S):
        c = cells(row)
        if len(c) < 7 or pct(c[3]) is None:
            continue  # summary/extra tables
        name_role = c[1]
        role = next((r for r in ROLES if name_role.endswith(" " + r)), None)
        name = name_role[: -len(role) - 1] if role else name_role
        href = re.search(r'href="/heroes/([a-z0-9-]+)"', row)
        icon = re.search(r'<img[^>]+src="([^"]+)"', row)
        slug = href.group(1) if href else re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        variant = re.search(r"\((\w+)\)\s*$", name)   # e.g. "Deadpool (Duelist)" shares one page per role
        if variant:
            slug = f"{slug}-{variant.group(1).lower()}"
        out.append({
            "slug": slug,
            "page_slug": href.group(1) if href else None,
            "name": name, "role": role,
            "wr": pct(c[3]), "pr": pct(c[4]), "ban": pct(c[5]),
            "matches": int(c[6].replace(",", "")) if c[6].replace(",", "").isdigit() else None,
            "icon_src": icon.group(1) if icon else None,
        })
    if len(out) < 30:
        raise RuntimeError(f"Only {len(out)} heroes parsed from {URL}; refusing to save a partial snapshot")
    return out, (season.group(1) if season else None)


def local_icon(slug: str, src: str | None):
    """Download the portrait once; return the site-relative path (or None)."""
    ICONS.mkdir(parents=True, exist_ok=True)
    ext = ".webp" if (src or "").split("?")[0].endswith(".webp") else ".png"
    path = ICONS / f"{slug}{ext}"
    if not path.exists() and src:
        url = src if src.startswith("http") else BASE + src
        try:
            req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                path.write_bytes(r.read())
        except Exception as e:
            print(f"warning: icon for {slug}: {e}")
            return None
    return f"assets/img/marvel-rivals/{path.name}" if path.exists() else None


def main():
    rows, season = fetch_rows()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    doc = read_json(OUT) or {
        "game": "marvel-rivals", "format": "rates", "dates": [], "heroes": [],
        "source": "rivalsheroes.com (ranked match data)", "source_url": URL, "slice": SLICE,
        "pick_rate_definition": "Pick rate: share of teams that played the hero.",
    }
    if season:
        doc["season"] = f"Season {season}"
    dates = doc["dates"]
    if today in dates:
        i = dates.index(today)
    else:
        dates.append(today)
        i = len(dates) - 1
        for h in doc["heroes"]:
            for k in ("wr", "pr", "ban", "matches"):
                h.setdefault(k, [None] * (len(dates) - 1)).append(None)

    by_slug = {h["slug"]: h for h in doc["heroes"]}
    for r in rows:
        h = by_slug.get(r["slug"])
        if h is None:
            h = {"id": r["slug"], "slug": r["slug"], **{k: [None] * len(dates) for k in ("wr", "pr", "ban", "matches")}}
            doc["heroes"].append(h)
            by_slug[r["slug"]] = h
        img = local_icon(r["page_slug"] or r["slug"], r["icon_src"])
        h.update({"name": r["name"], "role": r["role"], "image": img, "card_image": img, "page_slug": r["page_slug"]})
        for k in ("wr", "pr", "ban", "matches"):
            h[k][i] = r[k]

    doc["heroes"].sort(key=lambda h: h["name"])
    doc["updated"] = now_iso()
    write_json(OUT, doc, compact=True)
    print(f"marvel-rivals heroes.json: {len(rows)} heroes, snapshot {today}, {len(dates)} day(s) of history")


if __name__ == "__main__":
    main()
