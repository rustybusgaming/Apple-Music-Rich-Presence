#!/usr/bin/env python3
"""Download Apple's current Apple Music app icon from the App Store and
regenerate every icon this app uses from it.

    pip install pillow
    python scripts/update_logo.py

The release workflow runs this before each build, so releases always ship
with Apple's latest logo.
"""

import io
import json
import re
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

APP_ID = 1108187390  # Apple Music (com.apple.Music) on the App Store
ICONS = Path(__file__).resolve().parent.parent / "icons"
CORNER_RADIUS = 0.2237  # Apple's app icon corner radius, as a fraction of the size


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "AppleMusicRPC-icon-updater"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def download_logo():
    info = json.loads(fetch(f"https://itunes.apple.com/lookup?id={APP_ID}"))
    url = info["results"][0]["artworkUrl512"]
    # Apple's image server can render any size; ask for the largest as PNG.
    url = re.sub(r"/\d+x\d+bb\.\w+$", "/1024x1024bb.png", url)
    return Image.open(io.BytesIO(fetch(url))).convert("RGBA"), url


def rounded_mask(size, supersample=4):
    big = size * supersample
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=round(big * CORNER_RADIUS), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def tile(logo, size):
    """The logo as a rounded square, like it appears on an iPhone."""
    image = logo.resize((size, size), Image.LANCZOS)
    image.putalpha(rounded_mask(size))
    return image


def mac_icon(logo, size=1024):
    """macOS-style icon: a smaller rounded square with a soft drop shadow."""
    body = round(size * 824 / 1024)
    offset = (size - body) // 2
    shadow = Image.new("L", (size, size), 0)
    shadow.paste(rounded_mask(body), (offset, offset + round(size * 10 / 1024)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 14 / 1024)).point(lambda a: round(a * 0.35))
    black = Image.new("L", (size, size), 0)
    icon = Image.merge("RGBA", (black, black, black, shadow))
    icon.alpha_composite(tile(logo, body), (offset, offset))
    return icon


def menu_bar_template(logo, size):
    """Just the music note in black, for the macOS menu bar. macOS recolors
    template images to match light and dark mode."""
    darkness = logo.convert("L").point(lambda v: max(0, min(255, round((225 - v) * 255 / 185))))
    alpha = ImageChops.multiply(darkness, rounded_mask(logo.width))
    glyph = alpha.crop(alpha.point(lambda a: 255 if a > 40 else 0).getbbox())

    inner = size - max(2, size // 9)
    scale = inner / max(glyph.size)
    glyph = glyph.resize((max(1, round(glyph.width * scale)), max(1, round(glyph.height * scale))), Image.LANCZOS)

    canvas = Image.new("L", (size, size), 0)
    canvas.paste(glyph, ((size - glyph.width) // 2, (size - glyph.height) // 2))
    black = Image.new("L", (size, size), 0)
    return Image.merge("RGBA", (black, black, black, canvas))


def main():
    try:
        logo, url = download_logo()
    except Exception as error:  # noqa: BLE001 - report any network/parse failure plainly
        sys.exit(f"Couldn't download the Apple Music logo: {error}")
    print(f"Downloaded {url}")

    outputs = {
        "applemusic.png": tile(logo, 512),
        "tray.png": tile(logo, 16),  # Windows system tray
        "tray@2x.png": tile(logo, 32),
        "trayTemplate.png": menu_bar_template(logo, 18),  # macOS menu bar
        "trayTemplate@2x.png": menu_bar_template(logo, 36),
    }
    for name, image in outputs.items():
        image.save(ICONS / name, optimize=True)

    tile(logo, 256).save(
        ICONS / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )
    mac_icon(logo).save(ICONS / "icon.icns")
    print(f"Updated icons in {ICONS}")


if __name__ == "__main__":
    main()
