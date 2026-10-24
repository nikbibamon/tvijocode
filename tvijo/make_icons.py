#!/usr/bin/env python3
"""Generate every Tvijo Code brand image from one glyph.

Why a script and not hand-made files: the VSCodium tree ships its own logo in
~70 places; regenerating from one source keeps the brand consistent after each
upstream rebase. Pillow only, so it runs anywhere without ImageMagick/rsvg.

Usage: python3 tvijo/make_icons.py   (writes into tvijo/src/stable/)
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "src" / "stable"

BG = (40, 104, 216, 255)        # --accent light theme of the extension (#2868d8)
SURFACE = (17, 21, 28)          # --surface dark theme (#11151c)
FG = (255, 255, 255, 255)

# The glyph from the extension's media/tvijo.svg (viewBox 24x24):
# M3 5h18v2H3z  m7 3h4v11h-4z  m-4 3h12v2H6z
GLYPH = [(3, 5, 21, 7), (10, 8, 14, 19), (6, 11, 18, 13)]
GLYPH_SVG = '<path d="M3 5h18v2H3zm7 3h4v11h-4zm-4 3h12v2H6z"/>'


def glyph(draw: ImageDraw.ImageDraw, x0: float, y0: float, size: float, fill) -> None:
    k = size / 24.0
    for a, b, c, d in GLYPH:
        draw.rectangle([x0 + a * k, y0 + b * k, x0 + c * k - 1, y0 + d * k - 1], fill=fill)


def app_icon(size: int, margin: float = 0.0) -> Image.Image:
    """Rounded tile with the glyph; margin leaves room the macOS grid expects."""
    scale = 4  # draw big, downsample: cheap antialiasing
    s = size * scale
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    m = int(s * margin)
    d.rounded_rectangle([m, m, s - m - 1, s - m - 1], radius=int((s - 2 * m) * 0.22), fill=BG)
    inner = s - 2 * m
    glyph(d, m + inner * 0.12, m + inner * 0.10, inner * 0.76, FG)
    return im.resize((size, size), Image.LANCZOS)


def installer_big(w: int, h: int) -> Image.Image:
    im = Image.new("RGB", (w, h), SURFACE)
    tile = app_icon(int(w * 0.6))
    im.paste(tile, ((w - tile.width) // 2, int(h * 0.18)), tile)
    return im


def installer_small(w: int, h: int) -> Image.Image:
    im = Image.new("RGB", (w, h), (255, 255, 255))
    side = int(min(w, h) * 0.86)
    tile = app_icon(side)
    im.paste(tile, ((w - side) // 2, (h - side) // 2), tile)
    return im


def svg_tile() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 24 24">\n'
        '  <rect width="24" height="24" rx="5.3" fill="#2868d8"/>\n'
        '  <g fill="#fff" transform="translate(2.88 2.4) scale(0.76)">' + GLYPH_SVG + "</g>\n"
        "</svg>\n"
    )


def svg_letterpress(fill: str, opacity: str | None) -> str:
    op = f' fill-opacity="{opacity}"' if opacity else ""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24">\n'
        f'  <g fill="{fill}"{op}>' + GLYPH_SVG + "</g>\n"
        "</svg>\n"
    )


def xpm(im: Image.Image) -> str:
    """Pillow reads XPM but cannot write it; the rpm spec still wants one."""
    alpha = im.getchannel("A")
    pal = im.convert("RGB").quantize(colors=15)
    colours = pal.getpalette()[: 15 * 3]
    keys = "abcdefghijklmno"
    rows = []
    for y in range(im.height):
        row = []
        for x in range(im.width):
            row.append(" " if alpha.getpixel((x, y)) < 128 else keys[pal.getpixel((x, y))])
        rows.append('"' + "".join(row) + '"')
    head = [f'"{im.width} {im.height} 16 1"', '"  c None"']
    head += [f'"{keys[i]} c #{colours[3*i]:02x}{colours[3*i+1]:02x}{colours[3*i+2]:02x}"' for i in range(15)]
    return "/* XPM */\nstatic char * code_xpm[] = {\n" + ",\n".join(head + rows) + "};\n"


# Sizes copied from the VSCodium files these replace (checked 2026-10-24).
INNO_BIG = {100: (164, 314), 125: (192, 386), 150: (246, 459), 175: (273, 556),
            200: (328, 604), 225: (355, 700), 250: (410, 797)}
INNO_SMALL = {100: (55, 55), 125: (64, 68), 150: (83, 80), 175: (92, 97),
              200: (110, 106), 225: (119, 123), 250: (138, 140)}
LETTERPRESS = {"dark": ("#B2B2B2", "0.3"), "light": ("#B2B2B2", "0.1"),
               "hcDark": ("#3C3C3C", None), "hcLight": ("#B2B2B2", None)}


def main() -> None:
    win = OUT / "resources" / "win32"
    mac = OUT / "resources" / "darwin"
    lin = OUT / "resources" / "linux"
    srv = OUT / "resources" / "server"
    media = OUT / "src" / "vs" / "workbench" / "browser" / "media"
    editor = OUT / "src" / "vs" / "workbench" / "browser" / "parts" / "editor" / "media"
    for p in (win, mac, lin / "rpm", srv, media, editor):
        p.mkdir(parents=True, exist_ok=True)

    big = app_icon(1024)
    big.save(win / "code.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    app_icon(150).save(win / "code_150x150.png")
    app_icon(70).save(win / "code_70x70.png")
    for scale, (w, h) in INNO_BIG.items():
        installer_big(w, h).save(win / f"inno-big-{scale}.bmp")
    for scale, (w, h) in INNO_SMALL.items():
        installer_small(w, h).save(win / f"inno-small-{scale}.bmp")

    app_icon(1024, margin=0.1).save(mac / "code.icns")

    app_icon(512).save(lin / "code.png")
    (lin / "code.svg").write_text(svg_tile())
    (lin / "rpm" / "code.xpm").write_text(xpm(app_icon(64)))

    app_icon(192).save(srv / "code-192.png")
    app_icon(512).save(srv / "code-512.png")
    big.save(srv / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    (media / "code-icon.svg").write_text(svg_tile())
    for theme, (fill, op) in LETTERPRESS.items():
        (editor / f"letterpress-{theme}.svg").write_text(svg_letterpress(fill, op))

    print("written:", sum(1 for _ in OUT.rglob("*") if _.is_file()), "files under", OUT)


if __name__ == "__main__":
    main()
