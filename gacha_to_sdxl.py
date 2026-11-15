# -*- coding: utf-8 -*-
"""抽卡 → 生图 桥接脚本（gacha.py 抽卡结果直接送入 sdxl-text2img）。

流程：
  1. 用 gacha.py 的引擎从 JSON 池抽卡（角色/画师/风格 各抽若干条）
  2. 每抽拼成一条 prompt（comma 分隔标签）
  3. 依次调用 sdxl-text2img 的 main.py 生图，转发 --model/--project/--width 等参数
  4. 解析 main.py 的 [SUCCESS] 输出，汇总图片路径

示例：
  python gacha_to_sdxl.py --pulls 3 --count 1 --model noobai --project gacha_demo --seed 7
  python gacha_to_sdxl.py --pulls 2 --filter 原神 --fix-face --hires
  python gacha_to_sdxl.py --pulls 2 --dry-run                 # 只看将要执行的命令
  python gacha_to_sdxl.py --pulls 2 --start-comfy             # 自动拉起 ComfyUI
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import gacha  # 复用抽卡引擎（同目录）

WORKSPACE = Path(__file__).resolve().parent
SDXL_MAIN = Path(r"C:\Users\13410\.agents\skills\sdxl-text2img\scripts\main.py")
ANIMA_MAIN = Path(r"C:\Users\13410\.agents\skills\anima\scripts\main.py")
COMFY_URL = "http://127.0.0.1:8188"
# 模型标识 -> 期望的 checkpoint 文件名（用于启动前预检）
MODEL_CKPT = {
    "illustrious": "waiIllustriousSDXL_v170.safetensors",
    "simple": "waiSimpleIllustrious_v10.safetensors",
    "plantMilk": "plantMilkModelSuite_walnut.safetensors",
    "noobai": "noobaiXLNAIXL_vPred10Version.safetensors",
    "3d": "hsUltrahdCG_IllEpic.safetensors",
}
# 走干净管线（不挂 neg4all / VHSnoise 默认风格 LoRA）的模型
CLEAN_MODELS = {"simple"}
COMFY_BAT_CANDIDATES = [
    Path(r"X:\ai_tool\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\run_nvidia_gpu.bat"),
    Path(r"X:\work_code\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\run_nvidia_gpu.bat"),
    Path(r"C:\ComfyUI_windows_portable\run_nvidia_gpu.bat"),
    Path(r"ComfyUI_windows_portable\run_nvidia_gpu.bat"),
]


def comfy_online():
    try:
        with urllib.request.urlopen(COMFY_URL + "/system_stats", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def find_comfy_bat():
    for p in COMFY_BAT_CANDIDATES:
        if p.exists():
            return p
    return None


def start_comfyui():
    if comfy_online():
        print("[ComfyUI] 已在运行，无需启动。")
        return True
    bat = find_comfy_bat()
    if bat is None:
        print("[ERROR] 找不到 ComfyUI 启动脚本 (run_nvidia_gpu.bat)", file=sys.stderr)
        return False
    print(f"[ComfyUI] 拉起服务: {bat}")
    try:
        subprocess.Popen([str(bat)], cwd=str(bat.parent),
                         creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0))
    except Exception as e:
        print(f"[ERROR] 启动失败: {e}", file=sys.stderr)
        return False
    print("[ComfyUI] 等待端口 8188 就绪...", end="", flush=True)
    for _ in range(60):
        import time
        time.sleep(2)
        if comfy_online():
            print(" ✅")
            return True
        print(".", end="", flush=True)
    print(" ❌ 超时")
    return False


def decode_output(raw):
    """把子进程 stdout/stderr 字节解码为文本（UTF-8 优先，回退 GBK）。"""
    if not raw:
        return ""
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def available_checkpoints():
    """查询 ComfyUI 实际存在的 checkpoint 文件名集合。"""
    try:
        with urllib.request.urlopen(COMFY_URL + "/object_info/CheckpointLoaderSimple", timeout=5) as r:
            info = json.loads(r.read())
        return set(info["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0])
    except Exception:
        return None


def validate_model(model, available):
    """校验所选模型在本机是否存在对应权重，返回 (ok, message)。"""
    want = MODEL_CKPT.get(model)
    if available is None:
        return True, ""
    if want and want in available:
        return True, f"模型 {model} 权重在库 ✅ ({want})"
    names = sorted(available)
    usable = [m for m, c in MODEL_CKPT.items() if c in available]
    msg = (f"[ERROR] 所选模型 {model} 的权重缺失（期望 {want}）\n"
           f"        本机 checkpoint 列表: {names}\n"
           f"        可用的模型标识: {usable or '(无)'}；建议用 --model 指定。")
    return False, msg


def build_prompt(items, prepend, tag_sep):
    parts = [gacha.prompt_tag(it) for it in items]
    parts = [p for p in parts if p]
    body = tag_sep.join(parts)
    return (prepend + body).strip() if prepend else body


def parse_success(output):
    """从 main.py (SDXL 或 Anima) stdout 中提取所有 [SUCCESS] 图片路径。

    优先用正则直接抓绝对路径（兼容文案变化），文本标记作兜底。
    """
    paths = []
    for line in output.splitlines():
        if "[SUCCESS]" not in line:
            continue
        m = re.search(r"([A-Za-z]:[\\/][^\"'<>\r\n|?*]+?\.(?:png|jpg|jpeg|webp))",
                      line, re.I)
        if m:
            paths.append(m.group(1).strip())
            continue
        m = re.search(r"(/[^\"'<>\r\n|?*]+?\.(?:png|jpg|jpeg|webp))", line, re.I)
        if m:
            paths.append(m.group(1).strip())
            continue
        if "保存至项目:" in line:
            paths.append(line.split("保存至项目:", 1)[-1].strip())
        elif "已保存:" in line:
            paths.append(line.split("已保存:", 1)[-1].strip())
        elif "saved" in line.lower() and ":" in line:
            paths.append(line.split(":", 1)[-1].strip())
    return paths


IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp")


def snapshot_images(outdir):
    """输出目录现有图片快照（路径集合），用于差量检测新增图片。"""
    try:
        return {str(fp) for fp in Path(outdir).rglob("*")
                if fp.suffix.lower() in IMG_EXTS and fp.is_file()}
    except OSError:
        return set()


def scan_new_images(outdir, before):
    """回退方案：返回 before 快照之后新出现的图片（按 mtime 排序）。

    用于 main.py 已出图（ComfyUI 完成了渲染）但 [SUCCESS] 没被捕获、
    或 main.py 在收尾阶段崩溃（图片其实已落盘）的情况。
    用路径差集而非时间戳：批量生成时不会把上一抽的图误归到这一抽。
    """
    found = []
    try:
        for fp in Path(outdir).rglob("*"):
            if fp.suffix.lower() not in IMG_EXTS or not fp.is_file():
                continue
            s = str(fp)
            if s in before:
                continue
            try:
                found.append((fp.stat().st_mtime, s))
            except OSError:
                found.append((0.0, s))
    except OSError:
        pass
    return [p for _t, p in sorted(found)]


def lora_specs(loras):
    """把 [{'name':..,'weight':..}] / ['名字:权重'] 统一成 ['名字:权重']（去重保序）。"""
    out, seen = [], set()
    for it in loras or []:
        if isinstance(it, dict):
            name = str(it.get("name") or it.get("lora") or "").strip()
            try:
                weight = float(it.get("weight", 1.0))
            except (TypeError, ValueError):
                weight = 1.0
        else:
            name = str(it or "").strip()
            weight = 1.0
            if ":" in name:
                head, _, tail = name.rpartition(":")
                try:
                    weight = float(tail)
                    name = head
                except ValueError:
                    pass
        name = name.strip().strip("<>")
        if not name:
            continue
        key = (name, round(weight, 3))
        if key in seen:
            continue
        seen.add(key)
        out.append(f"{name}:{weight:g}")
    return out


def run_main(args, prompt, outdir, project, seed, engine="sdxl", base=False):
    if str(engine).lower().startswith("anima"):
        cmd = [sys.executable, str(ANIMA_MAIN),
               "--prompt", prompt,
               "--output", str(outdir),
               "--steps", str(args.steps)]
        if engine == "anima_base" or base:
            cmd.append("--base")
        if project:
            cmd += ["--project", project]
        if seed is not None:
            cmd += ["--seed", str(seed)]
        if args.width:
            cmd += ["--width", str(args.width)]
        if args.height:
            cmd += ["--height", str(args.height)]
        if args.cfg is not None:
            cmd += ["--cfg", str(args.cfg)]
        if args.negative:
            cmd += ["--negative", args.negative]
        return cmd

    cmd = [sys.executable, str(args.main),
           "--prompt", prompt,
           "--model", args.model,
           "--output", str(outdir)]
    if args.steps is not None:
        cmd += ["--steps", str(args.steps)]
    for spec in (getattr(args, "loras", None) or []):
        cmd += ["--lora", str(spec)]
    if getattr(args, "clip_skip", None):
        cmd += ["--clip-skip", str(args.clip_skip)]
    if project:
        cmd += ["--project", project]
    if seed is not None:
        cmd += ["--seed", str(seed)]
    if args.width:
        cmd += ["--width", str(args.width)]
    if args.height:
        cmd += ["--height", str(args.height)]
    if args.cfg is not None:
        cmd += ["--cfg", str(args.cfg)]
    if args.negative:
        cmd += ["--negative", args.negative]
    if args.hires:
        cmd += ["--hires", "--denoise", str(args.denoise)]
    if args.fix_face:
        cmd += ["--fix-face", "--face-denoise", str(args.face_denoise)]
    if args.upscale != 1.0:
        cmd += ["--upscale", str(args.upscale)]
    if args.sidecar:
        cmd += ["--sidecar"]
    return cmd


def generate_from_prompts(prompts, model="illustrious", project=None, outdir=None,
                          seed=None, width=None, height=None, steps=12, cfg=None,
                          negative="", fix_face=False, hires=False, denoise=0.6,
                          face_denoise=0.4, upscale=1.0, sidecar=False,
                          prepend=None, engine="sdxl", base=False,
                          loras=None, clip_skip=None):
    """给一组 prompt 生图（支持 SDXL / Anima 双引擎）。

    loras: [{'name': 'xxx.safetensors', 'weight': 0.85}] 或 ['xxx:0.85']
    clip_skip: 覆盖 CLIP 跳层数（不传则跟随模型预设）
    prepend: 质量词前缀；不传则按模型自动选（clean 模型不加，避免和预设前缀重复）

    返回 {ok, images: [绝对路径], urls: [相对 outputs 的相对路径], logs, error}。
    """
    # 质量词前缀：clean 模型自带一套，不再叠一遍
    if prepend is None:
        prepend = "" if model in CLEAN_MODELS else "masterpiece, best quality, "

    if not comfy_online():
        return {"ok": False, "images": [], "urls": [], "logs": [],
                "error": "ComfyUI 未运行，无法生图。请先启动 ComfyUI。"}
    if engine == "sdxl":
        ok, msg = validate_model(model, available_checkpoints())
        if not ok:
            return {"ok": False, "images": [], "urls": [], "logs": [], "error": msg}

    class _A:
        pass
    a = _A()
    a.main = SDXL_MAIN
    a.model = model
    a.width = width
    a.height = height
    a.steps = steps
    a.cfg = cfg
    a.negative = negative
    a.hires = hires
    a.denoise = denoise
    a.fix_face = fix_face
    a.face_denoise = face_denoise
    a.upscale = upscale
    a.sidecar = sidecar
    a.loras = lora_specs(loras)
    a.clip_skip = clip_skip

    outdir = (Path(outdir) if outdir else (WORKSPACE / "outputs")).resolve()
    project = project or f"gacha_{datetime.date.today().strftime('%Y%m%d')}"
    images, urls, logs = [], [], []
    if a.loras and str(engine).lower().startswith("anima"):
        logs.append("[WARN] Anima 引擎不支持 LoRA，已忽略")
        a.loras = []
    elif a.loras:
        logs.append(f"[INFO] 挂载 LoRA × {len(a.loras)}: {', '.join(a.loras)}")
    for i, prompt in enumerate([p for p in prompts if p and str(p).strip()]):
        draw_seed = (seed + i) if seed is not None else None
        if engine == "sdxl" and prepend:
            full = (prepend + str(prompt)).strip()
        else:
            full = str(prompt).strip()
        cmd = run_main(a, full, outdir, project, draw_seed, engine=engine, base=base)
        logs.append("$ " + subprocess.list2cmdline(cmd))
        before = snapshot_images(outdir)
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=1800)
        except Exception as e:  # noqa: BLE001
            logs.append(f"[ERROR] 生图进程异常: {e}")
            continue
        stdout, stderr = decode_output(proc.stdout), decode_output(proc.stderr)
        paths = []
        if proc.returncode != 0:
            # main.py 报错 ≠ 没出图：ComfyUI 可能已渲染完成，只是收尾步骤崩溃。
            # 先记 stderr，再尝试回退扫描新图“挽救”这次生成。
            logs.append(f"[ERROR] main.py 退出码 {proc.returncode}")
            logs.extend((stderr or "").splitlines()[-8:])
            paths = scan_new_images(outdir, before)
            if paths:
                logs.append(f"[FALLBACK] main.py 报错但扫描到 {len(paths)} 张新图，按成功处理")
            else:
                logs.extend((stdout or "").splitlines()[-8:])
                continue
        else:
            paths = parse_success(stdout)
            missing = [p for p in paths if not os.path.isfile(p)]
            if missing:
                logs.append(f"[WARN] [SUCCESS] 解析到的路径不存在: {missing}")
                paths = [p for p in paths if os.path.isfile(p)]
            if not paths:
                logs.append("[WARN] 未捕获到有效 [SUCCESS]，回退扫描输出目录新增图片…")
                logs.extend((stdout or stderr).splitlines()[-8:])
                paths = scan_new_images(outdir, before)
                if paths:
                    logs.append(f"[FALLBACK] 扫描到 {len(paths)} 张新图")
                else:
                    logs.append("[ERROR] 回退扫描也没有发现新图，请检查上方 stdout 尾部")
        for pth in paths:
            images.append(pth)
            try:
                rel = str(Path(pth).resolve().relative_to(outdir)).replace("\\", "/")
            except ValueError:
                rel = ""
            urls.append(rel)
        logs.extend(f"[SUCCESS] {p}" for p in paths)
    return {"ok": bool(images), "images": images, "urls": urls,
            "logs": logs, "error": ""}


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="gacha_to_sdxl",
        description="抽卡结果直接送入 sdxl-text2img 生图脚本。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("示例：")[-1],
    )
    # ---- 抽卡参数（同 gacha.py） ----
    ap.add_argument("files", nargs="*", metavar="JSON", default=None,
                    help="JSON 文件；缺省自动用 action.json zh_TW.json")
    ap.add_argument("--pulls", "-p", type=int, default=1, help="连抽次数")
    ap.add_argument("--count", "-c", type=int, default=1, help="每池条数")
    ap.add_argument("--pools", default="", help="只用指定池，如 artists,styleColumns")
    ap.add_argument("--filter", "-f", default="", help="关键字过滤（逗号分隔 OR）")
    ap.add_argument("--no-repeat", action="store_true", help="整批不重复")
    ap.add_argument("--seed", type=int, default=None, help="抽卡+生图种子（每抽 = seed+i）")
    ap.add_argument("--prepend", default="masterpiece, best quality, ",
                    help="追加在 prompt 前的质量词（默认: masterpiece, best quality, ）")
    ap.add_argument("--tag-sep", default=", ", help="标签分隔符")
    # ---- 生图转发参数（对应 main.py） ----
    ap.add_argument("--model", "-m", choices=list(MODEL_CKPT.keys()),
                    default="illustrious", help="生图模型（默认 illustrious，自动校验本机权重）")
    ap.add_argument("--lora", "-L", action="append", default=None, metavar="名字[:权重]",
                    help="加载 LoRA，可重复：--lora 'kurumichan (FX-fighter).safetensors:0.85'")
    ap.add_argument("--clip-skip", type=int, default=None,
                    help="CLIP 跳层数（不传则跟随模型预设；simple 默认 2）")
    ap.add_argument("--width", "-W", type=int, default=None)
    ap.add_argument("--height", "-H", type=int, default=None)
    ap.add_argument("--steps", "-s", type=int, default=12)
    ap.add_argument("--cfg", type=float, default=None)
    ap.add_argument("--negative", "-n", default="")
    ap.add_argument("--hires", action="store_true")
    ap.add_argument("--denoise", type=float, default=0.6)
    ap.add_argument("--fix-face", action="store_true")
    ap.add_argument("--face-denoise", type=float, default=0.4)
    ap.add_argument("--upscale", type=float, default=1.0)
    ap.add_argument("--sidecar", action="store_true")
    ap.add_argument("--project", default=None, help="项目名（默认 gacha_日期）")
    ap.add_argument("--output", "-o", type=Path, default=None, help="输出目录（默认 workspace/outputs）")
    # ---- 运行控制 ----
    ap.add_argument("--main", type=Path, default=SDXL_MAIN, help="sdxl main.py 路径")
    ap.add_argument("--start-comfy", action="store_true", help="ComfyUI 未启动时自动拉起")
    ap.add_argument("--dry-run", action="store_true", help="只打印命令不实际生图")
    args = ap.parse_args(argv)
    args.loras = lora_specs(args.lora)

    # UTF-8 控制台
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    # 0. 前置检查
    if not args.main.exists():
        print(f"[ERROR] 找不到生图脚本: {args.main}", file=sys.stderr)
        return 2
    if not args.dry_run:
        if not comfy_online():
            if args.start_comfy and start_comfyui():
                pass
            else:
                print("[ERROR] ComfyUI 未运行。请先启动（--start-comfy 可自动拉起），或先用 --dry-run 预览。", file=sys.stderr)
                return 2
        else:
            print("[ComfyUI] 在线 ✅")
        ok, msg = validate_model(args.model, available_checkpoints())
        if ok:
            print("[Model] " + msg)
        else:
            print(msg, file=sys.stderr)
            return 2

    # 1. 抽卡
    files = args.files or gacha.DEFAULT_FILES
    all_pools = []
    for f in files:
        all_pools.extend(gacha.load_pools(f))
    if not all_pools:
        print("[ERROR] 未识别到任何数据池", file=sys.stderr)
        return 2
    pools = gacha.pick_pools(all_pools, args.pools)
    keywords = [k.strip() for k in (args.filter or "").split(",") if k.strip()]
    if keywords:
        pools = [gacha.filter_pool(p, keywords) for p in pools]
    pools = [p for p in pools if len(p) > 0]
    if not pools:
        print("[ERROR] 过滤后无可用条目", file=sys.stderr)
        return 2

    import random
    rng = random.Random(args.seed)
    used_hist = {}
    draws = [gacha.draw_pull(rng, pools, max(1, args.count), args.no_repeat, used_hist)
             for _ in range(max(1, args.pulls))]

    # 2. 输出目录 / 项目名
    outdir = (args.output or (WORKSPACE / "outputs")).resolve()
    project = args.project or f"gacha_{datetime.date.today().strftime('%Y%m%d')}"

    # 3. 逐抽生图
    print("=" * 64)
    print(f"🎴 抽卡完成：{len(draws)} 抽 · 模型 {args.model} · 项目 {project}")
    if args.loras:
        print(f"   LoRA: {', '.join(args.loras)}")
    print("=" * 64)
    all_images = []
    for i, card in enumerate(draws, 1):
        prompt = build_prompt(card, args.prepend, args.tag_sep)
        draw_seed = (args.seed + i) if args.seed is not None else None
        cmd = run_main(args, prompt, outdir, project, draw_seed)

        print(f"\n──── 第 {i} 抽 ────")
        for it in card:
            print(f"  [{it['friendly']}] {it['label']}")
        print(f"  prompt: {prompt}")
        if args.seed is not None:
            print(f"  seed  : {draw_seed}")

        if args.dry_run:
            print("  $ " + subprocess.list2cmdline(cmd))
            continue

        print("  正在生图...")
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=1800)
        except Exception as e:
            print(f"  [ERROR] 生图失败: {e}", file=sys.stderr)
            continue
        stdout = decode_output(proc.stdout)
        stderr = decode_output(proc.stderr)
        for line in stdout.splitlines():
            if "[ERROR]" in line or "[SUCCESS]" in line or "[INFO]" in line:
                print("   " + line.strip())
        if proc.returncode != 0:
            print(f"  [ERROR] main.py 退出码 {proc.returncode}；stderr 尾部如下：")
            for line in (stderr or "").splitlines()[-8:]:
                print("   " + line)
            continue
        paths = parse_success(stdout)
        if paths:
            for pth in paths:
                print(f"  ✅ {pth}")
                all_images.append(pth)
        else:
            print("  （未捕获 [SUCCESS] 输出，请查看上方日志）")

    # 4. 汇总
    print("\n" + "=" * 64)
    if all_images:
        print(f"📁 本批共生成 {len(all_images)} 张图：")
        for p in all_images:
            print("  " + p)
    else:
        print("（本批未产出图片）")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    sys.exit(main())
