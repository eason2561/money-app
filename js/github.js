// Reads the money model from the private wiki repo. This page only talks to
// api.github.com, with the read-only token saved on this device in Settings.

const API = "https://api.github.com";
const KEY = "money:settings";
const CACHE = "money:model";

export const DEFAULTS = { owner: "eason2561", repo: "Wiki", branch: "main", path: "assets/financial/money/model.json", token: "" };

export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
  catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window: settings last this visit only */ }
}
export const isConfigured = (s = loadSettings()) => Boolean(s.token && s.owner && s.repo && s.path);

export function cachedModel() {
  try { const t = localStorage.getItem(CACHE); return t ? JSON.parse(t) : null; } catch { return null; }
}

export async function fetchModel(s = loadSettings()) {
  if (!isConfigured(s)) throw new Error("Add your GitHub token in Settings first.");
  const url = `${API}/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/contents/` +
    s.path.split("/").map(encodeURIComponent).join("/") + (s.branch ? `?ref=${encodeURIComponent(s.branch)}` : "");
  let res;
  try {
    res = await fetch(url, { cache: "no-store", headers: {
      Authorization: `Bearer ${s.token}`, Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28" } });
  } catch { throw new Error("Can't reach GitHub (offline?). Showing the last data loaded."); }
  if (res.status === 401) throw new Error("GitHub refused the token (401). Check it in Settings.");
  if (res.status === 404) throw new Error("Not found (404): the token can't see the repo, or the path is wrong.");
  if (!res.ok) throw new Error(`GitHub error ${res.status}.`);
  const text = await res.text();
  const model = JSON.parse(text);
  try { localStorage.setItem(CACHE, text); } catch { /* too big or blocked: fine, just not cached */ }
  return model;
}
