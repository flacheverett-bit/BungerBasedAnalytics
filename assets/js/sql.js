(async () => {
  const { el, fmt, toMs } = HMT;
  const app = document.getElementById("app");
  let res;
  try {
    res = await HMT.loadJSON("data/sql/results.json");
  } catch (e) {
    HMT.renderTopbar({ page: "sql" });
    return HMT.showError(app, e);
  }
  document.title = "SQL Analysis";
  HMT.renderTopbar({ page: "sql" });
  HMT.footer();

  const GAME_NAMES = { deadlock: "Deadlock", overwatch: "Overwatch", "marvel-rivals": "Marvel Rivals" };

  /* ---------- header ---------- */
  app.replaceChildren(el("div", { class: "page-head" }, el("div", {},
    el("h1", { text: "SQL analysis" }),
    el("p", { class: "lede" },
      `${res.queries.length} questions answered with SQL against a warehouse built daily from everything this site collects. `,
      `Each shows the question, the techniques used, the query and its live result. Engine: ${res.engine}. Last run ${fmt.date(toMs(res.generated))}.`))));

  // schema
  app.append(el("section", { class: "card" },
    el("div", { class: "section-head" }, el("h2", { text: "Warehouse tables" }),
      el("span", { class: "small" },
        el("a", { href: `${HMT.REPO}/blob/main/pipeline/build_warehouse.py`, target: "_blank", rel: "noopener", text: "Schema & loader ↗" }), " · ",
        el("a", { href: `${HMT.REPO}/tree/main/data/exports`, target: "_blank", rel: "noopener", text: "Download as CSV ↗" }), " · ",
        el("a", { href: `${HMT.REPO}/tree/main/analysis/sql`, target: "_blank", rel: "noopener", text: "All .sql files ↗" }))),
    el("div", { class: "schema" }, res.tables.map((t) =>
      el("span", { class: "chip" }, el("code", { text: t.name }), ` ${fmt.int(t.rows)} rows`)))));

  // table of contents
  app.append(el("nav", { class: "card section toc", "aria-label": "Queries" },
    el("h2", { text: "Questions" }),
    el("ol", {}, res.queries.map((q) => el("li", {}, el("a", { href: `#q-${q.id}`, text: q.title }))))));

  /* ---------- light SQL syntax highlighting (DOM nodes only) ---------- */
  const KW = new Set(("select from where group by order having qualify with as join left right inner outer on using and or not in is null " +
    "case when then else end over partition window rows range between preceding following current row interval limit union all distinct " +
    "filter asc desc like count sum avg min max round corr coalesce lag lead row_number rank percent_rank string_agg arg_max " +
    "date_trunc dayname isodow strftime abs days day").split(" "));
  function highlight(sql) {
    const pre = el("pre", { class: "sql" });
    const code = el("code");
    const re = /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+|[^\sA-Za-z0-9_'-]+|-)/g;
    let m;
    while ((m = re.exec(sql))) {
      if (m[1]) code.append(el("span", { class: "c", text: m[1] }));
      else if (m[2]) code.append(el("span", { class: "s", text: m[2] }));
      else if (m[3]) code.append(el("span", { class: "n", text: m[3] }));
      else if (m[4]) code.append(KW.has(m[4].toLowerCase()) ? el("span", { class: "k", text: m[4] }) : m[4]);
      else code.append(m[0]);
    }
    pre.append(code);
    return pre;
  }

  function cell(v, col) {
    if (v === null || v === undefined) return el("td", { class: "muted", text: "—" });
    if (typeof v === "number") {
      const s = Number.isInteger(v) && Math.abs(v) >= 1000 ? fmt.int(v) : (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1));
      return el("td", { class: "num", text: s });
    }
    if (col === "game" && GAME_NAMES[v]) return el("td", { text: GAME_NAMES[v] });
    return el("td", { text: String(v) });
  }

  function resultTable(q) {
    const shown = 12;
    const tbody = el("tbody");
    const render = (n) => tbody.replaceChildren(...q.rows.slice(0, n).map((r) =>
      el("tr", {}, r.map((v, i) => cell(v, q.columns[i])))));
    render(shown);
    const more = q.rows.length > shown
      ? el("button", { class: "linkish", type: "button", text: `Show all ${q.rows.length}${q.row_count > q.rows.length ? ` of ${q.row_count}` : ""} rows`,
          onclick: (e) => { render(q.rows.length); e.target.remove(); } })
      : null;
    return [el("div", { class: "table-wrap" }, el("table", { class: "sql-result" },
      el("thead", {}, el("tr", {}, q.columns.map((c) => el("th", { text: c })))), tbody)), more];
  }

  /* ---------- one card per query ---------- */
  res.queries.forEach((q, i) => {
    const copy = el("button", { class: "copy-btn", type: "button", text: "Copy SQL",
      onclick: async (e) => { try { await navigator.clipboard.writeText(q.sql); e.target.textContent = "Copied ✓"; } catch { e.target.textContent = "Select & copy"; } } });
    app.append(el("section", { class: "card section sql-card", id: `q-${q.id}`, "aria-labelledby": `q-${q.id}-h` },
      el("div", { class: "sql-head" },
        el("span", { class: "teamup-rank", text: String(i + 1) }),
        el("div", {}, el("h2", { id: `q-${q.id}-h`, text: q.title }), el("p", { class: "muted", style: "margin:2px 0 0", text: q.question }))),
      el("div", { class: "tags" }, (q.techniques || "").split(",").map((t) => t.trim()).filter(Boolean).map((t) => el("span", { class: "chip", text: t }))),
      q.takeaway ? el("div", { class: "takeaway" }, el("b", { text: "Result: " }), q.takeaway) : null,
      q.why ? el("p", { class: "small muted", text: `Why it matters: ${q.why}` }) : null,
      el("details", { class: "sql-details", open: true },
        el("summary", {}, "SQL ", el("span", { class: "muted small", text: `· ${q.file.split("/").pop()}` })),
        el("div", { class: "code-wrap" }, copy, highlight(q.sql))),
      q.error ? el("div", { class: "notice", text: `Query failed: ${q.error}` }) : resultTable(q),
      el("p", { class: "source" }, `${fmt.int(q.row_count || 0)} rows · ${q.runtime_ms ?? "—"} ms · `,
        el("a", { href: `${HMT.REPO}/blob/main/${q.file}`, target: "_blank", rel: "noopener", text: "view file ↗" }))));
  });
})();
