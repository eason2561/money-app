// Period maths and aggregation over the money model (assets/financial/money/model.json,
// written by ./money --publish). Kinds: income, spend, debt, other card (paid to a card whose
// purchases aren't itemised), saving, internal (between exported accounts), unmatched transfer.

export const OUT_KINDS = new Set(["spend", "debt", "other card"]);
export const SAVE_KINDS = new Set(["saving", "unmatched transfer"]);

export function prepare(raw) {
  const f = raw.fields;
  const ix = Object.fromEntries(f.map((n, i) => [n, i]));
  const tx = raw.tx.map((t, i) => ({
    i, date: t[ix.date], account: t[ix.account], flow: t[ix.flow], kind: t[ix.kind],
    group: t[ix.group], label: t[ix.label], pair: t[ix.pair], desc: t[ix.description],
    to: ix.to === undefined ? "" : t[ix.to], check: ix.check === undefined ? "" : t[ix.check],
    key: ix.key === undefined ? "" : t[ix.key] }));
  const accounts = Object.fromEntries(raw.accounts.map((a) => [a.id, a]));
  // First and last month each label appears in, for "new payee" and "one-off" checks.
  const seen = {};
  for (const t of tx) {
    const s = (seen[t.label] ||= { first: t.date, last: t.date, months: new Set() });
    if (t.date < s.first) s.first = t.date;
    if (t.date > s.last) s.last = t.date;
    s.months.add(t.date.slice(0, 7));
  }
  return { ...raw, tx, accounts, seen };
}

// ---- dates (ISO strings, local calendar, no time zones) ----
const pad = (n) => String(n).padStart(2, "0");
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
export const days = (a, b) => Math.round((parse(b) - parse(a)) / 86400000) + 1;

export const SCALES = [
  ["week", "Week"], ["2weeks", "2 weeks"], ["month", "Month"], ["quarter", "Quarter"],
  ["year", "12 months"], ["all", "All"], ["custom", "Custom"]];

// The period of a given scale that contains `anchor`.
export function period(scale, anchor, model, custom) {
  const d = parse(anchor);
  if (scale === "week" || scale === "2weeks") {
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    const end = addDays(anchor, 6 - dow);
    return { from: addDays(end, scale === "week" ? -6 : -13), to: end };
  }
  if (scale === "month") return { from: iso(new Date(d.getFullYear(), d.getMonth(), 1)), to: iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
  if (scale === "quarter") {
    const q = Math.floor(d.getMonth() / 3) * 3;
    return { from: iso(new Date(d.getFullYear(), q, 1)), to: iso(new Date(d.getFullYear(), q + 3, 0)) };
  }
  if (scale === "year") return { from: addDays(iso(new Date(d.getFullYear() - 1, d.getMonth(), d.getDate())), 1), to: anchor };
  if (scale === "custom" && custom?.from && custom?.to) return { from: custom.from, to: custom.to };
  return { from: model.from, to: model.to };
}

export function shift(scale, p, dir) {
  if (scale === "all" || scale === "custom") {
    const n = days(p.from, p.to);
    return dir < 0 ? { from: addDays(p.from, -n), to: addDays(p.from, -1) } : { from: addDays(p.to, 1), to: addDays(p.to, n) };
  }
  return { anchor: dir < 0 ? addDays(p.from, -1) : addDays(p.to, 1) };
}

export function previous(p) {
  const n = days(p.from, p.to);
  return { from: addDays(p.from, -n), to: addDays(p.from, -1) };
}

export const inPeriod = (model, p) => model.tx.filter((t) => t.date >= p.from && t.date <= p.to);

// ---- household totals ----
export function totals(model, rows) {
  let income = 0, out = 0, saved = 0;
  const growth = {}, payroll = {};
  for (const t of rows) {
    if (t.kind === "income") income += t.flow;
    else if (OUT_KINDS.has(t.kind)) out -= t.flow;
    else if (SAVE_KINDS.has(t.kind)) saved -= t.flow;
    else if (t.kind === "payroll") payroll[t.label] = (payroll[t.label] || 0) + t.flow;
    const type = model.accounts[t.account]?.type;
    // Outside accounts' own records (kind external) only confirm the bank side; never count them.
    if (type === "savings" && t.kind !== "external" && t.kind !== "payroll") growth[t.account] = (growth[t.account] || 0) + t.flow;
  }
  const kept = Object.values(growth).reduce((a, b) => a + b, 0);
  return { income, out, savedOut: saved, kept, saved: saved + kept, buffer: income - out - saved - kept, payroll };
}

export function sumBy(rows, keyFn, pred = () => true) {
  const m = new Map();
  for (const t of rows) if (pred(t)) { const k = keyFn(t); m.set(k, (m.get(k) || 0) + t.flow); }
  return m;
}

// ---- flows between accounts ----
// Edges: from -> to with amounts. Nodes are exported account ids plus outside nodes.
export const OUTSIDE_IN = "Income";
export const OUTSIDE_OUT = "Spending & bills";
export function accountFlows(model, rows) {
  const edges = new Map();
  const add = (a, b, v) => { if (v <= 0) return; const k = `${a}\u0000${b}`; edges.set(k, (edges.get(k) || 0) + v); };
  for (const t of rows) {
    if (t.kind === "income") add(OUTSIDE_IN, t.account, t.flow);
    else if (t.kind === "spend" || t.kind === "debt") add(t.account, OUTSIDE_OUT, -t.flow);
    else if (t.kind === "other card") add(t.account, `${t.group} (no detail)`, -t.flow);
    else if (t.kind === "saving") add(t.account, t.label, -t.flow);
    else if (t.kind === "unmatched transfer") {
      if (t.flow < 0) add(t.account, "Accounts not exported", -t.flow);
      else add("Accounts not exported", t.account, t.flow);
    } else if (t.kind === "internal" && t.flow < 0 && t.pair && t.pair !== "?") add(t.account, t.pair, -t.flow);
    else if (t.kind === "internal" && t.flow > 0 && t.pair === "?") add("Accounts not exported", t.account, t.flow);
  }
  return [...edges].map(([k, v]) => { const [from, to] = k.split("\u0000"); return { from, to, v }; });
}

// ---- trend buckets ----
export function bucketSize(p) {
  const n = days(p.from, p.to);
  return n <= 31 ? "day" : n <= 120 ? "week" : "month";
}
export function bucketKey(date, size) {
  if (size === "day") return date;
  if (size === "month") return date.slice(0, 7);
  const d = parse(date); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return iso(d);
}
export function trend(model, rows, p, size, pred) {
  const keys = [];
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) { const k = bucketKey(d, size); if (keys[keys.length - 1] !== k) keys.push(k); }
  const b = Object.fromEntries(keys.map((k) => [k, { in: 0, out: 0, saved: 0, sel: 0 }]));
  for (const t of rows) {
    const x = b[bucketKey(t.date, size)]; if (!x) continue;
    if (t.kind === "income") x.in += t.flow;
    else if (OUT_KINDS.has(t.kind)) x.out -= t.flow;
    else if (SAVE_KINDS.has(t.kind)) x.saved -= t.flow;
    if (pred && pred(t)) x.sel -= t.flow;
  }
  return keys.map((k) => ({ key: k, ...b[k] }));
}

// ---- things to look at ----
const SUBS = /Netflix|Disney|YouTube|Spotify|Hulu|Paramount|Peacock|New York Times|NYTIMES|Patreon|Masterclass|CLAUDE\.AI|Anthropic|Khanacademy|Audible|Kindle|Steam|Roblox|Xbox|PlayStation|Oculus|Nintendo|Apple\.com|Google Play/i;
export function watch(model, rows, prevRows, p) {
  const items = [];
  // "New" and "up" only mean something when there is data from before this period.
  const history = p && p.from > addDays(model.from, 30);
  const sum = (rs) => -rs.reduce((a, t) => a + t.flow, 0);
  const list = (rs, n = 6) => {
    const m = sumBy(rs, (t) => t.label);
    return [...m].sort((a, b) => a[1] - b[1]).slice(0, n).map(([l, v]) => ({ label: l, v: -v }));
  };
  const pick = (f) => rows.filter(f);
  const oc = pick((t) => t.kind === "other card");
  if (oc.length) items.push({ title: "Card purchases with no detail", v: sum(oc), why: "Paid to a card whose purchases aren't exported for these dates (mostly the Amazon card).", top: list(oc) });
  const uns = pick((t) => t.group === "Unsorted");
  if (uns.length) items.push({ title: "Not yet sorted", v: sum(uns), why: "Payees with no rule yet; a rule in meta/money/rules.csv sorts them.", top: list(uns) });
  const ppl = pick((t) => t.group === "People & payments");
  if (ppl.length) items.push({ title: "Venmo, Zelle and PayPal", v: sum(ppl), why: "Payments to people; no detail of what for.", top: list(ppl) });
  const cash = pick((t) => t.group === "Cash" || t.group === "Checks");
  if (cash.length) items.push({ title: "Cash and checks", v: sum(cash), why: "Money that leaves without a payee.", top: list(cash) });
  const subs = pick((t) => t.kind === "spend" && t.flow < 0 && SUBS.test(`${t.label} ${t.desc}`));
  if (subs.length) items.push({ title: "Subscriptions, games and apps", v: sum(subs), why: "Small repeating charges add up.", top: list(subs, 10) });
  const fresh = history ? pick((t) => OUT_KINDS.has(t.kind) && t.flow < 0 && model.seen[t.label]?.first >= p.from) : [];
  if (fresh.length) items.push({ title: "New payees this period", v: sum(fresh), why: "First time these appear in the data.", top: list(fresh, 10) });
  const big = pick((t) => t.kind === "spend" && t.flow <= -300 && (model.seen[t.label]?.months.size || 0) <= 2);
  if (big.length) items.push({ title: "Large one-off purchases", v: sum(big), why: "$300 or more to a payee seen in two months or fewer.", top: big.sort((a, b) => a.flow - b.flow).slice(0, 10).map((t) => ({ label: `${t.date} ${t.label}`, v: -t.flow })) });
  if (history && prevRows.length && M_prevCovered(model, p)) {
    const now = sumBy(rows, (t) => t.group, (t) => t.kind === "spend");
    const before = sumBy(prevRows, (t) => t.group, (t) => t.kind === "spend");
    const up = [...now].map(([g, v]) => ({ label: g, v: -v, prev: -(before.get(g) || 0) }))
      .filter((x) => x.v - x.prev > 100 && x.v > x.prev * 1.25).sort((a, b) => (b.v - b.prev) - (a.v - a.prev));
    if (up.length) items.push({ title: "Up on the period before", v: up.reduce((a, x) => a + x.v - x.prev, 0), why: "Groups more than 25% and $100 above the same length of time before.", top: up.slice(0, 8).map((x) => ({ label: `${x.label} (was ${Math.round(x.prev).toLocaleString()})`, v: x.v - x.prev })) });
  }
  return items.sort((a, b) => b.v - a.v);
}

function M_prevCovered(model, p) { return previous(p).from >= model.from; }
