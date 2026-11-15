# -*- coding: utf-8 -*-
"""ComfyUI 客户端：只走官方 HTTP / WebSocket API，不再 subprocess 调外部脚本。

支持 mock 模式（GACHA_COMFY_MOCK=1）：不连 ComfyUI，用本地占位图跑通全链路，
便于离线冒烟与前端联调。
"""
from __future__ import annotations

import io
import json
import time
import uuid
from collections.abc import Callable
from typing import Any

import httpx

from ..config import get_settings


class ComfyError(Exception):
    """ComfyUI 侧失败（网络、执行错误、超时）。"""


class CancelledError(Exception):
    """任务被用户取消。"""


class ComfyClient:
    def __init__(self, settings=None, client_id: str | None = None):
        self.s = settings or get_settings()
        self.client_id = client_id or f"gacha-{uuid.uuid4().hex[:12]}"
        self.http = httpx.Client(base_url=self.s.comfy_url, timeout=10.0)

    # ---------- 基础 ----------
    def status(self) -> dict:
        if self.s.comfy_mock:
            return {"online": True, "mock": True, "url": self.s.comfy_url,
                    "message": "mock 模式：不会连接 ComfyUI，生图返回占位图"}
        try:
            r = self.http.get("/system_stats", timeout=3.0)
            r.raise_for_status()
            return {"online": True, "mock": False, "url": self.s.comfy_url,
                    "system": r.json().get("system", {})}
        except Exception as exc:
            return {"online": False, "mock": False, "url": self.s.comfy_url,
                    "message": f"无法连接 ComfyUI: {exc}"}

    def object_info(self, node: str) -> dict:
        if self.s.comfy_mock:
            return {}
        r = self.http.get(f"/object_info/{node}", timeout=8.0)
        r.raise_for_status()
        return r.json().get(node, {})

    def _enum(self, node: str, key: str, index: int = 0) -> list[str]:
        try:
            info = self.object_info(node)
            required = info.get("input", {}).get("required", {})
            val = required.get(key)
            if isinstance(val, list) and val and isinstance(val[index], list):
                return sorted(str(x) for x in val[index])
        except Exception:
            pass
        return []

    def checkpoints(self) -> list[str]:
        return self._enum("CheckpointLoaderSimple", "ckpt_name")

    def loras(self) -> list[str]:
        return self._enum("LoraLoader", "lora_name")

    def samplers(self) -> list[str]:
        return self._enum("KSampler", "sampler_name")

    def schedulers(self) -> list[str]:
        return self._enum("KSampler", "scheduler")

    def models(self) -> dict:
        if self.s.comfy_mock:
            return {"checkpoints": ["waiIllustriousSDXL_v170.safetensors"],
                    "loras": [], "samplers": ["euler_ancestral", "euler", "dpmpp_2m"],
                    "schedulers": ["normal", "karras"], "mock": True}
        return {"checkpoints": self.checkpoints(), "loras": self.loras(),
                "samplers": self.samplers(), "schedulers": self.schedulers(),
                "mock": False}

    # ---------- workflow ----------
    def build_workflow(self, *, profile: dict, prompt: str, negative: str,
                       seed: int, workflow_name: str = "sdxl_minimal.json",
                       prefix: str = "gacha") -> dict:
        """读模板 → 渲染占位符 → 动态串联 LoraLoader。"""
        path = self.s.workflow_dir / workflow_name
        if not path.is_file():
            raise ComfyError(f"workflow 模板不存在: {path}")
        template = json.loads(path.read_text(encoding="utf-8"))
        wf = {k: v for k, v in template.items() if not k.startswith("_")}

        loras = profile.get("loras") or []
        model_src, clip_src = "1", "1"
        for i, lora in enumerate(loras):
            name = str(lora.get("name") or "").strip()
            if not name:
                continue
            weight = float(lora.get("weight", 1.0))
            nid = str(100 + i)
            wf[nid] = {
                "class_type": "LoraLoader",
                "inputs": {"lora_name": name, "strength_model": weight,
                           "strength_clip": weight,
                           "model": [model_src, 0], "clip": [clip_src, 1]},
            }
            model_src, clip_src = nid, nid

        params: dict[str, Any] = {
            "CKPT": profile.get("checkpoint") or "",
            "PROMPT": prompt,
            "NEGATIVE": negative,
            "SEED": int(seed),
            "WIDTH": int(profile.get("width", 1024)),
            "HEIGHT": int(profile.get("height", 1360)),
            "STEPS": int(profile.get("steps", 20)),
            "CFG": float(profile.get("cfg", 6.0)),
            "SAMPLER": profile.get("sampler", "euler_ancestral"),
            "SCHEDULER": profile.get("scheduler", "normal"),
            "MODEL_SRC": model_src,
            "CLIP_SRC": clip_src,
            "PREFIX": prefix,
        }
        for node in wf.values():
            inputs = node.get("inputs", {})
            for key, val in list(inputs.items()):
                inputs[key] = self._resolve(val, params)
        return wf

    @staticmethod
    def _resolve(val: Any, params: dict) -> Any:
        if isinstance(val, str) and val.startswith("$"):
            key = val[1:]
            if key not in params:
                raise ComfyError(f"workflow 占位符无对应参数: {val}")
            return params[key]
        if isinstance(val, list):
            return [ComfyClient._resolve(v, params) for v in val]
        return val

    # ---------- 提交 / 取结果 ----------
    def submit(self, workflow: dict) -> str:
        if self.s.comfy_mock:
            return f"mock-{uuid.uuid4().hex[:12]}"
        r = self.http.post("/prompt", json={"prompt": workflow,
                                            "client_id": self.client_id}, timeout=20.0)
        if r.status_code >= 400:
            raise ComfyError(f"ComfyUI 拒绝任务 ({r.status_code}): {r.text[:400]}")
        data = r.json()
        pid = data.get("prompt_id")
        if not pid:
            raise ComfyError(f"ComfyUI 未返回 prompt_id: {str(data)[:300]}")
        return pid

    def history(self, prompt_id: str) -> dict | None:
        r = self.http.get(f"/history/{prompt_id}", timeout=8.0)
        r.raise_for_status()
        return r.json().get(prompt_id)

    def _images_from_history(self, record: dict) -> list[dict]:
        out = []
        for _nid, node in (record.get("outputs") or {}).items():
            for img in node.get("images", []) or []:
                out.append({"filename": img.get("filename", ""),
                            "subfolder": img.get("subfolder", ""),
                            "type": img.get("type", "output")})
        return out

    def view(self, info: dict) -> bytes:
        r = self.http.get("/view", params={"filename": info["filename"],
                                           "subfolder": info.get("subfolder", ""),
                                           "type": info.get("type", "output")},
                          timeout=30.0)
        r.raise_for_status()
        return r.content

    def interrupt(self) -> None:
        if self.s.comfy_mock:
            return
        try:
            self.http.post("/interrupt", timeout=5.0)
        except Exception:
            pass

    def wait_result(self, prompt_id: str, *, on_progress: Callable[[int, int, str], None],
                    cancel_check: Callable[[], bool], timeout: int) -> list[bytes]:
        """阻塞等待一次生成完成，返回图片字节列表。进度通过回调上报。"""
        if self.s.comfy_mock:
            return self._mock_wait(on_progress, cancel_check)

        ws = None
        try:
            from websockets.sync.client import connect
            url = self.s.comfy_url.replace("http://", "ws://").replace("https://", "wss://")
            ws = connect(f"{url}/ws?clientId={self.client_id}", open_timeout=5)
        except Exception:
            ws = None  # WS 不可用则退化为纯轮询，不影响出图

        deadline = time.monotonic() + timeout
        last_step = 0
        try:
            while time.monotonic() < deadline:
                if cancel_check():
                    self.interrupt()
                    raise CancelledError("用户取消")
                if ws is not None:
                    try:
                        raw = ws.recv(timeout=0.15)
                        msg = json.loads(raw)
                        mtype, data = msg.get("type"), msg.get("data") or {}
                        if mtype == "progress" and data.get("prompt_id", prompt_id) == prompt_id:
                            step, total = int(data.get("value", 0)), int(data.get("max", 0))
                            last_step = step
                            on_progress(step, total, "running")
                        elif mtype == "execution_error":
                            raise ComfyError(str(data.get("exception_message", "执行错误"))[:500])
                        elif mtype == "executed":
                            on_progress(last_step, last_step or 1, "finishing")
                    except TimeoutError:
                        pass
                    except ComfyError:
                        raise
                    except Exception:
                        ws = None
                record = self.history(prompt_id)
                if record:
                    status = (record.get("status") or {}).get("status_str", "")
                    if status == "error":
                        raise ComfyError("ComfyUI 执行失败: " +
                                         json.dumps(record.get("status", {}),
                                                    ensure_ascii=False)[:400])
                    infos = self._images_from_history(record)
                    if infos:
                        on_progress(100, 100, "saving")
                        return [self.view(i) for i in infos]
                time.sleep(0.25)
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
        raise ComfyError(f"等待生成超时（{timeout}s），prompt_id={prompt_id}")

    def _mock_wait(self, on_progress, cancel_check) -> list[bytes]:
        from PIL import Image, ImageDraw
        total = 8
        for step in range(1, total + 1):
            if cancel_check():
                raise CancelledError("用户取消")
            on_progress(step, total, "running")
            time.sleep(0.18)
        img = Image.new("RGB", (512, 640), (238, 241, 248))
        draw = ImageDraw.Draw(img)
        draw.rectangle((24, 24, 488, 616), outline=(120, 140, 180), width=2)
        draw.text((40, 60), "GACHA MOCK IMAGE", fill=(40, 60, 100))
        draw.text((40, 90), "ComfyUI offline smoke test", fill=(80, 100, 140))
        draw.text((40, 120), "offline smoke test", fill=(80, 100, 140))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return [buf.getvalue()]
