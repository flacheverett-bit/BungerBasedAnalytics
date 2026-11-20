"""Overwatch hero perks + how often pros pick each one.

Perk names, descriptions, icons: OverFast API (mirrors Blizzard's official hero pages)
    https://overfast-api.tekrop.fr/heroes/<key>
Pick shares: owtics.gg hero pages, "Pick shares among pro players in OWCS matches"
    https://owtics.gg/en-US/hero/<slug>

owtics has no public API, so shares are read from the rendered page text. If that
breaks (layout change, hero missing), the perk is kept with share = null and the site
just shows the perk without a percentage.

Output: data/overwatch/perks.json
"""
from __future__ import annotations

import html
import re
import time

from common import DATA, get_json, get_text, now_iso, read_json, write_json

OVERFAST = "https://overfast-api.tekrop.fr"
OWTICS = "https://owtics.gg/en-US/hero"
OUT = DATA / "overwatch" / "perks.json"


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def page_text(raw: str) -> str:
    body = raw.split("<body", 1)[-1]
    body = re.sub(r"<script.*?</script>", " ", body, flags=re.S)
    txt = html.unescape(re.sub(r"<[^>]+>", "|", body))
    txt = re.sub(r"\s+", " ", txt)
    return re.sub(r"(\|\s*)+", "|", txt)


def owtics_shares(slug: str, hero_name: str, perk_names: list[str]):
    """Return ({perk name: share %}, context label) parsed from the owtics hero page."""
    txt = page_text(get_text(f"{OWTICS}/{slug}"))
    start = txt.find(f"{hero_name} Perks")
    if start < 0:
        start = txt.find("Perks|Pick shares")
    if start < 0:
        return {}, None
    end = txt.find("Map Stats", start)
    section = txt[start:end if end > 0 else start + 4000]
    tokens = [t.strip() for t in section.split("|") if t.strip()]
    shares = {}
    for name in perk_names:
        if name not in tokens:
            continue
        j = tokens.index(name)
        for t in tokens[j + 1:j + 4]:          # name, optional "Pro pick" label, then NN%
            m = re.fullmatch(r"(\d{1,3}(?:\.\d+)?)%", t)
            if m:
                shares[name] = float(m.group(1))
                break
    label = next((t for t in tokens[:4] if "pro" in t.lower()), None)
    return shares, label


def main():
    heroes = read_json(DATA / "overwatch" / "heroes.json")
    if not heroes:
        raise SystemExit("Run overwatch_heroes.py first.")
    previous = (read_json(OUT) or {}).get("heroes", {})

    owtics_slugs = {}
    try:
        for s in set(re.findall(r"/en-US/hero/([a-z0-9-]+)", get_text(OWTICS))):
            owtics_slugs[norm(s)] = s
    except Exception as e:
        print(f"warning: owtics hero list unavailable ({e})")

    out, label, with_shares = {}, None, 0
    for h in heroes["heroes"]:
        name = h["name"]
        try:
            info = get_json(f"{OVERFAST}/heroes/{h['id']}")
            perks = info.get("perks") or {}
        except Exception as e:
            print(f"warning: OverFast {name}: {e}; keeping previous perks")
            if name in previous:
                out[name] = previous[name]
            continue
        entry = {
            tier: [{"name": p["name"], "description": p.get("description"), "icon": p.get("icon"), "share": None}
                   for p in perks.get(tier, [])]
            for tier in ("minor", "major")
        }
        slug = owtics_slugs.get(norm(h["id"])) or owtics_slugs.get(norm(name))
        if slug:
            try:
                names = [p["name"] for t in entry.values() for p in t]
                shares, lbl = owtics_shares(slug, name, names)
                label = label or lbl
                for t in entry.values():
                    for p in t:
                        p["share"] = shares.get(p["name"])
                if shares:
                    with_shares += 1
            except Exception as e:
                print(f"warning: owtics {name}: {e}")
        out[name] = entry
        time.sleep(0.6)  # be polite to both free services

    write_json(OUT, {
        "game": "overwatch",
        "updated": now_iso(),
        "share_label": label or "Pick shares among pro players in OWCS matches",
        "sources": {"perks": "OverFast API (Blizzard hero data)", "shares": "owtics.gg"},
        "heroes": out,
    })
    print(f"perks.json: {len(out)} heroes, {with_shares} with pro pick shares")


if __name__ == "__main__":
    main()
