"""Draws sample.png: a toy robot from four sides on an off-white sheet, with
soft shadows, the way an image generator lays out a turnaround."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

S = 3  # drawn larger and scaled down, for smooth edges
W, H = 1600, 900
BG = (243, 241, 236)
BODY, DARK, GLASS, TRIM, PACK = (226, 94, 48), (58, 62, 74), (120, 200, 220), (245, 205, 80), (90, 120, 150)


def robot(d, cx, top, side, back=False, facing=1):
    def box(x0, y0, x1, y1, fill, r=14):
        d.rounded_rectangle([(cx + x0) * S, (top + y0) * S, (cx + x1) * S, (top + y1) * S], r * S, fill=fill)
    half = 55 if side else 105
    d.line([(cx * S, (top - 40) * S), (cx * S, top * S)], fill=DARK, width=6 * S)          # antenna
    d.ellipse([(cx - 10) * S, (top - 56) * S, (cx + 10) * S, (top - 36) * S], fill=TRIM)
    box(-half * .8, 0, half * .8, 130, BODY, 26)                                             # head
    box(-half, 150, half, 400, BODY, 22)                                                     # body
    for x in ((0,) if side else (-60, 60)):                                                  # legs, feet
        box(x - 24, 400, x + 24, 520, DARK, 8)
        box(x - 34 + (16 * facing if side else 0), 510, x + 34 + (16 * facing if side else 0), 545, DARK, 10)
    if side:
        box(-18, 170, 18, 330, DARK, 16)                                                     # the near arm
        box(-half - 36 if facing > 0 else half, 170, -half if facing > 0 else half + 36, 340, PACK, 10)  # backpack
        e = half * .8 * facing
        box(min(e, e - 20 * facing), 40, max(e, e - 20 * facing), 90, GLASS, 6)              # visor from the side
    else:
        for x in (-half - 40, half + 4):
            box(x, 160, x + 36, 340, DARK, 16)                                               # arms
        if back:
            box(-70, 170, 70, 340, PACK, 12)
            box(-20, 200, 20, 230, TRIM, 6)
        else:
            box(-62, 36, 62, 92, GLASS, 20)                                                  # visor
            box(-50, 190, 50, 260, (250, 248, 240), 10)                                      # a panel as light as the sheet
            for i, c in enumerate((TRIM, DARK, GLASS)):
                d.ellipse([(cx - 38 + i * 30) * S, (top + 290) * S, (cx - 18 + i * 30) * S, (top + 310) * S], fill=c)


sheet = Image.new('RGB', (W * S, H * S), BG)
shadow = Image.new('L', (W * S, H * S), 0)
sd = ImageDraw.Draw(shadow)
centres = (230, 610, 990, 1370)
for cx, wide in zip(centres, (130, 70, 130, 70)):
    sd.ellipse([(cx - wide) * S, 742 * S, (cx + wide) * S, 772 * S], fill=70)
shadow = shadow.filter(ImageFilter.GaussianBlur(10 * S))
sheet.paste((150, 146, 138), mask=shadow)
d = ImageDraw.Draw(sheet)
robot(d, centres[0], 210, side=False)
robot(d, centres[1], 210, side=True, facing=1)
robot(d, centres[2], 210, side=False, back=True)
robot(d, centres[3], 210, side=True, facing=-1)
sheet = sheet.resize((W, H), Image.LANCZOS)
out = Path(__file__).resolve().parent.parent / 'sample.png'
sheet.save(out, optimize=True)
print(out, sheet.size)
