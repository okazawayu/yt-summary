"use strict";

const DATA_URL = "data/videos.json";
const STATE_KEY = "yt-summary-state-v1";   // { items: { [videoId]: { r, rt, f, ft } } }
const LEGACY_READ_KEY = "yt-summary-read";
const SYNC_KEY = "yt-summary-sync";        // { token, repo }
const SYNC_BRANCH = "state";
const SYNC_PATH = "state.json";
const TAG_LIMIT = 14;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").normalize("NFKC").trim().toLowerCase();

const ui = { data: null, channel: "all", tag: null, q: "", unreadOnly: false, favOnly: false };

// ------------------------------------------------------------------ 状態（既読・お気に入り）
// 項目ごとに更新時刻を持たせ、端末間のマージは「新しい方を採用」で行う。
// 未読に戻す・お気に入り解除も時刻付きで残すので、別端末の古い状態に上書きされない。

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode 等 */ }
}

function loadState() {
  const st = lsGet(STATE_KEY, null) || { items: {} };
  const legacy = lsGet(LEGACY_READ_KEY, null);  // 旧版の既読リストを引き継ぐ
  if (Array.isArray(legacy)) {
    for (const id of legacy) if (!st.items[id]) st.items[id] = { r: 1, rt: 1 };
    try { localStorage.removeItem(LEGACY_READ_KEY); } catch { /* noop */ }
  }
  return st;
}
let state = loadState();
const saveState = () => lsSet(STATE_KEY, state);

const isRead = (id) => state.items[id]?.r === 1;
const isFav = (id) => state.items[id]?.f === 1;

function setFlag(id, key, value) {
  const it = state.items[id] || (state.items[id] = {});
  if ((it[key] === 1) === value) return;
  it[key] = value ? 1 : 0;
  it[key + "t"] = Date.now();
  saveState();
  sync.schedule();
}

function mergeStates(a, b) {
  const out = { items: {} };
  const ids = new Set([...Object.keys(a.items || {}), ...Object.keys(b.items || {})]);
  for (const id of ids) {
    const x = a.items?.[id] || {}, y = b.items?.[id] || {};
    const m = {};
    for (const k of ["r", "f"]) {
      const src = (x[k + "t"] || 0) >= (y[k + "t"] || 0) ? x : y;
      if (src[k] !== undefined) { m[k] = src[k]; m[k + "t"] = src[k + "t"] || 0; }
    }
    if (Object.keys(m).length) out.items[id] = m;
  }
  return prune(out);
}

// キー順に依存しない比較・保存用の文字列（差分がないのに書き込むのを防ぐ）
function canon(st) {
  const items = {};
  for (const id of Object.keys(st.items || {}).sort()) {
    const it = st.items[id], o = {};
    for (const k of ["f", "ft", "r", "rt"]) if (it[k] !== undefined) o[k] = it[k];
    items[id] = o;
  }
  return JSON.stringify({ items });
}

function prune(st) {
  // 既読のみの古い項目は 3000 件を超えたら古い順に捨てる（お気に入りは残す）
  const entries = Object.entries(st.items);
  if (entries.length <= 3000) return st;
  const keep = entries.filter(([, v]) => v.f === 1);
  const rest = entries.filter(([, v]) => v.f !== 1).sort((a, b) => (b[1].rt || 0) - (a[1].rt || 0));
  st.items = Object.fromEntries([...keep, ...rest.slice(0, 3000 - keep.length)]);
  return st;
}

// ------------------------------------------------------------------ GitHub 同期

function defaultRepo() {
  const owner = location.hostname.endsWith(".github.io") ? location.hostname.split(".")[0] : "";
  const name = location.pathname.split("/").filter(Boolean)[0] || "";
  return owner && name ? `${owner}/${name}` : "";
}

const b64encode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

const sync = {
  cfg: lsGet(SYNC_KEY, null),
  timer: null,
  busy: null,
  lastOk: null,

  enabled() { return !!(this.cfg?.token && this.cfg?.repo); },

  async api(method, path, body) {
    const res = await fetch(`https://api.github.com/repos/${this.cfg.repo}${path}`, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, json };
  },

  async ensureBranch() {
    const r = await this.api("GET", `/git/ref/heads/${SYNC_BRANCH}`);
    if (r.status === 200) return;
    if (r.status !== 404) throw httpError(r);
    // state ブランチが無ければ既定ブランチの先頭から作る
    const repo = await this.api("GET", "");
    if (repo.status !== 200) throw httpError(repo);
    const head = await this.api("GET", `/git/ref/heads/${repo.json.default_branch}`);
    if (head.status !== 200) throw httpError(head);
    const c = await this.api("POST", "/git/refs", { ref: `refs/heads/${SYNC_BRANCH}`, sha: head.json.object.sha });
    if (c.status !== 201 && c.status !== 422) throw httpError(c);
  },

  async fetchRemote() {
    const r = await this.api("GET", `/contents/${SYNC_PATH}?ref=${SYNC_BRANCH}&t=${Date.now()}`);
    if (r.status === 404) {
      const ref = await this.api("GET", `/git/ref/heads/${SYNC_BRANCH}`);
      if (ref.status === 404) await this.ensureBranch();
      return { sha: null, st: { items: {} } };
    }
    if (r.status !== 200) throw httpError(r);
    let st = { items: {} };
    try { st = JSON.parse(b64decode(r.json.content || "")); } catch { /* 壊れていたら空扱い */ }
    return { sha: r.json.sha, st: st && st.items ? st : { items: {} } };
  },

  // 取得 → マージ → 差分があれば書き込み。sha 競合時は取り直して再試行
  run() {
    if (!this.enabled()) return Promise.resolve();
    if (this.busy) return this.busy.then(() => this.run());
    this.busy = (async () => {
      setSyncStatus("同期中…");
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          const { sha, st: remote } = await this.fetchRemote();
          const merged = mergeStates(state, remote);
          const changedLocal = canon(merged) !== canon(state);
          state = merged; saveState();
          if (changedLocal && ui.data) renderAll();
          if (canon(merged) === canon(remote)) break;
          const body = {
            message: `state: update ${new Date().toISOString()}`,
            content: b64encode(canon(merged)),
            branch: SYNC_BRANCH,
            ...(sha ? { sha } : {}),
          };
          const w = await this.api("PUT", `/contents/${SYNC_PATH}`, body);
          if (w.status === 200 || w.status === 201) break;
          if (w.status === 409 || w.status === 422) { await sleep(400 * (attempt + 1)); continue; }
          throw httpError(w);
        }
        this.lastOk = new Date();
        setSyncStatus(`同期済み ${this.lastOk.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`);
      } catch (e) {
        setSyncStatus("同期エラー", true);
        throw e;
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  },

  schedule() {
    if (!this.enabled()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run().catch(() => {}), 1500);
  },
};

function httpError(r) {
  const msg = r.json?.message || "";
  if (r.status === 401) return new Error("トークンが無効です（401）");
  if (r.status === 403 || (r.status === 404 && /Not Found/.test(msg)))
    return new Error(`アクセスが拒否されました（${r.status}）。リポジトリ名と Contents: Read and write 権限を確認してください`);
  return new Error(`GitHub API エラー（${r.status}）${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setSyncStatus(text, error) {
  const el = $("sync-status");
  el.textContent = sync.enabled() ? ` ・ ${text}` : "";
  el.classList.toggle("error", !!error);
}

// ------------------------------------------------------------------ 表示ヘルパー

function fmtDate(iso) {
  const d = new Date(iso), diff = (Date.now() - d) / 60000;
  if (diff < 60) return `${Math.max(1, Math.round(diff))}分前`;
  if (diff < 60 * 24) return `${Math.round(diff / 60)}時間前`;
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
    weekday: "short", hour: "2-digit", minute: "2-digit" });
}
function toSec(ts) {
  const p = String(ts || "").split(":").map(Number);
  if (p.some(isNaN)) return 0;
  return p.reduce((a, n) => a * 60 + n, 0);
}
function errLabel(v) {
  const e = v.last_error || "";
  if (/配信/.test(e)) return e;
  if (/混雑|HTTP 50\d/.test(e)) return "Gemini混雑のため次回の更新で再試行します";
  if (e.startsWith("429")) return /PerDay/i.test(e) ? "本日の無料枠を使い切りました（翌日再開）" : "利用上限のため次回再試行します";
  if (/API key|HTTP 40[13]/.test(e)) return "APIキーが無効です（Secretを確認）";
  return `前回エラー（${v.attempts || 0}回目）: ${e.slice(0, 100)}`;
}
const thumb = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
const ytUrl = (id, t) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}${t ? `&t=${t}s` : ""}`;
const chStyle = (key) => `--c: var(--c-${esc(key)})`;
const imgErr = `onerror="this.style.visibility='hidden'"`;

// ------------------------------------------------------------------ データ

async function load(force) {
  const btn = $("refresh");
  btn.classList.add("spin");
  try {
    const res = await fetch(`${DATA_URL}?t=${force ? Date.now() : Math.floor(Date.now() / 60000)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ui.data = await res.json();
  } catch (e) {
    if (!ui.data) $("list").innerHTML = `<div class="empty">データを読み込めませんでした。<br>${esc(e.message)}</div>`;
  } finally {
    btn.classList.remove("spin");
  }
  if (ui.data) { renderAll(); route(); }
  sync.run().catch(() => {});
}

const visibleVideos = () => (ui.data?.videos || []).filter((v) => v.status === "done" || v.status === "pending");
const doneVideos = () => visibleVideos().filter((v) => v.status === "done");
const inChannel = (v) => ui.channel === "all" || v.channel_key === ui.channel;
const hasTag = (v, tag) => (v.summary?.keywords || []).some((k) => norm(k) === tag);

function topTags() {
  const count = new Map(), label = new Map();
  for (const v of doneVideos().filter(inChannel)) {
    const seen = new Set();
    for (const k of v.summary?.keywords || []) {
      const n = norm(k);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      count.set(n, (count.get(n) || 0) + 1);
      if (!label.has(n)) label.set(n, String(k).normalize("NFKC").trim());
    }
  }
  return [...count].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TAG_LIMIT).map(([n, c]) => ({ n, c, label: label.get(n) }));
}

function matches(v, q) {
  if (!q) return true;
  const s = v.summary || {};
  const hay = norm([v.title, v.channel_name, s.conclusion, ...(s.tldr || []), ...(s.keywords || []),
    ...(s.speakers || []).map((p) => `${p.name} ${p.role || ""} ${(p.claims || []).join(" ")}`),
    ...(s.chapters || []).map((c) => `${c.title} ${(c.points || []).join(" ")}`)].join(" "));
  return norm(q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

// ------------------------------------------------------------------ 描画

function renderAll() { renderChips(); renderTags(); renderList(); refreshDetailButtons(); }

function renderChips() {
  const unread = (k) => doneVideos().filter((v) => (k === "all" || v.channel_key === k) && !isRead(v.video_id)).length;
  const chans = [{ key: "all", name: "すべて" }, ...(ui.data.channels || [])];
  $("chips").innerHTML = chans.map((c) => {
    const n = unread(c.key);
    return `<button class="chip" data-k="${esc(c.key)}" aria-pressed="${ui.channel === c.key}">${esc(c.name)}${n ? `<span class="n">${n}</span>` : ""}</button>`;
  }).join("");
  $("updated").textContent = ui.data.updated_at ? `最終更新 ${fmtDate(ui.data.updated_at)}` : "";
  setSyncStatus(sync.lastOk ? `同期済み ${sync.lastOk.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}` : "未同期");
}

function renderTags() {
  const tags = topTags();
  if (ui.tag && !tags.some((t) => t.n === ui.tag)) tags.unshift({ n: ui.tag, c: 0, label: ui.tag });
  $("tags").hidden = !tags.length;
  $("tags").innerHTML = tags.map((t) =>
    `<button class="chip tag" data-tag="${esc(t.n)}" aria-pressed="${ui.tag === t.n}">#${esc(t.label)}${t.c ? `<span class="n">${t.c}</span>` : ""}</button>`).join("");
}

function renderList() {
  const vids = visibleVideos().filter((v) => {
    const done = v.status === "done";
    if (!inChannel(v)) return false;
    if (!done) return !ui.q && !ui.tag && !ui.unreadOnly && !ui.favOnly;
    return (!ui.unreadOnly || !isRead(v.video_id)) && (!ui.favOnly || isFav(v.video_id)) &&
      (!ui.tag || hasTag(v, ui.tag)) && matches(v, ui.q);
  });
  if (!vids.length) {
    const filtered = ui.q || ui.tag || ui.unreadOnly || ui.favOnly;
    $("list").innerHTML = `<div class="empty">${ui.favOnly && !ui.q && !ui.tag ? "お気に入りはまだありません。<br>★をタップすると追加できます。"
      : filtered ? "該当する動画はありません" : "まだ要約された動画がありません。<br>次回の自動更新をお待ちください。"}</div>`;
    return;
  }
  $("list").innerHTML = vids.map((v) => {
    const done = v.status === "done", id = v.video_id;
    const unread = done && !isRead(id);
    const tldr = done ? (v.summary.tldr || []).slice(0, 3).map((t) => `<li>${esc(t)}</li>`).join("") : "";
    return `<article class="card${unread ? " unread" : ""}${done ? "" : " pending"}" data-id="${esc(id)}" style="${chStyle(v.channel_key)}" ${done ? 'tabindex="0" role="button"' : ""}>
      <img class="thumb" loading="lazy" src="${thumb(id)}" alt="" ${imgErr}>
      <div>
        <div class="meta"><span class="ch-dot"></span><span class="ch-name">${esc(v.channel_name)}</span><span>${fmtDate(v.published)}</span>${done ? "" : `<span class="badge">要約待ち</span>`}</div>
        <h2>${esc(v.title)}</h2>
        ${!done && v.last_error ? `<div class="err">${esc(errLabel(v))}</div>` : ""}
      </div>
      ${done ? `<button class="star card-star" data-fav="${esc(id)}" aria-label="お気に入り" aria-pressed="${isFav(id)}">★</button>` : ""}
      ${tldr ? `<ul class="tldr">${tldr}</ul>` : ""}
    </article>`;
  }).join("");
}

function currentId() { return new URLSearchParams(location.hash.slice(1)).get("v"); }

function refreshDetailButtons() {
  const id = currentId();
  if (!id || $("detail").hidden) return;
  $("detail-fav").setAttribute("aria-pressed", String(isFav(id)));
  $("toggle-read").textContent = isRead(id) ? "未読に戻す" : "既読にする";
}

function renderDetail(v) {
  const s = v.summary || {}, id = v.video_id, meta = v.summary_meta || {};
  const chapters = (s.chapters || []).map((c) => {
    const t = toSec(c.start);
    return `<div class="chapter"><div class="chapter-h"><a class="ts" href="${ytUrl(id, t)}" target="_blank" rel="noopener">${esc(c.start)}</a><span>${esc(c.title)}</span></div>
      <ul>${(c.points || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`;
  }).join("");
  const speakers = (s.speakers || []).filter((p) => (p.claims || []).length).map((p) =>
    `<div class="speaker"><div class="speaker-h">${esc(p.name)}${p.role ? `<small>${esc(p.role)}</small>` : ""}</div>
      <ul>${p.claims.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>`).join("");
  const data = (s.data_points || []).map((d) => `<li>${esc(d)}</li>`).join("");
  const kw = (s.keywords || []).map((k) => `<button data-kw="${esc(norm(k))}">#${esc(k)}</button>`).join("");

  $("detail-ch").textContent = v.channel_name;
  $("detail").style.cssText = chStyle(v.channel_key);
  $("detail-body").innerHTML = `
    <a class="hero" href="${ytUrl(id)}" target="_blank" rel="noopener"><img src="https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg" alt="" ${imgErr}><span>▶ YouTubeで見る</span></a>
    <h2>${esc(v.title)}</h2>
    <div class="sub">${fmtDate(v.published)}</div>
    ${s.conclusion ? `<div class="conclusion"><b>結論</b>${esc(s.conclusion)}</div>` : ""}
    ${(s.tldr || []).length ? `<h3>3行要約</h3><ul>${s.tldr.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    ${chapters ? `<h3>チャプター</h3>${chapters}` : ""}
    ${speakers ? `<h3>出演者の主張</h3>${speakers}` : ""}
    ${data ? `<h3>数値・固有名詞</h3><ul>${data}</ul>` : ""}
    ${kw ? `<h3>キーワード</h3><div class="kw">${kw}</div>` : ""}
    <div class="note">AIによる自動要約（${esc(meta.model || "")}${meta.truncated ? `・先頭${esc(meta.truncated_to || meta.analyzed_until || "")}のみ` : meta.analyzed_until ? `・最大${esc(meta.analyzed_until)}まで解析` : ""}）。固有名詞や数値は誤る可能性があるため、重要な判断の前に動画で確認してください。</div>`;
}

function route() {
  const id = currentId();
  const v = id && doneVideos().find((x) => x.video_id === id);
  if (v) {
    const opening = $("detail").hidden || $("detail").dataset.id !== id;
    if (opening) { renderDetail(v); $("detail").dataset.id = id; $("detail").scrollTop = 0; }
    $("detail").hidden = false;
    document.body.style.overflow = "hidden";
    if (opening && !isRead(id)) { setFlag(id, "r", true); renderChips(); renderList(); }
    refreshDetailButtons();
  } else {
    $("detail").hidden = true;
    $("detail").dataset.id = "";
    document.body.style.overflow = "";
  }
}

// ------------------------------------------------------------------ 設定画面

function openSettings() {
  $("token").value = sync.cfg?.token || "";
  $("repo").value = sync.cfg?.repo || defaultRepo();
  $("sync-msg").textContent = "";
  $("settings").hidden = false;
}
async function saveSettings() {
  const token = $("token").value.trim(), repo = $("repo").value.trim();
  const msg = $("sync-msg");
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { msg.textContent = "トークンと「ユーザー名/リポジトリ名」を入力してください"; return; }
  sync.cfg = { token, repo };
  lsSet(SYNC_KEY, sync.cfg);
  msg.textContent = "同期しています…";
  try {
    await sync.run();
    msg.textContent = "同期しました。他の端末でも同じトークンを設定してください。";
  } catch (e) {
    msg.textContent = `同期できませんでした：${e.message}`;
  }
}
function clearSettings() {
  sync.cfg = null;
  try { localStorage.removeItem(SYNC_KEY); } catch { /* noop */ }
  $("token").value = "";
  $("sync-msg").textContent = "この端末からトークンを削除しました（既読・お気に入りはこの端末に残ります）。";
  setSyncStatus("");
}

// ------------------------------------------------------------------ イベント

$("list").addEventListener("click", (e) => {
  const star = e.target.closest("[data-fav]");
  if (star) {
    const id = star.dataset.fav;
    setFlag(id, "f", !isFav(id));
    star.setAttribute("aria-pressed", String(isFav(id)));
    if (ui.favOnly) renderList();
    return;
  }
  const card = e.target.closest(".card:not(.pending)");
  if (card) location.hash = `v=${card.dataset.id}`;
});
$("list").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches(".card:not(.pending)")) location.hash = `v=${e.target.dataset.id}`;
});
$("chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  ui.channel = chip.dataset.k;
  renderAll(); window.scrollTo({ top: 0 });
});
$("tags").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-tag]");
  if (!chip) return;
  ui.tag = ui.tag === chip.dataset.tag ? null : chip.dataset.tag;
  renderTags(); renderList(); window.scrollTo({ top: 0 });
});
$("q").addEventListener("input", (e) => { ui.q = e.target.value.trim(); renderList(); });
$("unread").addEventListener("change", (e) => { ui.unreadOnly = e.target.checked; renderList(); });
$("favonly").addEventListener("change", (e) => { ui.favOnly = e.target.checked; renderList(); });
$("refresh").addEventListener("click", () => load(true));
$("back").addEventListener("click", () => {
  if (history.length > 1 && location.hash) history.back(); else location.hash = "";
});
$("toggle-read").addEventListener("click", () => {
  const id = currentId();
  if (!id) return;
  setFlag(id, "r", !isRead(id));
  renderChips(); renderList(); refreshDetailButtons();
});
$("detail-fav").addEventListener("click", () => {
  const id = currentId();
  if (!id) return;
  setFlag(id, "f", !isFav(id));
  refreshDetailButtons(); renderList();
});
$("detail-body").addEventListener("click", (e) => {
  const k = e.target.closest("[data-kw]");
  if (!k) return;
  ui.tag = k.dataset.kw;
  location.hash = "";
  renderTags(); renderList(); window.scrollTo({ top: 0 });
});
$("open-settings").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", () => { $("settings").hidden = true; });
$("settings").addEventListener("click", (e) => { if (e.target.id === "settings") $("settings").hidden = true; });
$("sync-save").addEventListener("click", saveSettings);
$("sync-clear").addEventListener("click", clearSettings);
window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(false); });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
load(false);
