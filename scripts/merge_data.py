#!/usr/bin/env python3
"""2つの videos.json を動画単位でマージする（git の行単位マージで要約が消えるのを防ぐ）。

使い方: python scripts/merge_data.py <ours.json> <theirs.json> <out.json>
同じ動画は「要約済み > 失敗 > スキップ > 未処理」の順に進んでいる方を採用し、
同じ段階なら更新が新しい方を採用する。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

RANK = {"done": 4, "failed": 3, "skipped_short": 2, "skipped_old": 2, "pending": 1}


def _key(v: dict) -> tuple:
    return (RANK.get(v.get("status"), 0), v.get("summarized_at", ""), v.get("attempts", 0))


def merge(ours: dict, theirs: dict, keep: int = 400) -> dict:
    by_id: dict[str, dict] = {}
    for v in theirs.get("videos", []) + ours.get("videos", []):
        cur = by_id.get(v["video_id"])
        if cur is None or _key(v) > _key(cur):
            by_id[v["video_id"]] = v
    videos = sorted(by_id.values(), key=lambda v: v["published"], reverse=True)[:keep]
    return {
        "updated_at": max(ours.get("updated_at") or "", theirs.get("updated_at") or ""),
        "channels": ours.get("channels") or theirs.get("channels") or [],
        "videos": videos,
    }


def load(path: str) -> dict:
    p = Path(path)
    if not p.exists() or not p.read_text(encoding="utf-8").strip():
        return {"videos": []}
    return json.loads(p.read_text(encoding="utf-8"))


if __name__ == "__main__":
    ours, theirs, out = sys.argv[1:4]
    merged = merge(load(ours), load(theirs))
    Path(out).write_text(json.dumps(merged, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"merged: {len(merged['videos'])} videos")
