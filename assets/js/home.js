(async () => {
  const { el, loadJSON, fmt, toMs } = HMT;
  HMT.renderTopbar();
  HMT.footer();
  const grid = document.getElementById("games");
  try {
    const games = await loadJSON("data/games.json");
    for (const g of games) {
      const [players, patches, heroes] = await Promise.all([
        loadJSON(`data/${g.id}/players.json`).catch(() => null),
        loadJSON(`data/${g.id}/patches.json`).catch(() => null),
        loadJSON(`data/${g.id}/heroes.json`).catch(() => null),
      ]);
      const live = players && players.latest
        ? el("div", { class: "live" }, el("span", { class: "dot", "aria-hidden": "true" }),
            `${fmt.int(players.latest.players)} playing on Steam`,
            el("span", { class: "muted", text: ` · ${fmt.dateShort(toMs(players.latest.time))}` }))
        : null;
      const latest = patches && patches.latest;
      grid.append(el("a", { class: "card game-card", href: `game.html?game=${g.id}` },
        el("img", { src: g.image, alt: "", loading: "lazy" }),
        el("div", { class: "body" },
          el("h2", { text: g.name }),
          el("p", { class: "muted small", style: "margin:0", text: `${g.developer} · ${g.tagline}` }),
          el("div", { class: "meta" },
            el("span", { class: "chip", text: g.genre }),
            heroes ? el("span", { class: "chip", text: `${heroes.heroes.length} ${g.character_label.toLowerCase()}` }) : null,
            latest ? el("span", { class: "chip", text: `Latest patch ${fmt.dateShort(toMs(latest.date))}` }) : null),
          live)));
    }
    grid.append(el("div", { class: "card", style: "display:grid;place-items:center;text-align:center;min-height:200px;border-style:dashed;box-shadow:none" },
      el("div", {}, el("h3", { text: "More games coming" }),
        el("p", { class: "muted small", style: "margin:0", text: "New games are added through data/games.json." }))));
  } catch (e) {
    HMT.showError(grid, e);
  }
})();
