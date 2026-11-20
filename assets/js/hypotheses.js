(async () => {
  const { el, fmt, toMs } = HMT;
  const app = document.getElementById("app");
  const gameId = HMT.params.get("game") || "deadlock";
  const FILE = `data/${gameId}/hypotheses.md`;
  const EDIT_URL = `${HMT.REPO}/edit/main/${FILE}`;
  const VIEW_URL = `${HMT.REPO}/blob/main/${FILE}`;

  let game, text, heroes;
  try {
    game = await HMT.getGame(gameId);
    if (!game) throw new Error(`Unknown game "${gameId}"`);
    [text, heroes] = await Promise.all([
      fetch(FILE, { cache: "no-cache" }).then((r) => (r.ok ? r.text() : "")),
      HMT.loadJSON(`data/${gameId}/heroes.json`).catch(() => null),
    ]);
  } catch (e) {
    HMT.renderTopbar();
    return HMT.showError(app, e);
  }
  document.title = `${game.name} Hypotheses`;
  HMT.renderTopbar({ game, page: "hypotheses" });
  HMT.footer();

  const heroBy = new Map((heroes ? heroes.heroes : []).map((h) => [h.name.toLowerCase(), h]));

  /* ---------- parse the Markdown file ----------
     "## Title" starts a hypothesis; leading "- Key: value" lines are its details;
     everything after is free text. HTML comments (the template) are ignored. */
  function parse(md) {
    const clean = md.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n");
    const out = [];
    for (const chunk of clean.split(/^## /m).slice(1)) {
      const lines = chunk.split("\n");
      const h = { title: lines.shift().trim(), meta: {}, body: [] };
      let inMeta = true;
      for (const line of lines) {
        const m = inMeta && line.match(/^\s*[-*]\s*([A-Za-z ]{2,20}):\s*(.*)$/);
        if (m) { h.meta[m[1].trim().toLowerCase()] = m[2].trim(); continue; }
        if (inMeta && !line.trim()) continue;
        inMeta = false;
        h.body.push(line);
      }
      if (h.title) out.push(h);
    }
    return out;
  }

  /* ---------- tiny, safe Markdown renderer (builds DOM nodes, never innerHTML) ---------- */
  function inline(s) {
    const frag = document.createDocumentFragment();
    const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+|[a-z0-9_.\-/?=&#%]+\.html[^)\s]*)\))/gi;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) frag.append(s.slice(last, m.index));
      if (m[2]) frag.append(el("strong", { text: m[2] }));
      else if (m[3]) frag.append(el("em", { text: m[3] }));
      else if (m[4]) frag.append(el("code", { text: m[4] }));
      else frag.append(el("a", { href: m[6], target: /^https?:/i.test(m[6]) ? "_blank" : null, rel: "noopener", text: m[5] }));
      last = re.lastIndex;
    }
    if (last < s.length) frag.append(s.slice(last));
    return frag;
  }
  function blocks(lines) {
    const out = [];
    let para = [], list = null;
    const flushPara = () => { if (para.length) { out.push(el("p", {}, inline(para.join(" ")))); para = []; } };
    const flushList = () => { if (list) { out.push(list); list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) { flushPara(); list = list || el("ul"); list.append(el("li", {}, inline(li[1]))); continue; }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList(); para.push(line.trim());
    }
    flushPara(); flushList();
    return out;
  }

  const STATUS = {
    untested: { label: "Untested", cls: "adjustment" },
    testing: { label: "Testing", cls: "rework" },
    supported: { label: "✓ Supported", cls: "buff" },
    refuted: { label: "✗ Refuted", cls: "nerf" },
    inconclusive: { label: "~ Inconclusive", cls: "adjustment" },
  };
  const statusOf = (h) => STATUS[(h.meta.status || "untested").toLowerCase()] ? (h.meta.status || "untested").toLowerCase() : "untested";

  const items = parse(text);

  /* ---------- page ---------- */
  app.replaceChildren(el("div", { class: "page-head" },
    el("div", {},
      el("h1", { text: `${game.name} hypotheses` }),
      el("p", { class: "lede", text: "Ideas about the meta, written down before checking the data, then tracked as they're tested against this site's stats." })),
    el("div", { class: "head-actions" },
      el("a", { class: "button", href: EDIT_URL, target: "_blank", rel: "noopener", text: "✎ Edit on GitHub" }),
      el("a", { class: "small muted", href: VIEW_URL, target: "_blank", rel: "noopener", text: "View file" }))));

  if (!items.length) {
    app.append(el("section", { class: "card empty-state" },
      el("h2", { text: "No hypotheses yet" }),
      el("p", { class: "muted", text: `Click “Edit on GitHub”, copy the template at the top of the file, fill it in and commit. The page updates about a minute later.` }),
      el("a", { class: "button", href: EDIT_URL, target: "_blank", rel: "noopener", text: "✎ Write the first one" })));
    return;
  }

  // summary + filter
  const counts = items.reduce((a, h) => ((a[statusOf(h)] = (a[statusOf(h)] || 0) + 1), a), {});
  let filter = "all";
  const seg = el("div", { class: "seg", role: "group", "aria-label": "Filter by status" });
  [["all", `All (${items.length})`], ...Object.keys(STATUS).filter((k) => counts[k]).map((k) => [k, `${STATUS[k].label.replace(/^[✓✗~] /, "")} (${counts[k]})`])]
    .forEach(([k, lbl]) => seg.append(el("button", { type: "button", "data-k": k, text: lbl, onclick: () => { filter = k; draw(); } })));
  const list = el("div", { class: "hypo-list" });
  app.append(el("div", { class: "controls" }, seg), list);

  function heroLinks(s) {
    const names = s.split(",").map((x) => x.trim()).filter(Boolean);
    return names.map((n, i) => {
      const h = heroBy.get(n.toLowerCase());
      const node = h ? el("a", { class: "comp-hero", href: `heroes.html?game=${gameId}&hero=${h.slug}` },
        h.image ? el("img", { src: h.image, alt: "", loading: "lazy" }) : null, el("span", { text: h.name }))
        : el("span", { class: "comp-hero", text: n });
      return node;
    });
  }

  function card(h) {
    const st = STATUS[statusOf(h)];
    const created = h.meta.created && /^\d{4}-\d{2}-\d{2}$/.test(h.meta.created) ? fmt.date(toMs(h.meta.created)) : h.meta.created;
    const extra = Object.entries(h.meta).filter(([k]) => !["status", "created", "heroes"].includes(k));
    return el("article", { class: `card hypo status-${statusOf(h)}` },
      el("div", { class: "hypo-head" },
        el("h2", { text: h.title }),
        el("span", { class: `badge ${st.cls}`, text: st.label })),
      el("div", { class: "hypo-meta small muted" },
        created ? el("span", { text: `Created ${created}` }) : null,
        ...extra.map(([k, v]) => el("span", {}, `${k[0].toUpperCase()}${k.slice(1)}: `, el("b", { text: v })))),
      h.meta.heroes ? el("div", { class: "icons hypo-heroes" }, heroLinks(h.meta.heroes)) : null,
      el("div", { class: "hypo-body" }, blocks(h.body)));
  }

  function draw() {
    [...seg.children].forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === filter)));
    list.replaceChildren(...items.filter((h) => filter === "all" || statusOf(h) === filter).map(card));
  }
  draw();
})();
