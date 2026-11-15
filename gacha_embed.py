# -*- coding: utf-8 -*-
"""把默认 JSON（action.json + zh_TW.json）内嵌进 gacha.html，
使页面即使以 file:// 独立打开也能默认载入这两份数据。

用法：
  python gacha_embed.py [--files action.json zh_TW.json]
  （默认嵌入 DEFAULT_FILES；可多次运行，幂等，只替换标记之间的内容）
"""

import argparse
import json
import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_FILE = os.path.join(BASE_DIR, "gacha.html")
DEFAULT_FILES = ["action.json", "zh_TW.json"]
START = "/*__DEFAULT_JSONS_START__*/"
END = "/*__DEFAULT_JSONS_END__*/"


def main():
    ap = argparse.ArgumentParser(description="内嵌默认 JSON 到 gacha.html")
    ap.add_argument("--files", nargs="*", default=DEFAULT_FILES,
                    help="要内嵌的 json 文件（默认 action.json zh_TW.json）")
    ap.add_argument("--html", default=HTML_FILE, help="目标 HTML 路径")
    args = ap.parse_args()

    html_path = os.path.abspath(args.html)
    if not os.path.isfile(html_path):
        print(f"[ERROR] 找不到 {html_path}", file=sys.stderr)
        return 2
    html = open(html_path, "r", encoding="utf-8").read()
    if START not in html or END not in html:
        print(f"[ERROR] {html_path} 中缺少标记 {START!r} / {END!r}", file=sys.stderr)
        return 2

    payload = {}
    missing = []
    for f in args.files:
        fp = os.path.join(BASE_DIR, f)
        if not os.path.isfile(fp):
            missing.append(f)
            continue
        payload[f] = json.load(open(fp, "r", encoding="utf-8-sig"))
        print(f"  已读取 {f}: {len(payload[f])} 条")

    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    new_html = re.sub(
        re.escape(START) + r".*?" + re.escape(END),
        START + blob + END,
        html,
        flags=re.S,
    )
    open(html_path, "w", encoding="utf-8").write(new_html)
    size_kb = os.path.getsize(html_path) / 1024.0
    print(f"[OK] 已写入 {html_path}（{size_kb:.0f} KB）")
    if missing:
        print(f"[WARN] 缺失文件（未嵌入）: {missing}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
