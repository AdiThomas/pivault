"""Draws the PiVault app icon, splash image and favicon into mobile/assets/images.

    docker run --rm -v "$PWD/mobile/assets/images:/out" -v "$PWD/scripts/dev:/s" \
        pivault-dev-api python /s/make-icons.py
"""
from PIL import Image, ImageDraw

S = 2048  # draw large, then shrink for smooth edges
BG_TOP, BG_BOTTOM = (16, 22, 36), (9, 11, 16)
ACCENT, ACCENT_SOFT, WHITE = (79, 140, 255), (45, 84, 170), (242, 244, 247)


def background(size):
    img = Image.new("RGB", (size, size))
    px = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        px.line([(0, y), (size, y)],
                fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))
    return img.convert("RGBA")


def glyph(size, color=WHITE, ring=ACCENT, ring_soft=ACCENT_SOFT, scale=1.0):
    """The vault-door ring with a pi inside, on a transparent layer."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    c = size / 2
    u = size / 1024 * scale  # design units

    def box(x0, y0, x1, y1):
        return [c + x0 * u, c + y0 * u, c + x1 * u, c + y1 * u]

    # Outer ring and a thin inner ring, like a vault door.
    d.ellipse(box(-340, -340, 340, 340), outline=ring, width=round(46 * u))
    d.ellipse(box(-268, -268, 268, 268), outline=ring_soft, width=round(10 * u))
    # Dial marks at the four compass points.
    for dx, dy in ((0, -1), (1, 0), (0, 1), (-1, 0)):
        x, y = dx * 304, dy * 304
        w, h = (14, 40) if dx == 0 else (40, 14)
        d.rounded_rectangle(box(x - w / 2, y - h / 2, x + w / 2, y + h / 2), radius=7 * u, fill=ring)
    # Pi: a bar with two legs.
    d.rounded_rectangle(box(-176, -124, 176, -66), radius=29 * u, fill=color)
    d.rounded_rectangle(box(-108, -100, -54, 150), radius=27 * u, fill=color)
    d.rounded_rectangle(box(54, -100, 108, 150), radius=27 * u, fill=color)
    return layer


def save(img, name, size):
    img.resize((size, size), Image.Resampling.LANCZOS).save(f"/out/{name}", optimize=True)


# App icon (iOS adds its own rounded corners, so the square is full-bleed).
icon = background(S)
icon.alpha_composite(glyph(S))
save(icon.convert("RGB"), "icon.png", 1024)

# Android adaptive icon: the foreground must sit inside the central safe zone.
save(glyph(S, scale=0.62), "android-icon-foreground.png", 1024)
save(background(S).convert("RGB"), "android-icon-background.png", 1024)
save(glyph(S, color=(255, 255, 255), ring=(255, 255, 255), ring_soft=(255, 255, 255), scale=0.62),
     "android-icon-monochrome.png", 1024)

# Splash: the glyph alone; app.json supplies the dark background colour.
save(glyph(S), "splash-icon.png", 512)

# Browser tab icon.
favicon = background(S)
favicon.alpha_composite(glyph(S, scale=1.15))
save(favicon, "favicon.png", 96)
print("icons written")
