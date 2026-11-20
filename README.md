# Bunger Based Analytics

A static website that tracks hero shooter statistics: latest patch analysis, concurrent players, and per-hero win and pick rates with patch markers. Supported games: **Deadlock**, **Overwatch** and **Marvel Rivals**. The site is built so more games can be added.

**Live site:** https://flacheverett-bit.github.io/BungerBasedAnalytics/

## Pages

| Page | What it shows |
|---|---|
| `index.html` | Game selector (driven by `data/games.json`) |
| `game.html?game=deadlock` | Latest patch summary, meta impact, per-hero change cards (*how to play it now* and *meta effect*), concurrent-players chart (1 month / 3 months / YTD / 12 months / 3 years) with patch markers, full patch history |
| `heroes.html?game=deadlock` | Every hero with 30-day win and pick rate. Select a hero to see daily win rate and pick rate charts with markers for the patches that changed that hero (colored by buff, nerf or rework), a **patch impact table** (7 days before vs after each patch), **counters & matchups**, and **meta builds** (core items by game phase + the 3 most-played community builds) |
| `tiers.html?game=deadlock` | **Tier list**: every hero placed in S–F by win rate (fixed bands: S ≥ 54%, A 52–54, B 50–52, C 48–50, D 46–48, F < 46) for the latest patch, last 30 days or last 3 months |
| `…?game=overwatch` | The same three pages for Overwatch. The hero page shows **ban rate**, **meta team comps** that include the hero (in place of builds) and the hero's **perks with pro pick shares** (in place of items). No counters section, since no public matchup data exists. Tier bands are tighter for Overwatch: S ≥ 53%, A 51.5–53, B 50–51.5, C 48.5–50, D 47–48.5, F < 47 |

| `…?game=marvel-rivals` | Same as Overwatch, but with **team-up loadouts** in place of perks: for the selected hero, how often each of their two loadouts is picked, the hero's win rate with that partner, and what the loadout does. Tier bands are wider: S ≥ 55%, A 52.5–55, B 50–52.5, C 47.5–50, D 45–47.5, F < 45 |

Tier bands are set per game in `data/games.json` (`tier_bands`).

## Data sources

| Data | Source | Refresh |
|---|---|---|
| Hero win and pick rates (daily, ~13 months) | [deadlock-api.com](https://deadlock-api.com) community match data | Daily (GitHub Action) |
| Matchups, community builds, core items (last 30 days) | deadlock-api.com `hero-counter-stats`, `hero-build-stats`, `builds`, `item-stats` | Daily (GitHub Action) |
| Concurrent players, live | Steam Web API `ISteamChartsService/GetGamesByConcurrentPlayers` | Hourly (GitHub Action) |
| Concurrent players, history | SteamDB CSV export (one-time manual import, see below) | Once |
| Patch summaries and meta analysis | Hand-written in `data/deadlock/patch-notes.curated.json` | When a new patch drops |
| Patch dates (fallback) | Deadlock API `/v2/patches` (official forum and Steam changelog feed) | Daily |
| **Overwatch** hero win / pick / ban rates | [Blizzard's official hero statistics](https://overwatch.blizzard.com/en-us/rates/): Competitive Role Queue, PC, Americas, all ranks. Blizzard publishes current numbers only, so history grows by one snapshot per day (started Nov 20, 2026) | Daily (GitHub Action) |
| Overwatch perks | Names, icons and text from the [OverFast API](https://overfast-api.tekrop.fr) (Blizzard data); pick shares from [owtics.gg](https://owtics.gg) (**pro players in OWCS matches**; heroes not played in OWCS have no share) | Daily (GitHub Action) |
| Overwatch concurrent players | Steam Web API (hourly) + SteamCharts history back to Aug 2023 (monthly averages before 2026). **Steam only**: Battle.net and console players aren't counted | Hourly |
| **Marvel Rivals** hero win / pick / ban rates | [rivalsheroes.com](https://rivalsheroes.com/heroes/stats) ranked data (Competitive, all ranks, season to date). No official stats API exists. Daily snapshots, history started Nov 20, 2026 | Daily (GitHub Action) |
| Marvel Rivals team-up loadouts | Usage share: [rivalsdata.com](https://rivalsdata.com/team-ups) (**Grandmaster+** ranked, the only public source of actual loadout picks). Partner win rate and loadout text: rivalsheroes.com hero pages (all ranks) | Daily (GitHub Action) |
| Marvel Rivals concurrent players | Steam Web API (hourly) + SteamCharts history back to launch, Dec 2024 (monthly averages early on). Steam only | Hourly |
| Overwatch patch notes, meta team comps | Hand-written in `data/overwatch/patch-notes.curated.json` and `data/overwatch/comps.curated.json` (no public source tracks comp statistics) | Each patch |

**Definitions**
- **Win rate** = wins / matches played by the hero.
- **Pick rate** = share of tracked matches the hero appeared in. 12 heroes play in each match, so pick rates add up to about 1,200% across all heroes.
- The 7-day rolling average is **match-weighted**: it sums wins and matches over the window, so low-volume days don't swing the line.
- Player counts are **Steam only**.
- **Counters:** a hero's win rate in matches where the other hero is on the enemy team (any lane), compared with that hero's overall win rate. Only matchups with at least 1,000 games are shown.
- **Core items:** buy % = share of the hero's matches the item was bought in. Items are grouped by average purchase time (early < 10 min, mid 10–25 min, late > 25 min).

## Run it locally

Install Python 3.10 or newer. There are no packages to install because the pipeline uses only the standard library.

```powershell
cd BungerBasedAnalytics
python -m http.server 8000
```

Then open http://localhost:8000. Opening the HTML files directly with `file://` won't work, because browsers block the data fetches.

### Refresh the data by hand

```powershell
python pipeline/deadlock_heroes.py     # hero stats (~40 s)
python pipeline/deadlock_meta.py       # matchups, builds, core items (~1 min)
python pipeline/overwatch_heroes.py    # today's Overwatch snapshot (Blizzard)
python pipeline/overwatch_perks.py     # Overwatch perks + pro pick shares (~1 min)
python pipeline/marvel_rivals_heroes.py   # today's Marvel Rivals snapshot
python pipeline/marvel_rivals_teamups.py  # team-up loadout usage (~1 min)
python pipeline/patches.py deadlock overwatch marvel-rivals
python pipeline/patches.py             # rebuild patch markers after editing curated notes
python pipeline/players.py record      # take one live Steam reading for every game
```

### One-time: import player history from SteamDB

1. Go to https://steamdb.info/app/1422450/charts/ and use the download/export button under the chart to save the CSV.
2. Save it as `data/raw/steamdb_chart_1422450.csv`.
3. Run:

```powershell
python pipeline/players.py import-steamdb data/raw/steamdb_chart_1422450.csv
```

The importer detects the date, players and average-players columns automatically. Days that already have live readings keep the live values.

## Updating patch notes (when a new patch comes out)

Edit `data/deadlock/patch-notes.curated.json`:

1. Replace `latest_patch`. It has `summary`, `meta_impact`, and one `changes` entry per hero with `details`, `playstyle_impact` and `meta_impact`.
2. Add the patch to the top of `patch_history`, with `{"Hero": "buff" | "nerf" | "rework" | "adjustment" | "new"}`.
3. Run `python pipeline/patches.py`. It warns you if a hero name doesn't match the roster.

Patches you haven't written up yet still show as grey markers, pulled from the official changelog feed.

## Put it on GitHub

The repo is [flacheverett-bit/BungerBasedAnalytics](https://github.com/flacheverett-bit/BungerBasedAnalytics), published with GitHub Desktop. Repo settings it depends on:

1. **Settings → Pages → Deploy from a branch → `main` / root.**
2. **Settings → Actions → General → Workflow permissions → Read and write.** The data workflows need this to commit updates.
3. The Actions commit data every hour, so **click Fetch/Pull in GitHub Desktop before you edit anything locally** to avoid conflicts.

Notes:
- The hourly player workflow commits roughly once an hour, which is normal for scraped-data repos.
- GitHub pauses scheduled workflows in repos with no activity for 60 days. If that happens, re-enable them from the Actions tab.

## Adding another game later

1. Add an entry to `data/games.json` (`id`, `name`, `steam_appid`, `character_label`, and so on).
2. Write a pipeline script that outputs `data/<id>/heroes.json` in the same shape as Deadlock's: `dates`, `total_matches`, and `heroes[]` with daily `wins` and `matches`.
3. Generalize `pipeline/players.py` (it currently hard-codes Deadlock's app id) to output `data/<id>/players.json`.
4. Add `data/<id>/patch-notes.curated.json` and point `pipeline/patches.py` at it.

The pages read everything from `?game=<id>`, so no front-end changes are needed.

## Project layout

```
index.html, game.html, heroes.html    pages
assets/css/style.css                  theme tokens (light + dark), layout
assets/js/common.js                   data loading, date ranges, chart plugins (patch markers, crosshair)
assets/js/{home,game,heroes}.js       page logic
data/games.json                       game list
data/deadlock/*.json                  generated data + curated patch notes
pipeline/*.py                         data pipeline (standard library only)
.github/workflows/                    hourly player readings, daily stats refresh
```

Charts use [Chart.js](https://www.chartjs.org/) 4.4.1 with the date-fns adapter, loaded from CDNs.

*Not affiliated with Valve. Deadlock hero images are served from deadlock-api.com.*
