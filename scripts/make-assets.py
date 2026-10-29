"""把真实终端输出渲染成图片（PNG / 动图 GIF），用于 README。

输入：.demo/captures/*.txt（真实命令输出）
输出：docs/assets/*.png, *.gif
"""
from __future__ import annotations

import pathlib
import re

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
CAPS = ROOT / ".demo" / "captures"
OUT = ROOT / "docs" / "assets"
OUT.mkdir(parents=True, exist_ok=True)

W, H = 1120, 520
PAD = 28
LINE_H = 24
FS = 15

MONO = "C:/Windows/Fonts/consola.ttf"
CJK = "C:/Windows/Fonts/msyh.ttc"

f_mono = ImageFont.truetype(MONO, FS)
f_cjk = ImageFont.truetype(CJK, FS)
# 粗体标题
f_title = ImageFont.truetype(CJK, 14)

BG = (13, 17, 23)
BAR = (22, 27, 34)
FG = (201, 209, 217)
DIM = (139, 148, 158)
GREEN = (63, 185, 80)
RED = (248, 81, 73)
BLUE = (88, 166, 255)
YELLOW = (210, 153, 34)


def is_cjk(ch: str) -> bool:
    return ord(ch) > 0x2E80


def shorten(line: str) -> str:
    line = re.sub(r"[A-Z]:\\[^ ]*?\\\.demo\\downloads", "~/Downloads", line)
    line = re.sub(r"root=[A-Z]:\\[^ ]*", "root=~/Downloads", line)
    line = re.sub(r"[A-Z]:\\[^\s]*deskshell[^\s]*", "~/deskshell", line)
    return line.rstrip()


def color_for(line: str) -> tuple[int, int, int]:
    s = line.strip()
    if s.startswith("✓"):
        return GREEN
    if s.startswith("✗"):
        return RED
    if s.startswith("·"):
        return DIM
    if s.startswith("PASS"):
        return GREEN
    if s.startswith("FAIL"):
        return RED
    if s.startswith("WARN"):
        return YELLOW
    if s.startswith("RESULT") or s.startswith("PASS "):
        return GREEN
    return FG


def draw_line(draw: ImageDraw.ImageDraw, x: int, y: int, text: str, color: tuple[int, int, int]) -> int:
    """逐段绘制（ASCII 用 Consolas，中文用雅黑），返回结束 x。"""
    buf = ""
    cur_cjk = False
    for ch in text:
        c = is_cjk(ch)
        if buf and c != cur_cjk:
            f = f_cjk if cur_cjk else f_mono
            draw.text((x, y), buf, font=f, fill=color)
            x += f.getlength(buf)
            buf = ""
        buf += ch
        cur_cjk = c
    if buf:
        f = f_cjk if cur_cjk else f_mono
        draw.text((x, y), buf, font=f, fill=color)
        x += f.getlength(buf)
    return x


def frame(title: str, lines: list[str], height: int | None = None) -> Image.Image:
    h = height or max(240, 64 + len(lines) * LINE_H + 22)
    img = Image.new("RGB", (W, h), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W - 1, h - 1], radius=12, fill=BG, outline=(48, 54, 61))
    d.rectangle([0, 0, W, 38], fill=BAR)
    d.rounded_rectangle([0, 0, W, 38], radius=12, fill=BAR)
    for i, col in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([16 + i * 22, 13, 28 + i * 22, 25], fill=col)
    tw = d.textlength(title, font=f_title)
    d.text(((W - tw) / 2, 11), title, font=f_title, fill=DIM)

    y = 58
    for line in lines:
        if y > h - 28:
            break
        color = BLUE if line.startswith("$ ") else color_for(line)
        draw_line(d, PAD, y, shorten(line), color)
        y += LINE_H
    return img


def read(name: str) -> list[str]:
    p = CAPS / f"{name}.txt"
    return p.read_text(encoding="utf-8", errors="replace").splitlines()


def take(lines: list[str], n: int) -> list[str]:
    return lines[:n]


# --- 静态图 ---
cmd = {"doctor": "$ deskshell doctor", "story": "$ deskshell story", "undo": "$ deskshell run downloads-cleanup --mode undo"}
for name, n in [("doctor", 12), ("story", 17), ("undo", 8)]:
    body = [cmd.get(name, "")] + [l for l in take(read(name), n) if l.strip()]
    frame(f"deskshell — {name}", body).save(OUT / f"{name}.png")

# --- 动图：preview → apply → undo ---
preview = take(read("preview"), 12)
apply_ = take(read("apply"), 12)
undo_ = take(read("undo"), 10)

cmds = {
    "preview": "$ deskshell run downloads-cleanup --mode preview",
    "apply": "$ deskshell run downloads-cleanup --mode apply",
    "undo": "$ deskshell run downloads-cleanup --mode undo",
}
max_lines = max(len(preview), len(apply_), len(undo_)) + 1
gif_h = 64 + max_lines * LINE_H + 22
frames = [
    frame("deskshell — 先看计划，再动手", [cmds["preview"]] + preview[:4], gif_h),
    frame("deskshell — 先看计划，再动手", [cmds["preview"]] + preview, gif_h),
    frame("deskshell — 执行", [cmds["apply"]] + apply_, gif_h),
    frame("deskshell — 一键撤销", [cmds["undo"]] + undo_, gif_h),
]
frames = [f.convert("P", palette=Image.ADAPTIVE, colors=96) for f in frames]
frames[0].save(
    OUT / "hero.gif",
    save_all=True,
    append_images=frames[1:],
    duration=[900, 1500, 1500, 1800],
    loop=0,
    optimize=True,
)

for name in ["hero.gif", "doctor.png", "story.png", "undo.png"]:
    p = OUT / name
    print(f"{name:12} {p.stat().st_size/1024:6.1f} KB")
