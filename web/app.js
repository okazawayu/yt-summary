"use strict";

const DATA_URL = "data/videos.json";
const READ_KEY = "yt-summary-read";
const state = { data: null, channel: "all", q: "", unreadOnly: false, read: loadRead() };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function loadRead() {
  try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || "[]")); } catch { return new Set(); }
}
function saveRead() {
  try { localStorage.setItem(READ_KEY, JSON.stringify([...state.read].slice(-2000))); } catch { /* private mode 等 */ }
}

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

async function load(force) {
  const btn = $("refresh");
  btn.classList.add("spin");
  try {
    const res = await fetch(`${DATA_URL}?t=${force ? Date.now() : Math.floor(Date.now() / 60000)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (e) {
    if (!state.data) $("list").innerHTML = `<div class="empty">データを読み込めませんでした。<br>${esc(e.message)}</div>`;
  } finally {
    btn.classList.remove("spin");
  }
  if (state.data) { renderChips(); renderList(); route(); }
}

function visibleVideos() {
  return (state.data?.videos || []).filter((v) => v.status === "done" || v.status === "pending");
}

function renderChips() {
  const vids = visibleVideos().filter((v) => v.status === "done");
  const count = (k) => vids.filter((v) => (k === "all" || v.channel_key === k) && !state.read.has(v.video_id)).length;
  const chans = [{ key: "all", name: "すべて" }, ...(state.data.channels || [])];
  $("chips").innerHTML = chans.map((c) => {
    const n = count(c.key);
    return `<button class="chip" data-k="${esc(c.key)}" aria-pressed="${state.channel === c.key}">${esc(c.name)}${n ? `<span class="n">${n}</span>` : ""}</button>`;
  }).join("");
  $("updated").textContent = state.data.updated_at ? `最終更新 ${fmtDate(state.data.updated_at)}` : "";
}

function matches(v, q) {
  if (!q) return true;
  const s = v.summary || {};
  const hay = [v.title, v.channel_name, s.conclusion, ...(s.tldr || []), ...(s.keywords || []),
    ...(s.speakers || []).map((p) => `${p.name} ${p.role || ""} ${(p.claims || []).join(" ")}`),
    ...(s.chapters || []).map((c) => `${c.title} ${(c.points || []).join(" ")}`)].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function renderList() {
  const vids = visibleVideos().filter((v) =>
    (state.channel === "all" || v.channel_key === state.channel) &&
    (!state.unreadOnly || (v.status === "done" && !state.read.has(v.video_id))) &&
    (v.status === "done" ? matches(v, state.q) : !state.q));
  if (!vids.length) {
    $("list").innerHTML = `<div class="empty">${state.q || state.unreadOnly ? "該当する動画はありません" : "まだ要約された動画がありません。<br>次回の自動更新をお待ちください。"}</div>`;
    return;
  }
  $("list").innerHTML = vids.map((v) => {
    const done = v.status === "done";
    const unread = done && !state.read.has(v.video_id);
    const tldr = done ? (v.summary.tldr || []).slice(0, 3).map((t) => `<li>${esc(t)}</li>`).join("") : "";
    return `<button class="card${unread ? " unread" : ""}${done ? "" : " pending"}" data-id="${esc(v.video_id)}" style="${chStyle(v.channel_key)}" ${done ? "" : "disabled"}>
      <img class="thumb" loading="lazy" src="${thumb(v.video_id)}" alt="" onerror="this.style.visibility='hidden'">
      <div>
        <div class="meta"><span class="ch-dot"></span><span class="ch-name">${esc(v.channel_name)}</span><span>${fmtDate(v.published)}</span>${done ? "" : `<span class="badge">要約待ち</span>`}</div>
        <h2>${esc(v.title)}</h2>
        ${!done && v.last_error ? `<div class="err">${esc(errLabel(v))}</div>` : ""}
      </div>
      ${tldr ? `<ul class="tldr">${tldr}</ul>` : ""}
    </button>`;
  }).join("");
}

function renderDetail(v) {
  const s = v.summary || {};
  const id = v.video_id;
  const chapters = (s.chapters || []).map((c) => {
    const t = toSec(c.start);
    return `<div class="chapter"><div class="chapter-h"><a class="ts" href="${ytUrl(id, t)}" target="_blank" rel="noopener">${esc(c.start)}</a><span>${esc(c.title)}</span></div>
      <ul>${(c.points || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`;
  }).join("");
  const speakers = (s.speakers || []).filter((p) => (p.claims || []).length).map((p) =>
    `<div class="speaker"><div class="speaker-h">${esc(p.name)}${p.role ? `<small>${esc(p.role)}</small>` : ""}</div>
      <ul>${p.claims.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>`).join("");
  const data = (s.data_points || []).map((d) => `<li>${esc(d)}</li>`).join("");
  const kw = (s.keywords || []).map((k) => `<button data-kw="${esc(k)}">${esc(k)}</button>`).join("");
  const meta = v.summary_meta || {};

  $("detail-ch").textContent = v.channel_name;
  $("detail").style.cssText = chStyle(v.channel_key);
  $("detail-body").innerHTML = `
    <a class="hero" href="${ytUrl(id)}" target="_blank" rel="noopener"><img src="https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg" alt="" onerror="this.style.visibility='hidden'"><span>▶ YouTubeで見る</span></a>
    <h2>${esc(v.title)}</h2>
    <div class="sub">${fmtDate(v.published)}</div>
    ${s.conclusion ? `<div class="conclusion"><b>結論</b>${esc(s.conclusion)}</div>` : ""}
    ${(s.tldr || []).length ? `<h3>3行要約</h3><ul>${s.tldr.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    ${chapters ? `<h3>チャプター</h3>${chapters}` : ""}
    ${speakers ? `<h3>出演者の主張</h3>${speakers}` : ""}
    ${data ? `<h3>数値・固有名詞</h3><ul>${data}</ul>` : ""}
    ${kw ? `<h3>キーワード</h3><div class="kw">${kw}</div>` : ""}
    <div class="note">AIによる自動要約（${esc(meta.model || "")}${meta.truncated ? `・先頭${esc(meta.truncated_to || meta.analyzed_until || "")}のみ` : meta.analyzed_until ? `・最大${esc(meta.analyzed_until)}まで解析` : ""}）。固有名詞や数値は誤る可能性があるため、重要な判断の前に動画で確認してください。</div>`;
  $("toggle-read").textContent = "未読に戻す";
}

function route() {
  const id = new URLSearchParams(location.hash.slice(1)).get("v");
  const v = id && visibleVideos().find((x) => x.video_id === id && x.status === "done");
  if (v) {
    renderDetail(v);
    $("detail").hidden = false;
    $("detail").scrollTop = 0;
    document.body.style.overflow = "hidden";
    if (!state.read.has(id)) { state.read.add(id); saveRead(); renderChips(); renderList(); }
  } else {
    $("detail").hidden = true;
    document.body.style.overflow = "";
  }
}

// ---- イベント
$("list").addEventListener("click", (e) => {
  const card = e.target.closest(".card:not(.pending)");
  if (card) location.hash = `v=${card.dataset.id}`;
});
$("chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.channel = chip.dataset.k;
  renderChips(); renderList(); window.scrollTo({ top: 0 });
});
$("q").addEventListener("input", (e) => { state.q = e.target.value.trim(); renderList(); });
$("unread").addEventListener("change", (e) => { state.unreadOnly = e.target.checked; renderList(); });
$("refresh").addEventListener("click", () => load(true));
$("back").addEventListener("click", () => {
  if (history.length > 1 && location.hash) history.back(); else location.hash = "";
});
$("toggle-read").addEventListener("click", () => {
  const id = new URLSearchParams(location.hash.slice(1)).get("v");
  if (!id) return;
  state.read.delete(id); saveRead(); renderChips(); renderList();
  $("toggle-read").textContent = "未読にしました";
});
$("detail-body").addEventListener("click", (e) => {
  const k = e.target.closest("[data-kw]");
  if (!k) return;
  state.q = k.dataset.kw; $("q").value = state.q;
  location.hash = ""; renderList();
});
window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(false); });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
load(false);
