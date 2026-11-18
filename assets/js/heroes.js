(async () => {
  const { el, loadJSON, fmt, toMs, token, DAY } = HMT;
  const app = document.getElementById("app");
  const gameId = HMT.params.get("game") || "deadlock";

  let game, data, patches, meta;
  try {
    game = await HMT.getGame(gameId);
    if (!game) throw new Error(`Unknown game "${gameId}"`);
    [data, patches, meta] = await Promise.all([
      loadJSON(`data/${gameId}/heroes.json`),
      loadJSON(`data/${gameId}/patches.json`).catch(() => ({ markers: [] })),
      loadJSON(`data/${gameId}/meta.json`).catch(() => null),
    ]);
  } catch (e) {
    HMT.renderTopbar();
    return HMT.showError(app, e);
  }
  const label = game.character_label || "Characters";
  document.title = `${game.name} ${label}`;
  HMT.renderTopbar({ game, page: "heroes" });
  HMT.footer();
  HMT.applyChartDefaults();

  /* ---------- derived series ---------- */
  const dates = data.dates.map(toMs);
  const N = dates.length;
  const total = data.total_matches;
  const markers = (patches.markers || []).map((m) => ({ ...m, x: toMs(m.date) })).sort((a, b) => a.x - b.x);

  // Sum of arr[i0..i1] inclusive, clamped.
  const sum = (arr, i0, i1) => { let s = 0; for (let i = Math.max(0, i0); i <= Math.min(N - 1, i1); i++) s += arr[i]; return s; };
  // Rates over an index window (match-weighted, so low-volume days don't swing the line).
  function rates(h, i0, i1) {
    const m = sum(h.matches, i0, i1), w = sum(h.wins, i0, i1), t = sum(total, i0, i1);
    return m > 0 ? { wr: (w / m) * 100, pr: (m / t) * 100, matches: m } : { wr: null, pr: null, matches: 0 };
  }
  const indexAtOrAfter = (ms) => { let i = dates.findIndex((d) => d >= ms); return i === -1 ? N : i; };

  for (const h of data.heroes) {
    h.firstIdx = h.matches.findIndex((m) => m > 0);
    const r30 = rates(h, N - 30, N - 1), p30 = rates(h, N - 60, N - 31);
    h.wr30 = r30.wr; h.pr30 = r30.pr;
    h.wrDelta = r30.wr !== null && p30.wr !== null ? r30.wr - p30.wr : null;
    h.prDelta = r30.pr !== null && p30.pr !== null ? r30.pr - p30.pr : null;
  }

  /* ---------- state ---------- */
  const bySlug = new Map(data.heroes.map((h) => [h.slug, h]));
  const defaultHero = [...data.heroes].sort((a, b) => (b.pr30 || 0) - (a.pr30 || 0))[0];
  let hero = bySlug.get(HMT.params.get("hero")) || defaultHero;
  let range = HMT.store.get("heroRange", "3m");
  let smooth = HMT.store.get("heroSmooth", true);

  /* ---------- layout ---------- */
  app.replaceChildren(
    el("div", { class: "page-head" }, el("div", {},
      el("h1", { text: `${game.name} ${label.toLowerCase()}` }),
      el("p", { class: "lede", text: `Pick a hero to chart daily win rate and pick rate. Dashed markers show each patch that changed the selected hero.` }))));

  const detail = el("section", { class: "card", "aria-live": "polite", "aria-labelledby": "hero-name" });
  const titleBox = el("div", { class: "hero-title" });
  const tiles = el("div", { class: "tiles" });
  const controls = el("div", { class: "controls" });
  const legend = el("div", { class: "legend" });
  const box = el("div", { class: "chart-box tall" });
  const canvas = el("canvas", { role: "img" });
  box.append(canvas);
  const impactBox = el("div", { class: "section" });
  detail.append(titleBox, controls, tiles, legend, box,
    el("p", { class: "source" }, `Source: `, el("a", { href: data.source_url, target: "_blank", rel: "noopener", text: data.source }),
      `. ${data.pick_rate_definition} Updated ${fmt.date(toMs(data.updated))}.`),
    impactBox);
  const matchupSec = el("section", { class: "card section", "aria-labelledby": "matchups-h" });
  const buildSec = el("section", { class: "card section", "aria-labelledby": "builds-h" });
  app.append(detail, matchupSec, buildSec);

  HMT.rangeControl(controls, { keys: ["1m", "3m", "ytd", "12m"], value: range,
    onChange: (k) => { range = k; HMT.store.set("heroRange", k); drawDetail(); } });
  controls.append(
    el("label", { class: "check" }, el("input", { type: "checkbox", checked: smooth ? true : null,
      onchange: (e) => { smooth = e.target.checked; HMT.store.set("heroSmooth", smooth); drawDetail(); } }), "7-day rolling average"));

  /* ---------- hero grid ---------- */
  const gridSec = el("section", { class: "section", "aria-labelledby": "grid-h" });
  const search = el("input", { type: "search", placeholder: `Search ${label.toLowerCase()}…`, "aria-label": `Search ${label.toLowerCase()}` });
  const roles = [...new Set(data.heroes.map((h) => h.role).filter(Boolean))].sort();
  const roleSel = el("select", { "aria-label": "Filter by type" }, el("option", { value: "", text: "All types" }), roles.map((r) => el("option", { value: r, text: r })));
  const sortSel = el("select", { "aria-label": "Sort" },
    el("option", { value: "pr", text: "Sort: pick rate" }), el("option", { value: "wr", text: "Sort: win rate" }),
    el("option", { value: "wrDelta", text: "Sort: win rate change" }), el("option", { value: "name", text: "Sort: name" }));
  const grid = el("div", { class: "hero-grid" });
  gridSec.append(
    el("div", { class: "section-head" }, el("h2", { id: "grid-h", text: `All ${label.toLowerCase()} (${data.heroes.length})` }),
      el("span", { class: "muted small", text: "Last 30 days · change vs previous 30 days" })),
    el("div", { class: "controls" }, search, roleSel, sortSel), grid);
  app.append(gridSec);
  [search, roleSel, sortSel].forEach((c) => c.addEventListener("input", drawGrid));

  function drawGrid() {
    const q = search.value.trim().toLowerCase();
    const role = roleSel.value;
    const key = sortSel.value;
    const list = data.heroes
      .filter((h) => (!q || h.name.toLowerCase().includes(q)) && (!role || h.role === role))
      .sort((a, b) => key === "name" ? a.name.localeCompare(b.name) : ({ pr: b.pr30 - a.pr30, wr: b.wr30 - a.wr30, wrDelta: (b.wrDelta ?? -99) - (a.wrDelta ?? -99) })[key]);
    grid.replaceChildren(...list.map((h) => el("button", {
      class: "hero-btn", type: "button", "aria-pressed": String(h === hero),
      onclick: () => { select(h); detail.scrollIntoView({ behavior: "smooth", block: "start" }); },
    },
      el("span", { class: "top" }, el("img", { src: h.image, alt: "", loading: "lazy" }),
        el("span", {}, el("span", { class: "name", text: h.name }), el("br"), el("span", { class: "role", text: h.role || "" }))),
      el("span", { class: "nums" },
        el("span", {}, "WR ", el("b", { text: fmt.pct(h.wr30) }), " ", delta(h.wrDelta)),
        el("span", {}, "PR ", el("b", { text: fmt.pct(h.pr30) }))))));
    if (!list.length) grid.append(el("p", { class: "muted", text: "No matches." }));
  }

  function delta(d, unit = "") {
    if (d === null || d === undefined || Math.abs(d) < 0.05) return el("span", { class: "muted", text: "–" });
    return el("span", { class: d > 0 ? "delta-up" : "delta-down", text: `${d > 0 ? "▲" : "▼"}${Math.abs(d).toFixed(1)}${unit}` });
  }

  function select(h) {
    hero = h;
    const u = new URL(location.href);
    u.searchParams.set("hero", h.slug);
    history.replaceState(null, "", u);
    drawDetail();
    drawGrid();
  }

  /* ---------- detail ---------- */
  let chart = null;
  function heroChange(m) { return m.changes ? m.changes[hero.name] : undefined; }

  function drawDetail() {
    const h = hero;
    titleBox.replaceChildren(
      el("img", { src: h.card_image || h.image, alt: "" }),
      el("div", {},
        el("h2", { id: "hero-name", style: "display:flex;gap:10px;align-items:center" }, h.name,
          HMT.tierBadge(HMT.tierFor(h.wr30)),
          el("a", { class: "small muted", href: `tiers.html?game=${gameId}`, style: "font-weight:400", text: "30-day tier" })),
        el("p", { class: "muted small", text: [h.role, h.tagline].filter(Boolean).join(" · ") }),
        h.playstyle ? el("p", { class: "small", style: "max-width:80ch;margin-top:4px", text: h.playstyle }) : null));
    canvas.setAttribute("aria-label", `${h.name} daily win rate and pick rate, with patch markers`);

    const end = dates[N - 1];
    const start = Math.max(HMT.rangeStart(range, end), h.firstIdx >= 0 ? dates[h.firstIdx] : dates[0]);
    const i0 = indexAtOrAfter(start);

    // series
    const wr = [], pr = [];
    for (let i = i0; i < N; i++) {
      const r = smooth ? rates(h, Math.max(i - 6, h.firstIdx), i) : rates(h, i, i);
      wr.push({ x: dates[i], y: r.wr, m: r.matches });
      pr.push({ x: dates[i], y: r.pr });
    }

    // tiles: range totals vs the same-length window right before
    const cur = rates(h, i0, N - 1);
    const len = N - i0;
    const before = rates(h, i0 - len, i0 - 1);
    const l30 = h.last30 || {};
    tiles.replaceChildren(
      tile("Win rate", fmt.pct(cur.wr), deltaText(cur.wr, before.wr, "pts vs prior period")),
      tile("Pick rate", fmt.pct(cur.pr), deltaText(cur.pr, before.pr, "pts vs prior period")),
      tile("Matches tracked", fmt.compact(cur.matches), `in selected range`),
      tile("K / D / A", l30.kills ? `${l30.kills.toFixed(1)} / ${l30.deaths.toFixed(1)} / ${l30.assists.toFixed(1)}` : "—", "per match, last 30 days"),
      tile("Souls per match", fmt.compact(l30.souls), `hero damage ${fmt.compact(l30.hero_damage)}`));

    // markers
    // Only patches that changed this hero are drawn.
    const vis = markers.filter((m) => m.x >= start && m.x <= end + DAY && heroChange(m));
    const markerData = vis.map((m) => { const t = heroChange(m); return { x: m.x, color: HMT.changeColor(t), emphasis: true, m, type: t }; });

    legend.replaceChildren(
      el("span", {}, el("span", { class: "key-line", style: `background:${token("--series-1")}` }), "Win rate (top)"),
      el("span", {}, el("span", { class: "key-line", style: `background:${token("--series-2")}` }), "Pick rate (bottom)"),
      ...["buff", "nerf"].map((t) => el("span", {}, el("span", { class: "key-flag", style: `background:${HMT.changeColor(t)}` }), HMT.CHANGE_LABEL[t])),
      el("span", {}, el("span", { class: "key-flag", style: `background:${HMT.changeColor("rework")}` }), "◆ Rework / ★ Release"),
      el("span", {}, el("span", { class: "key-flag", style: `background:${token("--neutral-mark")}` }), "● Adjusted (mixed)"));

    const spanDays = (end - start) / DAY;
    const wrVals = wr.map((p) => p.y).filter((v) => v !== null);
    const wrMin = Math.min(...wrVals, 50), wrMax = Math.max(...wrVals, 50);
    const pad = Math.max(1, (wrMax - wrMin) * 0.12);
    const chartData = {
      datasets: [
        { label: "Win rate", data: wr, yAxisID: "yWin", borderColor: token("--series-1"), backgroundColor: token("--series-1") },
        { label: "Pick rate", data: pr, yAxisID: "yPick", borderColor: token("--series-2"), backgroundColor: token("--series-2") },
      ],
    };
    const options = {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 16 } },
      spanGaps: false,
      elements: { line: { borderWidth: 2, tension: smooth ? 0.25 : 0 }, point: { radius: 0, hoverRadius: 4, hitRadius: 12 } },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { type: "time", min: start, max: end,
          time: { unit: spanDays > 200 ? "month" : spanDays > 45 ? "week" : "day", tooltipFormat: "PP" },
          grid: { display: false }, border: { color: token("--axis") }, ticks: { maxRotation: 0, autoSkipPadding: 18 } },
        yPick: { stack: "rates", stackWeight: 1, offset: true, position: "left", beginAtZero: true,
          title: { display: true, text: "Pick rate", color: token("--text-secondary") },
          border: { display: false }, grid: { color: token("--grid") }, ticks: { callback: (v) => v + "%", maxTicksLimit: 4 } },
        yWin: { stack: "rates", stackWeight: 1.2, offset: true, position: "left",
          min: Math.floor(wrMin - pad), max: Math.ceil(wrMax + pad),
          title: { display: true, text: "Win rate", color: token("--text-secondary") },
          border: { display: false }, grid: { color: token("--grid") }, ticks: { callback: (v) => v + "%", maxTicksLimit: 5 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false, external: HMT.htmlTooltip(box, (c, tt) => heroTip(tt, markerData)) },
        patchMarkers: { markers: markerData },
        refLine: { lines: [{ scale: "yWin", value: 50, label: "50%" }] },
      },
    };
    if (chart) { chart.data = chartData; chart.options = options; chart.update(); }
    else chart = new Chart(canvas, { type: "line", data: chartData, options, plugins: [HMT.crosshairPlugin, HMT.patchMarkerPlugin, HMT.refLinePlugin] });

    drawImpact(h, vis);
    drawMatchups(h);
    drawBuilds(h);
  }

  /* ---------- matchups ---------- */
  const heroByName = new Map(data.heroes.map((x) => [x.name, x]));
  function matchRow(m) {
    const e = heroByName.get(m.enemy);
    return el("li", {},
      e ? el("img", { src: e.image, alt: "", loading: "lazy" }) : el("span"),
      e ? el("a", { href: `heroes.html?game=${gameId}&hero=${e.slug}`, text: m.enemy,
        onclick: (ev) => { ev.preventDefault(); select(e); detail.scrollIntoView({ behavior: "smooth", block: "start" }); } })
        : el("span", { text: m.enemy }),
      el("span", { class: "num" }, el("b", { text: fmt.pct(m.wr) }), " ", delta(m.delta, ""), el("br"),
        el("span", { class: "small", text: `${fmt.compact(m.matches)} games` })));
  }
  function drawMatchups(h) {
    const list = meta && meta.matchups && meta.matchups[h.name];
    matchupSec.replaceChildren(el("div", { class: "section-head" },
      el("h2", { id: "matchups-h", text: "Counters & matchups" }),
      el("span", { class: "muted small", text: `${h.name}'s win rate in matches against each hero, last ${meta ? meta.window_days : 30} days. ▲▼ = vs. ${h.name}'s average.` })));
    if (!list || !list.length) { matchupSec.append(el("p", { class: "muted", text: "No matchup data yet." })); return; }
    const n = 6;
    matchupSec.append(el("div", { class: "grid-2" },
      el("div", {}, el("h3", { text: `Counters to ${h.name}` }),
        el("p", { class: "muted small", style: "margin:0 0 6px", text: `Heroes ${h.name} struggles against` }),
        el("ul", { class: "match-list" }, list.slice(0, n).map(matchRow))),
      el("div", {}, el("h3", { text: `${h.name} counters` }),
        el("p", { class: "muted small", style: "margin:0 0 6px", text: `Heroes ${h.name} does best against` }),
        el("ul", { class: "match-list" }, list.slice(-n).reverse().map(matchRow)))));
  }

  /* ---------- meta builds ---------- */
  function itemIcon(id) {
    const it = meta.items[String(id)];
    if (!it) return null;
    return el("img", { class: `item-icon slot-${it.slot}`, src: it.image, alt: it.name, title: `${it.name}${it.cost ? ` · ${fmt.int(it.cost)} souls` : ""}`, loading: "lazy" });
  }
  function drawBuilds(h) {
    buildSec.replaceChildren(el("div", { class: "section-head" },
      el("h2", { id: "builds-h", text: "Meta builds" }),
      el("span", { class: "muted small", text: `From real matches, last ${meta ? meta.window_days : 30} days` })));
    if (!meta) { buildSec.append(el("p", { class: "muted", text: "No build data yet." })); return; }

    const phases = meta.core_items[h.name] || [];
    if (phases.length) {
      buildSec.append(el("h3", { text: "Core items by game phase" }),
        el("p", { class: "muted small", style: "margin:0 0 10px", text: `Most-bought items on ${h.name}, grouped by average purchase time. Buy % = share of ${h.name} matches the item was bought in.` }),
        el("div", { class: "phase-grid" }, phases.map((p) => el("div", { class: "phase" },
          el("h4", { text: p.phase }),
          p.items.length ? p.items.map((x) => el("div", { class: "item-row" },
            itemIcon(x.item),
            el("span", { text: meta.items[String(x.item)]?.name || "" }),
            el("span", { class: "num", title: `${fmt.pct(x.wr)} win rate · bought at ${x.buy_min} min on average`, text: `${Math.round(x.buy_rate)}% · ${fmt.pct(x.wr)} WR` })))
            : el("p", { class: "muted small", text: "No common items." })))),
        el("p", { class: "source", text: "Late items show higher win rates partly because they're bought in games that are already going well, so compare win rates within a phase, not across phases." }));
    }

    const builds = meta.builds[h.name] || [];
    buildSec.append(el("h3", { style: "margin-top:20px", text: "Most-played community builds" }),
      el("p", { class: "muted small", style: "margin:0 0 10px", text: "In-game builds players actually queued with most, and their win rate. Hover an item for its name and cost." }));
    if (!builds.length) { buildSec.append(el("p", { class: "muted", text: "No builds with enough games yet." })); return; }
    builds.forEach((b, i) => buildSec.append(el("div", { class: "build" },
      el("div", { class: "build-head" },
        el("strong", { text: `${i + 1}. ${b.name}` }),
        el("span", { class: "muted small" }, `${fmt.compact(b.matches)} games · `, el("b", { text: `${fmt.pct(b.wr)} WR` }), ` · in-game build ID ${b.id}`)),
      el("div", { class: "build-cats" }, b.categories.map((c) => el("div", { class: "build-cat" },
        el("span", { text: c.name }), el("div", { class: "icons" }, c.items.map(itemIcon))))))));
  }

  function heroTip(tt, markerData) {
    const pts = tt.dataPoints || [];
    if (!pts.length) return null;
    const x = pts[0].raw.x;
    const node = el("div", {}, el("div", { class: "tt-date", text: `${fmt.date(x)}${smooth ? " · 7-day avg" : ""}` }));
    pts.forEach((p) => node.append(HMT.ttRow(p.dataset.borderColor, fmt.pct(p.raw.y), p.dataset.label)));
    if (pts[0].raw.m) node.append(el("div", { class: "muted small", text: `${fmt.int(pts[0].raw.m)} matches` }));
    markerData.filter((d) => Math.abs(d.x - x) < DAY * 0.75).forEach((d) => {
      node.append(el("div", { class: "tt-patch" },
        el("strong", { text: d.m.title || d.m.version || "Patch" }),
        el("div", {}, HMT.badge(d.type))));
    });
    return node;
  }

  function tile(lbl, value, sub) {
    return el("div", { class: "tile" }, el("div", { class: "tile-label", text: lbl }), el("div", { class: "tile-value", text: value }),
      el("div", { class: "tile-sub" }, sub));
  }
  function deltaText(a, b, suffix) {
    if (a === null || b === null) return el("span", { class: "muted", text: "no prior data" });
    const d = a - b;
    return el("span", {}, delta(d), ` ${suffix}`);
  }

  // Patch impact: 7 days before vs 7 days after each patch that changed this hero.
  function drawImpact(h, visMarkers) {
    const own = markers.filter((m) => heroChange(m)).reverse();
    impactBox.replaceChildren(
      el("div", { class: "section-head" }, el("h3", { text: `Patch impact on ${h.name}` }),
        el("span", { class: "muted small", text: "7 days before vs 7 days after each patch (match-weighted)" })));
    if (!own.length) {
      impactBox.append(el("p", { class: "muted small", text: `No logged patch changes to ${h.name} in this period.` }));
      return;
    }
    const tbody = el("tbody");
    for (const m of own) {
      const pi = indexAtOrAfter(m.x);
      if (pi >= N && m.x > dates[N - 1] + DAY) continue;
      const b = rates(h, pi - 7, pi - 1), a = rates(h, pi + 1, pi + 7);
      const partial = pi + 7 > N - 1;
      tbody.append(el("tr", {},
        el("td", { class: "num", text: fmt.date(m.x) }),
        el("td", {}, m.url ? el("a", { href: m.url, target: "_blank", rel: "noopener", text: m.title || m.version }) : (m.title || m.version)),
        el("td", {}, HMT.badge(heroChange(m))),
        el("td", { class: "num", text: fmt.pct(b.wr) }),
        el("td", { class: "num" }, fmt.pct(a.wr), " ", a.wr !== null && b.wr !== null ? delta(a.wr - b.wr) : ""),
        el("td", { class: "num", text: fmt.pct(b.pr) }),
        el("td", { class: "num" }, fmt.pct(a.pr), " ", a.pr !== null && b.pr !== null ? delta(a.pr - b.pr) : "", partial ? " *" : "")));
    }
    impactBox.append(el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Date", "Patch", "Change", "WR before", "WR after", "PR before", "PR after"]
        .map((t, i) => el("th", { class: i >= 3 || i === 0 ? "num" : null, text: t })))),
      tbody)));
    if (own.some((m) => indexAtOrAfter(m.x) + 7 > N - 1)) impactBox.append(el("p", { class: "muted small", text: "* fewer than 7 days of post-patch data so far" }));
  }

  drawDetail();
  drawGrid();
  HMT.onThemeChange(() => { HMT.applyChartDefaults(); drawDetail(); });
})();
