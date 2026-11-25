"""update.py の単体テスト（ネットワーク不要）。  python3 -m unittest scripts/test_update.py"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import update  # noqa: E402

NOW = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)


def feed(entries):
    items = "".join(f"""
 <entry>
  <yt:videoId>{vid}</yt:videoId>
  <title>{title}</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v={vid}"/>
  <published>{pub}</published>
  <media:group><media:description>概要 {vid}</media:description></media:group>
 </entry>""" for vid, title, pub in entries)
    return f"""<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">{items}</feed>"""


GOOD_SUMMARY = {"tldr": ["a", "b", "c"], "conclusion": "c", "chapters": [], "speakers": [], "keywords": []}


class FakeHttp:
    def __init__(self, feeds, shorts=(), gemini=None):
        self.feeds, self.shorts = feeds, set(shorts)
        self.gemini = gemini or (lambda url, body: (200, gem_ok(GOOD_SUMMARY)))
        self.posts = []

    def get(self, url, follow=True, timeout=30):
        if "/feeds/videos.xml" in url:
            cid = url.split("channel_id=")[1]
            return (200, self.feeds[cid]) if cid in self.feeds else (404, "")
        if "/shorts/" in url:
            return (200, "") if url.rsplit("/", 1)[1] in self.shorts else (303, "")
        if "youtube.com/@" in url:
            handle = url.rsplit("@", 1)[1]
            return 200, f'<link rel="canonical" href="https://www.youtube.com/channel/UC{handle:_<22}">'
        return 404, ""

    def post_json(self, url, body, headers, timeout=600):
        self.posts.append((url, body))
        return self.gemini(url, body)


def gem_ok(summary):
    return {"candidates": [{"content": {"parts": [{"text": json.dumps(summary)}]}}],
            "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 200}}


def cid(handle):
    return f"UC{handle:_<22}"


class UpdateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        update.CHANNELS_FILE = d / "channels.json"
        update.DATA_FILE = d / "data" / "videos.json"
        update.CHANNEL_CACHE_FILE = d / "data" / "channel_ids.json"
        update.CHANNELS_FILE.write_text(json.dumps([
            {"key": "a", "name": "ChanA", "handle": "@chana"},
            {"key": "b", "name": "ChanB", "handle": "@chanb"},
        ]))
        os.environ.update(GEMINI_API_KEY="k", MAX_PER_RUN="8")
        os.environ.pop("DRY_RUN", None)
        update.time.sleep = lambda s: None

    def tearDown(self):
        self.tmp.cleanup()

    def test_first_run_skips_old_and_shorts_and_recent(self):
        http = FakeHttp({
            cid("chana"): feed([("v1", "新しい", "2026-11-25T08:00:00+00:00"),
                                ("v2", "直近すぎ", "2026-11-25T11:50:00+00:00"),
                                ("v3", "古い", "2026-11-01T00:00:00+00:00"),
                                ("s1", "ショート", "2026-11-25T09:00:00+00:00")]),
            cid("chanb"): feed([("v4", "B新着", "2026-11-24T20:00:00+00:00")]),
        }, shorts={"s1"})
        out = update.run(http, NOW)
        st = {v["video_id"]: v["status"] for v in out["videos"]}
        self.assertEqual(st, {"v1": "done", "v2": "pending", "v3": "skipped_old",
                              "s1": "skipped_short", "v4": "done"})
        # Gemini へのリクエスト形式
        url, body = http.posts[0]
        self.assertIn(":generateContent", url)
        part = body["contents"][0]["parts"][0]
        self.assertEqual(part["file_data"]["file_uri"], "https://www.youtube.com/watch?v=v1")
        self.assertEqual(part["video_metadata"]["fps"], 0.25)
        self.assertEqual(body["generationConfig"]["mediaResolution"], "MEDIA_RESOLUTION_LOW")
        # 2回目: 既知動画は再要約しない、v2 は時間経過で要約
        later = datetime(2026, 11, 25, 15, 0, tzinfo=timezone.utc)
        http.posts.clear()
        out = update.run(http, later)
        self.assertEqual(len(http.posts), 1)
        self.assertEqual({v["video_id"]: v["status"] for v in out["videos"]}["v2"], "done")

    def test_quota_stops_and_keeps_pending(self):
        http = FakeHttp({cid("chana"): feed([("v1", "t", "2026-11-25T08:00:00+00:00"),
                                             ("v2", "t", "2026-11-25T07:00:00+00:00")]),
                         cid("chanb"): feed([])},
                        gemini=lambda u, b: (429, {"error": "quota"}))
        out = update.run(http, NOW)
        v = {x["video_id"]: x for x in out["videos"]}
        self.assertEqual(v["v1"]["status"], "pending")
        self.assertEqual(v["v1"]["attempts"], 0)
        self.assertTrue(v["v1"]["last_error"].startswith("429"))
        # 分あたり上限: 各動画で通常→軽量の2回、2本連続で429なら停止
        self.assertEqual(len(http.posts), 4)
        self.assertEqual(http.posts[1][1]["contents"][0]["parts"][0]["video_metadata"],
                         {"fps": 0.1, "end_offset": "5400s"})

    def test_daily_quota_stops_immediately(self):
        http = FakeHttp({cid("chana"): feed([("v1", "t", "2026-11-25T08:00:00+00:00"),
                                             ("v2", "t", "2026-11-25T07:00:00+00:00")]),
                         cid("chanb"): feed([])},
                        gemini=lambda u, b: (429, {"error": {"details": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}))
        update.run(http, NOW)
        self.assertEqual(len(http.posts), 1)

    def test_per_minute_429_recovers_with_lite_mode(self):
        def gem(u, b):
            meta = b["contents"][0]["parts"][0]["video_metadata"]
            if meta.get("end_offset") == "5400s":
                return 200, gem_ok(GOOD_SUMMARY)
            return 429, {"error": {"details": [{"quotaId": "GenerateContentInputTokensPerModelPerMinute-FreeTier"}]}}
        http = FakeHttp({cid("chana"): feed([("v1", "t", "2026-11-25T08:00:00+00:00")]),
                         cid("chanb"): feed([])}, gemini=gem)
        out = update.run(http, NOW)
        self.assertEqual(out["videos"][0]["status"], "done")
        self.assertEqual(out["videos"][0]["summary_meta"]["truncated_to"], "90分")

    def test_model_fallback_and_long_video_retry(self):
        calls = []

        def gem(url, body):
            calls.append((url, body["contents"][0]["parts"][0]["video_metadata"]))
            if "gemini-3.8-flash" in url:
                return 404, {"error": "not found"}
            if "end_offset" not in body["contents"][0]["parts"][0]["video_metadata"]:
                return 400, {"error": {"message": "The input token count exceeds the maximum"}}
            return 200, gem_ok(GOOD_SUMMARY)

        http = FakeHttp({cid("chana"): feed([("v1", "t", "2026-11-25T08:00:00+00:00")]),
                         cid("chanb"): feed([])}, gemini=gem)
        out = update.run(http, NOW)
        v = out["videos"][0]
        self.assertEqual(v["status"], "done")
        self.assertTrue(v["summary_meta"]["truncated"])
        self.assertIn("gemini-3.6-flash", calls[-1][0])
        self.assertEqual(calls[-1][1], {"fps": 0.1, "end_offset": "10800s"})

    def test_failure_retries_then_marks_failed(self):
        os.environ["MAX_ATTEMPTS"] = "2"
        http = FakeHttp({cid("chana"): feed([("v1", "t", "2026-11-25T08:00:00+00:00")]),
                         cid("chanb"): feed([])},
                        gemini=lambda u, b: (400, {"error": "Video unavailable"}))
        update.run(http, NOW)
        out = update.run(http, NOW)
        self.assertEqual(out["videos"][0]["status"], "failed")
        os.environ.pop("MAX_ATTEMPTS")

    def test_max_per_run(self):
        os.environ["MAX_PER_RUN"] = "1"
        http = FakeHttp({cid("chana"): feed([("v1", "t", "2026-11-25T08:00:00+00:00"),
                                             ("v2", "t", "2026-11-25T07:00:00+00:00")]),
                         cid("chanb"): feed([])})
        out = update.run(http, NOW)
        self.assertEqual([v["status"] for v in out["videos"]], ["done", "pending"])


    def test_503_falls_back_and_does_not_count_attempt(self):
        def gem(u, b):
            if "gemini-3.8-flash" in u:
                return 503, {"error": {"code": 503, "message": "high demand"}}
            return 200, gem_ok(GOOD_SUMMARY)
        http = FakeHttp({cid("chana"): feed([("v1", "t", "2026-11-25T08:00:00+00:00")]),
                         cid("chanb"): feed([])}, gemini=gem)
        out = update.run(http, NOW)
        v = out["videos"][0]
        self.assertEqual(v["status"], "done")
        self.assertEqual(v["summary_meta"]["model"], "gemini-3.6-flash")
        # 3.8 は 503 → 待って再試行 → 3.6 で成功
        self.assertEqual([u.split("/models/")[1].split(":")[0] for u, _ in http.posts],
                         ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.6-flash"])

    def test_all_busy_keeps_pending_without_attempts(self):
        http = FakeHttp({cid("chana"): feed([("v%d" % i, "t", "2026-11-25T0%d:00:00+00:00" % i) for i in range(1, 6)]),
                         cid("chanb"): feed([])},
                        gemini=lambda u, b: (503, {"error": "busy"}))
        out = update.run(http, NOW)
        self.assertTrue(all(v["status"] == "pending" and v["attempts"] == 0 for v in out["videos"]))
        self.assertIn("混雑", out["videos"][0]["last_error"])
        self.assertEqual(len(http.posts), 3 * 6)  # 3本 × (3モデル × 2回) で停止


if __name__ == "__main__":
    unittest.main()
