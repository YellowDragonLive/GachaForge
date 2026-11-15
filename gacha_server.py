# -*- coding: utf-8 -*-
"""多 JSON 抽卡器 · 迷你配套服务器（HTML 呈现，抽卡由 gacha.py 负责）。

用法：
  python gacha_server.py [端口]
然后浏览器打开 http://127.0.0.1:8765/ （默认端口 8765）。

提供：
  GET  /              -> gacha.html 页面
  GET  /gacha.html    -> 同上
  GET  /data          -> 工作目录下 *.json 文件清单
  GET  /data/<名字>    -> 读取某个 json（防目录穿越）
  GET  /img?f=<相对路径> -> 读取 outputs/ 下生成的图片（防目录穿越）
  POST /api/gacha     -> 调用 gacha.py 引擎抽卡，返回结构化结果
  POST /api/generate  -> 用 gacha_to_sdxl.py 把一组 prompt 送进 ComfyUI 生图
  GET  /api/generate  -> 同上（空参数兜底）

带 CORS 头，允许把 gacha.html 从本地 file:// 打开后直接连本服务器。
"""

import collections
import datetime
import glob
import json
import os
import random
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import gacha  # 复用 gacha.py 的抽卡引擎（同一目录）
import gacha_to_sdxl  # 复用生图桥接（同一目录）
import gacha_wildcards  # 词卡库扫描（stable-diffusion-webui-wildcards/*.txt）
import gacha_combo  # 组合配方引擎（combos/*.json）

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8765

# LoRA 列表缓存（ComfyUI 不可用时回退扫这些目录）
_LORA_CACHE = None
LORA_DIR_CANDIDATES = [
    Path(r"X:\ai_tool\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\ComfyUI\models\loras"),
    Path(r"X:\work_code\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\ComfyUI\models\loras"),
    Path(r"C:\ComfyUI_windows_portable\ComfyUI\models\loras"),
]
LORA_SUFFIXES = (".safetensors", ".pt", ".ckpt", ".bin")


def list_loras(refresh=False):
    """列出 ComfyUI 可用的 LoRA 文件名（走 object_info，失败则扫目录）。"""
    global _LORA_CACHE
    if _LORA_CACHE is not None and not refresh:
        return _LORA_CACHE, "cache"
    names, source = None, "comfy"
    try:
        with urllib.request.urlopen(
                gacha_to_sdxl.COMFY_URL + "/object_info/LoraLoader", timeout=8) as r:
            info = json.loads(r.read())
        names = list(info["LoraLoader"]["input"]["required"]["lora_name"][0])
    except Exception:  # noqa: BLE001
        names = None
    if names is None:
        source = "fs"
        names = []
        for root in LORA_DIR_CANDIDATES:
            if not root.is_dir():
                continue
            for fp in root.rglob("*"):
                if fp.is_file() and fp.suffix.lower() in LORA_SUFFIXES:
                    names.append(str(fp.relative_to(root)).replace("/", "\\"))
            break
    names.sort(key=lambda s: s.lower())
    _LORA_CACHE = names
    return names, source

# 词卡池缓存（573 个 txt 全量读一遍约 0.7MB，没必要每次请求重扫）
_WC_POOLS_CACHE = None


def get_wc_pools(refresh=False):
    global _WC_POOLS_CACHE
    if _WC_POOLS_CACHE is None or refresh:
        _WC_POOLS_CACHE = gacha_wildcards.scan_wildcards()
    return _WC_POOLS_CACHE


# ---- 调试日志：内存环形缓冲 + logs/ 文件落地 + /api/logs 端点 ------------
LOG_RING = collections.deque(maxlen=500)
LOG_LOCK = threading.Lock()
LOG_FILE = os.path.join(BASE_DIR, "logs", "gacha_server.log")


def log_event(tag, msg, level="info"):
    """记录一条调试日志：内存（给前端抽屉）+ 文件（给离线排查）。"""
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    entry = {"ts": ts, "level": level, "tag": tag, "msg": str(msg)[:1500]}
    with LOG_LOCK:
        LOG_RING.append(entry)
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(f"[{ts}] [{level.upper():5}] [{tag}] {entry['msg']}\n")
    except Exception:  # noqa: BLE001
        pass


def log_gen_result(res, tag="generate"):
    """把一次生图的结果与 ComfyUI 侧日志写入调试日志。"""
    ok = bool(res.get("ok"))
    log_event(tag, f"ok={ok} images={len(res.get('images', []))} "
                   f"error={res.get('error') or '-'}",
              "info" if ok else "error")
    for line in (res.get("logs") or [])[-40:]:
        log_event("comfy", line, "error" if "[ERROR]" in line else "info")


class GachaHandler(BaseHTTPRequestHandler):
    server_version = "GachaSrv/1.0"

    # ---- 输出工具 -----------------------------------------------------
    def _send(self, code, body, ctype):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, obj, "application/json; charset=utf-8")

    def _serve_file(self, path, ctype):
        if os.path.isfile(path):
            with open(path, "rb") as fh:
                self._send(200, fh.read(), ctype)
        else:
            self._json({"error": "file not found"}, 404)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ---- CORS 预检 ----------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- GET ----------------------------------------------------------
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path in ("/", "/index.html", "/gacha.html"):
            return self._serve_file(os.path.join(BASE_DIR, "gacha.html"),
                                    "text/html; charset=utf-8")
        if path == "/data":
            files = sorted(os.path.basename(f) for f in glob.glob(os.path.join(BASE_DIR, "*.json")))
            return self._json({"files": files})
        if path.startswith("/data/"):
            name = os.path.basename(path[len("/data/"):])  # 防目录穿越
            if name.endswith(".json"):
                fp = os.path.join(BASE_DIR, name)
                if os.path.isfile(fp):
                    return self._serve_file(fp, "application/json; charset=utf-8")
            return self._json({"error": "not found"}, 404)
        if path == "/api/gacha":
            return self._do_gacha({})
        if path == "/api/pools":
            return self._do_pools()
        if path == "/api/wildcards":
            return self._do_wildcards()
        if path == "/api/combos":
            return self._do_combos()
        if path == "/api/loras":
            return self._do_loras()
        if path == "/api/logs":
            q = parse_qs(urlparse(self.path).query)
            try:
                n = min(500, max(1, int(q.get("n", ["200"])[0] or 200)))
            except ValueError:
                n = 200
            with LOG_LOCK:
                entries = list(LOG_RING)[-n:]
            return self._json({"ok": True, "logs": entries, "file": LOG_FILE})
        if path == "/api/generate":
            return self._do_generate({})
        if path == "/img":
            return self._serve_generated_image()
        return self._json({"error": "not found"}, 404)

    # ---- POST ---------------------------------------------------------
    def do_POST(self):
        route = urlparse(self.path).path
        if route not in ("/api/gacha", "/api/generate", "/api/pool/edit",
                         "/api/combo/run", "/api/combo/save", "/api/combo/delete",
                         "/api/logs/clear"):
            return self._json({"error": "not found"}, 404)
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except Exception:
            body = {}
        if route == "/api/gacha":
            return self._do_gacha(body)
        if route == "/api/pool/edit":
            return self._do_pool_edit(body)
        if route == "/api/combo/run":
            return self._do_combo_run(body)
        if route == "/api/combo/save":
            return self._do_combo_save(body)
        if route == "/api/combo/delete":
            return self._do_combo_delete(body)
        if route == "/api/logs/clear":
            with LOG_LOCK:
                LOG_RING.clear()
            log_event("logs", "日志已清空")
            return self._json({"ok": True})
        return self._do_generate(body)

    # ---- 数据池 CRUD 编辑（增删改查） -----------------------------------
    def _do_pool_edit(self, params):
        op = params.get("op", "get")
        file_name = params.get("file", "action.json")
        file_name = os.path.basename(file_name)
        if not file_name.endswith(".json"):
            return self._json({"ok": False, "error": "invalid file format"}, 400)
        fp = os.path.join(BASE_DIR, file_name)

        if op == "create_file":
            if os.path.isfile(fp):
                return self._json({"ok": False, "error": "file already exists"}, 400)
            with open(fp, "w", encoding="utf-8") as fh:
                json.dump({}, fh, ensure_ascii=False, indent=2)
            return self._json({"ok": True, "file": file_name, "message": f"创建 {file_name} 成功"})

        if op == "get":
            if not os.path.isfile(fp):
                return self._json({"ok": False, "error": "file not found"}, 404)
            try:
                with open(fp, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                return self._json({"ok": True, "file": file_name, "data": data})
            except Exception as e:
                return self._json({"ok": False, "error": f"read json error: {e}"}, 500)

        if op == "save_all":
            data = params.get("data")
            if data is None:
                return self._json({"ok": False, "error": "missing data"}, 400)
            try:
                with open(fp, "w", encoding="utf-8") as fh:
                    json.dump(data, fh, ensure_ascii=False, indent=2)
                return self._json({"ok": True, "file": file_name, "message": "保存成功"})
            except Exception as e:
                return self._json({"ok": False, "error": f"write json error: {e}"}, 500)

        if op in ("add_item", "update_item", "delete_item"):
            if not os.path.isfile(fp):
                return self._json({"ok": False, "error": "file not found"}, 404)
            try:
                with open(fp, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except Exception as e:
                return self._json({"ok": False, "error": f"read error: {e}"}, 500)

            key = str(params.get("key", "")).strip()
            old_key = str(params.get("old_key", "")).strip() or key
            val = params.get("val", "")

            if isinstance(data, dict):
                if op == "delete_item":
                    if old_key in data:
                        del data[old_key]
                elif op in ("add_item", "update_item"):
                    if old_key and old_key != key and old_key in data:
                        del data[old_key]
                    data[key] = val
            elif isinstance(data, list):
                if op == "delete_item":
                    data = [item for item in data if not (isinstance(item, dict) and item.get("label") == old_key)]
                elif op == "add_item":
                    data.append({"label": key, "tags": val})
                elif op == "update_item":
                    for item in data:
                        if isinstance(item, dict) and item.get("label") == old_key:
                            item["label"] = key
                            item["tags"] = val

            try:
                with open(fp, "w", encoding="utf-8") as fh:
                    json.dump(data, fh, ensure_ascii=False, indent=2)
                return self._json({"ok": True, "file": file_name, "message": "操作成功", "data": data})
            except Exception as e:
                return self._json({"ok": False, "error": f"write error: {e}"}, 500)

        return self._json({"ok": False, "error": "unknown op"}, 400)

    # ---- 数据池元信息（给前端渲染按池过滤框） --------------------------
    def _do_pools(self):
        q = parse_qs(urlparse(self.path).query)
        raw = q.get("f", [""])[0]
        files = [f.strip() for f in raw.split(",") if f.strip()]
        files = [f for f in files if isinstance(f, str) and os.path.basename(f) == f and f.endswith(".json")]
        if not files:
            files = ["action.json", "zh_TW.json"]
        all_pools = []
        for f in files:
            fp = os.path.join(BASE_DIR, f)
            if os.path.isfile(fp):
                all_pools.extend(gacha.load_pools(fp))
        meta = [{"name": p.name, "friendly": p.friendly,
                 "file": os.path.basename(p.file), "size": len(p)}
                for p in all_pools]
        return self._json({"ok": True, "pools": meta})

    # ---- 词卡库：类别树（给前端「能看/能选」的树形面板） -----------------
    def _do_wildcards(self):
        q = parse_qs(urlparse(self.path).query)
        refresh = q.get("refresh", [""])[0] in ("1", "true")
        pools = get_wc_pools(refresh)
        tree = {}
        for p in pools:
            top = p.name.split("/", 1)[0]
            tree.setdefault(top, []).append(
                {"name": p.name, "friendly": p.friendly, "size": len(p),
                 "sample": [it["label"] for it in p.items[:3]]})
        return self._json({"ok": True, "tree": tree, "total": len(pools),
                           "items": sum(len(p) for p in pools),
                           "root": gacha_wildcards.DEFAULT_ROOT})

    # ---- 可用 LoRA 清单（给前端下拉框） ---------------------------------
    def _do_loras(self):
        q = parse_qs(urlparse(self.path).query)
        refresh = q.get("refresh", [""])[0] in ("1", "true")
        try:
            names, source = list_loras(refresh)
        except Exception as exc:  # noqa: BLE001
            log_event("loras", f"读取失败: {exc}", "error")
            return self._json({"ok": False, "error": str(exc), "loras": []}, 500)
        loras = []
        for n in names:
            sub = os.path.dirname(n).replace("\\", "/")
            loras.append({"name": n, "label": os.path.basename(n),
                          "group": sub or "根目录",
                          "ext": os.path.splitext(n)[1].lstrip(".").lower()})
        return self._json({"ok": True, "loras": loras, "total": len(loras),
                           "source": source if source != "cache" else "comfy"})

    # ---- 配方清单（含完整内容，文件都很小） ------------------------------
    def _do_combos(self):
        try:
            return self._json({"ok": True, "combos": gacha_combo.list_recipes()})
        except Exception as exc:  # noqa: BLE001
            return self._json({"ok": False, "error": str(exc)}, 500)

    # ---- 配方执行：词卡 × 槽位/模板 → prompt（可选直接生图） -------------
    def _do_combo_run(self, params):
        try:
            recipe = params.get("recipe")
            if not recipe:
                recipe = gacha_combo.load_recipe(params.get("name", ""))
            pulls = max(1, min(50, int(params.get("pulls", 1) or 1)))
            raw_seed = params.get("seed")
            seed = int(raw_seed) if raw_seed not in (None, "") else None

            # JSON 池（可选混入）+ 全部词卡池
            json_files = []
            for f in params.get("files", []) or []:
                if isinstance(f, str) and os.path.basename(f) == f and f.endswith(".json"):
                    fp = os.path.join(BASE_DIR, f)
                    if os.path.isfile(fp):
                        json_files.append(fp)
            all_pools = [p for f in json_files for p in gacha.load_pools(f)]
            all_pools.extend(get_wc_pools())

            rng = random.Random(seed)
            draws = [gacha_combo.run_recipe(recipe, all_pools, rng)
                     for _ in range(pulls)]
            resp = {"ok": True, "draws": draws, "seed": seed,
                    "recipe": recipe.get("name", "")}
            preview = (draws[0]["prompt"][:120] + "…") if draws else "-"
            log_event("combo", f"recipe={recipe.get('name', '?')} pulls={pulls} "
                               f"seed={seed} 首发: {preview}")

            if params.get("generate"):
                gen = {k: v for k, v in (recipe.get("gen") or {}).items()
                       if k in gacha_combo.GEN_KEYS}
                gen.update({k: v for k, v in (params.get("gen") or {}).items()
                            if k in gacha_combo.GEN_KEYS})
                outdir = gacha_to_sdxl.WORKSPACE / "outputs"
                res = gacha_to_sdxl.generate_from_prompts(
                    prompts=[d["prompt"] for d in draws],
                    outdir=str(outdir), **gen)
                res["urls"] = [("/img?f=" + u) if u else ""
                               for u in res.get("urls", [])]
                resp["gen"] = res
                log_gen_result(res, "combo+gen")
            return self._json(resp)
        except Exception as exc:  # noqa: BLE001
            log_event("combo", f"异常: {exc}", "error")
            return self._json({"ok": False, "error": str(exc)}, 500)

    # ---- 配方保存 / 删除（文件名清洗在 gacha_combo 内完成） --------------
    def _do_combo_save(self, params):
        recipe = params.get("recipe")
        if not isinstance(recipe, dict):
            return self._json({"ok": False, "error": "missing recipe"}, 400)
        name = str(params.get("name") or recipe.get("name") or "").strip()
        if not name:
            return self._json({"ok": False, "error": "missing name"}, 400)
        try:
            fn = gacha_combo.save_recipe(recipe, name)
            return self._json({"ok": True, "file": fn,
                               "message": f"配方已保存：{fn}"})
        except Exception as exc:  # noqa: BLE001
            return self._json({"ok": False, "error": str(exc)}, 500)

    def _do_combo_delete(self, params):
        name = str(params.get("name", "")).strip()
        if not name:
            return self._json({"ok": False, "error": "missing name"}, 400)
        if gacha_combo.delete_recipe(name):
            return self._json({"ok": True, "message": f"已删除：{name}"})
        return self._json({"ok": False, "error": "配方不存在"}, 404)

    # ---- 生图：把 prompt 列表送进 ComfyUI（复用 gacha_to_sdxl） --------
    def _do_generate(self, params):
        prompts = params.get("prompts") or []
        if isinstance(prompts, str):
            prompts = [prompts]
        prompts = [str(p).strip() for p in prompts if isinstance(p, (str,)) and str(p).strip()]
        if not prompts:
            return self._json({"ok": False, "error": "no prompts"}, 400)
        outdir = gacha_to_sdxl.WORKSPACE / "outputs"
        loras = gacha_to_sdxl.lora_specs(params.get("loras"))
        raw_skip = params.get("clip_skip")
        try:
            clip_skip = int(raw_skip) if raw_skip not in (None, "", 0) else None
        except (TypeError, ValueError):
            clip_skip = None
        raw_steps = params.get("steps")
        try:
            # 不传步数就交给模型预设（simple=20、illustrious=15），别硬写 12
            steps = int(raw_steps) if raw_steps not in (None, "", 0) else None
        except (TypeError, ValueError):
            steps = None
        log_event("generate", f"prompts={len(prompts)} engine={params.get('engine', 'sdxl')} "
                              f"model={params.get('model', 'illustrious')} "
                              f"steps={steps or '预设'} "
                              f"lora={','.join(loras) or '-'} clip_skip={clip_skip or '-'} "
                              f"首发: {prompts[0][:100]}…")
        res = gacha_to_sdxl.generate_from_prompts(
            prompts=prompts,
            engine=params.get("engine", "sdxl"),
            base=bool(params.get("base", False)),
            model=params.get("model", "illustrious"),
            project=params.get("project") or None,
            outdir=str(outdir),
            seed=params.get("seed"),
            width=params.get("width"),
            height=params.get("height"),
            steps=steps,
            cfg=params.get("cfg"),
            negative=params.get("negative", ""),
            fix_face=bool(params.get("fix_face", False)),
            hires=bool(params.get("hires", False)),
            denoise=float(params.get("denoise", 0.6) or 0.6),
            face_denoise=float(params.get("face_denoise", 0.4) or 0.4),
            upscale=float(params.get("upscale", 1.0) or 1.0),
            sidecar=bool(params.get("sidecar", False)),
            loras=loras,
            clip_skip=clip_skip,
        )
        res["loras"] = loras
        res["clip_skip"] = clip_skip
        res["urls"] = [("/img?f=" + u) if u else "" for u in res.get("urls", [])]
        log_gen_result(res)
        return self._json(res)

    # ---- 生成图预览：只允许读取 outputs/ 下的文件 ---------------------
    def _serve_generated_image(self):
        q = parse_qs(urlparse(self.path).query)
        f = q.get("f", [""])[0]
        if not f:
            return self._json({"error": "missing f"}, 400)
        outdir = (gacha_to_sdxl.WORKSPACE / "outputs").resolve()
        fp = (outdir / f).resolve()
        if outdir not in fp.parents and fp != outdir:
            return self._json({"error": "forbidden"}, 403)
        if os.path.isfile(fp):
            with open(fp, "rb") as fh:
                self._send(200, fh.read(), "image/png")
            return
        return self._json({"error": "not found"}, 404)

    # ---- 抽卡核心（复用 gacha.py） -----------------------------------
    def _do_gacha(self, params):
        try:
            files = params.get("files") or ["action.json", "zh_TW.json"]
            # 只允许当前目录下的文件名，防止越权读取
            files = [f for f in files
                     if isinstance(f, str) and os.path.basename(f) == f and f.endswith(".json")]
            if not files:
                return self._json({"ok": False, "error": "no valid files"}, 400)

            all_pools = []
            for f in files:
                all_pools.extend(gacha.load_pools(os.path.join(BASE_DIR, f)))
            pools_meta = [{"name": p.name, "friendly": p.friendly,
                           "file": os.path.basename(p.file), "size": len(p)}
                          for p in all_pools]

            pools = gacha.pick_pools(all_pools, params.get("pools", ""))
            pools = gacha.apply_filter_spec(pools, params.get("filter", ""))
            if not pools:
                return self._json({"ok": False, "error": "filter left no items"}, 400)

            pulls = max(1, int(params.get("pulls", 1) or 1))
            count = max(1, int(params.get("count", 1) or 1))
            no_repeat = bool(params.get("no_repeat", False))
            raw_seed = params.get("seed")
            seed = int(raw_seed) if raw_seed not in (None, "") else None

            rng = random.Random(seed)
            used_hist = {}
            log_event("gacha", f"files={files} pulls={pulls} count={count} seed={seed}")
            fixed = str(params.get("fixed", "") or "").strip()
            draws = [gacha.draw_pull(rng, pools, count, no_repeat, used_hist, all_pools=all_pools, fixed=fixed)
                     for _ in range(pulls)]

            return self._json({"ok": True, "draws": draws,
                               "pools": pools_meta, "seed": seed,
                               "files": files})
        except Exception as exc:  # noqa: BLE001
            log_event("gacha", f"异常: {exc}", "error")
            return self._json({"ok": False, "error": str(exc)}, 500)


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            port = DEFAULT_PORT
    server = ThreadingHTTPServer(("127.0.0.1", port), GachaHandler)
    # 强制 UTF-8 输出，避免 Windows GBK 控制台打印 emoji/中文崩溃
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print("=" * 60)
    print("🎴 多 JSON 抽卡器 · 配套服务器")
    print(f"   打开浏览器: http://127.0.0.1:{port}/")
    print(f"   数据目录  : {BASE_DIR}")
    print(f"   调试日志  : {LOG_FILE}（页面右上角 🪵 可查看）")
    print("   按 Ctrl+C 停止")
    print("=" * 60)
    log_event("server", f"服务器启动 port={port} base={BASE_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
