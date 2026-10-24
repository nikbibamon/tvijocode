#!/usr/bin/env python3
"""Generate every Tvijo Code brand image from the Tvijo logo.

Why a script and not hand-made files: the VSCodium tree ships its own logo in
~30 places; regenerating from one source keeps the brand consistent after each
upstream rebase. Pillow only, so it runs anywhere without ImageMagick/rsvg.

Source: tvijo/logo-128.png (gold emblem on navy). A larger source can replace
it under the same name; 128 px upscaled to the 1024 px macOS icon is soft.

Usage: python3 tvijo/make_icons.py   (writes into tvijo/src/stable/)
"""
from __future__ import annotations

import base64
import io
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "src" / "stable"
LOGO = Image.open(ROOT / "logo-128.png").convert("RGBA")
SURFACE = (6, 14, 27)  # the logo's own background, so installer art blends in


def app_icon(size: int, margin: float = 0.0) -> Image.Image:
    """Logo on a rounded tile; margin leaves room the macOS icon grid expects."""
    scale = 4  # mask drawn big, then downsampled: cheap antialiasing
    inner = size - 2 * int(size * margin)
    logo = LOGO.resize((inner, inner), Image.LANCZOS)
    mask = Image.new("L", (inner * scale, inner * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, inner * scale - 1, inner * scale - 1], radius=int(inner * scale * 0.22), fill=255)
    logo.putalpha(mask.resize((inner, inner), Image.LANCZOS))
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    im.paste(logo, ((size - inner) // 2, (size - inner) // 2), logo)
    return im


def emblem_mask(size: int) -> Image.Image:
    """Alpha of the gold emblem alone: luminance above the navy background."""
    grey = LOGO.convert("L").resize((size, size), Image.LANCZOS)
    background = grey.getpixel((0, 0))
    return grey.point(lambda v: 0 if v <= background + 25 else min(255, (v - background - 25) * 3))


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


def png_data_uri(im: Image.Image) -> str:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def svg_image(im: Image.Image, width: int, height: int) -> str:
    """SVG wrapper around a raster: the workbench and Linux menus ask for .svg."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {im.width} {im.height}">\n'
        f'  <image width="{im.width}" height="{im.height}" href="{png_data_uri(im)}"/>\n'
        "</svg>\n"
    )


def letterpress(colour: tuple[int, int, int], opacity: float) -> Image.Image:
    mask = emblem_mask(256)
    if opacity < 1:
        mask = ImageChops.multiply(mask, Image.new("L", mask.size, int(255 * opacity)))
    im = Image.new("RGBA", mask.size, colour + (0,))
    im.putalpha(mask)
    return im


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
LETTERPRESS = {"dark": ((178, 178, 178), 0.3), "light": ((178, 178, 178), 0.1),
               "hcDark": ((60, 60, 60), 1.0), "hcLight": ((178, 178, 178), 1.0)}


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
    (lin / "code.svg").write_text(svg_image(app_icon(256), 1024, 1024))
    (lin / "rpm" / "code.xpm").write_text(xpm(app_icon(64)))

    app_icon(192).save(srv / "code-192.png")
    app_icon(512).save(srv / "code-512.png")
    big.save(srv / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    (media / "code-icon.svg").write_text(svg_image(app_icon(256), 1024, 1024))
    for theme, (colour, opacity) in LETTERPRESS.items():
        (editor / f"letterpress-{theme}.svg").write_text(svg_image(letterpress(colour, opacity), 40, 40))

    print("written:", sum(1 for _ in OUT.rglob("*") if _.is_file()), "files under", OUT)


if __name__ == "__main__":
    main()
