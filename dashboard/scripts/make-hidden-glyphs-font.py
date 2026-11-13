# A tiny font whose only glyphs are empty and zero-width, for the characters the Brink voice
# rules keep out of the UI (lightning bolt, emoji EasySchematic prints in its chrome).
# Used with unicode-range so it applies to those code points only (web/src/design/es-theme.css,
# "Brink Hidden Glyphs": paste the output into its @font-face data: URL).
#
# usage: python3 -m venv /tmp/v && /tmp/v/bin/pip install fonttools==4.60.1
#        /tmp/v/bin/python scripts/make-hidden-glyphs-font.py <out.b64>
import base64, io, sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

CPS = [0x26A1, 0x1F4C4, 0x1F50C, 0xFE0F]
names = [".notdef"] + [f"blank{cp:X}" for cp in CPS]
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(names)
fb.setupCharacterMap({cp: f"blank{cp:X}" for cp in CPS})
empty = TTGlyphPen(None).glyph()
fb.setupGlyf({n: empty for n in names})
fb.setupHorizontalMetrics({n: (0, 0) for n in names})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({"familyName": "Brink Hidden Glyphs", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
buf = io.BytesIO()
fb.save(buf)
data = buf.getvalue()
print(len(data), "bytes")
open(sys.argv[1], "w").write(base64.b64encode(data).decode())
