// Household Money dashboard. Data: assets/financial/money/model.json in the private wiki repo,
// written by ./money --publish (rebuilt by the wiki's "Money model" workflow when exports change).
import { loadSettings, saveSettings, isConfigured, cachedModel, fetchModel, DEFAULTS, readFile, writeFile } from "./github.js?v=2026.11.06-5";
import * as M from "./model.js?v=2026.11.06-5";
import { sankey, bars, hbars, line, money, esc } from "./charts.js?v=2026.11.06-5";

export const APP_VERSION = "2026.11.06-5";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view"), periodEl = $("#period"), statusEl = $("#status");
let model = null;
let state = loadState();
let drill = { group: null, label: null };

function loadState() {
  try { return { scale: "year", anchor: null, custom: {}, bucket: "auto", tx: {}, ...JSON.parse(localStorage.getItem("money:view") || "{}") }; }
  catch { return { scale: "year", anchor: null, custom: {}, bucket: "auto", tx: {} }; }
}
function saveState() { try { localStorage.setItem("money:view", JSON.stringify(state)); } catch { /* fine */ } }

const name = (id) => model?.accounts[id]?.name ? `${model.accounts[id].name}${/^\d+$/.test(id) ? ` ${id}` : ""}` : id;
const fmtDate = (s) => M.parse(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const el = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };
const delta = (now, before, goodUp) => {
  if (!before) return "";
  const d = now - before, cls = (d > 0) === goodUp ? "pos" : "neg";
  return `<span class="d ${Math.abs(d) < 1 ? "" : cls}">${d >= 0 ? "+" : "−"}${money(Math.abs(d))} vs period before</span>`;
};

// ---------- period ----------
function currentPeriod() {
  const anchor = state.anchor && state.anchor <= model.to ? state.anchor : model.to;
  return M.period(state.scale, anchor, model, state.custom);
}
function renderPeriod() {
  if (!model) { periodEl.innerHTML = ""; return; }
  const p = currentPeriod();
  periodEl.innerHTML = `<div class="seg">${M.SCALES.map(([k, l]) => `<button type="button" data-scale="${k}" class="${state.scale === k ? "on" : ""}">${l}</button>`).join("")}</div>
    <button type="button" class="btn" data-shift="-1" aria-label="Earlier">‹</button>
    <span class="range">${fmtDate(p.from)} – ${fmtDate(p.to)}</span>
    <button type="button" class="btn" data-shift="1" aria-label="Later">›</button>
    ${state.scale === "custom" ? `<input type="date" id="cf" value="${state.custom.from || model.from}"> to <input type="date" id="ct" value="${state.custom.to || model.to}">` : ""}`;
  periodEl.querySelectorAll("[data-scale]").forEach((b) => b.addEventListener("click", () => {
    state.scale = b.dataset.scale;
    if (state.scale === "custom" && !state.custom.from) state.custom = { ...p };
    saveState(); render();
  }));
  periodEl.querySelectorAll("[data-shift]").forEach((b) => b.addEventListener("click", () => {
    const r = M.shift(state.scale, currentPeriod(), Number(b.dataset.shift));
    if (r.anchor) state.anchor = r.anchor; else { state.scale = "custom"; state.custom = r; }
    saveState(); render();
  }));
  for (const id of ["cf", "ct"]) $(`#${id}`)?.addEventListener("change", () => {
    state.custom = { from: $("#cf").value, to: $("#ct").value }; saveState(); render();
  });
}

// ---------- views ----------
function coverageNote(p) {
  const slack = (a, b) => M.days(a, b) > 8; // ignore a few days at either end (statement timing)
  const partial = Object.values(model.accounts).filter((a) => a.exported && a.to >= p.from && a.from <= p.to
    && ((a.from > p.from && slack(p.from, a.from)) || (a.to < p.to && slack(a.to, p.to))));
  const none = Object.values(model.accounts).filter((a) => !a.exported).length;
  const bits = [];
  if (partial.length) bits.push(`Only part of this period is in the data for ${partial.map((a) => `${name(a.id)} (${a.from} to ${a.to})`).join(", ")}.`);
  if (none) bits.push(`${none} accounts not yet exported (see Close the loop).`);
  return bits.length ? `<p class="note">${esc(bits.join(" "))}</p>` : "";
}

function payrollNote(pay) {
  const e = Object.entries(pay || {}).filter(([, v]) => Math.abs(v) > 0.5).sort((a, b) => b[1] - a[1]);
  if (!e.length) return "";
  const tot = e.reduce((a, [, v]) => a + v, 0);
  return `<p class="note">Before pay reaches the bank: ${e.map(([k, v]) => `${esc(k)} ${money(v)}`).join(" · ")} (total ${money(tot)}; not in the figures above).</p>`;
}

// Clicked band -> what's inside it: a breakdown by payee (click one for its transactions), or the
// transactions themselves when there are few or only one payee.
function showDetail(card, title, list, note = "") {
  card.querySelector(".detail")?.remove();
  const box = document.createElement("div");
  box.className = "detail";
  const total = Math.abs(list.reduce((a, r) => a + r.flow, 0));
  box.append(el(`<h3><span>${esc(title)}: ${money(total)}</span><a href="#" class="close">close</a></h3>${note ? `<p class="note">${esc(note)}</p>` : ""}`));
  box.querySelector(".close").addEventListener("click", (e) => { e.preventDefault(); box.remove(); });
  const byLabel = new Map();
  for (const r of list) byLabel.set(r.label, (byLabel.get(r.label) || 0) + r.flow);
  for (const [k, v] of byLabel) byLabel.set(k, Math.abs(v));
  const inner = document.createElement("div");
  if (list.length > 12 && byLabel.size > 1) {
    inner.append(hbars([...byLabel].sort((a, b) => b[1] - a[1]).map(([label, v]) => ({ label, v })), {
      onPick: (label) => { inner.querySelector(".sub")?.remove(); const sub = document.createElement("div"); sub.className = "sub";
        sub.append(el(`<h3><span>${esc(label)}</span></h3>`), txTable(list.filter((r) => r.label === label))); inner.append(sub); sub.scrollIntoView({ behavior: "smooth", block: "nearest" }); } }));
  } else if (list.length) inner.append(txTable(list));
  box.append(inner);
  card.append(box);
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function overview(rows, prev, p) {
  const t = M.totals(model, rows);
  const b = M.previous(p).from >= model.from ? M.totals(model, prev) : {};
  view.append(el(`<div class="kpis">
    <div class="kpi"><b>${money(t.income)}</b><span>came in</span><br>${delta(t.income, b.income, true)}</div>
    <div class="kpi"><b>${money(t.out)}</b><span>spent, bills and loans</span><br>${delta(t.out, b.out, false)}</div>
    <div class="kpi"><b>${money(t.saved)}</b><span>saved (incl. ${money(t.kept)} kept in savings)</span><br>${delta(t.saved, b.saved, true)}</div>
    <div class="kpi"><b class="${t.buffer < 0 ? "neg" : ""}">${money(t.buffer)}</b><span>change in checking and cards</span></div>
  </div>${payrollNote(t.payroll)}${coverageNote(p)}`));
  // Flow: income sources -> household -> uses
  const inc = M.sumBy(rows, (r) => r.label, (r) => r.kind === "income");
  const left = [...inc].sort((a, c) => c[1] - a[1]);
  const srcs = left.slice(0, 6).map(([l]) => l);
  const src = (l) => (srcs.includes(l) ? l : "Other income");
  const edges = [];
  const add = (c, from, to, v, cls) => { if (v > 0.5) edges.push({ c, from, to, v, cls }); };
  const srcSum = new Map();
  for (const [l, v] of left) srcSum.set(src(l), (srcSum.get(src(l)) || 0) + v);
  if (t.kept < 0) srcSum.set("Drawn from savings", -t.kept);
  for (const [l, v] of srcSum) add(0, l, "H", v, "in");
  const uses = new Map(), cls = new Map();
  const use = (k, v, c) => { uses.set(k, (uses.get(k) || 0) + v); if (c) cls.set(k, c); };
  for (const r of rows) {
    if (r.kind === "spend" || r.kind === "debt") use(r.group, -r.flow, ["Unsorted", "People & payments", "Cash", "Checks"].includes(r.group) ? "leak" : "");
    else if (r.kind === "other card") use("Card purchases with no detail", -r.flow, "leak");
    else if (r.kind === "saving") use(r.label, -r.flow, "save");
    else if (r.kind === "unmatched transfer") use(r.flow < 0 ? "Moved out (accounts not exported)" : "Back from accounts not exported", -r.flow, "save");
  }
  if (uses.get("Back from accounts not exported")) { const v = -uses.get("Back from accounts not exported"); uses.delete("Back from accounts not exported"); use("Moved out (accounts not exported)", -v, "save"); }
  if (t.kept > 0) use("Kept in savings", t.kept, "save");
  if (t.buffer > 0) use("Left in checking", t.buffer, "save");
  else if (t.buffer < 0) srcSum.set("Drawn from checking", -t.buffer), add(0, "Drawn from checking", "H", -t.buffer, "in");
  const right = [...uses].filter(([, v]) => v > 0.5).sort((a, c) => c[1] - a[1]);
  const keep = right.slice(0, 15), rest = right.slice(15).reduce((a, [, v]) => a + v, 0);
  const kept = new Set(keep.map(([k]) => k));
  const savingsAcct = (id) => model.accounts[id]?.type === "savings";
  const useKey = (r) => {
    let k = null;
    if (r.kind === "spend" || r.kind === "debt") k = r.group;
    else if (r.kind === "other card") k = "Card purchases with no detail";
    else if (r.kind === "saving") k = r.label;
    else if (r.kind === "unmatched transfer") k = "Moved out (accounts not exported)";
    else if (r.kind === "internal" && savingsAcct(r.account) && !savingsAcct(r.pair)) k = "Kept in savings";
    if (k && !kept.has(k) && uses.has(k)) k = "Everything else";
    return k;
  };
  for (const [k, v] of keep) add(1, "H", k, v, cls.get(k) || "");
  if (rest > 0.5) add(1, "H", "Everything else", rest, "");
  const cols = [[...srcSum.keys()].map((id) => ({ id, label: id, cls: "in" })), [{ id: "H", label: "Household", cls: "acct" }],
    [...keep.map(([k]) => ({ id: k, label: k, cls: cls.get(k) || "" })), { id: "Everything else", label: "Everything else" }]];
  view.append(el(`<h2>How money moves</h2>`));
  const card = el(`<div class="card"></div>`).firstChild;
  card.append(sankey(cols, edges, {
    onPick: (id) => { if (uses.has(id) && !cls.get(id)) { location.hash = "#/groups"; drill = { group: id, label: null }; render(); } },
    onBand: (e) => {
      if (e.c === 0) {
        if (e.from.startsWith("Drawn from")) return showDetail(card, e.from, [], "Not a payee: the difference between money in and money out, covered from balances.");
        return showDetail(card, e.from, rows.filter((r) => r.kind === "income" && src(r.label) === e.from));
      }
      if (e.to === "Left in checking") return showDetail(card, e.to, [], "Not a payee: what money in exceeded money out by, left in checking and on the cards.");
      showDetail(card, e.to, rows.filter((r) => useKey(r) === e.to));
    } }));
  card.append(el(`<div class="legend"><span><i class="sw in"></i>money in</span><span><i class="sw out"></i>spending and bills</span><span><i class="sw leak"></i>can't see what it bought</span><span><i class="sw save"></i>saved or kept</span></div>`));
  view.lastChild.after(card);
  const size = M.bucketSize(p);
  view.append(el(`<h2>Over this period (${size === "day" ? "daily" : size === "week" ? "weekly" : "monthly"})</h2>`));
  const c2 = el(`<div class="card"></div>`).firstChild;
  c2.append(bars(M.trend(model, rows, p, size)));
  c2.append(el(`<div class="legend"><span><i class="sw in"></i>in</span><span><i class="sw out"></i>out</span><span>under each: in minus out</span></div>`));
  view.append(c2);
}

function accounts(rows, prev, p) {
  view.append(el(`<h2>Where money lands and what each account pays</h2><p class="note">Income on the left, the account it lands in, and what that account spends it on. Click a band to see what is in it, or an account for its transactions.</p>`));
  const edges = [], add = (c, from, to, v, cls) => { if (v > 0.5) edges.push({ c, from, to, v, cls }); };
  const inc = M.sumBy(rows, (r) => `${r.label}\u0000${r.account}`, (r) => r.kind === "income");
  const srcIds = new Set(), acctIds = new Set(), useIds = new Map();
  const incByLabel = M.sumBy(rows, (r) => r.label, (r) => r.kind === "income");
  const bigSrc = new Set([...incByLabel].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l]) => l));
  const merged = new Map();
  for (const [k, v] of inc) { const [l, a] = k.split("\u0000"); const s = bigSrc.has(l) ? l : "Other income"; merged.set(`${s}\u0000${a}`, (merged.get(`${s}\u0000${a}`) || 0) + v); }
  for (const [k, v] of merged) { const [l, a] = k.split("\u0000"); srcIds.add(l); acctIds.add(a); add(0, l, a, v, "in"); }
  const useOf = (r) => r.kind === "other card" ? ["Card purchases with no detail", "leak"] : r.kind === "saving" ? ["Saving and investing", "save"]
    : r.kind === "unmatched transfer" ? ["Accounts not exported", "save"] : [r.group, ""];
  const spend = new Map();
  for (const r of rows) {
    if (!(M.OUT_KINDS.has(r.kind) || r.kind === "saving" || (r.kind === "unmatched transfer" && r.flow < 0))) continue;
    const [u, c] = useOf(r); useIds.set(u, c); acctIds.add(r.account);
    const k = `${r.account}\u0000${u}`; spend.set(k, (spend.get(k) || 0) - r.flow);
  }
  const useTot = new Map();
  for (const [k, v] of spend) { const u = k.split("\u0000")[1]; useTot.set(u, (useTot.get(u) || 0) + v); }
  const big = new Set([...useTot].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([u]) => u));
  const sp2 = new Map();
  for (const [k, v] of spend) { const [a, u] = k.split("\u0000"); const uu = big.has(u) ? u : "Everything else"; sp2.set(`${a}\u0000${uu}`, (sp2.get(`${a}\u0000${uu}`) || 0) + v); }
  useIds.set("Everything else", "");
  for (const [k, v] of sp2) { const [a, u] = k.split("\u0000"); add(1, a, u, v, useIds.get(u)); }
  const topUses = [...big].map((u) => [u, useTot.get(u)]).sort((a, b) => b[1] - a[1]);
  topUses.push(["Everything else", 0]);
  const srcOf = (l) => (bigSrc.has(l) ? l : "Other income");
  const useAcc = (r) => { const u = useOf(r)[0]; return big.has(u) ? u : "Everything else"; };
  const isUse = (r) => M.OUT_KINDS.has(r.kind) || r.kind === "saving" || (r.kind === "unmatched transfer" && r.flow < 0);
  const c1 = el(`<div class="card"></div>`).firstChild;
  c1.append(sankey([[...srcIds].map((id) => ({ id, label: id, cls: "in" })), [...acctIds].map((id) => ({ id, label: name(id), cls: "acct" })),
    topUses.map(([u]) => ({ id: u, label: u, cls: useIds.get(u) }))], edges, { minH: 420,
    onPick: (id) => { if (model.accounts[id]) { state.tx = { account: id }; saveState(); location.hash = "#/tx"; } },
    onBand: (e) => e.c === 0
      ? showDetail(c1, `${e.from} → ${name(e.to)}`, rows.filter((r) => r.kind === "income" && r.account === e.to && srcOf(r.label) === e.from))
      : showDetail(c1, `${name(e.from)} → ${e.to}`, rows.filter((r) => r.account === e.from && isUse(r) && useAcc(r) === e.to)) }));
  view.append(c1);

  view.append(el(`<h2>Transfers between accounts</h2><p class="note">From (left) to (right). Card payments are transfers too: the purchases are counted on the card.</p>`));
  const f = M.accountFlows(model, rows).filter((e) => model.accounts[e.from] || e.from === "Accounts not exported")
    .filter((e) => model.accounts[e.to] || e.to === "Accounts not exported");
  const froms = [...new Set(f.map((e) => e.from))], tos = [...new Set(f.map((e) => e.to))];
  const c2 = el(`<div class="card"></div>`).firstChild;
  if (f.length) c2.append(sankey([froms.map((id) => ({ id, label: name(id), cls: "acct" })), tos.map((id) => ({ id, label: name(id), cls: id === "Accounts not exported" ? "save" : "acct" }))],
    f.map((e) => ({ c: 0, from: e.from, to: e.to, v: e.v, cls: e.to === "Accounts not exported" ? "save" : "" })), { minH: 260,
      onBand: (e) => showDetail(c2, `${name(e.from)} → ${name(e.to)}`, rows.filter((r) =>
        e.to === "Accounts not exported" ? r.account === e.from && r.kind === "unmatched transfer" && r.flow < 0
        : e.from === "Accounts not exported" ? r.account === e.to && r.flow > 0 && (r.kind === "unmatched transfer" || (r.kind === "internal" && r.pair === "?"))
        : r.account === e.from && r.pair === e.to && r.flow < 0)) }));
  else c2.append(el(`<p class="note">No transfers in this period.</p>`));
  view.append(c2);

  // Per-account table
  const per = {};
  for (const r of rows) {
    const a = (per[r.account] ||= { inOut: 0, outOut: 0, tin: 0, tout: 0, net: 0 });
    a.net += r.flow;
    if (r.kind === "internal" || r.kind === "unmatched transfer" || r.kind === "saving") { if (r.flow > 0) a.tin += r.flow; else a.tout -= r.flow; }
    else if (r.flow > 0) a.inOut += r.flow; else a.outOut -= r.flow;
  }
  view.append(el(`<h2>Each account</h2><div class="card"><table><tr><th>Account</th><th>Data</th><th class="n">In from outside</th><th class="n">Out to outside</th><th class="n">Transfers in</th><th class="n">Transfers out</th><th class="n">Net</th></tr>
    ${Object.values(model.accounts).filter((a) => a.exported && !["loan", "investment", "benefit", "wallet"].includes(a.type)).map((a) => { const x = per[a.id] || { inOut: 0, outOut: 0, tin: 0, tout: 0, net: 0 };
      return `<tr class="click" data-acct="${esc(a.id)}"><td><b>${esc(name(a.id))}</b><br><span class="note">${esc(a.role || a.type)}</span></td><td class="note">${a.from} to ${a.to}</td><td class="n">${money(x.inOut)}</td><td class="n">${money(x.outOut)}</td><td class="n">${money(x.tin)}</td><td class="n">${money(x.tout)}</td><td class="n ${x.net < 0 ? "neg" : ""}">${money(x.net)}</td></tr>`; }).join("")}
    </table></div>`));
  view.querySelectorAll("[data-acct]").forEach((tr) => tr.addEventListener("click", () => { state.tx = { account: tr.dataset.acct }; saveState(); location.hash = "#/tx"; }));
}

function groups(rows, prev) {
  const isOut = (r) => M.OUT_KINDS.has(r.kind);
  const keyOf = (r) => r.kind === "other card" ? "Card purchases with no detail" : r.group;
  if (drill.group && drill.label) {
    const list = rows.filter((r) => isOut(r) && keyOf(r) === drill.group && r.label === drill.label);
    view.append(el(`<p><a href="#/groups" id="up">‹ ${esc(drill.group)}</a></p><h2>${esc(drill.label)}</h2>`));
    $("#up").addEventListener("click", (e) => { e.preventDefault(); drill.label = null; render(); });
    view.append(txTable(list));
    return;
  }
  if (drill.group) {
    const now = M.sumBy(rows, (r) => r.label, (r) => isOut(r) && keyOf(r) === drill.group);
    const before = M.sumBy(prev, (r) => r.label, (r) => isOut(r) && keyOf(r) === drill.group);
    view.append(el(`<p><a href="#/groups" id="up">‹ All spending</a></p><h2>${esc(drill.group)}: ${money(-[...now.values()].reduce((a, b) => a + b, 0))}</h2>`));
    $("#up").addEventListener("click", (e) => { e.preventDefault(); drill = { group: null, label: null }; render(); });
    const c = el(`<div class="card"></div>`).firstChild;
    c.append(hbars([...now].sort((a, b) => a[1] - b[1]).map(([l, v]) => ({ label: l, v: -v, prev: -(before.get(l) || 0) })), { onPick: (l) => { drill.label = l; render(); } }));
    view.append(c);
    return;
  }
  const now = M.sumBy(rows, keyOf, isOut), before = M.sumBy(prev, keyOf, isOut);
  const leak = new Set(["Unsorted", "People & payments", "Cash", "Checks", "Card purchases with no detail"]);
  view.append(el(`<h2>Spending, bills and loans by group</h2><p class="note">Thin grey bar: the same length of time before. Click a group to see its payees, then a payee for its transactions.</p>`));
  const c = el(`<div class="card"></div>`).firstChild;
  c.append(hbars([...now].sort((a, b) => a[1] - b[1]).map(([g, v]) => ({ label: g, v: -v, prev: -(before.get(g) || 0), cls: leak.has(g) ? "leak" : "" })), { onPick: (g) => { drill = { group: g, label: null }; render(); } }));
  view.append(c);
}

function trendView(rows, prev, p) {
  const size = state.bucket === "auto" ? M.bucketSize(p) : state.bucket;
  const groupsList = [...new Set(rows.filter((r) => M.OUT_KINDS.has(r.kind)).map((r) => r.group))].sort();
  view.append(el(`<div class="filters"><label>Step <select id="bk">${[["auto", "Automatic"], ["day", "Day"], ["week", "Week"], ["month", "Month"]].map(([k, l]) => `<option value="${k}" ${state.bucket === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label>Show <select id="gs"><option value="">Money in vs out</option>${groupsList.map((g) => `<option ${state.trendGroup === g ? "selected" : ""}>${esc(g)}</option>`).join("")}</select></label></div>`));
  $("#bk").addEventListener("change", (e) => { state.bucket = e.target.value; saveState(); render(); });
  $("#gs").addEventListener("change", (e) => { state.trendGroup = e.target.value; saveState(); render(); });
  const g = state.trendGroup && groupsList.includes(state.trendGroup) ? state.trendGroup : "";
  const data = M.trend(model, rows, p, size, g ? (r) => M.OUT_KINDS.has(r.kind) && r.group === g : null);
  const c = el(`<div class="card"></div>`).firstChild;
  c.append(bars(data, { sel: Boolean(g) }));
  view.append(c);
  view.append(el(`<div class="card"><table><tr><th>${size === "day" ? "Day" : size === "week" ? "Week of" : "Month"}</th>${g ? `<th class="n">${esc(g)}</th>` : `<th class="n">In</th><th class="n">Out</th><th class="n">Saved</th><th class="n">In − out</th>`}</tr>
    ${data.map((b) => `<tr><td>${b.key}</td>${g ? `<td class="n">${money(b.sel)}</td>` : `<td class="n">${money(b.in)}</td><td class="n">${money(b.out)}</td><td class="n">${money(b.saved)}</td><td class="n ${b.in - b.out < 0 ? "neg" : ""}">${money(b.in - b.out)}</td>`}</tr>`).join("")}</table></div>`));
}

function loop(rows) {
  const checked = rows.filter((r) => r.check);
  const by = new Map();
  for (const r of checked) {
    const d = r.to || "unknown";
    const x = by.get(d) || { verified: [0, 0], missing: [0, 0], unverified: [0, 0], rows: [] };
    x[r.check][0]++; x[r.check][1] += Math.abs(r.flow); x.rows.push(r); by.set(d, x);
  }
  view.append(el(`<h2>Did money that left arrive?</h2><p class="note">Each payment from an exported account to another account is looked for at the destination (same amount within four days).
    <b>Verified</b>: found there. <b>Missing</b>: the destination's data covers the date but the money isn't there; look into these. <b>Not yet checkable</b>: no data for the destination on that date.</p>`));
  const dests = [...by].sort((a, b) => (b[1].missing[1] - a[1].missing[1]) || (b[1].unverified[1] - a[1].unverified[1]));
  const cell = (x, k) => x[k][0] ? `${x[k][0]} · ${money(x[k][1])}` : "";
  view.append(el(`<div class="card"><table><tr><th>Destination</th><th class="n">Verified</th><th class="n">Missing</th><th class="n">Not yet checkable</th><th>What would close it</th></tr>
    ${dests.map(([d, x]) => { const a = model.accounts[d];
      const need = x.unverified[0] ? (d === "unknown" ? "Exports of the other USAA accounts (kids, savings)" : `${a?.exported ? "A longer export of" : "An export or statements of"} ${esc(a?.name || d)} covering ${x.rows.filter((r) => r.check === "unverified").map((r) => r.date).sort()[0]} to ${x.rows.filter((r) => r.check === "unverified").map((r) => r.date).sort().pop()}`) : "";
      return `<tr class="click" data-dest="${esc(d)}"><td><b>${esc(d === "unknown" ? "USAA transfers, destination unknown" : name(d))}</b><br><span class="note">${esc(a?.institution || "")}</span></td><td class="n pos">${cell(x, "verified")}</td><td class="n neg">${cell(x, "missing")}</td><td class="n">${cell(x, "unverified")}</td><td class="note">${need}</td></tr>`; }).join("")}
    </table></div>`));
  view.querySelectorAll("[data-dest]").forEach((tr) => tr.addEventListener("click", () => {
    const x = by.get(tr.dataset.dest); const h = el(`<h2>${esc(name(tr.dataset.dest))}</h2>`); $("#loopdetail")?.remove();
    const box = document.createElement("div"); box.id = "loopdetail"; box.append(h, txTable(x.rows, true)); view.append(box); box.scrollIntoView({ behavior: "smooth" });
  }));
}

function watchView(rows, prev, p) {
  const items = M.watch(model, rows, prev, p);
  view.append(el(`<h2>Things to look at</h2><p class="note">Spending that can't be seen, has no payee, is new, or is up on the period before.</p>`));
  if (!items.length) { view.append(el(`<p class="note">Nothing stands out in this period.</p>`)); return; }
  view.append(el(`<p class="note">Tap a row to see its transactions.</p>`));
  for (const it of items) {
    const card = el(`<div class="card"><table><tr><th>${esc(it.title)}<br><span class="note">${esc(it.why)}</span></th><th class="n">${money(it.v)}</th></tr>
      ${it.top.map((x, i) => `<tr class="click" data-i="${i}"><td>${esc(x.label)}</td><td class="n">${money(x.v)}</td></tr>`).join("")}</table>
      <p class="note"><a href="#" class="all">Show all ${it.rows.length} transaction${it.rows.length === 1 ? "" : "s"}</a></p></div>`).firstChild;
    card.querySelectorAll("tr[data-i]").forEach((tr) => tr.addEventListener("click", () => {
      const x = it.top[Number(tr.dataset.i)];
      showDetail(card, x.label, x.rows);
    }));
    card.querySelector(".all").addEventListener("click", (e) => { e.preventDefault(); showDetail(card, it.title, it.rows); });
    view.append(card, el(`<p></p>`));
  }
}

// ---------- recategorising ----------
// A change is written to meta/money/overrides.csv in the repo (the model workflow then rebuilds
// model.json); until that rebuild arrives the change is kept on this device and applied on load.
const EDITABLE = new Set(["spend", "debt", "income", "other card"]);
const PENDING = "money:overrides";
const isIncome = (r) => r.kind === "income";
function groupOptions(r) {
  const same = new Set(model.tx.filter((t) => EDITABLE.has(t.kind) && isIncome(t) === isIncome(r)).map((t) => t.group));
  return [...same].sort();
}
function pending() { try { return JSON.parse(localStorage.getItem(PENDING) || "{}"); } catch { return {}; } }
function applyPending(m) {
  const ov = pending();
  for (const r of m.tx) {
    const o = ov[r.key] || ov[`label:${r.label}`];
    if (o && EDITABLE.has(r.kind)) r.group = o.group;
  }
}
async function recategorise(r, group, allFromPayee) {
  const key = allFromPayee ? `label:${r.label}` : r.key;
  const ov = pending(); ov[key] = { group, at: new Date().toISOString() };
  try { localStorage.setItem(PENDING, JSON.stringify(ov)); } catch { /* fine */ }
  applyPending(model);
  statusEl.textContent = "Saving…";
  try {
    const path = "meta/money/overrides.csv";
    const { text, sha } = await readFile(path);
    const lines = (text || "key,group,label,set_on,note\n").replace(/\n*$/, "\n").split("\n").filter(Boolean);
    const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const kept = lines.filter((l, i) => i === 0 || !l.startsWith(csvCell(key) + ","));
    kept.push([key, group, "", new Date().toISOString().slice(0, 10), allFromPayee ? "all from this payee" : `${r.date} ${money(r.flow)}`].map(csvCell).join(","));
    await writeFile(path, kept.join("\n") + "\n", sha, `Money: ${allFromPayee ? `all "${r.label}"` : `${r.label} ${r.date}`} -> ${group} (dashboard)`);
    statusEl.textContent = `Saved: ${r.label} → ${group}. The model rebuilds in a minute or two.`;
  } catch (err) {
    statusEl.textContent = `${err.message} The change shows on this device only.`;
  }
  render();
}

function txTable(list, showCheck = false) {
  const sorted = [...list].sort((a, b) => (a.date < b.date ? 1 : -1));
  const total = list.reduce((a, r) => a + r.flow, 0);
  const shown = sorted.slice(0, 500);
  const byKey = new Map(shown.map((r) => [r.key, r]));
  const groupCell = (r) => {
    if (r.kind === "internal") return esc(`transfer${r.pair && r.pair !== "?" ? ` ↔ ${name(r.pair)}` : ""}`);
    if (!EDITABLE.has(r.kind) || !r.key) return esc(r.group);
    const opts = groupOptions(r);
    return `<select class="regroup" data-key="${esc(r.key)}" aria-label="Group">${opts.map((g) => `<option ${g === r.group ? "selected" : ""}>${esc(g)}</option>`).join("")}<option value="__new">New group…</option></select>`;
  };
  const box = el(`<div class="card"><p class="note">${list.length} transactions, net ${money(total)}${list.length > 500 ? " (newest 500 shown)" : ""}. Change a group with its dropdown.</p><table><tr><th>Date</th><th>Account</th><th>Payee</th><th>Group</th>${showCheck ? "<th>Check</th>" : ""}<th class="n">Amount</th></tr>
    ${shown.map((r) => `<tr><td>${r.date}</td><td>${esc(name(r.account))}</td><td>${esc(r.label)}<br><span class="note">${esc(r.desc)}</span></td><td>${groupCell(r)}</td>${showCheck ? `<td><span class="tag ${r.check}">${esc(r.check || "")}</span></td>` : ""}<td class="n ${r.flow < 0 ? "" : "pos"}">${money(r.flow)}</td></tr>`).join("")}</table></div>`);
  box.addEventListener("change", (ev) => {
    const sel = ev.target.closest("select.regroup"); if (!sel) return;
    const r = byKey.get(sel.dataset.key); if (!r) return;
    let group = sel.value;
    if (group === "__new") { group = (prompt("Name of the new group:") || "").trim(); if (!group) { sel.value = r.group; return; } }
    if (group === r.group) return;
    const others = model.tx.filter((t) => t.label === r.label && t.key !== r.key && EDITABLE.has(t.kind)).length;
    const all = others > 0 && confirm(`Move all ${others + 1} "${r.label}" transactions to ${group}?\n\nOK = all of them (now and in future), Cancel = just this one.`);
    recategorise(r, group, all);
  });
  return box;
}

function txView(rows) {
  const f = state.tx || {};
  const accts = [...new Set(model.tx.map((r) => r.account))];
  const kinds = [...new Set(model.tx.map((r) => r.kind))].sort();
  const grps = [...new Set(model.tx.map((r) => r.group))].sort();
  view.append(el(`<div class="filters"><input id="q" type="search" placeholder="Search payee or description" value="${esc(f.q || "")}">
    <select id="fa"><option value="">All accounts</option>${accts.map((a) => `<option value="${esc(a)}" ${f.account === a ? "selected" : ""}>${esc(name(a))}</option>`).join("")}</select>
    <select id="fk"><option value="">All kinds</option>${kinds.map((k) => `<option ${f.kind === k ? "selected" : ""}>${esc(k)}</option>`).join("")}</select>
    <select id="fg"><option value="">All groups</option>${grps.map((g) => `<option ${f.group === g ? "selected" : ""}>${esc(g)}</option>`).join("")}</select></div><div id="txl"></div>`));
  const apply = () => {
    state.tx = { q: $("#q").value, account: $("#fa").value, kind: $("#fk").value, group: $("#fg").value }; saveState();
    const q = state.tx.q.toLowerCase();
    const list = rows.filter((r) => (!state.tx.account || r.account === state.tx.account) && (!state.tx.kind || r.kind === state.tx.kind)
      && (!state.tx.group || r.group === state.tx.group) && (!q || `${r.label} ${r.desc}`.toLowerCase().includes(q)));
    $("#txl").replaceChildren(txTable(list));
  };
  ["q", "fa", "fk", "fg"].forEach((id) => $(`#${id}`).addEventListener(id === "q" ? "input" : "change", apply));
  apply();
}

function settings() {
  const s = loadSettings();
  view.append(el(`<h2>Settings</h2>
    <form class="settings card" id="sf">
      <p class="note">This page has no data of its own. It reads <code>${esc(s.path)}</code> from your private repo through GitHub's API with a token kept only in this browser.</p>
      <label>GitHub token</label><input name="token" type="password" autocomplete="off" placeholder="github_pat_…" value="${esc(s.token)}">
      <p class="note">Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>: Only select repositories → <b>${esc(s.repo)}</b> → Repository permissions → <b>Contents: Read-only</b> to view, or <b>Read and write</b> to change groups from the dropdowns. Set an expiry you're happy with.</p>
      <label>Owner</label><input name="owner" value="${esc(s.owner)}">
      <label>Repository</label><input name="repo" value="${esc(s.repo)}">
      <label>Branch</label><input name="branch" value="${esc(s.branch)}">
      <label>Data file</label><input name="path" value="${esc(s.path)}">
      <p><button class="btn primary" type="submit">Save and load</button> <button class="btn" type="button" id="forget">Forget token and cached data</button></p>
      <div id="smsg"></div>
      <p class="note">Version ${APP_VERSION}</p>
    </form>`));
  $("#sf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    saveSettings({ ...DEFAULTS, ...Object.fromEntries([...f].map(([k, v]) => [k, String(v).trim()])) });
    await load(true);
    $("#smsg").innerHTML = model ? `<div class="msg">Loaded ${model.tx.length.toLocaleString()} transactions (${model.from} to ${model.to}).</div>` : "";
  });
  $("#forget").addEventListener("click", () => { try { localStorage.removeItem("money:settings"); localStorage.removeItem("money:model"); } catch { /* fine */ } model = null; render(); });
}

// ---------- routing ----------
// ---------- balances ----------
const usd = (v) => `${v < 0 ? "−" : ""}$${Math.round(Math.abs(v)).toLocaleString()}`;
function balancesView(rows, prev, p) {
  const ids = M.balanceIds(model);
  if (!ids.length) { view.append(el(`<div class="msg">No balances yet. They arrive with the next SimpleFIN sync (daily).</div>`)); return; }
  const start = M.addDays(p.from, -1), end = p.to < model.to ? p.to : model.to; // never past the data
  const cls = (id) => M.BALANCE_CLASS[model.accounts[id].type] || "Other";
  const info = ids.map((id) => ({ id, cls: cls(id), now: M.balanceAt(model, id, end), was: M.balanceAt(model, id, start) }));
  const order = ["Cash", "Investments", "Owed", "Other"];
  const tot = (c) => info.filter((a) => (!c || a.cls === c) && a.now).reduce((s, a) => s + a.now.v, 0);
  // Change counts only accounts known on both dates.
  const chg = (c) => info.filter((a) => (!c || a.cls === c) && a.now && a.was).reduce((s, a) => s + a.now.v - a.was.v, 0);
  const known = (c) => info.some((a) => (!c || a.cls === c) && a.now && a.was);
  const kpi = (label, c, goodUp, flip = false) => {
    const v = flip ? -tot(c) : tot(c), d = flip ? -chg(c) : chg(c);
    return `<div class="kpi"><span>${label}</span><b>${usd(v)}</b>${known(c) ? `<span class="d ${Math.abs(d) < 1 ? "" : (d > 0) === goodUp ? "pos" : "neg"}">${d >= 0 ? "+" : "−"}${usd(Math.abs(d))} in period</span>` : `<span class="d">change not known yet</span>`}</div>`;
  };
  view.append(el(`<h2>Balances on ${fmtDate(end)}</h2>
    <div class="kpis">${kpi("Cash (checking and savings)", "Cash", true)}${kpi("Investments", "Investments", true)}${kpi("Owed (cards and loans)", "Owed", false, true)}${kpi("Net worth", "", true)}</div>
    <p class="note">Change is against ${fmtDate(start)}, the day before the period starts. Checking, savings and card balances marked "estimated" are worked back from the transactions; investments and loans show the balance SimpleFIN last reported on or before the date (recorded daily from 2026-11-06).${Object.entries(model.estimates || {}).filter(([id]) => ids.includes(id)).map(([id, e]) => ` ${esc(name(id))} is an estimate: the balance on ${fmtDate(e.basis)} from ${esc(e.source)}, less the repayments since, with interest.`).join("")}</p>`));

  // Chart: one line, all cash or a chosen account.
  const pick = state.balPick && (state.balPick === "cash" || ids.includes(state.balPick)) ? state.balPick : "cash";
  const opts = [["cash", "All cash (checking and savings)"], ...ids.map((id) => [id, name(id)])];
  view.append(el(`<div class="filters"><label>Show <select id="bp">${opts.map(([k, l]) => `<option value="${esc(k)}" ${pick === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label></div>`));
  $("#bp").addEventListener("change", (e) => { state.balPick = e.target.value; saveState(); render(); });
  const at = (d) => {
    if (pick !== "cash") { const x = M.balanceAt(model, pick, d); return x ? x.v : null; }
    const xs = info.filter((a) => a.cls === "Cash").map((a) => M.balanceAt(model, a.id, d));
    return xs.some((x) => x) ? xs.reduce((s, x) => s + (x ? x.v : 0), 0) : null;
  };
  const n = M.days(start, end), step = Math.max(1, Math.ceil(n / 370)), pts = [];
  for (let i = 0; i < n; i += step) { const d = M.addDays(start, i); pts.push({ d, v: at(d) }); }
  if (pts[pts.length - 1].d !== end) pts.push({ d: end, v: at(end) });
  const c = el(`<div class="card"></div>`).firstChild;
  c.append(line(pts, { label: pick === "cash" ? "Cash" : name(pick) }));
  view.append(c);

  // Table by class.
  const body = order.filter((k) => info.some((a) => a.cls === k)).map((k) => {
    const list = info.filter((a) => a.cls === k).sort((a, b) => Math.abs(b.now?.v || 0) - Math.abs(a.now?.v || 0));
    return `<tr><th colspan="3">${k}</th></tr>` + list.map((a) => {
      const ch = a.now && a.was ? a.now.v - a.was.v : null;
      const e = model.estimates?.[a.id];
      const asOf = !a.now ? "not known" : e ? `estimate from<br>${e.basis.slice(5).replace("-", "/")}/${e.basis.slice(2, 4)} balance`
        : a.now.est ? "estimated" : a.now.asOf === end ? "reported" : `as of ${a.now.asOf.slice(5).replace("-", "/")}`;
      const chs = ch === null ? "–" : `${ch >= 0 ? "+" : "−"}$${Math.round(Math.abs(ch)).toLocaleString()}`;
      return `<tr class="click" data-acct="${esc(a.id)}"><td><b>${esc(name(a.id))}</b><br><span class="note">${esc(model.accounts[a.id].institution || "")}</span></td><td class="n">${a.now ? usd(a.now.v) : "–"}<br><span class="est">${asOf}</span></td><td class="n ${ch === null || Math.abs(ch) < 1 ? "" : ch < 0 ? "neg" : "pos"}">${chs}</td></tr>`;
    }).join("");
  }).join("");
  view.append(el(`<h2>Each account</h2><div class="card"><table><tr><th>Account</th><th class="n">Balance</th><th class="n">Change</th></tr>${body}</table></div>`));
  view.querySelectorAll("[data-acct]").forEach((tr) => tr.addEventListener("click", () => { state.tx = { account: tr.dataset.acct }; saveState(); location.hash = "#/tx"; }));
  const missing = Object.values(model.accounts).filter((a) => !ids.includes(a.id) && a.to && a.to >= M.addDays(model.to, -60));
  if (missing.length) view.append(el(`<p class="note">No balance from SimpleFIN for: ${missing.map((a) => esc(name(a.id))).join(", ")}.</p>`));
}

const VIEWS = { overview, balances: balancesView, accounts, groups, trend: trendView, loop, watch: watchView, tx: txView, settings };
function render() {
  const route = (location.hash.replace(/^#\//, "") || "overview").split("?")[0];
  const v = VIEWS[route] ? route : "overview";
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === v));
  view.replaceChildren();
  if (v !== "groups") drill = { group: null, label: null };
  renderPeriod();
  if (v === "settings" || !model) {
    if (!model && v !== "settings") view.append(el(`<div class="msg">${isConfigured() ? "Loading…" : 'No data yet. Open <a href="#/settings">Settings</a> and add your GitHub token.'}</div>`));
    if (v === "settings") settings();
    return;
  }
  const p = currentPeriod(), rows = M.inPeriod(model, p), prev = M.inPeriod(model, M.previous(p));
  VIEWS[v](rows, prev, p);
}

async function load(force = false) {
  if (!model || force) {
    const c = cachedModel();
    if (c && !model) { model = M.prepare(c); applyPending(model); statusEl.textContent = `Data to ${model.to} (cached)`; render(); }
  }
  if (!isConfigured()) { render(); return; }
  statusEl.textContent = "Loading…";
  try {
    model = M.prepare(await fetchModel());
    // Forget local changes the rebuilt model already carries, then apply any still waiting.
    const ov = pending();
    for (const [k, o] of Object.entries(ov)) {
      const hit = model.tx.filter((r) => (k.startsWith("label:") ? `label:${r.label}` : r.key) === k);
      if (hit.length && hit.every((r) => r.group === o.group)) delete ov[k];
    }
    try { localStorage.setItem(PENDING, JSON.stringify(ov)); } catch { /* fine */ }
    applyPending(model);
    statusEl.textContent = `Data to ${model.to} · built ${model.generated.slice(0, 10)}`;
  } catch (err) {
    statusEl.textContent = err.message;
  }
  render();
}

window.addEventListener("hashchange", render);
// A tab link to the page already shown fires no hashchange (e.g. Spending while drilled into a
// group), so reset that page here.
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="#/"]');
  if (!a || e.defaultPrevented || a.getAttribute("href") !== location.hash) return;
  e.preventDefault();
  drill = { group: null, label: null };
  render();
});
$("#refresh").addEventListener("click", () => load(true));
load();
