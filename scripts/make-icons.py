from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

out = Path(__file__).resolve().parent.parent / "icons"
out.mkdir(exist_ok=True)

def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = max(4, size // 6)
    d.rounded_rectangle((1, 1, size - 2, size - 2), radius=r, fill=(14, 22, 19, 255), outline=(61, 255, 138, 220), width=max(1, size // 32))
    pad = size * 0.28
    # lock body
    x0, y0 = pad, size * 0.42
    x1, y1 = size - pad, size * 0.82
    d.rounded_rectangle((x0, y0, x1, y1), radius=max(2, size // 14), fill=(61, 255, 138, 255))
    # shackle
    cx = size / 2
    top = size * 0.22
    d.arc((pad + size * 0.08, top, size - pad - size * 0.08, size * 0.58), 200, 340, fill=(61, 255, 138, 255), width=max(2, size // 12))
    return img

for s in (16, 48, 128):
    make(s).save(out / f"icon{s}.png")

def make_clip(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), (23, 33, 43))
    d = ImageDraw.Draw(img)
    m = int(size * 0.08)
    d.ellipse((m, m, size - m, size - m), fill=(42, 171, 238))
    font = None
    for p in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        try:
            font = ImageFont.truetype(p, int(size * 0.52))
            break
        except OSError:
            continue
    text = "S"
    if font:
        bbox = d.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text(((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1] - size * 0.02), text, fill=(255, 255, 255), font=font)
    else:
        d.text((size * 0.32, size * 0.22), text, fill=(255, 255, 255))
    return img

make_clip(180).save(out / "icon180.png")
print("ok")
