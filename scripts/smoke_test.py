# -*- coding: utf-8 -*-
"""全链路冒烟：固定入口 `python scripts/smoke_test.py`。

默认强制 mock 模式，不依赖 ComfyUI 在线。覆盖编译、健康检查、抽卡复现、
旧算法一致性、抽卡 detail 前后端契约、任务状态机、幂等、图片落盘/缩略图/标注/导出、
静态前端与错误结构。

重要：全程跑在 %TEMP% 的临时库副本上，不写正式库、不污染画廊。
配置必须在 import backend.app.main 之前设好，因为 db.py 模块级就会创建 engine。
"""
from __future__ import annotations

import json
import os
import random
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.config import load_dotenv  # noqa: E402

load_dotenv()

# ---- 隔离：临时库副本 + 临时图片目录 ----
SMOKE_DIR = Path(tempfile.mkdtemp(prefix="gacha_smoke_"))
SMOKE_DB = SMOKE_DIR / "gacha.db"
_src = Path(os.environ.get("GACHA_DB_PATH", "data/gacha.db"))
if not _src.is_absolute():
    _src = ROOT / _src

if _src.is_file():
    # SQLite backup API：即使正式库正在 WAL 模式被服务占用，也能拿到一致快照。
    # 注意 sqlite3 的 with 只提交事务、不 close()，必须显式关闭，
    # 否则 Windows 上句柄不释放，cleanup() 删不掉临时目录。
    _con, _out = sqlite3.connect(_src), sqlite3.connect(SMOKE_DB)
    try:
        _con.backup(_out)
    finally:
        _con.close()
        _out.close()
    # 只复用卡池/配方/预设等基础数据；运行时记录一律不带进副本，
    # 否则「有图片记录但文件已被删」会让原图接口检查假失败
    _c = sqlite3.connect(SMOKE_DB)
    try:
        for _table in ("images", "generation_jobs", "draws", "draw_sessions"):
            _c.execute(f"DELETE FROM {_table}")
        _c.commit()
    finally:
        _c.close()
else:
    # 正式库还不存在（全新 clone）：临时库自建表并导入旧数据
    _env = os.environ.copy()
    _env.update({
        "GACHA_DB_PATH": str(SMOKE_DB),
        "GACHA_OUTPUTS_DIR": str(SMOKE_DIR / "outputs"),
        "GACHA_THUMBS_DIR": str(SMOKE_DIR / "thumbs"),
        "GACHA_COMFY_MOCK": "1",
    })
    for _script, _args in (("scripts/init_db.py", []),
                           ("scripts/migrate_legacy.py", ["--if-empty"])):
        subprocess.run([sys.executable, _script, *_args], cwd=ROOT,
                       env=_env, check=True)

os.environ.update({
    "GACHA_COMFY_MOCK": "1",
    "GACHA_DB_PATH": str(SMOKE_DB),
    "GACHA_OUTPUTS_DIR": str(SMOKE_DIR / "outputs"),
    "GACHA_THUMBS_DIR": str(SMOKE_DIR / "thumbs"),
})

from fastapi.testclient import TestClient  # noqa: E402

from backend.app.main import app  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def cleanup() -> None:
    """释放 SQLite 句柄后删除临时目录，否则 Windows 上文件被占用删不掉。"""
    try:
        from backend.app.db import engine
        engine.dispose()
    except Exception:
        pass
    shutil.rmtree(SMOKE_DIR, ignore_errors=True)


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


def frontend_contract() -> tuple[bool, str]:
    """Node 跑前端纯函数契约测试；无 node 时跳过（不计失败）。"""
    node = shutil.which("node")
    script = ROOT / "scripts" / "test_frontend.mjs"
    if not node or not script.is_file():
        return True, "跳过（node 或测试脚本不可用）"
    try:
        p = subprocess.run([node, str(script)], cwd=ROOT, capture_output=True,
                           text=True, timeout=60)
    except Exception as exc:
        return False, f"执行失败: {exc}"
    lines = p.stdout.strip().splitlines()
    return p.returncode == 0, (lines[-1] if lines else p.stderr.strip()[:120])


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
    ok_fe, note_fe = frontend_contract()
    check("前端 detail 契约（Node）", ok_fe, note_fe)

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

        # 点选控件的数据源：路由必须排在 /{pool_id} 之前，否则会被 int 校验吞掉变 422
        hot = c.get("/api/pools/tag-suggest?limit=20")
        hot_data = hot.json()["data"] if hot.status_code == 200 else {}
        check("tag 候选端点可用（路由顺序）",
              hot.status_code == 200 and bool(hot_data.get("items"))
              and all("value" in x and "count" in x for x in hot_data["items"]),
              f"HTTP {hot.status_code} / {len(hot_data.get('items', []))} 项")
        sug = c.get("/api/pools/tag-suggest?q=asuna&limit=20").json()["data"]
        check("tag 候选：asuna 子串联想",
              any("asuna" in x["value"] for x in sug["items"])
              and all("," not in x["value"] and "\\" not in x["value"] for x in sug["items"]),
              f"{[x['value'] for x in sug['items'][:4]]}")
        scoped = c.get("/api/pools/tag-suggest?pool=角色&q=asuna").json()["data"]
        check("tag 候选：按类别限定",
              scoped["pool"] == "角色" and any("asuna" in x["value"] for x in scoped["items"]),
              f"{scoped['pool']} / {len(scoped['items'])} 项")

        print("-- 抽卡与复现 --")
        body = {"recipe_id": recipes[0]["id"], "pulls": 3, "seed": 42}
        s1 = c.post("/api/draw-sessions", json=body).json()["data"]
        s2 = c.post("/api/draw-sessions", json=body).json()["data"]
        check("同 seed 结果完全一致",
              [d["prompt"] for d in s1["draws"]] == [d["prompt"] for d in s2["draws"]],
              f"{len(s1['draws'])} 抽 / {s1['pool_count']} 池")
        check("抽卡快照已保存",
              c.get(f"/api/draw-sessions/{s2['session_id']}").json()["ok"])

        # detail 契约：两种抽卡模式都必须返回 {slot, tags: list[str]}，
        # 否则前端渲染卡片时会抛 "x.tags.join is not a function"。
        recipe_detail = [x for d in s1["draws"] for x in d["detail"]]
        check("配方模式 detail 契约统一",
              bool(recipe_detail) and all(
                  "slot" in x and isinstance(x.get("tags"), list) for x in recipe_detail),
              f"{len(recipe_detail)} 个槽位")
        free = c.post("/api/draw-sessions", json={"pulls": 2, "seed": 7}).json()["data"]
        free_detail = [x for d in free["draws"] for x in d["detail"]]
        check("全池随机 detail 契约统一",
              bool(free_detail) and all(
                  "slot" in x and isinstance(x.get("tags"), list) for x in free_detail),
              f"{len(free_detail)} 个槽位")

        # 过滤语义：裸关键字作用于全部卡池，会把配方槽位静默清空；
        # 按池语法、大小写不敏感、告警与空槽位标记都必须成立。
        inline = {"fixed_head": "masterpiece, best quality", "template": "",
                  "fixed_tail": "",
                  "slots": [{"pool": "画师", "count": 1, "weight": 1, "filter": ""},
                            {"pool": "action", "count": 1, "weight": 1, "filter": ""},
                            {"pool": "角色", "count": 1, "weight": 1, "filter": ""}]}

        def draw_with(flt):
            return c.post("/api/draw-sessions", json={
                "definition": inline, "pulls": 1, "seed": 99, "filter": flt})

        plain = draw_with("").json()["data"]
        plain_slots = {x["slot"] for x in plain["draws"][0]["detail"]}
        per_pool = draw_with("角色:fate").json()["data"]
        per_slots = {x["slot"] for x in per_pool["draws"][0]["detail"]}
        check("按池过滤保留全部配方槽位",
              plain_slots == per_slots and "action" in per_slots,
              f"{len(per_slots)} 槽位 / {per_pool['pool_count']} 池")
        bare = draw_with("fate").json()["data"]
        check("裸关键字告警并标记空槽位",
              bool(bare["warnings"])
              and any(x.get("empty") for x in bare["draws"][0]["detail"])
              and bare["pool_count"] < per_pool["pool_count"],
              f"{bare['pool_count']} 池 / {len(bare['warnings'])} 条告警")
        upper = draw_with("角色:FATE")
        u = upper.json()["data"] if upper.status_code == 200 else {}
        up_slots = {x["slot"]: x for x in u.get("draws", [{}])[0].get("detail", [])}
        check("过滤大小写不敏感",
              upper.status_code == 200 and bool(up_slots.get("角色", {}).get("tags")),
              f"示例写法 角色:FATE → HTTP {upper.status_code}")

        # 表单过滤是会话级设置，应临时覆盖配方槽位里写死的 filter；
        # 两层 AND 会让「角色:asuna」被槽位残留的 filter:fate 全部筛掉。
        with_slot_filter = json.loads(json.dumps(inline))
        with_slot_filter["slots"][2]["filter"] = "fate"

        def role_slot(data):
            return next(x for x in data["draws"][0]["detail"] if x["slot"] == "角色")

        r1 = c.post("/api/draw-sessions", json={
            "definition": with_slot_filter, "filter": "角色:asuna",
            "pulls": 1, "seed": 7}).json()["data"]
        role1 = role_slot(r1)
        check("表单过滤覆盖槽位级 filter",
              not role1.get("empty")
              and "asuna" in " ".join(role1["tags"]).lower()
              and any("覆盖" in w for w in r1["warnings"]),
              f"角色抽到 {'/'.join(role1['tags'])[:50]} / {len(r1['warnings'])} 条告警")
        r2 = c.post("/api/draw-sessions", json={
            "definition": with_slot_filter, "filter": "",
            "pulls": 1, "seed": 7}).json()["data"]
        role2 = role_slot(r2)
        check("表单留空时槽位 filter 仍生效",
              not role2.get("empty")
              and "fate" in " ".join(role2["tags"]).lower()
              and not any("覆盖" in w for w in r2["warnings"]),
              f"角色抽到 {'/'.join(role2['tags'])[:50]}")

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
        for asset in ("/app.js", "/api.js", "/detail.js", "/widgets.js", "/styles.css"):
            check(f"静态资源 {asset}", c.get(asset).status_code == 200)
        spec = c.get("/openapi.json").json()
        check("SSE 端点已注册", "/api/jobs/stream" in spec.get("paths", {}))
        check("tag 候选端点已注册",
              "/api/pools/tag-suggest" in spec.get("paths", {}))

        print("-- 通用概念缩略图（数据库驱动） --")
        cst = c.get("/api/concepts/status")
        check("概念索引状态", cst.status_code == 200 and cst.json()["ok"],
              f"{cst.json().get('data', {}).get('concept_count', 0)} 个概念")
        wj = c.get("/api/concepts/wall", params={"limit": 8, "thumbs": 2}).json()
        wd = wj.get("data", {})
        check("概念墙返回带缩略图的卡片",
              wj.get("ok") is True and len(wd.get("items", [])) >= 1,
              f"{wd.get('total', 0)} 概念 / {wd.get('image_count', 0)} 图")
        pool_kinds = {p["kind"] for p in c.get("/api/pools").json()["data"]}
        check("概念过滤池都来自数据库类别",
              all((not x.get("pool")) or x["pool"] in pool_kinds
                  for x in wd.get("items", [])))
        if wd.get("items"):
            first = wd["items"][0]
            check("概念卡片带真实代表图",
                  bool(first.get("thumbs"))
                  and str(first.get("thumb_url", "")).startswith("/api/"))
            check("概念缩略图可读取", c.get(first["thumb_url"]).status_code == 200)
            one = c.get("/api/concepts/thumbs", params={"key": first["key"]})
            check("单概念反查", one.status_code == 200 and one.json()["data"]["found"])
            batch = c.post("/api/concepts/thumbs-batch",
                           json={"keys": [first["key"], "不存在的xyz"], "limit": 2})
            check("批量概念反查", batch.status_code == 200
                  and len(batch.json()["data"]["items"]) == 2)
            info = c.get("/api/concepts/wall", params={"limit": 3, "kind": "底模"})
            check("信息类概念按类别查看", info.json()["data"]["total"] >= 1)

        print("-- 语义抽卡（索引缺失时验证降级） --")
        sst = c.get("/api/semantics/status").json()["data"]
        if sst.get("ready"):
            sug = c.get("/api/semantics/suggest",
                        params={"q": "厚涂暗色调逆光", "top_k": 4}).json()
            sitems = sug.get("data", {}).get("items", [])
            check("语义卡片带风格样图与历史出图",
                  sug.get("ok") is True and len(sitems) >= 1
                  and "history" in sitems[0] and bool(sitems[0].get("thumb_url")))
            check("外部风格样图只读分发",
                  c.get("/api/semantics/thumb",
                        params={"index": sitems[0]["index"]}).status_code == 200)
        else:
            degraded = c.get("/api/semantics/suggest", params={"q": "厚涂"})
            check("语义索引缺失时降级为 503",
                  degraded.status_code == 503 and degraded.json()["ok"] is False)
        check("概念与语义端点已注册",
              "/api/concepts/wall" in spec.get("paths", {})
              and "/api/semantics/suggest" in spec.get("paths", {}))

        print("-- 离线依赖（零下载约定） --")
        req = (ROOT / "requirements.txt").read_text(encoding="utf-8")
        bat = (ROOT / "scripts" / "start.bat").read_text(encoding="utf-8")
        check("离线依赖搬运脚本存在",
              (ROOT / "scripts" / "vendor_deps.py").is_file())
        check("requirements 不会触发 ONNX 下载",
              "onnxruntime==" not in req and "tokenizers==" not in req)
        check("start.bat 不自动 pip 安装",
              "pip install -r requirements.txt" not in bat.replace(
                  "Install manually once - python -m pip install -r requirements.txt", ""))
        vd = ROOT / "vendor" / "pydeps"
        check("本机依赖已搬入 vendor/pydeps",
              (vd / "onnxruntime" / "__init__.py").is_file()
              and (vd / "tokenizers" / "__init__.py").is_file())
        from backend.app.core import embed  # noqa: E402
        cached = (embed.cache_model_dir() / "model.onnx").is_file()
        check("模型权重已搬入项目（零下载）", embed.is_ready(),
              "缓存副本仍在（可再生）" if cached else "缓存副本已剪切移除")

    passed = sum(1 for _n, ok, _d in RESULTS if ok)
    print(f"\n== 汇总: {passed}/{len(RESULTS)} 通过 ==")
    for name, ok, detail in RESULTS:
        if not ok:
            print(f"  FAILED: {name} {detail}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    try:
        _rc = main()
    finally:
        cleanup()
    raise SystemExit(_rc)
