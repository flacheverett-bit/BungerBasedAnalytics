(async () => {
  const { el, loadJSON, fmt, toMs, token } = HMT;
  const app = document.getElementById("app");
  const gameId = HMT.params.get("game") || "deadlock";
  const REPO = "https://github.com/flacheverett-bit/BungerBasedAnalytics";

  let game, res, heroes;
  try {
    game = await HMT.getGame(gameId);
    if (!game) throw new Error(`Unknown game "${gameId}"`);
    [res, heroes] = await Promise.all([
      loadJSON(`data/${gameId}/patch_impact.json`),
      loadJSON(`data/${gameId}/heroes.json`).catch(() => null),
    ]);
  } catch (e) {
    HMT.renderTopbar();
    return HMT.showError(app, e);
  }
  document.title = `${game.name} Patch Impact`;
  HMT.renderTopbar({ game, page: "analysis" });
  HMT.footer();
  HMT.applyChartDefaults();

  const S = res.summary, P = res.params, PL = res.placebo;
  const heroBy = new Map((heroes ? heroes.heroes : []).map((h) => [h.name, h]));
  const events = res.events.filter((e) => e.status === "ok");
  const signed = (v, d = 2) => (v === null || v === undefined ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
  const pctShare = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);

  /* ---------- header ---------- */
  app.replaceChildren(el("div", { class: "page-head" }, el("div", {},
    el("h1", { text: "Do balance patches actually work?" }),
    el("p", { class: "lede" },
      `When ${game.name}'s developers buff or nerf a hero, does the hero's win rate move by more than it normally drifts week to week? `,
      `${fmt.int(S.total_events)} hero changes from ${fmt.date(toMs(res.data_range[0]))} to ${fmt.date(toMs(res.data_range[1]))}, tested against each hero's own normal noise.`))));

  /* ---------- headline tiles ---------- */
  const tile = (label, value, sub, cls) => el("div", { class: "tile" },
    el("div", { class: "tile-label", text: label }), el("div", { class: `tile-value ${cls || ""}`, text: value }), el("div", { class: "tile-sub" }, sub));
  const b = S.buff, n = S.nerf;
  app.append(el("section", { class: "card" },
    el("h2", { text: "Headline results" }),
    el("p", { class: "muted small", style: "margin:2px 0 12px",
      text: "Effect = change in the 7 days after vs. the 7 days before, minus the average change of heroes that weren't touched (difference-in-differences). Ranges are 95% bootstrap intervals." }),
    el("div", { class: "tiles" },
      tile("Average buff · win rate", `${signed(b.wr.mean_effect)} pts`, `95% CI ${signed(b.wr.ci95[0])} to ${signed(b.wr.ci95[1])} · ${b.events} buffs`, "delta-up"),
      tile("Average nerf · win rate", `${signed(n.wr.mean_effect)} pts`, `95% CI ${signed(n.wr.ci95[0])} to ${signed(n.wr.ci95[1])} · ${n.events} nerfs`, "delta-down"),
      tile("Moved the intended way", `${pctShare(n.wr.share_expected_direction)} / ${pctShare(b.wr.share_expected_direction)}`, "of nerfs / of buffs (win rate)"),
      tile("Average effect · pick rate", `${signed(b.pr.mean_effect, 1)} / ${signed(n.pr.mean_effect, 1)}`, "pts after buffs / nerfs"),
      tile("Normal weekly swing", `±${Math.max(Math.abs(PL.wr_p2_5), Math.abs(PL.wr_p97_5)).toFixed(1)} pts`, `95% of no-patch weeks (${fmt.int(PL.observations)} hero-days)`))));

  /* ---------- key findings (generated from the numbers) ---------- */
  const mr = S.mean_reversion;
  const findings = [
    `Nerfs land harder than buffs: the average nerf moved win rate ${signed(n.wr.mean_effect)} points vs. ${signed(b.wr.mean_effect)} for buffs, and ${pctShare(n.wr.share_expected_direction)} of nerfs moved the intended way vs. ${pctShare(b.wr.share_expected_direction)} of buffs.`,
    `Players react to patch notes quickly: pick rate moved ${signed(b.pr.mean_effect, 1)} points after buffs and ${signed(n.pr.mean_effect, 1)} after nerfs, and pick rate moved the intended way more consistently than win rate after buffs (${pctShare(b.pr.share_expected_direction)} vs. ${pctShare(b.wr.share_expected_direction)}).`,
    `Most single changes are within normal noise: after correcting for ${events.filter((e) => e.q_wr !== null).length} simultaneous tests, ${b.wr.significant} of ${b.events} buffs and ${n.wr.significant} of ${n.events} nerfs changed win rate by more than the hero's usual week-to-week swing.`,
    mr ? `It isn't regression to the mean: patched heroes sat near 50% (buffed ≈ ${mr.buff.mean_pre_wr.toFixed(1)}%, nerfed ≈ ${mr.nerf.mean_pre_wr.toFixed(1)}%), and on no-patch days drift barely depends on starting win rate (slope ${mr.beta.toFixed(3)}), so removing it leaves the effects at ${signed(mr.buff.effect_adjusted)} / ${signed(mr.nerf.effect_adjusted)}.` : null,
  ].filter(Boolean);
  app.append(el("section", { class: "card section" }, el("h2", { text: "Key findings" }),
    el("ul", { class: "findings" }, findings.map((f) => el("li", { text: f })))));

  /* ---------- chart: every event vs the noise band ---------- */
  const chartSec = el("section", { class: "card section" });
  const box = el("div", { class: "chart-box tall" });
  const canvas = el("canvas", { role: "img", "aria-label": "Scatter plot of every hero change's win-rate effect over time, against the normal noise band" });
  box.append(canvas);
  chartSec.append(
    el("div", { class: "section-head" }, el("h2", { text: "Every hero change" }),
      el("span", { class: "muted small", text: "Each dot is one hero in one patch. Shaded band = 95% of normal no-patch swings." })),
    el("div", { class: "legend" },
      el("span", {}, el("span", { class: "key-flag", style: `background:${HMT.changeColor("buff")}` }), "▲ Buff"),
      el("span", {}, el("span", { class: "key-flag", style: `background:${HMT.changeColor("nerf")}` }), "▼ Nerf"),
      el("span", {}, el("span", { class: "key-flag", style: `background:${token("--neutral-mark")}` }), "Rework / adjustment"),
      el("span", {}, "Filled dot = beyond normal noise (significant); hollow = within noise")),
    box);
  app.append(chartSec);

  const band = Math.max(Math.abs(PL.wr_p2_5), Math.abs(PL.wr_p97_5));
  const bandPlugin = {
    id: "noiseBand",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { y } } = chart;
      const top = y.getPixelForValue(band), bot = y.getPixelForValue(-band);
      ctx.save();
      ctx.fillStyle = token("--surface-2");
      ctx.fillRect(a.left, top, a.right - a.left, bot - top);
      ctx.strokeStyle = token("--axis"); ctx.beginPath(); ctx.moveTo(a.left, y.getPixelForValue(0)); ctx.lineTo(a.right, y.getPixelForValue(0)); ctx.stroke();
      ctx.restore();
    },
  };
  function drawChart() {
    const groups = [["buff", "Buff"], ["nerf", "Nerf"], ["other", "Rework / adjustment"]];
    const color = (k) => (k === "other" ? token("--neutral-mark") : HMT.changeColor(k));
    const datasets = groups.map(([k, label]) => {
      const pts = events.filter((e) => (k === "other" ? !["buff", "nerf"].includes(e.type) : e.type === k))
        .map((e) => ({ x: toMs(e.patch_date), y: e.did_wr, e }));
      return {
        label, data: pts, borderColor: color(k), borderWidth: 1.5,
        backgroundColor: pts.map((p) => (p.e.sig_wr ? color(k) : "transparent")),
        pointRadius: 4.5, pointHoverRadius: 6, pointHitRadius: 10,
      };
    });
    const options = {
      responsive: true, maintainAspectRatio: false, parsing: true,
      scales: {
        x: { type: "time", time: { unit: "month" }, grid: { display: false }, border: { color: token("--axis") }, ticks: { maxRotation: 0 } },
        y: { title: { display: true, text: "Win-rate effect (pts vs. unchanged heroes)", color: token("--text-secondary") },
          grid: { color: token("--grid") }, border: { display: false }, ticks: { callback: (v) => (v > 0 ? "+" : "") + v } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false, external: HMT.htmlTooltip(box, (c, tt) => {
          const p = tt.dataPoints && tt.dataPoints[0];
          if (!p) return null;
          const e = p.raw.e;
          return el("div", {},
            el("div", { class: "tt-date", text: `${fmt.date(toMs(e.patch_date))} · ${e.patch || ""}` }),
            el("div", { class: "tt-row" }, el("strong", { text: e.hero }), HMT.badge(e.type)),
            el("div", { class: "tt-row" }, el("strong", { text: `${signed(e.did_wr)} pts` }), el("span", { class: "muted", text: "win-rate effect" })),
            el("div", { class: "muted small", text: `WR ${fmt.pct(e.wr_before)} → ${fmt.pct(e.wr_after)} · normal swing ±${(1.96 * (e.noise_sd_wr || 0)).toFixed(1)}` }),
            el("div", { class: "small", text: e.q_wr === null ? "Not enough no-patch history to test" : e.sig_wr ? `Significant (q = ${e.q_wr.toFixed(3)})` : `Within normal noise (q = ${e.q_wr.toFixed(2)})` }));
        }) },
      },
      interaction: { mode: "nearest", intersect: true },
    };
    if (chart) { chart.data.datasets = datasets; chart.options = options; chart.update(); }
    else chart = new Chart(canvas, { type: "scatter", data: { datasets }, options, plugins: [bandPlugin] });
  }
  let chart = null;
  drawChart();
  HMT.onThemeChange(() => { HMT.applyChartDefaults(); drawChart(); });

  /* ---------- table ---------- */
  const tableSec = el("section", { class: "card section" });
  const typeSel = el("select", { "aria-label": "Change type" },
    el("option", { value: "", text: "All changes" }), el("option", { value: "buff", text: "Buffs" }),
    el("option", { value: "nerf", text: "Nerfs" }), el("option", { value: "other", text: "Reworks / adjustments" }));
  const sigSel = el("select", { "aria-label": "Significance" },
    el("option", { value: "", text: "Any result" }), el("option", { value: "sig", text: "Significant only" }),
    el("option", { value: "wrong", text: "Significant, wrong direction" }));
  const search = el("input", { type: "search", placeholder: "Search hero…", "aria-label": "Search hero" });
  const sortSel = el("select", { "aria-label": "Sort" },
    el("option", { value: "date", text: "Sort: newest" }), el("option", { value: "effect", text: "Sort: biggest effect" }));
  const tbody = el("tbody");
  const count = el("span", { class: "muted small" });
  tableSec.append(
    el("div", { class: "section-head" }, el("h2", { text: "All tested changes" }), count),
    el("div", { class: "controls" }, typeSel, sigSel, search, sortSel),
    el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Date", "Hero", "Change", "WR before → after", "Effect", "Normal swing", "Result", "Pick-rate effect"]
        .map((t, i) => el("th", { class: [0, 4, 5, 7].includes(i) ? "num" : null, text: t })))), tbody)));
  app.append(tableSec);
  [typeSel, sigSel, search, sortSel].forEach((c) => c.addEventListener("input", drawTable));

  function result(e) {
    if (e.q_wr === null) return el("span", { class: "muted", text: "Not enough history" });
    if (!e.sig_wr) return el("span", { class: "muted", text: "Within noise" });
    const intended = ["buff", "nerf"].includes(e.type) ? e.expected_wr : null;
    return el("span", { class: `badge ${intended === false ? "nerf" : "buff"}`, title: `q = ${e.q_wr.toFixed(3)}`,
      text: intended === false ? "Significant · wrong way" : "Significant" });
  }
  function drawTable() {
    const q = search.value.trim().toLowerCase();
    let rows = events.filter((e) =>
      (!typeSel.value || (typeSel.value === "other" ? !["buff", "nerf"].includes(e.type) : e.type === typeSel.value)) &&
      (!sigSel.value || (sigSel.value === "sig" ? e.sig_wr : e.sig_wr && e.expected_wr === false && ["buff", "nerf"].includes(e.type))) &&
      (!q || e.hero.toLowerCase().includes(q)));
    rows = rows.sort(sortSel.value === "effect" ? (a, b) => Math.abs(b.did_wr) - Math.abs(a.did_wr) : (a, b) => b.patch_date.localeCompare(a.patch_date));
    count.textContent = `${rows.length} of ${events.length} tested changes`;
    tbody.replaceChildren(...rows.slice(0, 400).map((e) => {
      const h = heroBy.get(e.hero);
      return el("tr", {},
        el("td", { class: "num", text: fmt.date(toMs(e.patch_date)) }),
        el("td", {}, h ? el("a", { href: `heroes.html?game=${gameId}&hero=${h.slug}`, text: e.hero }) : e.hero),
        el("td", {}, HMT.badge(e.type)),
        el("td", { text: `${fmt.pct(e.wr_before)} → ${fmt.pct(e.wr_after)}` }),
        el("td", { class: `num ${e.did_wr >= 0 ? "delta-up" : "delta-down"}`, text: signed(e.did_wr) }),
        el("td", { class: "num muted", text: e.noise_sd_wr ? `±${(1.96 * e.noise_sd_wr).toFixed(1)}` : "—" }),
        el("td", {}, result(e)),
        el("td", { class: "num", text: signed(e.did_pr, 1) }));
    }));
  }
  drawTable();

  /* ---------- method ---------- */
  const excluded = Object.entries(S.excluded || {}).map(([k, v]) => `${v} ${k}`).join(", ");
  app.append(el("section", { class: "card section method" },
    el("h2", { text: "How this was measured" }),
    el("ol", {},
      el("li", {}, el("b", { text: "Before vs. after. " }), `Match-weighted win and pick rate in the ${P.window_days} days before vs. the ${P.window_days} days after each patch. The patch day itself is skipped.`),
      el("li", {}, el("b", { text: "Difference-in-differences. " }), "Subtract the average change of heroes that weren't changed near that patch, removing anything that shifted the whole game at once."),
      el("li", {}, el("b", { text: "Placebo noise baseline. " }), `The same calculation on every day a hero had no change within ±${P.placebo_guard_days} days gives that hero's normal week-to-week swing. Real swings are about 3× larger than a textbook binomial interval assumes, so the binomial model would call almost every change "significant".`),
      el("li", {}, el("b", { text: "Significance. " }), `Empirical p-value against the hero's own placebo swings, then a Benjamini–Hochberg correction across all tests (false discovery rate ${Math.round(P.fdr * 100)}%).`),
      el("li", {}, el("b", { text: "Robustness. " }), "A regression-to-the-mean check fits no-patch drift against starting win rate. It barely moves the results.")),
    el("p", { class: "small muted", text: `Not tested: ${excluded}. Windows need at least ${fmt.int(P.min_matches)} games on each side. Data is a large sample of public matches (deadlock-api.com), and buff/nerf labels for older patches were classified from patch-note wording. This is observational, not a randomized experiment.` }),
    el("p", { class: "small" }, "Full walkthrough with code and charts: ",
      el("a", { href: `${REPO}/blob/main/analysis/deadlock_patch_impact.ipynb`, target: "_blank", rel: "noopener", text: "analysis notebook on GitHub ↗" }),
      ". Recomputed daily by ", el("code", { text: "pipeline/patch_impact.py" }), `. Last run ${fmt.date(toMs(res.generated))}.`)));
})();
