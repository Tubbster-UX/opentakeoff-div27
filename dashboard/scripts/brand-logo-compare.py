# Compare web/public/brand/*.svg with the logo artwork as the Brink Design Brand Guidelines PDF
# (v1.0) renders it (pages 3, 4, 5). The PDF is the owner's and is not in the repository.
# Writes cmp-*.png (PDF | SVG | overlap diff) and compare.json (IoU of the ink masks) to <workdir>.
#
# usage (Python with Pillow and NumPy; Chromium through Playwright for the SVG renders):
#   pdftocairo -png -r 288 -f 3 -l 5 Brink-Design-Brand-Guidelines.pdf <workdir>/pdf
#   cp web/public/brand/brink-design-{shield,wordmark}-{navy,white}.svg <workdir>/
#   python3 scripts/brand-logo-compare.py <workdir> crop     # finds the artwork, writes sizes.json
#   render each SVG to <workdir>/r-<shield|wordmark>-<navy|white>.png at the size in sizes.json, transparent
#   python3 scripts/brand-logo-compare.py <workdir> diff
import json, sys, os
from PIL import Image, ImageChops, ImageDraw, ImageFont
import numpy as np

W = sys.argv[1]
K = 3168 / 1100  # 288-dpi page px per px of an 1100-px-wide page preview (the crop boxes below)
# (name, pdf page, preview-px crop box, mark is dark?, svg file)
CASES = [
    ("shield-navy p3", "pdf-03.png", (150, 290, 545, 620), True, "brink-design-shield-navy.svg"),
    ("shield-white p4", "pdf-04.png", (410, 230, 690, 460), False, "brink-design-shield-white.svg"),
    ("wordmark-navy p5", "pdf-05.png", (120, 220, 500, 400), True, "brink-design-wordmark-navy.svg"),
    ("wordmark-white p5", "pdf-05.png", (600, 220, 990, 400), False, "brink-design-wordmark-white.svg"),
]

def mask(img, dark):
    a = np.asarray(img.convert("L"), dtype=np.float32)
    return a < 128 if dark else a > 128

phase = sys.argv[2] if len(sys.argv) > 2 else "crop"
sizes = {}
report = []
for name, page, box, dark, svg in CASES:
    im = Image.open(os.path.join(W, page)).convert("RGB")
    crop = im.crop(tuple(int(v * K) for v in box))
    m = mask(crop, dark)
    ys, xs = np.nonzero(m)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    art = crop.crop((x0, y0, x1, y1))
    key = name.split()[0]
    if phase == "crop":
        art.save(os.path.join(W, f"p-{key}.png"))
        sizes[key] = [int(x1 - x0), int(y1 - y0), svg]
        continue
    r = Image.open(os.path.join(W, f"r-{key}.png")).convert("RGB")
    bg = (13, 22, 31) if not dark else (255, 255, 255)
    flat = Image.new("RGB", r.size, bg)
    flat.paste(r, mask=Image.open(os.path.join(W, f"r-{key}.png")).split()[-1])
    a, b = mask(art, dark), mask(flat, dark)
    h = min(a.shape[0], b.shape[0]); w = min(a.shape[1], b.shape[1])
    a, b = a[:h, :w], b[:h, :w]
    iou = (a & b).sum() / max((a | b).sum(), 1)
    xor = (a ^ b).sum() / max(a.sum(), 1)
    report.append({"case": name, "pdf_px": [int(x1 - x0), int(y1 - y0)], "iou": round(float(iou), 4), "xor_over_ink": round(float(xor), 4)})
    # side by side + diff
    d = np.zeros((h, w, 3), np.uint8) + 255
    d[a & b] = (150, 160, 170)
    d[a & ~b] = (200, 30, 30)
    d[~a & b] = (30, 90, 200)
    pad = 24
    sheet = Image.new("RGB", (w * 3 + pad * 4, h + pad * 2 + 30), (255, 255, 255))
    sheet.paste(art.resize((w, h)) if art.size != (w, h) else art.crop((0, 0, w, h)), (pad, pad + 30))
    sheet.paste(flat.crop((0, 0, w, h)), (pad * 2 + w, pad + 30))
    sheet.paste(Image.fromarray(d), (pad * 3 + 2 * w, pad + 30))
    dr = ImageDraw.Draw(sheet)
    f = ImageFont.load_default(size=22)
    dr.text((pad, 8), f"PDF ({page}, 288 dpi)", fill=(0, 0, 0), font=f)
    dr.text((pad * 2 + w, 8), f"{svg}", fill=(0, 0, 0), font=f)
    dr.text((pad * 3 + 2 * w, 8), f"overlap IoU {iou:.3f} (red PDF only, blue SVG only)", fill=(0, 0, 0), font=f)
    sheet.save(os.path.join(W, f"cmp-{key}.png"))
if phase == "crop":
    json.dump(sizes, open(os.path.join(W, "sizes.json"), "w"))
    print(sizes)
else:
    json.dump(report, open(os.path.join(W, "compare.json"), "w"), indent=1)
    print(json.dumps(report, indent=1))
