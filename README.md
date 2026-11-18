# Hero Meta Tracker

A static website that tracks hero shooter statistics: latest patch analysis, concurrent players, and per-hero win and pick rates with patch markers. **Deadlock** is supported today. The site is built so other games can be added later.

**Live site:** https://flacheverett-bit.github.io/HeroTrackerDashboard/

## Pages

| Page | What it shows |
|---|---|
| `index.html` | Game selector (driven by `data/games.json`) |
| `game.html?game=deadlock` | Latest patch summary, meta impact, per-hero change cards (*how to play it now* and *meta effect*), concurrent-players chart (1 month / 3 months / YTD / 12 months / 3 years) with patch markers, full patch history |
| `heroes.html?game=deadlock` | Every hero with 30-day win and pick rate. Select a hero to see daily win rate and pick rate charts, patch markers colored by buff, nerf or rework, and a **patch impact table** comparing the 7 days before and after each patch that changed the hero |

## Data sources

| Data | Source | Refresh |
|---|---|---|
| Hero win and pick rates (daily, ~13 months) | [deadlock-api.com](https://deadlock-api.com) community match data | Daily (GitHub Action) |
| Concurrent players, live | Steam Web API `ISteamChartsService/GetGamesByConcurrentPlayers` | Hourly (GitHub Action) |
| Concurrent players, history | SteamDB CSV export (one-time manual import, see below) | Once |
| Patch summaries and meta analysis | Hand-written in `data/deadlock/patch-notes.curated.json` | When a new patch drops |
| Patch dates (fallback) | Deadlock API `/v2/patches` (official forum and Steam changelog feed) | Daily |

**Definitions**
- **Win rate** = wins / matches played by the hero.
- **Pick rate** = share of tracked matches the hero appeared in. 12 heroes play in each match, so pick rates add up to about 1,200% across all heroes.
- The 7-day rolling average is **match-weighted**: it sums wins and matches over the window, so low-volume days don't swing the line.
- Player counts are **Steam only**.

## Run it locally

Install Python 3.10 or newer. There are no packages to install because the pipeline uses only the standard library.

```powershell
cd hero-meta-tracker
python -m http.server 8000
```

Then open http://localhost:8000. Opening the HTML files directly with `file://` won't work, because browsers block the data fetches.

### Refresh the data by hand

```powershell
python pipeline/deadlock_heroes.py     # hero stats (~40 s)
python pipeline/patches.py             # rebuild patch markers after editing curated notes
python pipeline/players.py record      # take one live Steam reading
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

The repo is [flacheverett-bit/HeroTrackerDashboard](https://github.com/flacheverett-bit/HeroTrackerDashboard), published with GitHub Desktop. Repo settings it depends on:

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
