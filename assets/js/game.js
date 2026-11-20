(async () => {
  const { el, loadJSON, fmt, toMs, token, DAY } = HMT;
  const app = document.getElementById("app");
  const gameId = HMT.params.get("game") || "deadlock";

  let game, patches, players, heroes;
  try {
    game = await HMT.getGame(gameId);
    if (!game) throw new Error(`Unknown game "${gameId}"`);
    [patches, players, heroes] = await Promise.all([
      loadJSON(`data/${gameId}/patches.json`).catch(() => null),
      loadJSON(`data/${gameId}/players.json`).catch(() => null),
      loadJSON(`data/${gameId}/heroes.json`).catch(() => null),
    ]);
  } catch (e) {
    HMT.renderTopbar();
    return HMT.showError(app, e);
  }
  document.title = `${game.name} Patch and Players`;
  HMT.renderTopbar({ game, page: "game" });
  HMT.footer();
  HMT.applyChartDefaults();

  const heroByName = new Map((heroes ? heroes.heroes : []).map((h) => [h.name, h]));
  const heroLink = (name) => {
    const h = heroByName.get(name);
    return h ? `heroes.html?game=${gameId}&hero=${h.slug}` : null;
  };

  app.replaceChildren();
  const latest = patches && patches.latest;

  /* ---------- header ---------- */
  app.append(el("div", { class: "page-head" },
    el("div", {},
      el("h1", { text: game.name }),
      el("p", { class: "lede" },
        latest ? `Latest patch: ${latest.title || latest.version} (${fmt.date(toMs(latest.date))}). ` : "",
        latest && latest.url ? el("a", { href: latest.url, target: "_blank", rel: "noopener", text: "Official notes ↗" }) : ""))));

  /* ---------- latest patch ---------- */
  if (latest) {
    const sec = el("section", { class: "section", "aria-labelledby": "patch-h" });
    sec.append(el("div", { class: "section-head" },
      el("h2", { id: "patch-h", text: "Latest patch summary" }),
      el("span", { class: "muted small", text: latest.version ? `Version ${latest.version}` : "" })));
    sec.append(el("div", { class: "grid-2" },
      el("div", { class: "card patch-summary" }, el("h3", { text: "What changed" }), ...paras(latest.summary)),
      el("div", { class: "card patch-summary" }, el("h3", { text: "Meta impact" }), ...paras(latest.meta_impact))));

    const changes = latest.changes || [];
    if (changes.length) {
      const types = ["all", ...new Set(changes.map((c) => c.type))];
      const head = el("div", { class: "section-head", style: "margin-top:24px" },
        el("h2", { text: `${game.character_label} affected (${changes.length})` }));
      const filter = el("div", { class: "seg", role: "group", "aria-label": "Filter by change type" });
      const list = el("div", { class: "change-list" });
      let current = "all";
      const draw = () => {
        list.replaceChildren(...changes.filter((c) => current === "all" || c.type === current).map(changeCard));
        [...filter.children].forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.t === current)));
      };
      types.forEach((t) => filter.append(el("button", { type: "button", "data-t": t,
        text: t === "all" ? "All" : (HMT.CHANGE_LABEL[t] || t), onclick: () => { current = t; draw(); } })));
      head.append(filter);
      sec.append(head, list);
      draw();
    }
    app.append(sec);
  } else {
    app.append(el("div", { class: "notice", text: "No patch notes yet. Add them to data/<game>/patch-notes.curated.json and run pipeline/patches.py." }));
  }

  function paras(text) {
    return String(text || "").split(/\n\s*\n/).filter(Boolean).map((p) => el("p", { text: p }));
  }

  function changeCard(c) {
    const h = heroByName.get(c.character);
    const href = heroLink(c.character);
    return el("article", { class: "change" },
      el("div", { class: "change-head" },
        h && h.image ? el("img", { src: h.image, alt: "", loading: "lazy" }) : null,
        href ? el("a", { href, text: c.character }) : el("strong", { text: c.character }),
        HMT.badge(c.type)),
      c.details && c.details.length ? el("ul", {}, c.details.map((d) => el("li", { text: d }))) : null,
      c.playstyle_impact ? el("div", { class: "impact" }, el("b", { text: "How to play it now" }), c.playstyle_impact) : null,
      c.meta_impact ? el("div", { class: "impact" }, el("b", { text: "Meta effect" }), c.meta_impact) : null);
  }

  /* ---------- concurrent players ---------- */
  const psec = el("section", { class: "section", "aria-labelledby": "players-h" });
  psec.append(el("div", { class: "section-head" },
    el("h2", { id: "players-h", text: "Concurrent players" }),
    el("span", { class: "muted small", text: players && players.metric ? players.metric : "" })));
  const pcard = el("div", { class: "card" });
  psec.append(pcard);
  app.append(psec);

  const daily = (players && players.daily) || [];
  const rows = daily.map(([d, avg, peak, n]) => ({ x: toMs(d), avg, peak, live: n !== null }));
  const markers = (patches && patches.markers) || [];

  let range = HMT.store.get("playersRange", "12m");
  let showPatches = HMT.store.get("playersPatches", true);
  const controls = el("div", { class: "controls" });
  HMT.rangeControl(controls, { keys: ["1m", "3m", "ytd", "12m", "3y"], value: range,
    onChange: (k) => { range = k; HMT.store.set("playersRange", k); drawPlayers(); } });
  const patchToggle = el("input", { type: "checkbox", checked: showPatches ? true : null,
    onchange: (e) => { showPatches = e.target.checked; HMT.store.set("playersPatches", showPatches); drawPlayers(); } });
  controls.append(el("label", { class: "check" }, patchToggle, "Show patch markers"));
  const tiles = el("div", { class: "tiles" });
  const legend = el("div", { class: "legend" });
  const box = el("div", { class: "chart-box" });
  const canvas = el("canvas", { role: "img", "aria-label": "Line chart of daily peak and average concurrent players" });
  box.append(canvas);
  const sourceNote = el("p", { class: "source" });
  pcard.append(controls, tiles, legend, box, sourceNote);

  if (players && players.sources && players.sources.length) {
    sourceNote.append(`Source: ${players.sources.join(" + ")}. Steam players only. Updated ${fmt.date(toMs(players.updated))}.`);
  }

  let chart = null;
  function drawPlayers() {
    const end = rows.length ? rows[rows.length - 1].x : Date.now();
    const start = HMT.rangeStart(range, end);
    const vis = rows.filter((r) => r.x >= start);
    const prev = rows.filter((r) => r.x < start);

    // tiles
    tiles.replaceChildren();
    const latestRead = players && players.latest;
    const peakRow = vis.reduce((a, r) => (!a || r.peak > a.peak ? r : a), null);
    const avgAll = vis.length ? vis.reduce((s, r) => s + r.avg, 0) / vis.length : null;
    const first = vis[0], last = vis[vis.length - 1];
    const change = first && last && first !== last ? ((last.avg - first.avg) / first.avg) * 100 : null;
    tiles.append(
      tile("Right now", latestRead ? fmt.int(latestRead.players) : "—", latestRead ? `${latestRead.steam_rank ? `Steam rank #${latestRead.steam_rank} · ` : ""}${new Date(latestRead.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""),
      tile("Peak in range", peakRow ? fmt.int(peakRow.peak) : "—", peakRow ? fmt.date(peakRow.x) : ""),
      tile("Avg daily players", avgAll ? fmt.int(avgAll) : "—", `${vis.length} day${vis.length === 1 ? "" : "s"} of data`),
      tile("Change over range", change === null ? "—" : `${change >= 0 ? "▲" : "▼"} ${Math.abs(change).toFixed(1)}%`, "daily average, first vs last day",
        change === null ? "" : change >= 0 ? "delta-up" : "delta-down"));

    legend.replaceChildren(
      el("span", {}, el("span", { class: "key-line", style: `background:${token("--series-1")}` }), "Daily peak"),
      el("span", {}, el("span", { class: "key-line", style: `background:${token("--series-2")}` }), "Daily average"),
      showPatches ? el("span", {}, el("span", { class: "key-flag", style: `background:${token("--neutral-mark")}` }), "Patch with hero changes") : null);

    box.querySelector(".chart-empty")?.remove();
    if (vis.length < 2) {
      box.append(el("div", { class: "chart-empty" }, el("div", {},
        el("strong", { text: "Not enough history yet." }), el("br"),
        "Live Steam readings are recorded every hour. To backfill past years, download the CSV from ",
        el("a", { href: `https://steamdb.info/app/${game.steam_appid}/charts/`, target: "_blank", rel: "noopener", text: "SteamDB" }),
        ", save it in data/raw/ and run ", el("code", { text: "python pipeline/players.py import-steamdb <file>" }), ".")));
    }

    // Only patches that changed at least one hero get a marker.
    const markerData = showPatches
      ? markers.filter((m) => Object.keys(m.changes || {}).length > 0)
          .map((m) => ({ x: toMs(m.date), color: token("--neutral-mark"), emphasis: Object.keys(m.changes).length >= 5, m }))
          .filter((m) => m.x >= start)
      : [];

    const data = {
      datasets: [
        { label: "Daily peak", data: vis.map((r) => ({ x: r.x, y: r.peak })), borderColor: token("--series-1"), backgroundColor: token("--series-1") },
        { label: "Daily average", data: vis.map((r) => ({ x: r.x, y: r.avg })), borderColor: token("--series-2"), backgroundColor: token("--series-2") },
      ],
    };
    const spanDays = vis.length ? (vis[vis.length - 1].x - vis[0].x) / DAY : 0;
    const options = {
      responsive: true, maintainAspectRatio: false, parsing: true,
      layout: { padding: { top: 14 } },
      elements: { line: { borderWidth: 2, tension: 0.2 }, point: { radius: vis.length < 3 ? 4 : 0, hoverRadius: 4 } },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { type: "time", min: Math.max(start, vis.length ? vis[0].x : start), max: end,
          time: { unit: spanDays > 400 ? "quarter" : spanDays > 100 ? "month" : "week" },
          grid: { display: false }, border: { color: token("--axis") }, ticks: { maxRotation: 0, autoSkipPadding: 16 } },
        y: { beginAtZero: true, border: { display: false }, grid: { color: token("--grid") },
          ticks: { callback: (v) => fmt.compact(v), maxTicksLimit: 6 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false, external: HMT.htmlTooltip(box, (c, tt) => playersTip(c, tt, markerData)) },
        patchMarkers: { markers: markerData },
      },
    };
    if (chart) { chart.data = data; chart.options = options; chart.update(); }
    else chart = new Chart(canvas, { type: "line", data, options, plugins: [HMT.crosshairPlugin, HMT.patchMarkerPlugin] });
  }

  function playersTip(_chart, tt, markerData) {
    const pts = tt.dataPoints || [];
    if (!pts.length) return null;
    const x = pts[0].raw.x;
    const node = el("div", {}, el("div", { class: "tt-date", text: fmt.date(x) }));
    pts.forEach((p) => node.append(HMT.ttRow(p.dataset.borderColor, fmt.int(p.raw.y), p.dataset.label)));
    const near = markerData.filter((m) => Math.abs(m.x - x) < DAY * 0.75);
    near.forEach(({ m }) => node.append(el("div", { class: "tt-patch" },
      el("strong", { text: m.title || "Patch" }),
      el("div", { class: "muted", text: `${Object.keys(m.changes).length} hero${Object.keys(m.changes).length === 1 ? "" : "es"} changed` }))));
    return node;
  }

  function tile(label, value, sub, cls) {
    return el("div", { class: "tile" },
      el("div", { class: "tile-label", text: label }),
      el("div", { class: `tile-value ${cls || ""}`, text: value }),
      el("div", { class: "tile-sub", text: sub }));
  }

  drawPlayers();
  HMT.onThemeChange(() => { HMT.applyChartDefaults(); drawPlayers(); });

  /* ---------- patch history ---------- */
  if (markers.length) {
    const hsec = el("section", { class: "section", "aria-labelledby": "hist-h" });
    hsec.append(el("div", { class: "section-head" }, el("h2", { id: "hist-h", text: "Patch history" }),
      el("span", { class: "muted small", text: `${markers.length} patches since ${fmt.date(toMs(markers[markers.length - 1].date))}` })));
    const list = el("ul", { class: "patch-list" });
    markers.forEach((m) => {
      const ch = Object.entries(m.changes || {});
      const counts = ch.reduce((a, [, t]) => ((a[t] = (a[t] || 0) + 1), a), {});
      list.append(el("li", {},
        el("span", { class: "date", text: fmt.date(toMs(m.date)) }),
        m.url ? el("a", { href: m.url, target: "_blank", rel: "noopener", text: m.title || m.version || "Patch" }) : el("span", { text: m.title || m.version }),
        el("span", { class: "muted small", text: ch.length ? Object.entries(counts).map(([t, n]) => `${n} ${t}${n > 1 && t !== "new" ? "s" : ""}`).join(" · ") : (m.curated ? "" : "from official changelog feed") })));
    });
    hsec.append(el("div", { class: "card" }, list));
    app.append(hsec);
  }
})();
