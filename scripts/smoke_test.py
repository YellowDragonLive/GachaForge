# -*- coding: utf-8 -*-
"""全链路冒烟：固定入口 `python scripts/smoke_test.py`。

默认强制 mock 模式，不依赖 ComfyUI 在线。覆盖编译、健康检查、抽卡复现、
旧算法一致性、任务状态机、幂等、图片落盘/缩略图/标注/导出、静态前端与错误结构。
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("GACHA_COMFY_MOCK", "1")

from fastapi.testclient import TestClient  # noqa: E402

from backend.app.main import app  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(cond), detail))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))


def legacy_algorithm_match() -> tuple[bool, str]:
    """新 core 与旧 gacha.py 在同一 JSON、同一 seed 下应给出完全相同的抽取结果。"""
    import gacha as legacy
    from backend.app.core.pools import discover_pools, draw_pull

    fp = ROOT / "zh_TW.json"
    data = json.loads(fp.read_text(encoding="utf-8-sig"))
    new_pools = discover_pools(data, str(fp), "zh_TW")
    old_pools = legacy.load_pools(str(fp))
    a = draw_pull(random.Random(2026), new_pools, 2, False, {}, all_pools=new_pools)
    b = legacy.draw_pull(random.Random(2026), old_pools, 2, False, {}, all_pools=old_pools)
    sig = lambda c: [(x["label"], x["tags"]) for x in c]  # noqa: E731
    return sig(a) == sig(b), f"{len(a)} 条条目比对"


def wait_job(c: TestClient, job_id: int, timeout: float = 12.0) -> dict:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        rows = c.get("/api/jobs").json()["data"]
        row = next((r for r in rows if r["id"] == job_id), None)
        if row and row["status"] in ("succeeded", "failed", "dead", "cancelled"):
            return row
        time.sleep(0.3)
    return {}


def main() -> int:
    print("== 抽卡工作台冒烟测试（mock 模式） ==")
    ok_legacy, note = legacy_algorithm_match()
    check("旧抽卡算法一致性", ok_legacy, note)

    with TestClient(app) as c:
        print("-- 基础 --")
        for path in ("/health", "/ready", "/api/config", "/api/comfy/status",
                     "/api/comfy/models"):
            r = c.get(path)
            check(f"GET {path}", r.status_code == 200 and r.json().get("ok") is True)

        pools = c.get("/api/pools").json()["data"]
        recipes = c.get("/api/recipes").json()["data"]
        profiles = c.get("/api/gen-profiles").json()["data"]
        check("卡池已导入", len(pools) > 100, f"{len(pools)} 池")
        check("内置配方存在", len(recipes) >= 3, f"{len(recipes)} 个")
        check("默认参数预设存在", len(profiles) >= 1)

        print("-- 抽卡与复现 --")
        body = {"recipe_id": recipes[0]["id"], "pulls": 3, "seed": 42}
        s1 = c.post("/api/draw-sessions", json=body).json()["data"]
        s2 = c.post("/api/draw-sessions", json=body).json()["data"]
        check("同 seed 结果完全一致",
              [d["prompt"] for d in s1["draws"]] == [d["prompt"] for d in s2["draws"]],
              f"{len(s1['draws'])} 抽 / {s1['pool_count']} 池")
        check("抽卡快照已保存",
              c.get(f"/api/draw-sessions/{s2['session_id']}").json()["ok"])

        print("-- 任务与幂等 --")
        did = s2["draws"][0]["id"]
        j1 = c.post("/api/jobs", json={"draw_ids": [did]}).json()["data"]
        job_id = j1["created"][0] if j1["created"] else j1["reused"][0]
        final = wait_job(c, job_id)
        check("任务执行成功", final.get("status") == "succeeded",
              f"progress={final.get('progress')}")
        j2 = c.post("/api/jobs", json={"draw_ids": [did]}).json()["data"]
        check("重复提交幂等", not j2["created"] and job_id in j2["reused"])
        retried = c.post(f"/api/jobs/{job_id}/retry", json={})
        check("重试点可用", retried.status_code == 200)
        cancelled = c.post(f"/api/jobs/{job_id}/cancel", json={})
        check("取消点可用", cancelled.status_code == 200)

        print("-- 图片与画廊 --")
        imgs = c.get("/api/images").json()["data"]
        check("图片已落盘注册", imgs["total"] >= 1, f"{imgs['total']} 张")
        if imgs["items"]:
            iid = imgs["items"][0]["id"]
            check("原图接口", c.get(f"/api/images/{iid}/file").status_code == 200)
            check("缩略图接口", c.get(f"/api/images/{iid}/thumb").status_code == 200)
            patched = c.patch(f"/api/images/{iid}", json={"rating": 4, "favorite": True})
            check("标注可写", patched.json()["data"]["rating"] == 4)
            exp = c.get(f"/api/images/export?ids={iid}")
            check("元数据导出", exp.json()["ok"] and len(exp.json()["data"]) == 1)

        print("-- 边界与前端 --")
        bad = c.post("/api/draw-sessions", json={"pulls": 0})
        check("参数校验返回 400", bad.status_code == 400 and bad.json()["ok"] is False)
        miss = c.get("/api/pools/999999")
        check("404 统一错误结构", miss.status_code == 404 and "error" in miss.json())
        page = c.get("/")
        check("静态首页", page.status_code == 200 and "抽卡工作台" in page.text)
        for asset in ("/app.js", "/api.js", "/styles.css"):
            check(f"静态资源 {asset}", c.get(asset).status_code == 200)
        spec = c.get("/openapi.json").json()
        check("SSE 端点已注册", "/api/jobs/stream" in spec.get("paths", {}))

    passed = sum(1 for _n, ok, _d in RESULTS if ok)
    print(f"\n== 汇总: {passed}/{len(RESULTS)} 通过 ==")
    for name, ok, detail in RESULTS:
        if not ok:
            print(f"  FAILED: {name} {detail}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
