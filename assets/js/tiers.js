(async () => {
  const { el, loadJSON, fmt, toMs, DAY } = HMT;
  const app = document.getElementById("app");
  const gameId = HMT.params.get("game") || "deadlock";

  let game, data, patches;
  try {
    game = await HMT.getGame(gameId);
    if (!game) throw new Error(`Unknown game "${gameId}"`);
    [data, patches] = await Promise.all([
      loadJSON(`data/${gameId}/heroes.json`),
      loadJSON(`data/${gameId}/patches.json`).catch(() => null),
    ]);
  } catch (e) {
    HMT.renderTopbar();
    return HMT.showError(app, e);
  }
  document.title = `${game.name} Tier List`;
  HMT.useTierBands(game.tier_bands);
  HMT.renderTopbar({ game, page: "tiers" });
  HMT.footer();

  const isRates = data.format === "rates";
  const dates = data.dates.map(toMs);
  const N = dates.length;
  const total = data.total_matches;
  const latest = patches && patches.latest;
  const LOW_SAMPLE = 5000;

  const WINDOWS = (isRates
    ? [
        { key: "latest", label: `Latest data (${fmt.dateShort(dates[N - 1])})`, start: dates[N - 1] },
        { key: "7d", label: "Last 7 days", start: dates[N - 1] - 6 * DAY },
        { key: "30d", label: "Last 30 days", start: dates[N - 1] - 29 * DAY },
      ]
    : [
        latest ? { key: "patch", label: `Since latest patch (${fmt.dateShort(toMs(latest.date))})`, start: toMs(latest.date) + DAY } : null,
        { key: "30d", label: "Last 30 days", start: dates[N - 1] - 29 * DAY },
        { key: "90d", label: "Last 3 months", start: dates[N - 1] - 89 * DAY },
      ]).filter(Boolean);
  const storeKey = `tierWindow:${gameId}`;
  let win = HMT.store.get(storeKey, WINDOWS[0].key);
  if (!WINDOWS.some((w) => w.key === win)) win = WINDOWS[0].key;
  let role = "";

  app.replaceChildren(el("div", { class: "page-head" }, el("div", {},
    el("h1", { text: `${game.name} tier list` }),
    el("p", { class: "lede" }, "Every hero ranked by win rate using fixed bands: ",
      HMT.tiers().map((t) => `${t.tier} ${HMT.tierRangeLabel(t.tier)}`).join(" · "),
      ". Within a tier, heroes are sorted by win rate. ", game.tier_note || ""))));

  const controls = el("div", { class: "controls" });
  const seg = el("div", { class: "seg", role: "group", "aria-label": "Time window" });
  WINDOWS.forEach((w) => seg.append(el("button", { type: "button", "data-k": w.key, text: w.label,
    onclick: () => { win = w.key; HMT.store.set(storeKey, win); draw(); } })));
  const roles = [...new Set(data.heroes.map((h) => h.role).filter(Boolean))].sort();
  const roleSel = el("select", { "aria-label": "Filter by type", onchange: (e) => { role = e.target.value; draw(); } },
    el("option", { value: "", text: "All types" }), roles.map((r) => el("option", { value: r, text: r })));
  controls.append(seg, roleSel);
  const board = el("div", { class: "card", style: "padding:0;overflow:hidden" });
  const note = el("p", { class: "source" });
  app.append(controls, board, note);

  function windowRates(h, start) {
    let i0 = dates.findIndex((d) => d >= start); if (i0 < 0) i0 = N;
    if (isRates) {  // average of daily published snapshots
      const avg = (arr) => { const v = arr.slice(i0).filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      return { wr: avg(h.wr), pr: avg(h.pr), ban: avg(h.ban), matches: null };
    }
    let w = 0, m = 0, t = 0;
    for (let i = i0; i < N; i++) { w += h.wins[i]; m += h.matches[i]; t += total[i]; }
    return { wr: m ? (w / m) * 100 : null, pr: t ? (m / t) * 100 : null, matches: m };
  }

  function draw() {
    [...seg.children].forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === win)));
    const w = WINDOWS.find((x) => x.key === win);
    const rows = data.heroes
      .filter((h) => !role || h.role === role)
      .map((h) => ({ h, ...windowRates(h, w.start) }))
      .filter((r) => (isRates ? r.wr !== null : r.matches > 0))
      .map((r) => ({ ...r, tier: HMT.tierFor(r.wr) }));

    board.replaceChildren(...HMT.tiers().map(({ tier }) => {
      const inTier = rows.filter((r) => r.tier === tier).sort((a, b) => b.wr - a.wr);
      return el("div", { class: "tier-row" },
        el("div", { class: "tier-label" }, HMT.tierBadge(tier),
          el("span", { class: "small muted", text: HMT.tierRangeLabel(tier) }),
          el("span", { class: "small muted", text: `${inTier.length} hero${inTier.length === 1 ? "" : "es"}` })),
        el("div", { class: "tier-heroes" }, inTier.length ? inTier.map(card) : el("span", { class: "empty", text: "No heroes in this tier" })));
    }));
    const from = Math.max(w.start, dates[0]);
    const days = Math.round((dates[N - 1] - from) / DAY) + 1;
    note.textContent = `Window: ${days} day${days === 1 ? "" : "s"} of data (${fmt.date(from)} – ${fmt.date(dates[N - 1])}). ` +
      (isRates
        ? `Average of ${game.developer}'s daily published rates${data.slice ? ` (${data.slice})` : ""}; history started ${fmt.date(dates[0])}. Source: ${data.source}.`
        : `Heroes marked * have fewer than ${fmt.int(LOW_SAMPLE)} games in the window. Source: ${data.source}.`);
  }

  function card(r) {
    return el("a", { class: "hero-btn", href: `heroes.html?game=${gameId}&hero=${r.h.slug}`, style: "text-decoration:none" },
      el("span", { class: "top" }, el("img", { src: r.h.image, alt: "", loading: "lazy" }),
        el("span", {}, el("span", { class: "name", text: r.h.name + (!isRates && r.matches < LOW_SAMPLE ? " *" : "") }), el("br"),
          el("span", { class: "role", text: r.h.role || "" }))),
      el("span", { class: "nums" },
        el("span", {}, "WR ", el("b", { text: fmt.pct(r.wr) })),
        el("span", {}, "PR ", el("b", { text: fmt.pct(r.pr) }))));
  }

  draw();
})();
