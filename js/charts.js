// Plain SVG charts (no library, no inline styles: colours are SVG attributes or CSS classes).

export const money = (v) => {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  return a >= 10000 ? `${s}$${(a / 1000).toFixed(1)}k` : `${s}$${Math.round(a).toLocaleString()}`;
};
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function wrap(svg, onPick, onBand, bandEdges) {
  const w = document.createElement("div");
  w.className = "chart-wrap";
  w.innerHTML = svg;
  if (onPick || onBand) w.addEventListener("click", (ev) => {
    const band = ev.target.closest("[data-band]")?.dataset.band;
    if (band !== undefined && onBand) { onBand(bandEdges[Number(band)]); return; }
    const id = ev.target.closest("[data-pick]")?.dataset.pick;
    if (id && onPick) onPick(id);
  });
  return w;
}

// Layered flow diagram. columns: [[{id, label, cls}]]; edges: [{from, to, v}] between adjacent columns.
// Node ids must be unique per column; the same id may appear in two columns (e.g. from/to accounts).
export function sankey(columns, edges, { width = 960, minH = 300, onPick, onBand } = {}) {
  const key = (ci, id) => `${ci}\u0000${id}`;
  const outV = new Map(), inV = new Map();
  for (const e of edges) {
    outV.set(key(e.c, e.from), (outV.get(key(e.c, e.from)) || 0) + e.v);
    inV.set(key(e.c + 1, e.to), (inV.get(key(e.c + 1, e.to)) || 0) + e.v);
  }
  const nodeV = (ci, id) => Math.max(outV.get(key(ci, id)) || 0, inV.get(key(ci, id)) || 0);
  columns = columns.map((c, ci) => c.filter((n) => nodeV(ci, n.id) > 0.5));
  const gap = 8, nw = 14, padT = 20, padB = 10;
  const maxN = Math.max(1, ...columns.map((c) => c.length));
  const height = Math.max(minH, maxN * 17 + padT + padB + 20);
  const colTot = columns.map((c, ci) => c.reduce((a, n) => a + nodeV(ci, n.id), 0));
  const scale = Math.min(...columns.map((c, i) => (height - padT - padB - gap * Math.max(c.length - 1, 0)) / (colTot[i] || 1)));
  const textW = (c, ci) => Math.min(280, 14 + 6.4 * Math.max(0, ...c.map((n) => `${n.label} ${money(nodeV(ci, n.id))}`.length)));
  const leftW = textW(columns[0] || [], 0), rightW = textW(columns[columns.length - 1] || [], columns.length - 1);
  const xs = columns.map((_, i) => leftW + i * ((width - leftW - rightW - nw) / Math.max(columns.length - 1, 1)));
  const pos = new Map();
  columns.forEach((c, ci) => {
    const h = c.reduce((a, n) => a + nodeV(ci, n.id) * scale, 0) + gap * Math.max(c.length - 1, 0);
    let y = padT + (height - padT - padB - h) / 2;
    for (const n of c) {
      const hh = Math.max(nodeV(ci, n.id) * scale, 2);
      pos.set(key(ci, n.id), { x: xs[ci], y, h: hh, oy: y, iy: y, n, ci, v: nodeV(ci, n.id) });
      y += hh + gap;
    }
  });
  const p = [""];
  // Draw bands in node order so they stack cleanly at both ends.
  const order = (ci) => new Map(columns[ci]?.map((n, i) => [n.id, i]) || []);
  const es = [...edges].filter((e) => pos.has(key(e.c, e.from)) && pos.has(key(e.c + 1, e.to)));
  es.sort((a, b) => a.c - b.c || order(a.c).get(a.from) - order(a.c).get(b.from) || order(a.c + 1).get(a.to) - order(a.c + 1).get(b.to));
  const inOrder = [...es].sort((a, b) => a.c - b.c || order(a.c + 1).get(a.to) - order(a.c + 1).get(b.to) || order(a.c).get(a.from) - order(a.c).get(b.from));
  const y1s = new Map();
  for (const e of inOrder) { const b = pos.get(key(e.c + 1, e.to)); y1s.set(e, b.iy); b.iy += e.v * scale; }
  for (const e of es) {
    const a = pos.get(key(e.c, e.from)), b = pos.get(key(e.c + 1, e.to));
    const h = Math.max(e.v * scale, 0.5), x0 = a.x + nw, x1 = b.x, c = (x0 + x1) / 2, y0 = a.oy, y1 = y1s.get(e);
    a.oy += e.v * scale;
    p.push(`<path class="band ${e.cls || b.n.cls || a.n.cls || ""}${onBand ? " pickable" : ""}" data-band="${edges.indexOf(e)}" d="M${x0},${y0} C${c},${y0} ${c},${y1} ${x1},${y1} L${x1},${y1 + h} C${c},${y1 + h} ${c},${y0 + h} ${x0},${y0 + h} Z"><title>${esc(a.n.label)} → ${esc(b.n.label)}: ${money(e.v)}</title></path>`);
  }
  const lastY = new Map();
  let maxY = height;
  for (const q of pos.values()) {
    const last = q.ci === columns.length - 1, first = q.ci === 0;
    p.push(`<rect class="node ${q.n.cls || ""}" x="${q.x}" y="${q.y}" width="${nw}" height="${Math.max(q.h, 1)}" data-pick="${esc(q.n.id)}"><title>${esc(q.n.label)}: ${money(q.v)}</title></rect>`);
    const tx = first ? q.x - 6 : q.x + nw + 6;
    const anchor = first ? "end" : "start";
    // Keep labels in a column at least 13px apart so small nodes don't overprint.
    const ty = Math.max(q.y + q.h / 2 + 4, (lastY.get(q.ci) ?? -99) + 13);
    lastY.set(q.ci, ty);
    maxY = Math.max(maxY, ty + 6);
    const halo = !first && !last ? " halo" : "";
    p.push(`<text x="${tx}" y="${ty}" text-anchor="${anchor}" class="lbl${halo}" data-pick="${esc(q.n.id)}">${esc(q.n.label)} <tspan class="num">${money(q.v)}</tspan></text>`);
  }
  p[0] = `<svg viewBox="0 0 ${width} ${Math.ceil(maxY)}" class="chart sankey" role="img" aria-label="Flow diagram">`;
  p.push("</svg>");
  return wrap(p.join(""), onPick, onBand, edges);
}

// Paired bars per bucket (in vs out, net below), or one series when `sel` is set.
export function bars(buckets, { width = 960, height = 240, sel = false } = {}) {
  const padL = 52, padB = 34, padT = 10;
  const max = Math.max(1, ...buckets.map((b) => (sel ? b.sel : Math.max(b.in, b.out))));
  const bw = (width - padL - 10) / Math.max(buckets.length, 1);
  const y = (v) => height - padB - (Math.max(v, 0) / max) * (height - padB - padT);
  const p = [`<svg viewBox="0 0 ${width} ${height}" class="chart bars" role="img" aria-label="Money over time">`];
  for (const f of [0, 0.5, 1]) p.push(`<line class="grid" x1="${padL}" x2="${width - 10}" y1="${y(max * f)}" y2="${y(max * f)}"/><text class="tick" x="${padL - 6}" y="${y(max * f) + 4}" text-anchor="end">${money(max * f)}</text>`);
  const every = Math.ceil(buckets.length / 13);
  buckets.forEach((b, i) => {
    const x = padL + i * bw;
    if (sel) {
      p.push(`<rect class="sel" x="${x + 2}" y="${y(b.sel)}" width="${Math.max(bw - 4, 1)}" height="${height - padB - y(b.sel)}"><title>${b.key}: ${money(b.sel)}</title></rect>`);
    } else {
      const w = Math.max(bw / 2 - 2, 1);
      p.push(`<rect class="in" x="${x + 1}" y="${y(b.in)}" width="${w}" height="${height - padB - y(b.in)}"><title>${b.key} in ${money(b.in)}</title></rect>`);
      p.push(`<rect class="out" x="${x + 2 + w}" y="${y(b.out)}" width="${w}" height="${height - padB - y(b.out)}"><title>${b.key} out ${money(b.out)}</title></rect>`);
    }
    if (i % every === 0) {
      p.push(`<text class="tick" x="${x + bw / 2}" y="${height - padB + 14}" text-anchor="middle">${b.key.length === 7 ? b.key.slice(2) : b.key.slice(5)}</text>`);
      if (!sel) { const net = b.in - b.out; p.push(`<text class="tick ${net < 0 ? "neg" : ""}" x="${x + bw / 2}" y="${height - 4}" text-anchor="middle">${net < 0 ? "−" : "+"}${money(Math.abs(net))}</text>`); }
    }
  });
  p.push("</svg>");
  return wrap(p.join(""));
}

// Horizontal bars: rows [{label, v, prev?, cls?}]; click a row to pick it.
export function hbars(rows, { width = 960, onPick } = {}) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.v, r.prev || 0)));
  const rowH = 26, labelW = 240, numW = 140, bw = width - labelW - numW, h = rows.length * rowH + 6;
  const p = [`<svg viewBox="0 0 ${width} ${h}" class="chart hbars" role="img" aria-label="Amounts">`];
  rows.forEach((r, i) => {
    const y = i * rowH + 4;
    const lab = r.label.length > 36 ? `${r.label.slice(0, 35)}…` : r.label;
    p.push(`<g data-pick="${esc(r.label)}" class="${onPick ? "pickable" : ""}"><rect class="hit" x="0" y="${y}" width="${width}" height="${rowH - 2}"/><text class="lbl" x="${labelW - 8}" y="${y + 14}" text-anchor="end">${esc(lab)}</text>`);
    if (r.prev !== undefined) p.push(`<rect class="prev" x="${labelW}" y="${y + 15}" width="${(Math.max(r.prev, 0) / max) * bw}" height="5"><title>period before: ${money(r.prev)}</title></rect>`);
    p.push(`<rect class="bar ${r.cls || ""}" x="${labelW}" y="${y + 2}" width="${Math.max((Math.max(r.v, 0) / max) * bw, 1)}" height="12"><title>${esc(r.label)}: ${money(r.v)}</title></rect>`);
    const d = r.prev !== undefined && r.prev > 1 ? Math.round(((r.v - r.prev) / r.prev) * 100) : null;
    p.push(`<text class="num" x="${width - 4}" y="${y + 14}" text-anchor="end">${money(r.v)}${d === null ? "" : ` <tspan class="${d > 0 ? "neg" : "pos"}">${d > 0 ? "+" : ""}${d}%</tspan>`}</text></g>`);
  });
  p.push("</svg>");
  return wrap(p.join(""), onPick);
}
