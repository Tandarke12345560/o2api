#!/usr/bin/env python3
"""Generate assets/demo.gif and assets/social.png without external tools."""

from PIL import Image, ImageDraw, ImageFont

W, H = 780, 440
BG = "#0B0E14"
PANEL = "#11161F"
BORDER = "#1F2937"
GREEN = "#34D399"
CYAN = "#22D3EE"
PURPLE = "#A78BFA"
GRAY = "#9CA3AF"
WHITE = "#F3F4F6"
DIM = "#6B7280"
RED = "#F87171"
YELLOW = "#FBBF24"

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
f = ImageFont.truetype(FONT, 17)
fb = ImageFont.truetype(FONT_B, 17)
ft = ImageFont.truetype(FONT_B, 15)


def window(draw):
    draw.rounded_rectangle([16, 16, W - 16, H - 16], radius=16, fill=PANEL, outline=BORDER, width=2)
    for i, color in enumerate(["#FF5F57", "#FEBC2E", "#28C840"]):
        cx = 44 + i * 22
        draw.ellipse([cx - 6, 38, cx + 6, 50], fill=color)
    draw.text((130, 34), "o2api — zsh", font=ft, fill=DIM)


def line(draw, y, parts, x=40):
    for text, font, color in parts:
        draw.text((x, y), text, font=font, fill=color)
        x += draw.textlength(text, font=font)


LINES = [
    [("$ ", fb, GREEN), ("o2api", fb, WHITE)],
    [("  ➜ ", f, GREEN), ("Local     ", f, GRAY), ("http://127.0.0.1:8787/v1", f, CYAN)],
    [("  ➜ ", f, GREEN), ("Upstream  ", f, GRAY), ("http://127.0.0.1:49374", f, CYAN)],
    [("  ➜ ", f, GREEN), ("Auth      ", f, GRAY), ("open (localhost only)", f, YELLOW)],
    [],
    [("$ ", fb, GREEN), ("curl -s localhost:8787/v1/models | jq '.data[0].id'", f, WHITE)],
    [('"flint-40b-free"', f, PURPLE)],
    [],
    [("$ ", fb, GREEN), ("curl -s localhost:8787/v1/chat/completions \\", f, WHITE)],
    [("     -d '{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'", f, WHITE)],
    [("{\"choices\":[{\"message\":{\"content\":", f, GRAY), ('"Merhaba!"', f, PURPLE), ("}}]}", f, GRAY)],
]


def frame(n_lines, cursor=True, cursor_line=None):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    window(d)
    y = 76
    for i, parts in enumerate(LINES[:n_lines]):
        line(d, y, parts)
        y += 28
    if cursor:
        cy = 76 + 28 * (n_lines - 1 if n_lines else 0)
        if cursor_line is not None:
            cy = 76 + 28 * cursor_line
        prefix_w = 0
        if LINES and n_lines:
            prefix_w = sum(d.textlength(t, font=fnt) for t, fnt, _ in LINES[min(n_lines - 1, len(LINES) - 1)])
        d.rectangle([40 + prefix_w + 2, cy + 2, 40 + prefix_w + 13, cy + 21], fill=GREEN)
    return img


frames = []
for i in range(1, len(LINES) + 1):
    frames.append(frame(i, cursor=True, cursor_line=i - 1))
# blink hold
frames.append(frame(len(LINES), cursor=True, cursor_line=len(LINES) - 1))
frames.append(frame(len(LINES), cursor=False))
frames.append(frame(len(LINES), cursor=True, cursor_line=len(LINES) - 1))

durations = [480] * (len(frames) - 3) + [600, 500, 1600]

frames[0].save(
    "/root/opencode-bridge/assets/demo.gif",
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
)
print("wrote assets/demo.gif", len(frames), "frames")

# ---------------------------------------------------------------- social card

SW, SH = 1280, 640
img = Image.new("RGB", (SW, SH), BG)
d = ImageDraw.Draw(img)

for y in range(SH):
    t = y / SH
    r = int(11 + 8 * t)
    g = int(14 + 8 * t)
    b = int(20 + 18 * t)
    d.line([(0, y), (SW, y)], fill=(r, g, b))

big = ImageFont.truetype(FONT_B, 74)
mark = ImageFont.truetype(FONT_B, 54)
sub = ImageFont.truetype(FONT, 26)
chip = ImageFont.truetype(FONT_B, 20)

d.rounded_rectangle([80, 88, 210, 218], radius=30, fill="#111827", outline="#7C3AED", width=2)
mw = d.textlength("{ }", font=mark)
d.text((145 - mw / 2, 118), "{ }", font=mark, fill=CYAN)

d.text((246, 100), "o2", font=big, fill=WHITE)
d.text((246 + d.textlength("o2", font=big) + 6, 100), "api", font=big, fill=CYAN)
d.text((250, 196), "OpenCode  →  OpenAI-compatible API", font=sub, fill=GRAY)

for i, (label, color) in enumerate([("zero deps", "#C4B5FD"), ("one command", "#A5F3FC"), ("OpenAI SDK", "#A7F3D0")]):
    x = 250 + i * 210
    d.rounded_rectangle([x, 262, x + 185, 304], radius=21, fill="#161C28", outline=color, width=1)
    d.text((x + 24, 272), label, font=chip, fill=color)

d.text((250, 372), "curl http://127.0.0.1:8787/v1/chat/completions", font=sub, fill=CYAN)
d.text((250, 414), '  -d \'{"model":"...","messages":[...]}\'', font=sub, fill=DIM)
d.text((250, 482), "https://github.com/yourname/o2api", font=sub, fill=GRAY)

img.save("/root/opencode-bridge/assets/social.png", optimize=True)
print("wrote assets/social.png")
