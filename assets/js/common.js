/* Shared helpers: data loading, theme, formatting, date ranges, chart plumbing. */
const HMT = (() => {
  const SITE_NAME = "Bunger Based Analytics";
  const REPO = "https://github.com/flacheverett-bit/BungerBasedAnalytics";
  const params = new URLSearchParams(location.search);

  /* ---------- tiers (fixed win-rate bands, set per game from games.json "tier_bands") ---------- */
  let TIERS = [];
  function useTierBands(bands = [54, 52, 50, 48, 46]) {
    TIERS = ["S", "A", "B", "C", "D"].map((tier, i) => ({ tier, min: bands[i] })).concat({ tier: "F", min: -Infinity });
    return TIERS;
  }
  useTierBands();
  function tiers() { return TIERS; }
  function tierFor(wr) {
    if (wr === null || wr === undefined || Number.isNaN(wr)) return null;
    return TIERS.find((t) => wr >= t.min).tier;
  }
  function tierBadge(tier) {
    return tier ? el("span", { class: `tier-badge tier-${tier}`, title: `${tier} tier`, text: tier }) : null;
  }
  function tierRangeLabel(tier) {
    const i = TIERS.findIndex((t) => t.tier === tier);
    const lo = TIERS[i].min, hi = i > 0 ? TIERS[i - 1].min : null;
    if (lo === -Infinity) return `under ${hi}%`;
    return hi === null ? `${lo}%+` : `${lo}–${hi}%`;
  }

  /* ---------- data ---------- */
  const cache = {};
  async function loadJSON(path) {
    if (!cache[path]) {
      cache[path] = fetch(path, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        return r.json();
      });
    }
    return cache[path];
  }
  async function getGame(id) {
    const games = await loadJSON("data/games.json");
    return games.find((g) => g.id === id) || null;
  }

  /* ---------- storage (per-viewer conveniences only) ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem("hmt:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("hmt:" + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  /* ---------- theme ---------- */
  const themeListeners = [];
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
    themeListeners.forEach((fn) => fn());
  }
  function isDark() {
    const t = document.documentElement.getAttribute("data-theme");
    if (t) return t === "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function toggleTheme() {
    const next = isDark() ? "light" : "dark";
    store.set("theme", next);
    applyTheme(next);
  }
  function onThemeChange(fn) { themeListeners.push(fn); }
  applyTheme(store.get("theme", null));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => themeListeners.forEach((fn) => fn()));

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* ---------- DOM ---------- */
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return n;
  }

  // Browser-tab icon: the "B" brand mark, tinted with the game's theme color.
  // [background, letter] — yellow needs a dark letter to stay readable.
  const GAME_ICON_COLORS = { deadlock: ["#4f8a62", "#ffffff"], overwatch: ["#f99e1a", "#ffffff"], "marvel-rivals": ["#f5c400", "#1a1a19"] };
  function setFavicon(colors) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.append(link); }
    if (!colors) { link.type = "image/svg+xml"; link.href = "assets/img/favicon.svg"; return; }
    const [bg, fg] = colors;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/>` +
      `<text x="32" y="46" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="40" font-weight="800" fill="${fg}">B</text></svg>`;
    link.type = "image/svg+xml";
    link.href = "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function renderTopbar({ game = null, page = "home" } = {}) {
    // Per-game accent theme (see style.css); the home page keeps the neutral brass accent.
    if (game) document.documentElement.setAttribute("data-game", game.id);
    else document.documentElement.removeAttribute("data-game");
    setFavicon(game ? GAME_ICON_COLORS[game.id] : null);
    const crumbs = el("nav", { class: "crumbs", "aria-label": "Breadcrumb" });
    if (game) {
      crumbs.append(el("span", { "aria-hidden": "true", text: "/" }), el("a", { href: `game.html?game=${game.id}`, text: game.name }));
    }
    const tabs = game
      ? el("nav", { class: "tabs", "aria-label": "Game sections" },
          el("a", { href: `game.html?game=${game.id}`, "aria-current": page === "game" ? "page" : null, text: "Patch & players" }),
          el("a", { href: `heroes.html?game=${game.id}`, "aria-current": page === "heroes" ? "page" : null, text: game.character_label || "Characters" }),
          el("a", { href: `tiers.html?game=${game.id}`, "aria-current": page === "tiers" ? "page" : null, text: "Tier list" }),
          game.analysis ? el("a", { href: `analysis.html?game=${game.id}`, "aria-current": page === "analysis" ? "page" : null, text: "Patch impact" }) : null,
          el("a", { href: `hypotheses.html?game=${game.id}`, "aria-current": page === "hypotheses" ? "page" : null, text: "Hypotheses" }))
      : null;
    const themeBtn = el("button", { class: "icon-btn", type: "button", title: "Toggle light/dark", "aria-label": "Toggle light or dark theme", onclick: toggleTheme, text: "◐" });
    const sqlLink = el("span", { class: "site-links" },
      el("a", { class: "nav-link", href: "meta.html", "aria-current": page === "meta" ? "page" : null, text: "Meta health" }),
      el("a", { class: "nav-link", href: "sql.html", "aria-current": page === "sql" ? "page" : null, text: "SQL" }));
    const bar = el("header", { class: "topbar" },
      el("div", { class: "wrap" },
        el("a", { class: "brand", href: "index.html" }, el("span", { class: "brand-mark", "aria-hidden": "true", text: "B" }), SITE_NAME),
        crumbs, el("div", { class: "spacer" }), tabs, sqlLink, themeBtn));
    document.body.prepend(bar);
  }

  function showError(container, err) {
    console.error(err);
    container.replaceChildren(el("div", { class: "notice" },
      "Couldn't load data. If you opened this file directly, run a local server instead (see README): ",
      el("code", { text: "python -m http.server" }), ". ", el("span", { class: "muted", text: String(err.message || err) })));
  }

  /* ---------- formatting ---------- */
  const nf = new Intl.NumberFormat("en-US");
  const fmt = {
    int: (n) => (n === null || n === undefined || Number.isNaN(n) ? "—" : nf.format(Math.round(n))),
    compact: (n) => (n === null || n === undefined ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)),
    pct: (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? "—" : n.toFixed(d) + "%"),
    date: (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
    dateShort: (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
  };
  const toMs = (iso) => Date.parse(iso.length === 10 ? iso + "T00:00:00Z" : iso);
  const DAY = 86400000;

  /* ---------- date ranges ---------- */
  const RANGES = [
    { key: "1m", label: "1 month" },
    { key: "3m", label: "3 months" },
    { key: "ytd", label: "YTD" },
    { key: "12m", label: "12 months" },
    { key: "3y", label: "3 years" },
  ];
  function rangeStart(key, endMs) {
    const d = new Date(endMs);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    switch (key) {
      case "1m": return Date.UTC(y, m - 1, day);
      case "3m": return Date.UTC(y, m - 3, day);
      case "ytd": return Date.UTC(y, 0, 1);
      case "12m": return Date.UTC(y - 1, m, day);
      case "3y": return Date.UTC(y - 3, m, day);
      default: return -Infinity;
    }
  }
  function rangeControl(container, { keys, value, onChange, label = "Time range" }) {
    const seg = el("div", { class: "seg", role: "group", "aria-label": label });
    const btns = RANGES.filter((r) => keys.includes(r.key)).map((r) =>
      el("button", { type: "button", "aria-pressed": String(r.key === value), "data-key": r.key, text: r.label,
        onclick: () => { btns.forEach((b) => b.setAttribute("aria-pressed", String(b === btn(r.key)))); onChange(r.key); } }));
    const btn = (k) => btns.find((b) => b.dataset.key === k);
    seg.append(...btns);
    container.append(seg);
    return seg;
  }

  /* ---------- chart plumbing ---------- */
  function applyChartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.font.family = token("--font") || "system-ui";
    Chart.defaults.font.size = 12;
    Chart.defaults.color = token("--text-muted");
    Chart.defaults.borderColor = token("--grid");
    Chart.defaults.animation = false;
  }

  // Vertical hairline that follows the hovered x position.
  const crosshairPlugin = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements();
      if (!active || !active.length) return;
      const x = active[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = token("--axis");
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.restore();
    },
  };

  // Patch markers: dashed vertical lines + a flag at the top of the plot.
  // options.plugins.patchMarkers = { markers: [{ x: ms, color, emphasis: bool }] }
  const patchMarkerPlugin = {
    id: "patchMarkers",
    afterDatasetsDraw(chart, _args, opts) {
      const markers = (opts && opts.markers) || [];
      if (!markers.length) return;
      const xs = chart.scales.x;
      const { top, bottom, left, right } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      for (const m of markers) {
        const x = xs.getPixelForValue(m.x);
        if (x < left - 1 || x > right + 1) continue;
        ctx.globalAlpha = m.emphasis ? 0.9 : 0.35;
        ctx.strokeStyle = m.color;
        ctx.lineWidth = m.emphasis ? 1.5 : 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = m.emphasis ? 1 : 0.55;
        ctx.fillStyle = m.color;
        const s = m.emphasis ? 6 : 4;
        ctx.beginPath(); ctx.moveTo(x - s, top - 2 - s * 1.6); ctx.lineTo(x + s, top - 2 - s * 1.6); ctx.lineTo(x, top - 2); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    },
  };

  // Horizontal reference line on a given scale (e.g. 50% win rate).
  const refLinePlugin = {
    id: "refLine",
    afterDatasetsDraw(chart, _args, opts) {
      if (!opts || !opts.lines) return;
      const ctx = chart.ctx;
      ctx.save();
      for (const l of opts.lines) {
        const sc = chart.scales[l.scale];
        if (!sc) continue;
        const y = sc.getPixelForValue(l.value);
        if (y < sc.top || y > sc.bottom) continue;
        ctx.strokeStyle = token("--text-muted");
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(chart.chartArea.left, y); ctx.lineTo(chart.chartArea.right, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = token("--text-muted");
        ctx.font = `11px ${Chart.defaults.font.family}`;
        ctx.textAlign = "right";
        ctx.fillText(l.label, chart.chartArea.right - 4, y - 4);
      }
      ctx.restore();
    },
  };

  // HTML tooltip. build(chart, tooltip) returns a DOM node (built with textContent, never innerHTML).
  function htmlTooltip(box, build) {
    const tip = el("div", { class: "tooltip", role: "status" });
    box.append(tip);
    return (context) => {
      const { chart, tooltip } = context;
      if (tooltip.opacity === 0) { tip.classList.remove("show"); return; }
      const node = build(chart, tooltip);
      if (!node) { tip.classList.remove("show"); return; }
      tip.replaceChildren(node);
      tip.classList.add("show");
      const x = tooltip.caretX, y = tooltip.caretY;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      const bw = box.clientWidth;
      let left = x + 14;
      if (left + w > bw) left = x - w - 14;
      tip.style.left = Math.max(0, left) + "px";
      tip.style.top = Math.max(0, Math.min(y - h / 2, box.clientHeight - h)) + "px";
    };
  }

  function ttRow(color, value, label) {
    return el("div", { class: "tt-row" },
      el("span", { class: "key-line", style: `background:${color}` }),
      el("strong", { text: value }),
      el("span", { class: "muted", text: label }));
  }

  const CHANGE_LABEL = { buff: "▲ Buff", nerf: "▼ Nerf", rework: "◆ Rework", new: "★ New", adjustment: "● Adjusted", patch: "Patch" };
  function changeColor(type) {
    return { buff: token("--buff"), nerf: token("--nerf"), rework: token("--rework"), new: token("--rework") }[type] || token("--neutral-mark");
  }
  function badge(type) {
    const t = CHANGE_LABEL[type] ? type : "adjustment";
    return el("span", { class: `badge ${t}`, text: CHANGE_LABEL[t] });
  }

  function footer(extra) {
    document.body.append(el("footer", {},
      el("div", { class: "wrap" },
        `${SITE_NAME}. A student data-analytics project. Not affiliated with Valve or any game publisher. `,
        extra || "")));
  }

  return {
    SITE_NAME, REPO, tiers, useTierBands, tierFor, tierBadge, tierRangeLabel,
    params, loadJSON, getGame, store, token, el, renderTopbar, showError, fmt, toMs, DAY,
    RANGES, rangeStart, rangeControl, applyChartDefaults, onThemeChange, isDark,
    crosshairPlugin, patchMarkerPlugin, refLinePlugin, htmlTooltip, ttRow, badge, changeColor, CHANGE_LABEL, footer,
  };
})();
