/**
 * translation-report-html — renders the missing-translations report into a
 * self-contained HTML page (data embedded, no external assets) for
 * print/share. Defaults to the published-site view (drafts included,
 * matching docs:pull --all used by the deploy script).
 *
 * Usage:
 *   bun scripts/translation-report-html.ts [--out translation-report.html]
 *                                          [--input output/manifest.json]
 *                                          [--input-dir output]
 *                                          [--active-only] [--open]
 */

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { buildReport, type TranslationReport } from "./missing-translations.js";
import { parseArgs } from "./lib/args.js";

// NOTE: the embedded page script below must not use backticks or ${...},
// since the whole template lives in a JS template literal.
const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CoMapeo Docs — Translation Coverage</title>
<style>
  :root {
    --ok: #1a7f37; --ok-bg: #dafbe1;
    --warn: #9a6700; --warn-bg: #fff8c5;
    --miss: #cf222e; --miss-bg: #ffebe9;
    --bg: #f6f8fa; --card: #ffffff; --ink: #1f2328; --muted: #59636e;
    --border: #d1d9e0;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px; line-height: 1.45;
  }
  header { padding: 28px 32px 8px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .meta { color: var(--muted); font-size: 13px; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 14px 32px; }
  button, select {
    font: inherit; padding: 6px 14px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--card); color: var(--ink);
    cursor: pointer;
  }
  button:hover { background: #eef1f4; }
  button.primary { background: #0969da; border-color: #0969da; color: #fff; }
  button.primary:hover { background: #0860c4; }
  #count { color: var(--muted); font-size: 13px; margin-left: auto; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; padding: 4px 32px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .card .num { font-size: 30px; font-weight: 650; }
  .card .label { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .num.ok { color: var(--ok); } .num.warn { color: var(--warn); } .num.miss { color: var(--miss); }
  .bars { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; padding: 14px 32px; }
  .barcard { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
  .barlabel { font-size: 13px; margin-bottom: 8px; color: var(--muted); }
  .barlabel b { color: var(--ink); }
  .bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: #eaeef2; }
  .seg.ok { background: var(--ok); } .seg.warn { background: #d4a72c; } .seg.miss { background: #e7818b; }
  table {
    width: calc(100% - 64px); margin: 10px 32px 8px; border-collapse: collapse;
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    overflow: hidden;
  }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { background: #f6f8fa; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  tr.row { cursor: pointer; }
  tr.row:hover { background: #f6f8fa; }
  tr.details { display: none; }
  tr.details.open { display: table-row; }
  tr.details td { background: #fafbfc; color: var(--muted); font-size: 12px; }
  .slug { color: var(--muted); font-size: 12px; }
  .dgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
  .dgrid code { font-size: 11px; word-break: break-all; }
  .badge { display: inline-block; min-width: 26px; text-align: center; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge.ok { background: var(--ok-bg); color: var(--ok); }
  .badge.warn { background: var(--warn-bg); color: var(--warn); }
  .badge.miss { background: var(--miss-bg); color: var(--miss); }
  .legend { padding: 4px 32px 40px; color: var(--muted); font-size: 12px; }
  #toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--ink); color: #fff; padding: 8px 16px; border-radius: 6px;
    opacity: 0; transition: opacity .2s; pointer-events: none; font-size: 13px;
  }
  #toast.show { opacity: 1; }
  @media print {
    body { background: #fff; }
    .toolbar, #toast { display: none !important; }
    header { padding-top: 8px; }
    .cards, .bars { padding-left: 0; padding-right: 0; }
    table { width: 100%; margin: 8px 0; }
    tr { page-break-inside: avoid; }
    .card, .barcard, table { border-color: #999; }
  }
</style>
</head>
<body>
<header>
  <h1>CoMapeo Docs — Translation Coverage</h1>
  <div class="meta" id="meta"></div>
</header>

<div class="toolbar">
  <button class="primary" onclick="window.print()">Print / Save PDF</button>
  <button onclick="shareReport()">Share</button>
  <button onclick="downloadJson()">Download JSON</button>
  <select id="filter" onchange="renderTable()">
    <option value="all">All pages</option>
    <option value="needs" selected>Needs work</option>
    <option value="missing">Missing translation</option>
    <option value="english">English content only</option>
    <option value="complete">Fully translated</option>
  </select>
  <span id="count"></span>
</div>

<section class="cards" id="cards"></section>
<section class="bars" id="bars"></section>

<table>
  <thead>
    <tr><th>Page</th><th>Section</th><th>EN</th><th>ES</th><th>PT</th></tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>

<div class="legend">
  Badges: green ✓ = translated · amber EN = page exists but published with English content
  (stub body or fallback language) · red ✗ = no translation file. Click a row for file paths
  and Notion page ids.
</div>

<div id="toast"></div>

<script>
var DATA = __DATA__;

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function localeState(page, locale) {
  if (page.missing && page.missing.indexOf(locale) !== -1) return "miss";
  var m = page.locales[locale];
  if (!m) return "miss";
  if (locale !== "en" && (!m.has_body || m.language_source === "fallback")) return "warn";
  return "ok";
}

function badge(state) {
  if (state === "ok") return '<span class="badge ok">✓</span>';
  if (state === "warn") return '<span class="badge warn" title="Published with English content">EN</span>';
  return '<span class="badge miss" title="Translation missing">✗</span>';
}

function renderMeta() {
  var d = DATA.generated_at ? new Date(DATA.generated_at).toLocaleString() : "";
  document.getElementById("meta").innerHTML =
    (d ? "Generated " + esc(d) + " &middot; " : "") +
    DATA.pages.length + " published pages &middot; locales: " +
    DATA.supported_locales.join(", ") + " &middot; source: " + esc(DATA.generated_from);
}

function renderCards() {
  var s = DATA.summary;
  var items = [
    [s.total_pages, "Published pages", ""],
    [s.complete, "Fully translated", "ok"],
    [s.missing_translation, "Missing translations", "miss"],
    [s.english_content_only, "English content only", "warn"]
  ];
  var html = "";
  for (var i = 0; i < items.length; i++) {
    html += '<div class="card"><div class="num ' + items[i][2] + '">' + items[i][0] +
      '</div><div class="label">' + items[i][1] + "</div></div>";
  }
  document.getElementById("cards").innerHTML = html;
}

function renderBars() {
  var total = DATA.pages.length;
  var html = "";
  var locales = DATA.supported_locales;
  for (var i = 0; i < locales.length; i++) {
    var l = locales[i];
    if (l === "en") continue;
    var ok = 0, warn = 0;
    for (var j = 0; j < DATA.pages.length; j++) {
      var st = localeState(DATA.pages[j], l);
      if (st === "ok") ok++;
      else if (st === "warn") warn++;
    }
    var miss = total - ok - warn;
    var pctOk = total ? (ok / total) * 100 : 0;
    var pctWarn = total ? (warn / total) * 100 : 0;
    var pctMiss = total ? (miss / total) * 100 : 0;
    html += '<div class="barcard">' +
      '<div class="barlabel"><b>' + l.toUpperCase() + "</b> &mdash; " + ok + "/" + total +
      " translated &middot; " + warn + " English content &middot; " + miss + " missing</div>" +
      '<div class="bar">' +
      '<span class="seg ok" style="width:' + pctOk + '%"></span>' +
      '<span class="seg warn" style="width:' + pctWarn + '%"></span>' +
      '<span class="seg miss" style="width:' + pctMiss + '%"></span>' +
      "</div></div>";
  }
  document.getElementById("bars").innerHTML = html;
}

function detailHtml(p) {
  var h = '<div class="dgrid">';
  var locales = DATA.supported_locales;
  for (var i = 0; i < locales.length; i++) {
    var l = locales[i];
    var m = p.locales[l];
    var st = localeState(p, l);
    var status = st === "miss" ? "missing" : (st === "ok" ? "translated" : "english content");
    h += "<div><b>" + l + "</b> &mdash; " + status +
      (m ? " &middot; Notion page <code>" + esc(m.page_id) + "</code>" : "") +
      "<br><code>" + esc(p.paths[l]) + "</code></div>";
  }
  return h + "</div>";
}

function renderTable() {
  var f = document.getElementById("filter").value;
  var rows = "";
  var shown = 0;
  for (var i = 0; i < DATA.pages.length; i++) {
    var p = DATA.pages[i];
    var needsWork = p.missing.length > 0 || p.english_content.length > 0;
    if (f === "needs" && !needsWork) continue;
    if (f === "missing" && p.missing.length === 0) continue;
    if (f === "english" && p.english_content.length === 0) continue;
    if (f === "complete" && needsWork) continue;
    shown++;
    rows += '<tr class="row">' +
      "<td><b>" + esc(p.title) + '</b><br><span class="slug">' + esc(p.slug) + "</span></td>" +
      "<td>" + esc(p.section) + "</td>" +
      "<td>" + badge(localeState(p, "en")) + "</td>" +
      "<td>" + badge(localeState(p, "es")) + "</td>" +
      "<td>" + badge(localeState(p, "pt")) + "</td>" +
      "</tr>";
    rows += '<tr class="details"><td colspan="5">' + detailHtml(p) + "</td></tr>";
  }
  document.getElementById("tbody").innerHTML = rows;
  document.getElementById("count").textContent = shown + " of " + DATA.pages.length + " pages";
}

function summaryText() {
  var s = DATA.summary;
  return "CoMapeo docs translation coverage: " + s.complete + "/" + s.total_pages +
    " pages fully translated. Missing: ES " + (s.missing_by_locale.es || 0) +
    ", PT " + (s.missing_by_locale.pt || 0) +
    ". Published with English content: ES " + (s.english_content_by_locale.es || 0) +
    ", PT " + (s.english_content_by_locale.pt || 0) + ".";
}

function shareReport() {
  var payload = { title: "CoMapeo docs translation coverage", text: summaryText() };
  if (navigator.share) {
    navigator.share(payload).catch(function () {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(payload.text).then(function () {
      toast("Summary copied to clipboard");
    });
  } else {
    toast(summaryText());
  }
}

function downloadJson() {
  var blob = new Blob([JSON.stringify(DATA, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "missing-translations.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function toast(msg) {
  var t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show";
  setTimeout(function () { t.className = ""; }, 2200);
}

document.getElementById("tbody").addEventListener("click", function (e) {
  var tr = e.target.closest ? e.target.closest("tr.row") : null;
  if (!tr) return;
  var next = tr.nextElementSibling;
  if (next) next.classList.toggle("open");
});

renderMeta();
renderCards();
renderBars();
renderTable();
</script>
</body>
</html>
`;

function openInBrowser(file: string): void {
  // On Windows, pass directly to explorer to avoid cmd.exe command parsing metacharacters.
  const isWin = process.platform === "win32";
  const cmd = process.platform === "darwin" ? "open" : isWin ? "explorer" : "xdg-open";
  const args = [file];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  let report: TranslationReport;
  try {
    report = buildReport({
      input: args.input,
      inputDir: args["input-dir"],
      includeDrafts: args["active-only"] !== "true",
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  report.generated_at = new Date().toISOString();

  // Replacer form avoids $-pattern interpretation in the replacement string;
  // escape "<" so embedded content can never close the <script> block.
  const data = JSON.stringify(report).replace(/</g, "\\u003c");
  const html = TEMPLATE.replace("__DATA__", () => data);

  const out = args.out || join(process.cwd(), "translation-report.html");
  writeFileSync(out, html);

  const s = report.summary;
  const byLocale = (m: Record<string, number>): string =>
    Object.entries(m).sort(([a], [b]) => a.localeCompare(b))
      .map(([l, n]) => `${l.toUpperCase()} ${n}`).join(", ");
  console.log(`Translation coverage: ${s.total_pages} published pages`);
  console.log(`  Fully translated:    ${s.complete}`);
  console.log(`  Missing translation: ${s.missing_translation} (${byLocale(s.missing_by_locale)})`);
  console.log(`  English content only: ${s.english_content_only} (${byLocale(s.english_content_by_locale)})`);
  console.log(`Report: ${resolve(out)}`);

  if (args.open === "true") openInBrowser(resolve(out));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
