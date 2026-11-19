// Reads the money model from the private Money repo. This page only talks to
// api.github.com, with the token saved on this device in Settings (shared with Keep and Fitness
// Log through shared-auth.js).
import { resolveToken } from "./shared-auth.js?v=2026.11.19-1";

const API = "https://api.github.com";
const KEY = "money:settings";
const CACHE = "money:model";

export const DEFAULTS = { owner: "eason2561", repo: "Money", branch: "main", path: "assets/financial/money/model.json", token: "" };

function stored() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
export function loadSettings() {
  const s = { ...DEFAULTS, ...stored() };
  if (s.owner === "eason2561" && s.repo === "Wiki") s.repo = "Money";  // the data moved 2026-11-07
  return { ...s, token: resolveToken(s.token) };
}
// The token itself is saved with shared-auth.js. A token this page saved before that is kept
// until it's replaced, unless dropLegacyToken.
export function saveSettings({ token, ...rest }, { dropLegacyToken = false } = {}) {
  const legacy = dropLegacyToken ? "" : stored().token;
  try { localStorage.setItem(KEY, JSON.stringify({ ...rest, ...(legacy ? { token: legacy } : {}) })); } catch { /* private window: settings last this visit only */ }
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

// Sync now: start the SimpleFIN workflow (mode sync) and wait for it to finish. It downloads the
// banks' transactions and commits a rebuilt model.json, so the caller reloads afterwards.
// Needs a token with Actions: Read and write on the repo. onStep(text) reports progress.
const WORKFLOW = "simplefin.yml";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, s, init = {}) {
  const res = await fetch(`${API}/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}${path}`, { cache: "no-store", ...init,
    headers: { Authorization: `Bearer ${s.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  if (res.status === 401) throw new Error("GitHub refused the token (401). Check it in Settings.");
  if (res.status === 403 || res.status === 404) throw new Error("The token can't start the sync: give it Actions: Read and write on the Money repo (GitHub → Settings → Developer settings → your token).");
  if (!res.ok) throw new Error(`GitHub error ${res.status} starting the sync.`);
  return res.status === 204 ? null : res.json();
}

export async function runSync(onStep = () => {}, s = loadSettings()) {
  if (!isConfigured(s)) throw new Error("Add your GitHub token in Settings first.");
  const started = Date.now() - 60_000;  // allow for clock difference with GitHub
  onStep("Starting sync…");
  await api(`/actions/workflows/${WORKFLOW}/dispatches`, s, { method: "POST",
    body: JSON.stringify({ ref: s.branch || "main", inputs: { mode: "sync" } }) });
  const deadline = Date.now() + 6 * 60_000;
  let run = null;
  while (Date.now() < deadline) {
    await sleep(run ? 5000 : 3000);
    if (!run) {
      const j = await api(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`, s);
      run = (j.workflow_runs || []).find((r) => Date.parse(r.created_at) >= started) || null;
      if (!run) { onStep("Waiting for GitHub to start the sync…"); continue; }
    } else {
      run = await api(`/actions/runs/${run.id}`, s);
    }
    if (run.status === "completed") {
      if (run.conclusion !== "success") throw new Error(`Sync ${run.conclusion || "failed"}: see Money → Actions → SimpleFIN.`);
      return run;
    }
    onStep(run.status === "in_progress" ? "Downloading from the banks…" : "Sync queued at GitHub…");
  }
  throw new Error("Sync is taking longer than usual; it will keep running. Tap Refresh in a few minutes.");
}
