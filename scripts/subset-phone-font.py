#!/usr/bin/env python3
"""
Builds the phone terminal's font: Nanum Gothic Coding (SIL OFL 1.1) cut to printable ASCII and
the 2,350 Hangul syllables of KS X 1001, as woff2.

Why: the phone draws the Mac's terminal with xterm's DOM renderer, which pads each wide character
to two cells. Android Chrome exposes no CJK monospace font, so its Hangul fell back to a glyph 1.43
cells wide and every syllable got a gap after it (G3, Galaxy 2026-11-05). Nanum Gothic Coding's
Latin is half the width of its Hangul — exactly two cells.

    python3 -m pip install fonttools brotli   # or: uv pip install fonttools brotli
    python3 scripts/subset-phone-font.py NanumGothicCoding-Regular.ttf \
        src/renderer/src/phone/fonts/clim-phone-mono-ksx1001.woff2

The TTF comes from Google Fonts (fonts.googleapis.com/css2?family=Nanum+Gothic+Coding → fonts.gstatic.com).
"""
import sys

from fontTools import subset


def ks_x_1001_hangul() -> str:
    """The 2,350 syllables of KS X 1001 (EUC-KR rows 0xB0-0xC8, columns 0xA1-0xFE)."""
    out = []
    for lead in range(0xB0, 0xC9):
        for trail in range(0xA1, 0xFF):
            out.append(bytes([lead, trail]).decode('euc_kr'))
    return ''.join(out)


# OFL 1.1 condition 3: a Modified Version (this cut is one) may not use a Reserved Font Name as its
# primary name. The Nanum fonts reserve theirs, so the cut font is named for what it is here.
FAMILY = 'CLIM Phone Mono'


def rename(font) -> None:
    names = font['name']
    postscript = FAMILY.replace(' ', '') + '-Regular'
    for record in list(names.names):
        if record.nameID in (1, 16):
            names.setName(FAMILY, record.nameID, record.platformID, record.platEncID, record.langID)
        elif record.nameID in (2, 17):
            names.setName('Regular', record.nameID, record.platformID, record.platEncID, record.langID)
        elif record.nameID in (3, 4):
            names.setName(f'{FAMILY} Regular' if record.nameID == 4 else f'{postscript};cut from Nanum Gothic Coding 2.000', record.nameID, record.platformID, record.platEncID, record.langID)
        elif record.nameID == 6:
            names.setName(postscript, record.nameID, record.platformID, record.platEncID, record.langID)
    if 'CFF ' in font:
        font['CFF '].cff.fontNames = [postscript]


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit('usage: subset-phone-font.py <NanumGothicCoding-Regular.ttf> <out.woff2>')
    source, target = sys.argv[1], sys.argv[2]
    hangul = ks_x_1001_hangul()
    assert len(hangul) == 2350, len(hangul)
    ascii_printable = ''.join(chr(code) for code in range(0x20, 0x7F))
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = []  # a terminal draws one glyph per cell: no ligatures or kerning
    options.name_IDs = ['*']  # keep the copyright and OFL license strings
    options.notdef_outline = True
    font = subset.load_font(source, options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=ascii_printable + hangul)
    subsetter.subset(font)
    rename(font)
    subset.save_font(font, target, options)


if __name__ == '__main__':
    main()
