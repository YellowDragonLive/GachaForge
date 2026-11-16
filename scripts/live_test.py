# -*- coding: utf-8 -*-
"""真实后端端到端：真抽一张、真让 ComfyUI 出图、逐项核对落盘结果。

    python scripts/live_test.py                 # 抽 1 张，最多等 600 秒
    python scripts/live_test.py --wait 300      # 改超时
    python scripts/live_test.py --url 127.0.0.1:8765

和 scripts/smoke_test.py 的分工：
  * smoke_test  强制 mock + 临时库副本，秒级跑 76 项契约回归，不需要 ComfyUI；
  * live_test   必须 mock=0，打真实服务 + 真实 ComfyUI，验的是「mock 测不出来的东西」：
                checkpoint 名对不对、workflow 模板渲得出来、图真的落盘、缩略图真的生成、
                锁定的条目真的进了 prompt、人数 tag 只出现一次。

前置：
  1. ComfyUI 在 GACHA_COMFY_URL（默认 127.0.0.1:8188）上跑着；
  2. .env 里 GACHA_COMFY_MOCK=0；
  3. 服务已启动（scripts/start.bat 或 scripts/run_server.py）。
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.core.weights import strip_weights  # noqa: E402


def pretty(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


class Client:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        # trust_env=False：本机服务不能走系统代理。httpx 默认会吃 http_proxy，
        # 打 127.0.0.1 时被代理截走，表现为「请求成功但拿回空结果」，
        # 排查起来像服务端 bug（实测轮询一直读不到刚出图的任务）。
        self.http = httpx.Client(base_url=self.base, timeout=60.0, trust_env=False)

    def get(self, path: str, **params):
        r = self.http.get(path, params=params or None)
        r.raise_for_status()
        body = r.json()
        if not body.get("ok", True):
            raise RuntimeError(f"GET {path} 失败：{pretty(body)[:300]}")
        return body.get("data")

    def post(self, path: str, payload: dict):
        r = self.http.post(path, json=payload)
        if r.status_code >= 400:
            raise RuntimeError(f"POST {path} → {r.status_code}：{r.text[:400]}")
        body = r.json()
        if not body.get("ok", True):
            raise RuntimeError(f"POST {path} 失败：{pretty(body)[:300]}")
        return body.get("data")


def step(n: int, total: int, text: str) -> None:
    print(f"[{n}/{total}] {text}")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="真实后端 + 真实 ComfyUI 端到端")
    ap.add_argument("--url", default="127.0.0.1:8765", help="工作台地址")
    ap.add_argument("--wait", type=int, default=600, help="等出图的秒数上限")
    ap.add_argument("--seed", type=int, default=20261116)
    args = ap.parse_args()

    c = Client(f"http://{args.url}")
    total = 7
    t0 = time.time()

    # ---- 1. 前置：必须是真实模式，ComfyUI 必须在线 ----
    cfg = c.get("/api/config")
    if cfg.get("comfy_mock"):
        print("✗ 当前是 mock 模式（GACHA_COMFY_MOCK=1），出的是占位图。")
        print("  把 .env 改成 GACHA_COMFY_MOCK=0 后重启服务，或直接跑 scripts/smoke_test.py。")
        return 2
    comfy_url = cfg.get("comfy_url", "")
    try:
        sysinfo = httpx.get(f"{comfy_url}/system_stats", timeout=5.0).json()
        ver = sysinfo.get("system", {}).get("comfyui_version", "?")
        print(f"[1/{total}] 真实模式 ✓  ComfyUI {ver} @ {comfy_url}")
    except Exception as exc:
        print(f"✗ ComfyUI 连不上（{comfy_url}）：{exc}")
        return 2

    # ---- 2. 找一个能锁定的角色与发型条目 ----
    def first_item(kind: str) -> dict:
        data = c.get("/api/pools/items", kind=kind, limit=40)
        for it in data.get("items") or []:
            label = str(it.get("label") or "").strip()
            tags = str(it.get("tags") or "").strip()
            if 2 <= len(label) <= 40 and tags and "," not in label:
                return it
        raise RuntimeError(f"「{kind}」里没找到可用于锁定的条目")

    role = first_item("角色")
    # 发型必须与角色分开挑：人物-头发 池里也有以角色名命名的条目（25时miku），
    # 撞上就变成同一条目锁两次、prompt 里同一个 tag 出现两遍。
    hair = None
    for it in c.get("/api/pools/items", kind="发型", limit=40).get("items") or []:
        label = str(it.get("label") or "").strip()
        if (2 <= len(label) <= 40 and it.get("tags") and "," not in label
                and label != role["label"] and it.get("pool") != role.get("pool")):
            hair = it
            break
    if not hair:
        raise RuntimeError("「发型」里找不到与角色不同的可用条目")
    step(2, total, f"锁定条目：角色「{role['label']}」/ 发型「{hair['label']}」")

    # ---- 3. 建一次抽卡（装配式定义：人数由 count_tags 统一注入）----
    definition = {
        "fixed_head": "masterpiece, best quality",
        "fixed_tail": "",
        "count_tags": "1girl",
        "slots": [
            {"pool": role["pool"], "count": 1, "pick": role["label"]},
            {"pool": hair["pool"], "count": 1, "pick": hair["label"]},
        ],
    }
    sess = c.post("/api/draw-sessions", {
        "definition": definition, "pulls": 1, "count": 1,
        "seed": args.seed, "gen_profile_id": 1,
    })
    draw = sess["draws"][0]
    prompt = str(draw.get("prompt") or "")
    print(f"[3/{total}] 抽到 draw #{draw['id']}")
    print(f"        prompt: {prompt[:220]}{'…' if len(prompt) > 220 else ''}")

    # prompt 必须真的包含锁定的东西与人数——这是 mock 模式最容易漏的一环
    low = prompt.lower()
    problems: list[str] = []
    if low.count("1girl") != 1:
        problems.append(f"人数 tag「1girl」出现 {low.count('1girl')} 次（应为 1）")
    for tag in [str(role["tags"]).split(",")[0].strip(),
                str(hair["tags"]).split(",")[0].strip()]:
        # 池子里可能带手写权重（`(closed collar…:1.2)`），prompt 里是剥过的版本，
        # 比对也要比剥过的：否则「清理生效」反而被当成「锁定 tag 没进 prompt」。
        want = strip_weights(tag).strip().strip("([{ ").strip()
        if want and want.lower() not in low:
            problems.append(f"锁定的 tag「{tag}」没进 prompt")
    locked = [x.get("locked") for x in draw.get("detail") or [] if x.get("locked")]
    if len(locked) < 2:
        problems.append(f"detail 里只记到 {len(locked)} 个锁定槽位（应为 2）")
    tags = [t.strip().lower() for t in prompt.split(",") if t.strip()]
    dupes = sorted({t for t in tags if tags.count(t) > 1})
    if dupes:
        problems.append("prompt 里有重复 tag：" + "、".join(dupes))
    # 条目自带的手写权重必须在出图前剥掉（池子文本不改，prompt 要干净）
    leftover = [t for t in prompt.split(",")
                if strip_weights(t.strip()) != t.strip()]
    if leftover:
        problems.append("prompt 里还有手写权重：" + "、".join(leftover[:3]))
    if problems:
        print("✗ prompt 核对失败：" + "；".join(problems))
        return 1
    step(4, total, "prompt 核对通过：人数 1 次、两个锁定 tag 都在")

    # ---- 5. 提交生成任务 ----
    c.post("/api/jobs", {"draw_ids": [draw["id"]], "gen_profile_id": 1})
    print(f"[5/{total}] 已提交生成任务，等 ComfyUI 出图（上限 {args.wait}s）…")

    # ---- 6. 轮询到 succeeded / failed ----
    last = ""
    job: dict | None = None
    images: list = []
    deadline = time.time() + args.wait
    while time.time() < deadline:
        rows = c.get("/api/draws/status", draw_ids=str(draw["id"])) or []
        st = rows[0] if rows else {}
        job, images = st.get("job"), st.get("images") or []
        if job:
            line = f"{job.get('status')} {job.get('progress') or 0}%"
            if line != last:
                print(f"        {line}  ({int(time.time() - t0)}s)")
                last = line
            if job.get("status") == "failed":
                print(f"✗ 生成失败：{job.get('error_code')} {job.get('error_message')}")
                return 1
        if images:
            break
        time.sleep(2)
    if not images:
        print(f"✗ 等了 {args.wait}s 还没出图（job 状态 {job and job.get('status')}）")
        print(f"   最后一次 /api/draws/status 返回 {len(rows)} 行：{str(rows)[:300]}")
        return 1
    step(6, total, f"出图成功：{len(images)} 张，用时 {int(time.time() - t0)}s")

    # ---- 7. 落盘核对：原图、缩略图、概念索引 ----
    db = Path(cfg["db_path"])
    con = sqlite3.connect(db)
    try:
        row = con.execute(
            "select id, file_path, thumb_path, width, height, file_size "
            "from images order by id desc limit 1").fetchone()
        concepts = con.execute("select count(*) from concepts").fetchone()[0]
        linked = con.execute("select count(*) from concept_images").fetchone()[0]
    finally:
        con.close()

    if not row:
        print("✗ 库里没有图片记录")
        return 1
    img_id, file_path, thumb_path, w, h, size = row
    fpath = Path(file_path)
    fpath = fpath if fpath.is_absolute() else ROOT / fpath
    tpath = Path(thumb_path or "")
    tpath = tpath if tpath.is_absolute() else ROOT / tpath

    fail: list[str] = []
    if not fpath.is_file():
        fail.append(f"原图不存在：{fpath}")
    elif fpath.stat().st_size < 5000:
        fail.append(f"原图只有 {fpath.stat().st_size} 字节，像占位图")
    if not tpath.is_file():
        fail.append(f"缩略图不存在：{tpath}")
    if (w or 0) < 256 or (h or 0) < 256:
        fail.append(f"尺寸异常：{w}×{h}")
    if concepts < 1 or linked < 1:
        fail.append(f"概念索引没落库（concepts={concepts}, concept_images={linked}）")

    if fail:
        print("✗ 落盘核对失败：" + "；".join(fail))
        return 1

    print(f"[7/{total}] 落盘核对通过")
    print()
    print("=" * 62)
    print(f"PASS  真实后端端到端  {int(time.time() - t0)}s")
    print(f"  图    : {fpath}  ({w}×{h}, {size / 1024:.0f} KB)")
    print(f"  缩略图: {tpath}")
    print(f"  prompt: {prompt[:160]}")
    print(f"  概念  : {concepts} 个，关联 {linked} 条")
    print("=" * 62)
    print(f"\n清掉这次测试再跑：python scripts/clean_db.py --yes")
    # 机读结果，方便别的脚本/人后续取图
    print(f"\nIMAGE={fpath}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
