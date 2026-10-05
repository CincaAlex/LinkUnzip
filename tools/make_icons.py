#!/usr/bin/env python3
"""Make every icon and logo image from the one source logo, logo/linkunzip-logo.png:

- extension/icons/icon{16,32,48,128}.png (128 keeps the Chrome Web Store's 16 px margin)
- logo/linkunzip-logo-256.png
- resources/linkunzip.ico (the helper and the installer, see build.rs and installer/linkunzip.iss)
- resources/wizard-{large,small}-{100,200}.bmp (the installer's side panel and header images)
- extension/icons/logo-lines.png: the logo's engraved line work alone, light on transparent, for
  the popup header and the faint mark behind the file list

    python tools/make_icons.py
"""
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
SOURCE = os.path.join(ROOT, "logo", "linkunzip-logo.png")
ICONS = os.path.join(ROOT, "extension", "icons")
LOGO = os.path.join(ROOT, "logo")
RESOURCES = os.path.join(ROOT, "resources")

# The installer panel: the popup header's graphite, so the logo's tile stands out the same way.
PANEL = (30, 33, 36)
WORDMARK = (238, 241, 242)


def load_tile():
    """The logo cropped to its rounded tile (the source has a transparent margin)."""
    img = Image.open(SOURCE).convert("RGBA")
    box = img.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    return img.crop(box)


def shrink(tile, size):
    """Resize, then sharpen a little: the logo's fine engraving goes soft below 64 px."""
    out = tile.resize((size, size), Image.LANCZOS)
    if size <= 64:
        rgb = out.convert("RGB").filter(ImageFilter.UnsharpMask(radius=1, percent=80, threshold=1))
        rgb.putalpha(out.getchannel("A"))
        out = rgb
    return out


def with_margin(tile, size, margin):
    """`tile` scaled into a `size` square with `margin` transparent pixels on every side."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = shrink(tile, size - 2 * margin)
    canvas.paste(inner, (margin, margin), inner)
    return canvas


def line_art(tile, height):
    """The logo's line work taken from its own pixels: the engraved grooves are darker than the
    tile around them, so what is darker than a blurred copy becomes a light line."""
    gray = tile.convert("L")
    darker = ImageChops.subtract(gray.filter(ImageFilter.GaussianBlur(6)), gray)
    alpha = darker.point(lambda v: max(0, min(255, (v - 3) * 7)))
    inside = tile.getchannel("A").filter(ImageFilter.MinFilter(41))  # not the tile's dark rim
    alpha = ImageChops.multiply(alpha, inside)
    art = Image.new("RGBA", tile.size, WORDMARK + (0,))
    art.putalpha(alpha)
    art = art.crop(alpha.point(lambda a: 255 if a > 40 else 0).getbbox())
    return art.resize((round(art.width * height / art.height), height), Image.LANCZOS)


def wordmark(draw, center_x, top, scale):
    """LINKUNZIP with LINK bold and UNZIP light, like the popup header."""
    try:
        bold = ImageFont.truetype("segoeuib.ttf", 20 * scale)
        light = ImageFont.truetype("segoeuil.ttf", 20 * scale)
    except OSError:
        bold = light = ImageFont.load_default()
    spacing = 1.5 * scale
    parts = [(ch, bold) for ch in "LINK"] + [(ch, light) for ch in "UNZIP"]
    width = sum(draw.textlength(ch, font=f) + spacing for ch, f in parts) - spacing
    x = center_x - width / 2
    for ch, f in parts:
        draw.text((x, top), ch, font=f, fill=WORDMARK)
        x += draw.textlength(ch, font=f) + spacing


def write(img, path):
    img.save(path)
    print("wrote", os.path.relpath(path, ROOT))


def main():
    tile = load_tile()

    for size in (16, 32, 48):
        write(shrink(tile, size), os.path.join(ICONS, f"icon{size}.png"))
    write(with_margin(tile, 128, 16), os.path.join(ICONS, "icon128.png"))
    write(line_art(tile, 240), os.path.join(ICONS, "logo-lines.png"))
    write(shrink(tile, 256), os.path.join(LOGO, "linkunzip-logo-256.png"))

    os.makedirs(RESOURCES, exist_ok=True)
    sizes = (16, 20, 24, 32, 40, 48, 64, 128, 256)
    frames = [shrink(tile, s) for s in sizes]
    ico = os.path.join(RESOURCES, "linkunzip.ico")
    frames[-1].save(ico, sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    print("wrote", os.path.relpath(ico, ROOT))

    for scale in (1, 2):
        # Side panel of the welcome and finish pages (164 x 314 at 100 %).
        w, h = 164 * scale, 314 * scale
        panel = Image.new("RGB", (w, h), PANEL)
        size = 104 * scale
        logo = shrink(tile, size)
        top = int(h * 0.28)
        panel.paste(logo, ((w - size) // 2, top), logo)
        wordmark(ImageDraw.Draw(panel), w / 2, top + size + 16 * scale, scale)
        write(panel, os.path.join(RESOURCES, f"wizard-large-{scale * 100}.bmp"))

        # Top-right image of the inner pages (55 x 55 at 100 %), on the page's white.
        side = 55 * scale
        small = Image.new("RGB", (side, side), (255, 255, 255))
        logo = with_margin(tile, side, 3 * scale)
        small.paste(logo, (0, 0), logo)
        write(small, os.path.join(RESOURCES, f"wizard-small-{scale * 100}.bmp"))


if __name__ == "__main__":
    main()
