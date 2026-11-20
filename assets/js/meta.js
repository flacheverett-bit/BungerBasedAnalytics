(async () => {
  const { el, fmt, toMs, token, DAY } = HMT;
  const app = document.getElementById("app");
  let res;
  try {
    res = await HMT.loadJSON("data/meta_health.json");
  } catch (e) {
    HMT.renderTopbar({ page: "meta" });
    return HMT.showError(app, e);
  }
  document.title = "Meta Health";
  HMT.renderTopbar({ page: "meta" });
  HMT.footer();
  HMT.applyChartDefaults();

  const games = res.games;
  const SERIES = ["--series-1", "--series-2", "--series-3"];
  const gameColor = (i) => token(SERIES[i % SERIES.length]);
  const COMPONENTS = [["diversity", "Pick diversity"], ["viable", "Viable roster"], ["fairness", "Fairness"]];
  const poss = (name) => (name.endsWith("s") ? `${name}'` : `${name}'s`);
  const signed = (v, d = 1) => (v === null || v === undefined ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);

  /* ---------- header ---------- */
  app.replaceChildren(el("div", { class: "page-head" }, el("div", {},
    el("h1", { text: "Meta health" }),
    el("p", { class: "lede", text: "Is each game's meta healthy? That means many heroes worth playing, picks spread across the roster, and no hero far from a fair 50% win rate. The Meta Health Score turns that into one number from 0 to 100, tracked daily." }))));

  /* ---------- scorecards ---------- */
  const best = [...games].sort((a, b) => b.latest.score - a.latest.score)[0];
  app.append(el("section", { class: "score-grid" }, games.map((g, i) => {
    const c = g.change_30d;
    return el("a", { class: "card scorecard", href: `game.html?game=${g.id}`, style: `--game-line:${gameColor(i)}` },
      el("div", { class: "scorecard-head" },
        el("h2", { text: g.name }),
        g === best ? el("span", { class: "badge buff", text: "Healthiest now" }) : null),
      el("div", { class: "score-big" }, el("span", { text: g.latest.score.toFixed(0) }), el("small", { text: "/100" })),
      el("div", { class: "small muted", text: c ? `${signed(c.score)} pts vs. 30 days ago` : `History started ${fmt.date(toMs(g.series[0].date))}` }),
      el("div", { class: "comp-bars" }, COMPONENTS.map(([k, lbl]) => el("div", { class: "comp-bar" },
        el("span", { class: "small", text: lbl }),
        el("div", { class: "share-bar" }, el("span", { style: `width:${Math.max(0, Math.min(100, g.latest[k]))}%;background:var(--game-line)` })),
        el("b", { class: "small", text: `${g.latest[k].toFixed(0)}%` })))),
      el("div", { class: "small muted" }, `${g.latest.effective_heroes.toFixed(1)} effective heroes of ${g.latest.roster} · win-rate spread ±${g.latest.wr_spread_sd.toFixed(1)} pts`));
  })));

  /* ---------- findings (generated from the data) ---------- */
  const findings = [];
  const ranked = [...games].sort((a, b) => b.latest.score - a.latest.score);
  findings.push(`Right now ${ranked.map((g) => `${g.name} scores ${g.latest.score.toFixed(0)}`).join(", ")}.`);
  const weakest = (g) => COMPONENTS.map(([k, l]) => [l, g.latest[k]]).sort((a, b) => a[1] - b[1])[0];
  games.forEach((g) => { const [l, v] = weakest(g); findings.push(`${poss(g.name)} weakest component is ${l.toLowerCase()} (${v.toFixed(0)}%).`); });
  const tested = games.filter((g) => g.patch_effects.length && g.patch_noise);
  tested.forEach((g) => {
    const e = g.patch_effects;
    const mean = e.reduce((s, x) => s + x.score, 0) / e.length;
    const up = e.filter((x) => x.score > 0).length, beyond = e.filter((x) => x.beyond_noise).length;
    findings.push(`${g.name}: big patches don't reliably improve meta health. The average change was ${signed(mean)} points, ${up} of ${e.length} improved it, and only ${beyond} moved it beyond the normal ±${Math.max(Math.abs(g.patch_noise.p2_5), Math.abs(g.patch_noise.p97_5)).toFixed(0)}-point drift between any two 2-week periods.`);
  });
  const dl = games.find((g) => g.series.length > 120);
  if (dl) {
    const byMonth = {};
    dl.series.forEach((p) => { const m = p.date.slice(0, 7); (byMonth[m] = byMonth[m] || []).push(p.score); });
    const months = Object.entries(byMonth).map(([m, v]) => [m, v.reduce((a, b) => a + b, 0) / v.length]);
    const lo = months.reduce((a, b) => (b[1] < a[1] ? b : a)), hi = months.reduce((a, b) => (b[1] > a[1] ? b : a));
    findings.push(`${poss(dl.name)} healthiest month was ${fmt.date(toMs(hi[0] + "-01")).replace(/ \d+,/, "")} (${hi[1].toFixed(0)}) and its least healthy was ${fmt.date(toMs(lo[0] + "-01")).replace(/ \d+,/, "")} (${lo[1].toFixed(0)}).`);
  }
  app.append(el("section", { class: "card section" }, el("h2", { text: "Key findings" }),
    el("ul", { class: "findings" }, findings.map((f) => el("li", { text: f })))));

  /* ---------- chart 1: score over time, all games ---------- */
  const c1 = el("div", { class: "chart-box" }), cv1 = el("canvas", { role: "img", "aria-label": "Meta Health Score over time for each game" });
  c1.append(cv1);
  app.append(el("section", { class: "card section" },
    el("div", { class: "section-head" }, el("h2", { text: "Meta Health Score over time" }),
      el("span", { class: "muted small", text: "Deadlock: 7-day rolling. Overwatch and Marvel Rivals: daily snapshots, history started Nov 2026." })),
    el("div", { class: "legend" }, games.map((g, i) => el("span", {}, el("span", { class: "key-line", style: `background:${gameColor(i)}` }), g.name))),
    c1));

  /* ---------- chart 2: components for one game, with big patches ---------- */
  let sel = HMT.store.get("metaGame", games[0].id);
  if (!games.some((g) => g.id === sel)) sel = games[0].id;
  const seg = el("div", { class: "seg", role: "group", "aria-label": "Game" });
  games.forEach((g) => seg.append(el("button", { type: "button", "data-k": g.id, text: g.name, onclick: () => { sel = g.id; HMT.store.set("metaGame", sel); draw2(); drawPatches(); } })));
  const c2 = el("div", { class: "chart-box" }), cv2 = el("canvas", { role: "img", "aria-label": "Meta health components over time with big patch markers" });
  c2.append(cv2);
  const legend2 = el("div", { class: "legend" });
  const note2 = el("p", { class: "source" });
  app.append(el("section", { class: "card section" },
    el("div", { class: "section-head" }, el("h2", { text: "What's driving it" }), seg),
    legend2, c2, note2));

  /* ---------- patch effects table ---------- */
  const patchSec = el("section", { class: "card section" });
  app.append(patchSec);

  /* ---------- method ---------- */
  app.append(el("section", { class: "card section method" },
    el("h2", { text: "How the score is built" }),
    el("ol", {},
      el("li", {}, el("b", { text: "Pick diversity: " }), "the effective number of heroes (1 ÷ HHI of pick shares, the Herfindahl–Hirschman Index economists use for market concentration) as a % of the roster. 100% means every hero is picked equally. In role-queue games (Overwatch), it's measured within each role and weighted by the role's share of picks, so different role pool sizes aren't mistaken for concentration."),
      el("li", {}, el("b", { text: "Viable roster: " }), "the % of heroes with a win rate at or above the game's C-tier floor and at least half of an equal pick share (within their role for role-queue games)."),
      el("li", {}, el("b", { text: "Fairness: " }), `the % of all picks that go to heroes within ±${res.params.fair_band_pts} points of a 50% win rate. It's weighted by picks, because an overpowered hero nobody plays hurts less than one everyone plays.`),
      el("li", {}, el("b", { text: "Score: " }), "the average of the three components, so each counts equally. The parts are always shown alongside it, so you can see what's driving the number."),
      el("li", {}, el("b", { text: "Patch test: " }), `the average score in the ${res.params.patch_window_days} days before vs. after each big patch, compared with the normal change between any two ${res.params.patch_window_days}-day periods with no big patch nearby.`)),
    el("p", { class: "small muted", text: "Limitations: the weights and thresholds are judgment calls, stated openly so they can be challenged. Overwatch and Marvel Rivals use published season-to-date rates, so their daily score moves slowly and their history is short. Steam and public-match samples, not every match. The score measures balance and variety, not whether a game is fun." }),
    el("p", { class: "small" }, "Code: ", el("a", { href: `${HMT.REPO}/blob/main/pipeline/meta_health.py`, target: "_blank", rel: "noopener", text: "pipeline/meta_health.py ↗" }), `. Recomputed daily. Last run ${fmt.date(toMs(res.generated))}.`)));

  /* ---------- drawing ---------- */
  let chart1 = null, chart2 = null;
  const baseOptions = (min, max) => ({
    responsive: true, maintainAspectRatio: false, layout: { padding: { top: 14 } },
    interaction: { mode: "nearest", axis: "x", intersect: false },
    elements: { line: { borderWidth: 2, tension: 0.2 }, point: { radius: 0, hoverRadius: 4, hitRadius: 10 } },
    scales: {
      x: { type: "time", time: { unit: "month" }, grid: { display: false }, border: { color: token("--axis") }, ticks: { maxRotation: 0, autoSkipPadding: 16 } },
      y: { min, max, grid: { color: token("--grid") }, border: { display: false }, ticks: { maxTicksLimit: 6 } },
    },
    plugins: { legend: { display: false } },
  });

  function draw1() {
    const datasets = games.map((g, i) => ({
      label: g.name, data: g.series.map((p) => ({ x: toMs(p.date), y: p.score })),
      borderColor: gameColor(i), backgroundColor: gameColor(i),
      pointRadius: g.series.length < 15 ? 4 : 0,
    }));
    const opts = baseOptions(30, 100);
    opts.plugins.tooltip = { enabled: false, external: HMT.htmlTooltip(c1, (c, tt) => {
      const pts = tt.dataPoints || []; if (!pts.length) return null;
      return el("div", {}, el("div", { class: "tt-date", text: fmt.date(pts[0].raw.x) }),
        pts.map((p) => HMT.ttRow(p.dataset.borderColor, p.raw.y.toFixed(1), p.dataset.label)));
    }) };
    if (chart1) { chart1.data.datasets = datasets; chart1.options = opts; chart1.update(); }
    else chart1 = new Chart(cv1, { type: "line", data: { datasets }, options: opts, plugins: [HMT.crosshairPlugin] });
  }

  function draw2() {
    [...seg.children].forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === sel)));
    const g = games.find((x) => x.id === sel);
    const colors = COMPONENTS.map((_, i) => token(SERIES[i]));
    legend2.replaceChildren(
      ...COMPONENTS.map(([, l], i) => el("span", {}, el("span", { class: "key-line", style: `background:${colors[i]}` }), l)),
      el("span", {}, el("span", { class: "key-flag", style: `background:${token("--neutral-mark")}` }), `Big patch (${g.big_patch_min_heroes}+ heroes changed)`));
    const first = toMs(g.series[0].date);
    const markers = g.big_patches.map((p) => ({ x: toMs(p.date), color: token("--neutral-mark"), emphasis: true, p })).filter((m) => m.x >= first);
    const datasets = COMPONENTS.map(([k, l], i) => ({
      label: l, data: g.series.map((p) => ({ x: toMs(p.date), y: p[k] })), borderColor: colors[i], backgroundColor: colors[i],
      pointRadius: g.series.length < 15 ? 4 : 0,
    }));
    const opts = baseOptions(0, 100);
    opts.plugins.patchMarkers = { markers };
    opts.plugins.tooltip = { enabled: false, external: HMT.htmlTooltip(c2, (c, tt) => {
      const pts = tt.dataPoints || []; if (!pts.length) return null;
      const x = pts[0].raw.x;
      const node = el("div", {}, el("div", { class: "tt-date", text: fmt.date(x) }), pts.map((p) => HMT.ttRow(p.dataset.borderColor, `${p.raw.y.toFixed(0)}%`, p.dataset.label)));
      markers.filter((m) => Math.abs(m.x - x) < DAY * 0.75).forEach((m) => node.append(el("div", { class: "tt-patch" }, el("strong", { text: m.p.title }), el("div", { class: "muted", text: `${m.p.heroes_changed} heroes changed` }))));
      return node;
    }) };
    if (chart2) { chart2.data.datasets = datasets; chart2.options = opts; chart2.update(); }
    else chart2 = new Chart(cv2, { type: "line", data: { datasets }, options: opts, plugins: [HMT.crosshairPlugin, HMT.patchMarkerPlugin] });
    note2.textContent = `${g.name}: ${g.smoothing}. ${g.role_queue ? "Role queue: diversity and viability are measured within each role. " : ""}C-tier floor for "viable": ${g.c_floor}% win rate.`;
  }

  function drawPatches() {
    const g = games.find((x) => x.id === sel);
    patchSec.replaceChildren(el("div", { class: "section-head" }, el("h2", { text: `Do big patches make ${poss(g.name)} meta healthier?` }),
      g.patch_noise ? el("span", { class: "muted small", text: `${res.params.patch_window_days} days before vs. after · normal drift ${signed(g.patch_noise.p2_5)} to ${signed(g.patch_noise.p97_5)} pts` }) : null));
    if (!g.patch_effects.length || !g.patch_noise) {
      patchSec.append(el("p", { class: "muted", text: `Not enough history yet. ${poss(g.name)} score started ${fmt.date(toMs(g.series[0].date))}, and the test needs a few months of daily data around several big patches.` }));
      return;
    }
    const tbody = el("tbody", {}, g.patch_effects.map((e) => el("tr", {},
      el("td", { class: "num", text: fmt.date(toMs(e.date)) }),
      el("td", { text: e.title || "" }),
      el("td", { class: "num", text: String(e.heroes_changed) }),
      el("td", { class: "num", text: `${e.score_before.toFixed(0)} → ${e.score_after.toFixed(0)}` }),
      el("td", { class: `num ${e.score >= 0 ? "delta-up" : "delta-down"}`, text: signed(e.score) }),
      ...COMPONENTS.map(([k]) => el("td", { class: "num muted", text: signed(e[k]) })),
      el("td", {}, e.beyond_noise ? el("span", { class: "badge nerf", text: "Beyond normal drift" }) : el("span", { class: "muted", text: "Within normal drift" })))));
    patchSec.append(el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Date", "Patch", "Heroes", "Score", "Change", "Diversity", "Viable", "Fairness", "Result"]
        .map((t, i) => el("th", { class: [0, 2, 3, 4, 5, 6, 7].includes(i) ? "num" : null, text: t })))), tbody)));
  }

  draw1(); draw2(); drawPatches();
  HMT.onThemeChange(() => { HMT.applyChartDefaults(); draw1(); draw2(); });
})();
