"""提示词权重清理：删掉 `:1.2` 这类超重标记（形如 `(a:1.2)`、`(a, b:1.3)`、`a:1.2`）。

为什么要它：从外面导进来的词卡里混着大量 SD1.5 时代的手写权重，`(long petticoat:1.2)`、
`((full body))` 这种在抽卡里就是污染 —— 条目本来只是「一个概念」，抽卡时该由人来决定
强调程度，而不是每条自带 1.2/1.5 把 prompt 拉偏。

口径（顺序即实现顺序，改动请同步 scripts/clean_weights.py 的 --self-test）：
1. `<lora:xxx:0.7>` / `<lyco:...>` 这类整体跳过：里面的数字是 LoRA 权重，不是污染。
2. 括号组里的权重由内向外剥；剥权重的同时把这对括号去掉 —— 留着 `(a)` 在 A1111/Comfy
   里仍是 1.1 倍强调，等于没清干净。想要保留括号用 unwrap=False。
3. 裸权重（`anal beads:1.2`，逗号分隔段尾）只在这一段以 `:数字` 结尾时剥。
4. 权重值限定在 [1.1, 5.0]：`reverse:1999`、`(重返未來:1999)` 这类「冒号+年份」的
   合法 tag 因此不会被误吃；0.5/0.8 这类降权也保持原样（用户只要求清超重）。
"""
from __future__ import annotations

import re

_NUM = r"[0-9]+(?:\.[0-9]+)?"
_BRACKETS = (("(", ")"), ("[", "]"), ("{", "}"))
_HOLD_OPEN, _HOLD_CLOSE = "\ufff0", "\ufff1"   # 私用区占位符，正常文本不会出现


def _strip_orphan(s: str, min_w: float, max_w: float) -> tuple[str, bool]:
    """括号不配对时的兜底：`...ribbons:1.2),` 这种丢了开括号的，把 `:1.2` 和那个多余的后括号一起删。

    真实数据里就有这种（导入时按 `(` 切分把开括号吃掉了）；配对括号已经由
    `_strip_one_pair` 处理过，这里只管孤立的、没有对应开括号的后半括号。
    """
    closers = {cl: op for op, cl in _BRACKETS}
    out: list[str] = []
    balance = {op: 0 for op, _ in _BRACKETS}
    removed = False
    for ch in s:
        if ch in balance:
            balance[ch] += 1
            out.append(ch)
            continue
        if ch in closers:
            op = closers[ch]
            if balance[op] > 0:
                balance[op] -= 1
                out.append(ch)
                continue
            j = k = len(out)
            while k > 0 and (out[k - 1].isdigit() or out[k - 1] == "."):
                k -= 1
            if k < j and k > 0 and out[k - 1] == ":" and \
                    min_w <= float("".join(out[k:j])) <= max_w:
                del out[k - 1:j]     # 去掉 `:1.2`
                removed = True
                continue             # 顺带把这个多余的后括号也丢掉
            out.append(ch)
            continue
        out.append(ch)
    return "".join(out), removed


def _pairs(s: str) -> list[tuple[int, int]]:
    """所有配对的括号位置（支持 () [] {} 混用；不配对的直接忽略，不猜）。"""
    openers = {op: cl for op, cl in _BRACKETS}
    closers = {cl: op for op, cl in _BRACKETS}
    stack: list[tuple[str, int]] = []
    out: list[tuple[int, int]] = []
    for i, ch in enumerate(s):
        if ch in openers:
            stack.append((ch, i))
        elif ch in closers:
            if stack and stack[-1][0] == closers[ch]:
                _, a = stack.pop()
                out.append((a, i))
            # 不配对的后半括号：跳过（可能本身就是坏数据）
    return out


def _strip_one_pair(s: str, min_w: float, max_w: float,
                    unwrap: bool) -> tuple[str, bool]:
    """剥掉最内层/最右侧那个带超重权重的括号对，返回 (新文本, 是否改了)。

    一次只改一个，调用方循环 —— 这样每次的括号位置都是现算的，嵌套不会算错。
    """
    for a, b in reversed(sorted(_pairs(s))):
        inner = s[a + 1:b]
        m = re.match(rf"^(.*\S)\s*:\s*({_NUM})\s*$", inner)
        if not m or not (min_w <= float(m.group(2)) <= max_w):
            continue
        body = m.group(1)
        if unwrap:
            return s[:a] + body + s[b + 1:], True
        return s[:a + 1] + body + s[b:], True
    return s, False


def strip_weights(text: str, *, min_w: float = 1.1, max_w: float = 5.0,
                  unwrap: bool = True) -> str:
    """返回清掉超重标记后的文本；没有命中时原样返回（幂等）。"""
    if not text:
        return text
    held: list[str] = []

    def hold(m: re.Match) -> str:
        held.append(m.group(0))
        return f"{_HOLD_OPEN}{len(held) - 1}{_HOLD_CLOSE}"

    # 1) 保护 <lora:...> / <lyco:...> / <hypernet:...>
    tmp = re.sub(r"<[^<>]*>", hold, text)
    removed = False   # 只有真的剥了权重才做空白整理，否则原样返回（不做无谓的格式翻新）

    # 2) 括号权重：按「配对括号」由内向外剥（正则会漏掉 `((a, b):1.3)` 这种双括号）
    while True:
        tmp, hit = _strip_one_pair(tmp, min_w, max_w, unwrap)
        if not hit:
            break
        removed = True

    # 3) 括号不配对时剩下的 `:1.2)`（导入时丢了开括号），连多余的后括号一起清
    while True:
        tmp, hit = _strip_orphan(tmp, min_w, max_w)
        if not hit:
            break
        removed = True

    # 4) 裸权重：整段以 `:数字` 结尾才剥，避免误伤 `series:1999`
    segs = []
    for seg in tmp.split(","):
        m = re.match(rf"^(.*\S)\s*:\s*({_NUM})\s*$", seg)
        if m and min_w <= float(m.group(2)) <= max_w:
            segs.append(m.group(1))
            removed = True
        else:
            segs.append(seg)
    tmp = ",".join(segs)

    if not removed:
        return text      # 没有权重可删：连空白都不碰（保持原样，幂等且 diff 干净）

    # 5) 收拾空白与多余逗号（unwrap 之后会出现 `,,` / ` ,`）
    tmp = re.sub(r"\s*,\s*", ", ", tmp)
    tmp = re.sub(r"[ \t]{2,}", " ", tmp).strip().strip(",").strip()

    # 6) 还原保护段
    for i, raw in enumerate(held):
        tmp = tmp.replace(f"{_HOLD_OPEN}{i}{_HOLD_CLOSE}", raw)
    return tmp


def has_overweight(text: str, *, min_w: float = 1.1, max_w: float = 5.0) -> bool:
    """是否含待清理的超重标记（用于统计，不依赖 strip_weights 的副作用）。"""
    return bool(text) and strip_weights(text, min_w=min_w, max_w=max_w) != text
