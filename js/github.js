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

// Read a text file (with its sha, needed to update it) and write it back as a commit.
// Writing needs a token with Contents: Read and write.
function contentsUrl(s, path) {
  return `${API}/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/contents/` + path.split("/").map(encodeURIComponent).join("/");
}
const b64 = (text) => { const bytes = new TextEncoder().encode(text); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
const unb64 = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

export async function readFile(path, s = loadSettings()) {
  const res = await fetch(contentsUrl(s, path) + (s.branch ? `?ref=${encodeURIComponent(s.branch)}` : ""), { cache: "no-store",
    headers: { Authorization: `Bearer ${s.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
  if (res.status === 401) throw new Error("GitHub refused the token (401). Check it in Settings.");
  if (res.status === 404) return { text: "", sha: null };
  if (!res.ok) throw new Error(`GitHub error ${res.status} reading ${path}.`);
  const j = await res.json();
  return { text: unb64(j.content), sha: j.sha };
}

export async function writeFile(path, text, sha, message, s = loadSettings()) {
  const body = { message, content: b64(text), ...(sha ? { sha } : {}), ...(s.branch ? { branch: s.branch } : {}) };
  const res = await fetch(contentsUrl(s, path), { method: "PUT", headers: { Authorization: `Bearer ${s.token}`,
    Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 403 || res.status === 404) throw new Error("The token can't save (it needs Contents: Read and write on the repo).");
  if (res.status === 409) throw new Error("Someone else changed the file first; try again.");
  if (!res.ok) throw new Error(`GitHub error ${res.status} saving ${path}.`);
  return res.json();
}
