#!/usr/bin/env python3
"""YouTube 新着動画を取得し、Gemini API で要約して data/videos.json を更新する。

標準ライブラリのみで動作する（GitHub Actions で pip install 不要）。

環境変数:
  GEMINI_API_KEY      必須。Google AI Studio で発行した API キー
  GEMINI_MODEL        既定 gemini-3.8-flash
  GEMINI_FALLBACK_MODELS  カンマ区切り。モデルが 404 のとき順に試す
  VIDEO_FPS           既定 0.25（トーク番組は画より音声が重要なので低 fps で節約）
  MAX_PER_RUN         1 回の実行で要約する最大本数。既定 8
  FIRST_RUN_DAYS      初回登録時に要約対象とする過去日数。既定 2
  MIN_AGE_MINUTES     公開直後の動画は待つ（ライブ配信・プレミア対策）。既定 30
  MAX_ATTEMPTS        失敗時の再試行上限（実行回数単位）。既定 6
  KEEP_ITEMS          保持する動画件数の上限。既定 400
  NTFY_TOPIC          任意。設定すると ntfy.sh に新着要約を通知
  DRY_RUN=1           Gemini を呼ばずにダミー要約を入れる（動作確認用）
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANNELS_FILE = ROOT / "channels.json"
DATA_FILE = ROOT / "data" / "videos.json"
CHANNEL_CACHE_FILE = ROOT / "data" / "channel_ids.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}
JST = timezone(timedelta(hours=9))


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------------------------------------------------------------- HTTP

class Http:
    """テストで差し替えられるよう HTTP をクラスに閉じ込める。"""

    def get(self, url: str, *, follow: bool = True, timeout: int = 30) -> tuple[int, str]:
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept-Language": "ja,en;q=0.8",
            # EU 同意画面を避ける
            "Cookie": "CONSENT=YES+cb; SOCS=CAI",
        })
        opener = urllib.request.build_opener() if follow else urllib.request.build_opener(_NoRedirect)
        try:
            with opener.open(req, timeout=timeout) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace") if e.fp else ""

    def post_json(self, url: str, body: dict, headers: dict, timeout: int = 600) -> tuple[int, dict | str]:
        data = json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method="POST", headers={
            "Content-Type": "application/json", **headers})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "replace") if e.fp else ""
            try:
                return e.code, json.loads(txt)
            except json.JSONDecodeError:
                return e.code, txt


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # noqa: D401
        return None


# ---------------------------------------------------------------- YouTube

CHANNEL_ID_RE = re.compile(r'"(?:externalId|channelId)":"(UC[0-9A-Za-z_-]{22})"')
CANONICAL_RE = re.compile(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[0-9A-Za-z_-]{22})"')


def resolve_channel_id(http: Http, ch: dict, cache: dict) -> str | None:
    if ch.get("channel_id"):
        return ch["channel_id"]
    if ch["key"] in cache:
        return cache[ch["key"]]
    status, html = http.get(f"https://www.youtube.com/{ch['handle']}")
    cid = None
    if status == 200:
        m = CANONICAL_RE.search(html) or CHANNEL_ID_RE.search(html)
        cid = m.group(1) if m else None
    if not cid:
        log(f"[warn] {ch['handle']} のチャンネルID解決に失敗 (HTTP {status})。hint を使用")
        cid = ch.get("channel_id_hint")
    else:
        cache[ch["key"]] = cid
    return cid


def parse_feed(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    out = []
    for e in root.findall("atom:entry", NS):
        vid = e.findtext("yt:videoId", namespaces=NS)
        if not vid:
            continue
        group = e.find("media:group", NS)
        desc = group.findtext("media:description", default="", namespaces=NS) if group is not None else ""
        link = e.find("atom:link", NS)
        out.append({
            "video_id": vid,
            "title": (e.findtext("atom:title", namespaces=NS) or "").strip(),
            "published": e.findtext("atom:published", namespaces=NS),
            "url": link.get("href") if link is not None else f"https://www.youtube.com/watch?v={vid}",
            "description": desc[:1500],
        })
    return out


def is_short(http: Http, video_id: str) -> bool:
    """/shorts/ID が 200 なら Shorts、通常動画は /watch へリダイレクトされる。"""
    status, _ = http.get(f"https://www.youtube.com/shorts/{video_id}", follow=False, timeout=15)
    return status == 200


# ---------------------------------------------------------------- Gemini

SUMMARY_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "tldr": {"type": "ARRAY", "items": {"type": "STRING"},
                 "description": "動画全体の要点を3行で。各行60字以内"},
        "conclusion": {"type": "STRING", "description": "結論・最も重要な主張を2〜3文で"},
        "chapters": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "start": {"type": "STRING", "description": "開始時刻 H:MM:SS または M:SS"},
                    "title": {"type": "STRING"},
                    "points": {"type": "ARRAY", "items": {"type": "STRING"}},
                },
                "required": ["start", "title", "points"],
            },
        },
        "speakers": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "name": {"type": "STRING"},
                    "role": {"type": "STRING", "description": "肩書き・番組内の役割"},
                    "claims": {"type": "ARRAY", "items": {"type": "STRING"}},
                },
                "required": ["name", "claims"],
            },
        },
        "data_points": {"type": "ARRAY", "items": {"type": "STRING"},
                        "description": "言及された具体的な数値・固有名詞・日付"},
        "keywords": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["tldr", "conclusion", "chapters", "speakers", "keywords"],
}

PROMPT = """あなたは経済・ビジネス番組の要約者です。この YouTube 動画を視聴し、日本語で詳細な要約を作成してください。

ルール:
- 動画内で実際に話された内容だけを書く。推測や一般論で補わない。
- 数値・企業名・人名・日付は聞き取れた通りに正確に書く。聞き取れない固有名詞は「（聞き取り不明）」とする。
- chapters は話題の切り替わりごとに 4〜12 個。start は動画内のおおよその開始時刻。各 points は 2〜5 個の具体的な箇条書き。
- speakers は出演者ごとに、その人の主要な主張・見解を 2〜5 個。司会者は主張がなければ省略してよい。
- 宣伝・メンバーシップ告知・スポンサー部分は要約に含めない。

参考情報（動画タイトルと概要欄。出演者名の表記確認に使う）:
タイトル: {title}
概要欄: {description}
"""


class QuotaExceeded(Exception):
    pass


class ModelNotFound(Exception):
    pass


def gemini_summarize(http: Http, api_key: str, model: str, video: dict,
                     fps: float, end_offset: str | None = None) -> tuple[dict, dict]:
    part = {"file_data": {"file_uri": f"https://www.youtube.com/watch?v={video['video_id']}"}}
    meta: dict = {"fps": fps}
    if end_offset:
        meta["end_offset"] = end_offset
    part["video_metadata"] = meta
    body = {
        "contents": [{"parts": [
            part,
            {"text": PROMPT.format(title=video["title"], description=video.get("description", "")[:1500])},
        ]}],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
            "responseSchema": SUMMARY_SCHEMA,
            "mediaResolution": "MEDIA_RESOLUTION_LOW",
        },
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    status, res = http.post_json(url, body, {"x-goog-api-key": api_key})
    if status == 429:
        raise QuotaExceeded(str(res)[:300])
    if status == 404:
        raise ModelNotFound(model)
    if status != 200 or not isinstance(res, dict):
        raise RuntimeError(f"HTTP {status}: {str(res)[:500]}")
    cands = res.get("candidates") or []
    if not cands:
        raise RuntimeError(f"候補なし: {json.dumps(res.get('promptFeedback', {}), ensure_ascii=False)[:300]}")
    text = "".join(p.get("text", "") for p in cands[0].get("content", {}).get("parts", []))
    summary = json.loads(text)
    usage = res.get("usageMetadata", {})
    return summary, {"model": model, "prompt_tokens": usage.get("promptTokenCount"),
                     "output_tokens": usage.get("candidatesTokenCount")}


def is_too_long_error(msg: str) -> bool:
    m = msg.lower()
    return "token" in m and ("exceed" in m or "too long" in m or "maximum" in m)


def summarize_with_fallbacks(http: Http, api_key: str, models: list[str], video: dict,
                             fps: float) -> tuple[dict, dict]:
    last_err: Exception | None = None
    for model in models:
        try:
            try:
                return gemini_summarize(http, api_key, model, video, fps)
            except RuntimeError as e:
                if not is_too_long_error(str(e)):
                    raise
                # 長尺動画: fps を下げ、先頭 3 時間に制限して再試行
                log(f"  長尺のため fps=0.1, 先頭3時間で再試行: {video['video_id']}")
                summary, meta = gemini_summarize(http, api_key, model, video, 0.1, end_offset="10800s")
                meta["truncated"] = True
                return summary, meta
        except ModelNotFound as e:
            log(f"  [warn] モデル {e} が見つかりません。次の候補へ")
            last_err = e
            continue
    raise RuntimeError(f"利用可能なモデルがありません: {last_err}")


def is_daily_quota(msg: str) -> bool:
    m = msg.lower()
    return "perday" in m or "per day" in m or "daily" in m


def summarize_lite(http: Http, api_key: str, models: list[str], video: dict) -> tuple[dict, dict]:
    """分あたりトークン上限に収めるため fps 0.1・先頭90分（約30万トークン以下）で要約する。"""
    last: Exception | None = None
    for model in models:
        try:
            summary, meta = gemini_summarize(http, api_key, model, video, 0.1, end_offset="5400s")
            meta["truncated"] = True
            meta["truncated_to"] = "90分"
            return summary, meta
        except ModelNotFound as e:
            last = e
    raise RuntimeError(f"利用可能なモデルがありません: {last}")


def dummy_summary(video: dict) -> tuple[dict, dict]:
    return ({
        "tldr": [f"（DRY_RUN）{video['title'][:40]}", "要点2", "要点3"],
        "conclusion": "DRY_RUN のためダミーの要約です。",
        "chapters": [{"start": "0:00", "title": "オープニング", "points": ["ダミー"]},
                     {"start": "5:30", "title": "本題", "points": ["ダミー1", "ダミー2"]}],
        "speakers": [{"name": "出演者A", "role": "ゲスト", "claims": ["ダミーの主張"]}],
        "data_points": [],
        "keywords": ["ダミー"],
    }, {"model": "dry-run"})


# ---------------------------------------------------------------- 通知

def notify_ntfy(http: Http, topic: str, items: list[dict]) -> None:
    if not topic or not items:
        return
    lines = [f"[{v['channel_name']}] {v['title']}" for v in items[:8]]
    body = {"topic": topic, "title": f"要約 {len(items)}件 追加", "message": "\n".join(lines), "tags": ["tv"]}
    if os.environ.get("APP_URL"):
        body["click"] = os.environ["APP_URL"]
    try:  # JSON 形式なら日本語タイトルも送れる。通知失敗は本処理に影響させない
        status, res = http.post_json("https://ntfy.sh/", body, {}, timeout=15)
        if status != 200:
            log(f"[warn] ntfy 通知失敗 HTTP {status}: {str(res)[:200]}")
    except Exception as e:  # noqa: BLE001
        log(f"[warn] ntfy 通知失敗: {e}")


# ---------------------------------------------------------------- メイン

def load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def run(http: Http | None = None, now: datetime | None = None) -> dict:
    http = http or Http()
    now = now or now_utc()
    dry = os.environ.get("DRY_RUN") == "1"
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key and not dry:
        log("GEMINI_API_KEY が未設定です")
        sys.exit(1)
    # Actions の未設定 vars は空文字で渡るので `or` で既定値に倒す
    models = [os.environ.get("GEMINI_MODEL") or "gemini-3.8-flash"] + [
        m.strip() for m in (os.environ.get("GEMINI_FALLBACK_MODELS") or "gemini-3.6-flash,gemini-3.5-flash").split(",")
        if m.strip()]
    models = list(dict.fromkeys(models))
    fps = env_float("VIDEO_FPS", 0.25)
    max_per_run = env_int("MAX_PER_RUN", 8)
    first_run_days = env_int("FIRST_RUN_DAYS", 2)
    min_age = timedelta(minutes=env_int("MIN_AGE_MINUTES", 30))
    max_attempts = env_int("MAX_ATTEMPTS", 6)
    keep = env_int("KEEP_ITEMS", 400)

    channels = load_json(CHANNELS_FILE, [])
    db = load_json(DATA_FILE, {"videos": []})
    cache = load_json(CHANNEL_CACHE_FILE, {})
    by_id = {v["video_id"]: v for v in db["videos"]}
    known_channels = {v["channel_key"] for v in db["videos"]}

    # 1) 新着検知
    for ch in channels:
        cid = resolve_channel_id(http, ch, cache)
        if not cid:
            continue
        status, xml_text = http.get(f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}")
        if status != 200:
            log(f"[warn] RSS 取得失敗 {ch['name']} HTTP {status}")
            # キャッシュした ID が誤っている可能性があるので消す
            cache.pop(ch["key"], None)
            continue
        try:
            entries = parse_feed(xml_text)
        except ET.ParseError as e:
            log(f"[warn] RSS 解析失敗 {ch['name']}: {e}")
            continue
        first_time = ch["key"] not in known_channels
        cutoff = now - timedelta(days=first_run_days)
        added = 0
        for ent in entries:
            if ent["video_id"] in by_id:
                by_id[ent["video_id"]]["title"] = ent["title"]  # タイトル変更に追随
                continue
            rec = {**ent, "channel_key": ch["key"], "channel_name": ch["name"],
                   "status": "pending", "attempts": 0, "added_at": iso(now)}
            if first_time and parse_iso(ent["published"]) < cutoff:
                rec["status"] = "skipped_old"
            by_id[ent["video_id"]] = rec
            added += 1
        log(f"{ch['name']}: RSS {len(entries)}件, 新規 {added}件")

    # 2) 要約
    pending = sorted(
        (v for v in by_id.values() if v["status"] == "pending"
         and now - parse_iso(v["published"]) >= min_age),
        key=lambda v: v["published"], reverse=True)
    done_now: list[dict] = []
    tries = 0
    consecutive_429 = 0
    for v in pending:
        if len(done_now) >= max_per_run or tries >= max_per_run * 2:
            break
        if is_short(http, v["video_id"]):
            v["status"] = "skipped_short"
            log(f"  Shorts のためスキップ: {v['title']}")
            continue
        log(f"要約中: [{v['channel_name']}] {v['title']}")
        tries += 1
        v["attempts"] += 1
        try:
            if dry:
                summary, meta = dummy_summary(v)
            else:
                try:
                    summary, meta = summarize_with_fallbacks(http, api_key, models, v, fps)
                except QuotaExceeded as e:
                    if is_daily_quota(str(e)):
                        raise
                    # 分あたりのトークン上限: 1分待ち、fps を下げ先頭90分に絞って再試行
                    log(f"  429（分あたり上限）。65秒待って軽量モードで再試行: {str(e)[:200]}")
                    time.sleep(65)
                    summary, meta = summarize_lite(http, api_key, models, v)
            consecutive_429 = 0
        except QuotaExceeded as e:
            v["attempts"] -= 1
            v["last_error"] = f"429: {str(e)[:280]}"
            consecutive_429 += 1
            if is_daily_quota(str(e)) or consecutive_429 >= 2:
                log(f"[stop] クォータ超過のため今回は終了: {str(e)[:300]}")
                break
            log("  [skip] 429 が続くため次の動画へ")
            continue
        except Exception as e:  # noqa: BLE001
            v["last_error"] = str(e)[:300]
            log(f"  [error] {e}")
            if v["attempts"] >= max_attempts:
                v["status"] = "failed"
            continue
        v.update(status="done", summary=summary, summary_meta=meta, summarized_at=iso(now))
        v.pop("last_error", None)
        done_now.append(v)
        time.sleep(0 if dry else 2)

    # 3) 保存（新しい順、上限件数）
    videos = sorted(by_id.values(), key=lambda v: v["published"], reverse=True)[:keep]
    out = {"updated_at": iso(now), "channels": [{"key": c["key"], "name": c["name"], "handle": c["handle"]}
                                                 for c in channels], "videos": videos}
    save_json(DATA_FILE, out)
    save_json(CHANNEL_CACHE_FILE, cache)
    notify_ntfy(http, os.environ.get("NTFY_TOPIC", ""), done_now)
    log(f"完了: 要約 {len(done_now)}件 / 未処理 {sum(1 for v in videos if v['status'] == 'pending')}件")
    return out


if __name__ == "__main__":
    run()
