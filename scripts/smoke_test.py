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
        # v2 关系表也要清：正式库可能带着抽卡明细 / 参数快照 / 概念索引，
        # 只删四张主表会在 sqlite 默认 foreign_keys=OFF 时留下孤儿行。
        # slot_extras / job_snapshots / profile_params 这三张「只加表」的附属表必须一起清：
        # 它们用 slot_id / job_id 指向被删的主表，但 sqlite 默认不级联也不报错，
        # 留下的孤儿行会让新插入的 draw_slots 复用 id=1 时撞 UNIQUE(slot_kind, slot_id)——
        # 症状是 POST /api/draw-sessions 直接 500，而正式库跑得好好的。
        for _table in ("concept_images", "concepts", "image_assets", "images",
                       "generation_jobs", "job_snapshots", "profile_params",
                       "draw_slot_tags", "draw_slots", "slot_extras",
                       "session_recipe_slots", "session_recipes", "session_loras",
                       "draw_profiles", "draws", "draw_sessions", "event_logs"):
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


def draw_deterministic() -> tuple[bool, str]:
    """同一 seed 必须抽出完全一样的结果，换 seed 必须不同。

    旧 gacha.py 已随旧实现一起删除，原先「新旧实现逐项比对」的用例随之取消；
    这里守的是行为契约本身 —— 种子复现是这个工具的核心承诺，与实现语言无关。
    """
    from backend.app.core.pools import discover_pools, draw_pull

    fp = ROOT / "zh_TW.json"
    data = json.loads(fp.read_text(encoding="utf-8-sig"))
    pools = discover_pools(data, str(fp), "zh_TW")
    sig = lambda cs: [(x["label"], tuple(x["tags"])) for x in cs]  # noqa: E731
    a = sig(draw_pull(random.Random(2026), pools, 2, False, {}, all_pools=pools))
    b = sig(draw_pull(random.Random(2026), pools, 2, False, {}, all_pools=pools))
    c = sig(draw_pull(random.Random(2027), pools, 2, False, {}, all_pools=pools))
    return len(a) == 2 and a == b and a != c, f"{len(a)} 条，同 seed 一致 / 换 seed 不同"


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
    ok_legacy, note = draw_deterministic()
    check("抽卡种子复现（同 seed 一致）", ok_legacy, note)
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

        print("-- 快速筛选（前端一个 input → 后端搜索） --")
        from backend.app.services.pools import _q_words
        check("搜索词：空格分词 + 下划线归一",
              _q_words(" Black_Hair  h ") == ["black", "hair", "h"],
              str(_q_words(" Black_Hair  h ")))
        probe = c.get("/api/pools/items", params={"kind": "角色", "limit": 3})
        first = (probe.json()["data"]["items"] or [{}])[0]
        tag = (first.get("tags") or "").split(",")[0].strip()
        if tag:
            # `black h` 这种半截词要能命中 `black hair`：库里取样，不写死数据
            half = tag[:max(2, len(tag) // 2)]
            r = c.get("/api/pools/items",
                      params={"kind": "角色", "q": half, "limit": 60}).json()["data"]
            check("半截词能搜到条目", r["total"] > 0, f"{half!r} → {r['total']} 条")
            r2 = c.get("/api/pools/items",
                       params={"kind": "角色", "q": f"{half} zzzznotexist"}).json()["data"]
            check("多词是 AND（加一个不存在的词必须归零）", r2["total"] == 0,
                  f"total={r2['total']}")
        else:
            check("半截词能搜到条目", False, "库里没有可取样的 tag")
            check("多词是 AND（加一个不存在的词必须归零）", False, "跳过")

        print("-- 参数预设 增删改查 --")
        # 增：不带 id、新名字 → 新建
        r = c.post("/api/gen-profiles", json={"name": "冒烟-测试预设", "steps": 30, "cfg": 5.0})
        created = r.json()["data"]
        check("预设·新建", r.status_code == 200 and created.get("steps") == 30,
              f"#{created.get('id')} steps={created.get('steps')}")
        # 改：带 id 改名 → 就地更新，不产生重复条目
        r2 = c.post("/api/gen-profiles",
                    json={"id": created["id"], "name": "冒烟-测试预设改", "steps": 28})
        renamed = r2.json()["data"]
        n_all = c.get("/api/gen-profiles").json()["data"]
        check("预设·带 id 改名就地更新",
              r2.status_code == 200 and renamed["id"] == created["id"]
              and renamed["steps"] == 28
              and sum(1 for x in n_all if x["id"] == created["id"]) == 1,
              f"steps={renamed.get('steps')}")
        # 改名撞到别的预设 → 409，不吞掉别人的预设
        r3 = c.post("/api/gen-profiles",
                    json={"id": created["id"], "name": profiles[0]["name"]})
        check("预设·改名撞名被拒(409)", r3.status_code == 409, f"HTTP {r3.status_code}")
        # 删：被配方引用 → 409；解绑后再删 → 200
        c.post("/api/recipes", json={
            "name": "冒烟-引用预设的配方",
            "definition": {"fixed_head": "masterpiece", "slots": []},
            "gen_profile_id": created["id"]})
        r4 = c.delete(f"/api/gen-profiles/{created['id']}")
        check("预设·被配方引用时拒绝删除(409)", r4.status_code == 409,
              f"HTTP {r4.status_code} / {r4.json().get('error', {}).get('message', '')[:40]}")
        ref = next(x for x in c.get("/api/recipes").json()["data"]
                   if x["name"] == "冒烟-引用预设的配方")
        c.put(f"/api/recipes/{ref['id']}", json={
            "name": "冒烟-引用预设的配方", "definition": {"fixed_head": "masterpiece", "slots": []},
            "gen_profile_id": None})
        r5 = c.delete(f"/api/gen-profiles/{created['id']}")
        check("预设·解绑后可删除", r5.status_code == 200 and r5.json()["data"]["deleted"] == created["id"],
              f"HTTP {r5.status_code}")
        c.delete(f"/api/recipes/{ref['id']}")
        check("预设·清理测试配方",
              all(x["id"] != ref["id"] for x in c.get("/api/recipes").json()["data"]))

        # 超重权重：池子里的原文要留着（用户要看原貌），只在写进 prompt 那一刻剥
        cloth = c.get("/api/pools/items", params={
            "kind": "服装", "pool": "组合预设/服装-女性复杂穿戴", "limit": 40}).json()["data"]
        raw = [i["tags"] for i in cloth["items"] if ":1." in (i["tags"] or "")]
        check("池子条目保留原始权重（运行期清理，不写库）",
              bool(raw), f"{len(raw)} 条带 :1.x 原文")
        pv = c.post("/api/recipes/preview", params={"pulls": 3, "seed": 11}, json={
            "fixed_head": "(masterpiece:1.5), best quality",
            "count_tags": "1girl",
            "slots": [{"pool": "组合预设/服装-女性复杂穿戴", "count": 2, "weight": 1.0}],
        }).json()["data"]
        prompts = [p["prompt"] for p in pv]
        check("组装 prompt 时剥掉超重权重",
              bool(prompts) and not any(":1." in x for x in prompts),
              prompts[0][:70] if prompts else "无")
        check("明细留痕 stripped_weight + 原文（能对照）",
              any(it.get("stripped_weight") and it.get("raw_tags")
                  for p in pv for it in p.get("detail", [])))

        # 任意值（free）：池里没有的词也要能出图 —— 自造 tag、外部画师名都走这条
        pv_free = c.post("/api/recipes/preview", params={"pulls": 2, "seed": 5}, json={
            "fixed_head": "masterpiece, best quality", "count_tags": "1girl",
            "slots": [{"pool": "画师", "free": "my custom artist"},
                      {"pool": "发型", "free": "silver hair, long hair"},
                      {"pool": "表情", "pick": "smile"}],
        }).json()["data"]
        prompts_free = [p["prompt"] for p in pv_free]
        check("任意值直接写进 prompt（不查池子）",
              bool(prompts_free) and all("my custom artist" in x and "silver hair" in x
                                         for x in prompts_free),
              prompts_free[0][:80] if prompts_free else "无")
        check("任意值明细标 free、与锁定条目共存",
              any(it.get("free") and it.get("locked") for p in pv_free for it in p.get("detail", []))
              and all("smile" in x for x in prompts_free))

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

        print("-- 池内切片：一个池混装多个维度时按维度收窄 --")
        # 用户口径：「随便改池子是伪需求，真正的需求是细化池子」。`人物-头发` 214 条
        # 混着长短 / 束法 / 质地 / 性别向 / 适格，整池随机就会「想画长发女孩抽到光头」。
        hair = next((p for p in pools if p["name"] == "人物-头发"), None)
        check("切片：头发池在池列表里", bool(hair), f"{hair['item_count'] if hair else 0} 条")
        if hair:
            fd = c.get(f"/api/pools/{hair['id']}/facets").json()["data"]
            names = [g["name"] for g in fd["groups"]]
            check("切片端点返回维度分组", fd["has_facets"] and "长度" in names, f"{names}")
            check("切片带条数（用户要知道切完还剩多少）",
                  all(o["count"] > 0 for g in fd["groups"] for o in g["options"]))
            sub = c.get("/api/pools/items", params={
                "pool": "人物-头发", "facets": "len-long", "limit": 60}).json()["data"]
            check("按切片收窄条目", 0 < sub["total"] < hair["item_count"],
                  f"{sub['total']} / {hair['item_count']}")
            check("收窄后的条目都真属于这一档",
                  all("long" in (i["tags"] or "").lower() for i in sub["items"]),
                  f"{[i['label'] for i in sub['items'][:3]]}")
            ds = c.post("/api/draw-sessions", json={
                "pulls": 3, "count": 1, "seed": 9,
                "facets": {"人物-头发": ["len-long"]},
                "definition": {"slots": [{"pool": "人物-头发", "count": 1}]},
            }).json()["data"]
            got = [d["prompt"] for d in ds["draws"]]
            check("抽卡时切片生效（抽到的都是长发）",
                  bool(got) and all("long" in p.lower() for p in got), f"{got}")
            check("切片不影响未选中的池（其他槽位照常随机）",
                  c.post("/api/draw-sessions", json={
                      "pulls": 1, "count": 1, "seed": 3,
                      "definition": {"slots": [{"pool": "发型", "count": 1}]},
                  }).status_code == 200)
        # 收编：danbooru 细分类池与粗池 100% 重叠，界面不再单列，但数据一条不删
        vis = [p["name"] for p in c.get("/api/pools").json()["data"]]
        allp = [p["name"] for p in c.get("/api/pools",
                                         params={"include_absorbed": True}).json()["data"]]
        check("细分类池已收编（界面不再单列）",
              not any(n.startswith("DanbooruTAG/hair_styles") for n in vis),
              f"{len(vis)} 池可见")
        check("收编只隐藏、数据仍在（可回滚）",
              any(n == "DanbooruTAG/hair_styles_tied" for n in allp)
              and len(allp) > len(vis), f"{len(allp)} - {len(vis)} = 隐藏 {len(allp)-len(vis)}")

        print("-- 画师图鉴：条目名 → 风格样图 --")
        # 文件名是 `<序号>_<原 tag>_result.png`，池里的 tag 带 `artist:` / `rib:` 前缀，
        # 归一化必须两边都能对上，否则一千多条名字里大部分都查不到图。
        from backend.app.core import semantics as sem_core
        check("画师名归一：前缀两种写法都认",
              sem_core._norm_artist("artist:satou daiji") == "satou daiji"
              and sem_core._norm_artist("artist:satou daiji", keep_prefix=True)
              == "artistsatou daiji"
              and sem_core._norm_artist("rib:y\\\\(uhki\\\\)", keep_prefix=True)
              == "riby(uhki)",
              "artist:/rib: 前缀 + 反斜杠括号")
        art = c.get("/api/pools/items", params={
            "kind": "画师", "pool": "画师图鉴", "limit": 60}).json()["data"]
        with_thumb = [i for i in art["items"] if i.get("thumb_url")]
        check("画师条目带风格样图地址（只给配得上的）",
              len(with_thumb) >= len(art["items"]) // 2,
              f"{len(with_thumb)}/{len(art['items'])} 条")
        if with_thumb:
            tr = c.get(with_thumb[0]["thumb_url"])
            check("样图可取（只读白名单，非任意路径）",
                  tr.status_code == 200
                  and tr.headers.get("content-type", "").startswith("image/"),
                  f"HTTP {tr.status_code} / {len(tr.content) // 1024} KB")
        else:
            check("样图可取（只读白名单，非任意路径）", False, "没有带样图的条目")
        miss = c.get("/api/semantics/artist-thumb", params={"name": "zzz-no-such-artist"})
        check("查不到样图返回 404，不猜路径", miss.status_code == 404,
              f"HTTP {miss.status_code}")

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

        # 抽卡台底部的「任意值」输入：装配编译成一个 pool='任意值' + free 的槽位。
        # 它不查池子、不吃过滤，池里不存在的词也必须原样进 prompt。
        extra = {"fixed_head": "masterpiece, best quality", "count_tags": "1girl",
                 "slots": [{"pool": "任意值", "count": 1, "weight": 1,
                            "free": "silver hair, from behind"}]}
        extra_s = c.post("/api/draw-sessions", json={
            "definition": extra, "pulls": 1, "seed": 3, "filter": "角色:fate"}).json()["data"]
        extra_prompt = extra_s["draws"][0]["prompt"]
        check("任意值槽位原样进 prompt（不查池、不吃过滤）",
              "silver hair" in extra_prompt and "from behind" in extra_prompt,
              extra_prompt[:90])
        check("任意值槽位在明细里标 free",
              any(x.get("free") for x in extra_s["draws"][0]["detail"]),
              f"{len(extra_s['draws'][0]['detail'])} 个槽位")

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

        # 点选的 `池:tag` 在配方里没有对应槽位时，原本会被静默忽略：
        # 画师池被筛过了，但配方根本不抽画师，prompt 里一个画师 tag 都没有。
        no_artist = {"fixed_head": "masterpiece, best quality", "template": "",
                     "fixed_tail": "",
                     "slots": [{"pool": "角色", "count": 1, "weight": 1,
                                "filter": ""}]}
        pinned = c.post("/api/draw-sessions", json={
            "definition": no_artist, "filter": "画师:bowalia",
            "pulls": 1, "seed": 5}).json()["data"]
        pin_detail = pinned["draws"][0]["detail"]
        check("无对应槽位的点选条件自动补入 prompt",
              "bowalia" in pinned["draws"][0]["prompt"].lower()
              and any(x["slot"] == "画师" and x.get("tags") for x in pin_detail)
              and any("自动补入" in w for w in pinned["warnings"]),
              f"prompt={pinned['draws'][0]['prompt'][:60]} / "
              f"{len(pinned['warnings'])} 条告警")
        has_artist = json.loads(json.dumps(no_artist))
        has_artist["slots"].insert(0, {"pool": "画师", "count": 1,
                                       "weight": 1, "filter": ""})
        dup = c.post("/api/draw-sessions", json={
            "definition": has_artist, "filter": "画师:bowalia",
            "pulls": 1, "seed": 5}).json()["data"]
        check("配方已有对应槽位时不重复补",
              "bowalia" in dup["draws"][0]["prompt"].lower()
              and not any("自动补入" in w for w in dup["warnings"]),
              f"{len(dup['warnings'])} 条告警")

        print("-- 任务与幂等 --")
        did = s2["draws"][0]["id"]
        j1 = c.post("/api/jobs", json={"draw_ids": [did]}).json()["data"]
        job_id = j1["created"][0] if j1["created"] else j1["reused"][0]
        final = wait_job(c, job_id)
        check("任务执行成功", final.get("status") == "succeeded",
              f"progress={final.get('progress')}")
        j2 = c.post("/api/jobs", json={"draw_ids": [did]}).json()["data"]
        check("重复提交幂等", not j2["created"] and job_id in j2["reused"])

        print("-- 结果卡内联状态 --")
        st = c.get(f"/api/draws/status?draw_ids={did}").json()["data"]
        check("按 draw 批量返回状态", len(st) == 1 and st[0]["draw_id"] == did,
              f"{len(st)} 条")
        check("状态带最新任务与已出图",
              (st[0].get("job") or {}).get("status") == "succeeded"
              and len(st[0]["images"]) >= 1,
              f"job={(st[0].get('job') or {}).get('status')} "
              f"imgs={len(st[0]['images'])}")
        empty = c.get("/api/draws/status?draw_ids=").json()["data"]
        dirty = c.get("/api/draws/status?draw_ids=abc,-1,999999").json()["data"]
        check("非法 id 容错不报错",
              empty == [] and len(dirty) == 1 and dirty[0]["job"] is None,
              f"empty={empty} dirty={len(dirty)} 条")

        print("-- 同一抽卡用不同 workflow 重跑（多模型核心） --")
        anima = c.post("/api/gen-profiles", json={
            "name": "smoke-anima", "checkpoint": "waiANIMAInt8_v10Int8Experimental.safetensors",
            "workflow": "anima.json", "clip": "qwen_3_06b_base.safetensors",
            "vae": "qwen_image_vae.safetensors", "steps": 10, "cfg": 4.5}).json()["data"]
        j3 = c.post("/api/jobs", json={"draw_ids": [did],
                                       "gen_profile_id": anima["id"], "force": True}).json()["data"]
        check("不同预设 force 重跑会新建任务", bool(j3["created"]),
              f"created={j3['created']}")
        if j3["created"]:
            jid3 = j3["created"][0]
            import sqlite3 as _sq
            _c = _sq.connect(str(SMOKE_DB))
            snap = _c.execute("select workflow, profile_json from job_snapshots where job_id=?",
                              (jid3,)).fetchone()
            first = _c.execute("select workflow from job_snapshots where job_id=?",
                               (job_id,)).fetchone()
            _c.close()
            check("每个 Job 记录自己的 workflow（修复假覆盖）",
                  snap and snap[0] == "anima.json" and first and first[0] == "sdxl_minimal.json",
                  f"job1={first[0] if first else None} job3={snap[0] if snap else None}")
            import json as _js
            check("Anima 专有参数进了该 Job 快照",
                  snap and _js.loads(snap[1]).get("clip") == "qwen_3_06b_base.safetensors",
                  str(snap[1][:120] if snap else None))
            check("workflow 不同 → 幂等键不同，两个任务共存",
                  jid3 != job_id)

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

        print("-- v2 关系模型：单一事实源 --")
        _c = sqlite3.connect(SMOKE_DB)
        try:
            cols = {
                t: {r[1] for r in _c.execute(f'PRAGMA table_info("{t}")')}
                for t in ("draws", "draw_sessions", "images", "draw_slots",
                          "draw_slot_tags", "draw_profiles", "session_loras",
                          "session_recipes", "session_recipe_slots",
                          "image_assets", "concepts", "concept_images")
            }
            check("重复 JSON 字段已从主表移除",
                  "detail_json" not in cols["draws"]
                  and "meta_json" not in cols["images"]
                  and "profile_snapshot_json" not in cols["draw_sessions"]
                  and "recipe_snapshot_json" not in cols["draw_sessions"])
            counts = {t: _c.execute(f'select count(*) from "{t}"').fetchone()[0]
                      for t in cols}
            check("抽卡明细写入关系表",
                  counts["draw_slots"] > 0 and counts["draw_slot_tags"] > 0
                  and counts["draw_profiles"] > 0 and counts["session_recipes"] > 0,
                  f"槽位 {counts['draw_slots']} / tag {counts['draw_slot_tags']}")
            check("图片元数据写入关系表", counts["image_assets"] > 0,
                  f"{counts['image_assets']} 条")
            check("概念物化表由写入路径增量维护",
                  counts["concepts"] > 0 and counts["concept_images"] > 0,
                  f"{counts['concepts']} 概念 / {counts['concept_images']} 关联")
        finally:
            _c.close()

        print("-- 通用概念（列表零图片 / 封面按需 / 详情页 50 张上限） --")
        cst = c.get("/api/concepts/status")
        check("概念索引状态", cst.status_code == 200 and cst.json()["ok"],
              f"{cst.json().get('data', {}).get('concept_count', 0)} 个概念")
        wj = c.get("/api/concepts/wall", params={"limit": 8}).json()
        wd = wj.get("data", {})
        items = wd.get("items", [])
        check("概念墙只返回文字与计数",
              wj.get("ok") is True and len(items) >= 1
              and all("thumbs" not in x and "thumb_url" not in x for x in items),
              f"{wd.get('total', 0)} 概念 / {wd.get('image_count', 0)} 图")
        pool_kinds = {p["kind"] for p in c.get("/api/pools").json()["data"]}
        check("概念过滤池都来自数据库类别",
              all((not x.get("pool")) or x["pool"] in pool_kinds for x in items))
        if items:
            first = items[0]
            check("卡片只带封面 ID，不带图片数组",
                  "cover_image_id" in first and "thumbs" not in first)
            cov = c.get("/api/concepts/cover", params={"key": first["key"]})
            cd = cov.json().get("data", {})
            check("按需封面只返回一张图",
                  cov.status_code == 200 and cd.get("found") is True
                  and bool(cd.get("image"))
                  and str(cd["image"].get("url", "")).startswith("/api/"))
            if cd.get("image"):
                check("封面缩略图可读取",
                      c.get(cd["image"]["url"]).status_code == 200)
            page = c.get("/api/concepts/images",
                         params={"key": first["key"], "limit": 50}).json().get("data", {})
            check("概念详情页首屏上限 50 张",
                  page.get("found") is True and page.get("limit") <= 50
                  and len(page.get("items", [])) <= 50,
                  f"total={page.get('total', 0)} / 返回 {len(page.get('items', []))} 张")
            check("详情页图片 URL 全部走本服务只读端点",
                  all(str(x.get("url", "")).startswith("/api/")
                      for x in page.get("items", [])))
            one = c.get("/api/concepts/thumbs", params={"key": first["key"]})
            check("旧反查接口兼容且只给一张",
                  one.status_code == 200 and one.json()["data"]["found"]
                  and len(one.json()["data"]["thumbs"]) <= 1)
            batch = c.post("/api/concepts/thumbs-batch",
                           json={"keys": [first["key"], "不存在的xyz"], "limit": 2})
            check("批量概念反查兼容", batch.status_code == 200
                  and len(batch.json()["data"]["items"]) == 2)
            info = c.get("/api/concepts/wall", params={"limit": 3, "kind": "底模"})
            check("信息类概念按类别查询可用",
                  info.status_code == 200 and info.json()["ok"] is True,
                  f"total={info.json().get('data', {}).get('total', 0)}")
            over = c.get("/api/concepts/images",
                         params={"key": first["key"], "limit": 500})
            check("详情页 limit 被拒绝（防一次性拉全库）",
                  over.status_code in (400, 422) and over.json().get("ok") is False,
                  f"HTTP {over.status_code}")

        print("-- 语义抽卡（索引缺失时验证降级） --")
        sst = c.get("/api/semantics/status").json()["data"]
        if sst.get("ready"):
            sug = c.get("/api/semantics/suggest",
                        params={"q": "厚涂暗色调逆光", "top_k": 4}).json()
            sitems = sug.get("data", {}).get("items", [])
            check("语义卡片只给风格锚点与历史计数",
                  sug.get("ok") is True and len(sitems) >= 1
                  and bool(sitems[0].get("thumb_url"))
                  and "thumbs" not in sitems[0].get("history", {})
                  and "image_count" in sitems[0].get("history", {}))
            check("外部风格样图只读分发",
                  c.get("/api/semantics/thumb",
                        params={"index": sitems[0]["index"]}).status_code == 200)
        else:
            degraded = c.get("/api/semantics/suggest", params={"q": "厚涂"})
            check("语义索引缺失时降级为 503",
                  degraded.status_code == 503 and degraded.json()["ok"] is False)
        paths = spec.get("paths", {})
        check("概念与语义端点已注册",
              all(p in paths for p in ("/api/concepts/wall", "/api/concepts/cover",
                                      "/api/concepts/images", "/api/semantics/suggest")))

        print("-- 意群双语词表（本地 map，补全与写入英文） --")
        vt = c.get("/api/vocab/status").json()["data"]
        check("词表已就绪（本地词表可重建）",
              vt.get("ready") is True and vt.get("count", 0) >= 30000,
              f"{vt.get('count')} 条")
        zh = c.get("/api/vocab/suggest", params={"q": "黑发", "limit": 5}).json()["data"]
        check("中文输入 → 中文候选、双语显示",
              zh["lang"] == "zh" and len(zh["items"]) >= 1
              and any(x["en"] == "black hair" and "黑发" in x["display"]
                      for x in zh["items"]),
              str([x["display"] for x in zh["items"][:2]]))
        en = c.get("/api/vocab/suggest", params={"q": "silver h", "limit": 5}).json()["data"]
        check("英文输入 → 英文候选、双语显示",
              en["lang"] == "en" and any("silver hair" in x["en"] and x["zh"]
                                          for x in en["items"]),
              str([x["display"] for x in en["items"][:2]]))
        tr = c.get("/api/vocab/translate", params={"text": "黑发, 长发"}).json()["data"]
        check("整段中文 → 英文 tag（写进 prompt 的永远是英文）",
              tr["en"] == "black hair, long hair" and not tr["missing"])
        check("词表端点已注册",
              all(p in paths for p in ("/api/vocab/suggest", "/api/vocab/translate")))

        print("-- 多模型 workflow 架构（数据驱动适配器） --")
        sys.path.insert(0, str(ROOT / "backend"))
        from app.core.workflow import WorkflowRegistry
        from app.services.comfy import ComfyClient
        from app.config import get_settings
        reg = WorkflowRegistry(ROOT / "backend" / "workflows")
        names = reg.templates()
        check("workflow 模板可被枚举（sdxl + anima）",
              "sdxl_minimal.json" in names and "anima.json" in names, str(names))
        sdxl_spec = reg.load("sdxl_minimal.json")
        anima_spec = reg.load("anima.json")
        check("spec 已加载（非兼容降级）",
              not sdxl_spec.legacy and not anima_spec.legacy,
              f"sdxl={sdxl_spec.id} anima={anima_spec.id}")
        check("两种模型 LoRA 策略不同且各自正确",
              sdxl_spec.lora["class_type"] == "LoraLoader"
              and anima_spec.lora["class_type"] == "LoraLoaderModelOnly"
              and anima_spec.params["MODEL_SRC"]["default"] == "44",
              f"{sdxl_spec.lora['class_type']} / {anima_spec.lora['class_type']}")
        client = ComfyClient(get_settings())
        profile = {"checkpoint": "test.safetensors", "steps": 5,
                   "loras": [{"name": "l.safetensors", "weight": 0.8}]}
        for wf_name in ("sdxl_minimal.json", "anima.json"):
            wf = client.build_workflow(profile=profile, prompt="a cat", negative="bad",
                                       seed=42, workflow_name=wf_name, prefix="smoke")
            leftover = [v for node in wf.values() for v in node.get("inputs", {}).values()
                        if isinstance(v, str) and v.startswith("$")]
            check(f"构图无残留占位符: {wf_name}", not leftover,
                  f"{len(wf)} 节点")
        check("结果节点由 spec 指定，不扫全部节点",
              sdxl_spec.result_nodes == ("7",) and anima_spec.result_nodes == ("46",))
        cfg = c.get("/api/config").json()["data"]
        check("/api/config 下发 workflow_specs",
              len(cfg.get("workflow_specs", [])) >= 2
              and all("capabilities" in w for w in cfg["workflow_specs"]),
              str([w.get("id") for w in cfg.get("workflow_specs", [])]))
        # 纯 UNet（MOSS/Anima）与完整 checkpoint（SDXL）在 ComfyUI 里是两个目录、
        # 两套枚举。spec 必须标明归哪边，前端才能列出正确的候选。
        kinds = {w["name"]: w.get("ckpt_kind") for w in cfg["workflow_specs"]}
        check("权重加载器类型由 spec 标明（UNet / checkpoint）",
              kinds.get("moss.json") == "unet" and kinds.get("anima.json") == "unet"
              and kinds.get("sdxl_minimal.json") == "checkpoint", str(kinds))
        defaults = {w["name"]: (w.get("defaults") or {}) for w in cfg["workflow_specs"]}
        check("spec 透出换模型族要跟着换的默认权重",
              defaults.get("moss.json", {}).get("CKPT")
              and defaults.get("moss.json", {}).get("CLIP") == "qwen3.5_9b_w4a8_gptq.safetensors"
              and defaults.get("moss.json", {}).get("STEPS"),
              str(defaults.get("moss.json")))
        models = c.get("/api/comfy/models").json()["data"]
        check("/api/comfy/models 单独下发 UNet 列表（否则纯 UNet 模型在前端不可选）",
              isinstance(models.get("unet"), list),
              f"unet={len(models.get('unet') or [])} ckpt={len(models.get('checkpoints') or [])}")
        import sqlite3 as _sq
        _db = _sq.connect(str(get_settings().db_path))
        _tables = {r[0] for r in _db.execute(
            "select name from sqlite_master where type='table'")}
        _db.close()
        check("三张新表存在（job_snapshots/profile_params/slot_extras）",
              {"job_snapshots", "profile_params", "slot_extras"} <= _tables)

        print("-- 离线依赖（零下载约定） --")
        req = (ROOT / "requirements.txt").read_text(encoding="utf-8")
        bat = (ROOT / "scripts" / "start.bat").read_text(encoding="utf-8")
        check("离线依赖搬运脚本存在",
              (ROOT / "scripts" / "vendor_deps.py").is_file())
        check("requirements 不会触发 ONNX 下载",
              "onnxruntime==" not in req and "tokenizers==" not in req)
        check("start.bat 不自动 pip 安装",
              "python -m pip install -r requirements.txt ||" not in bat
              and "Installing dependencies" not in bat)
        check("start.bat 自动挑选已装依赖的解释器",
              'set "PY="' in bat
              and "GACHA_PYTHON" in bat
              and '"%PY%" scripts\\run_server.py' in bat
              and "WorkBuddy bundled Python" in bat)
        vd = ROOT / "vendor" / "pydeps"
        check("本机依赖已搬入 vendor/pydeps",
              (vd / "onnxruntime" / "__init__.py").is_file()
              and (vd / "tokenizers" / "__init__.py").is_file())
        from backend.app.core import embed  # noqa: E402
        cached = (embed.cache_model_dir() / "model.onnx").is_file()
        check("模型权重已搬入项目（零下载）", embed.is_ready(),
              "缓存副本仍在（可再生）" if cached else "缓存副本已剪切移除")

        print("-- 清空重建与索引重建（方案 C 固定入口） --")
        reset_src = (ROOT / "scripts" / "reset_db.py").read_text(encoding="utf-8")
        rebuild_src = (ROOT / "scripts" / "rebuild_concepts.py").read_text(encoding="utf-8")
        check("清空脚本支持 dry-run 且先备份",
              "--dry-run" in reset_src and "shutil.copy2" in reset_src
              and "shutil.move" in reset_src)
        check("清空只归档、不物理删除",
              "unlink(" not in reset_src and "os.remove(" not in reset_src
              and "shutil.rmtree" not in reset_src)
        check("概念索引可全量重建", "rebuild(" in rebuild_src)
        check("归档目录不入库",
              "data/archive/" in (ROOT / ".gitignore").read_text(encoding="utf-8"))
        mig = (ROOT / "backend" / "migrations" / "versions" /
               "0001_initial.py").read_text(encoding="utf-8")
        check("Alembic 基线已重做为 v2 关系模型",
              'revision = "0001_v2_relational"' in mig)

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
