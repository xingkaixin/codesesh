# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools[woff]==4.63.0", "uharfbuzz==0.57.0"]
# ///
"""Subsets apps/www web fonts to the usage collected by scripts/www-fonts.mjs.

Run through the Node script, which builds the site and passes the usage file.
"""

import hashlib
import io
import json
import sys
import urllib.request
from pathlib import Path

import uharfbuzz as hb
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps/www/src/fonts"
CACHE = ROOT / "node_modules/.cache/www-fonts"
UPSTREAM = "https://raw.githubusercontent.com/google/fonts/6157dfaa640ca5738b4d1a7070fe389c3036d7fc/ofl/"
SHA256 = {
    "montserrat/Montserrat[wght].ttf": "0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7",
    "montserrat/OFL.txt": "8b7141c03fa4f8d44e6345d5d4931709290f0f67875e452e95ac1fd3a027802e",
    "ibmplexmono/IBMPlexMono-Light.ttf": "780bcf65509d72a35ec114b57bcbe220dc6b77d8ea2e9b25e294be3c570c5025",
    "ibmplexmono/IBMPlexMono-Regular.ttf": "6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46",
    "ibmplexmono/IBMPlexMono-Medium.ttf": "a9b4c49bb299e05b5f6c481e7fb5e78943d2793249a0c8874ab574a2d1ea6755",
    "ibmplexmono/IBMPlexMono-SemiBold.ttf": "d3c38e55c78f5b0f28009fddba4834ec503278936a5986032424c9bd2d23aa46",
    "ibmplexmono/OFL.txt": "7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da",
}
FAMILIES = [
    {
        "css": "Montserrat Variable",
        "slug": "montserrat",
        "format": "woff2-variations",
        "license": "montserrat/OFL.txt",
        # Keeps the full wght axis: instancing to the used range shifts outlines and
        # advances by up to 2/1000 em, which moves text.
        "variable": ("montserrat/Montserrat[wght].ttf", 100, 900),
    },
    {
        "css": "IBM Plex Mono",
        "slug": "codesesh-mono",
        "format": "woff2",
        "license": "ibmplexmono/OFL.txt",
        "static": {
            300: "ibmplexmono/IBMPlexMono-Light.ttf",
            400: "ibmplexmono/IBMPlexMono-Regular.ttf",
            500: "ibmplexmono/IBMPlexMono-Medium.ttf",
            600: "ibmplexmono/IBMPlexMono-SemiBold.ttf",
        },
        # OFL Reserved Font Name "Plex": a subset is a Modified Version.
        "rename": ("IBM Plex Mono", "CodeSesh Mono"),
    },
]


def parse_ranges(text):
    out = set()
    for part in text.split(","):
        lo, _, hi = part.strip().removeprefix("U+").partition("-")
        out.update(range(int(lo, 16), int(hi or lo, 16) + 1))
    return out


# Union of the fontsource subset ranges the site used before; characters outside
# it (arrows, CJK, symbols) rendered from fallback fonts and must keep doing so.
ELIGIBLE = parse_ranges(
    "U+0000-02BA,U+02BB-02BC,U+02BD-02C5,U+02C6,U+02C7-02CC,U+02CE-02D7,U+02DA,U+02DC,"
    "U+02DD-02FF,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+0400-045F,"
    "U+0460-052F,U+0490-0491,U+04B0-04B1,U+1C80-1C8A,U+1D00-1DBF,U+1E00-1E9F,"
    "U+1EA0-1EF9,U+1EF2-1EFF,U+2000-206F,U+2020,U+20A0-20AB,U+20AC,U+20AD-20C0,"
    "U+2113,U+2116,U+2122,U+2191,U+2193,U+2212,U+2215,U+2C60-2C7F,U+2DE0-2DFF,"
    "U+A640-A69F,U+A720-A7FF,U+FE2E-FE2F,U+FEFF,U+FFFD"
)
ASCII = set(range(0x20, 0x7F))
PUNCTUATION = {0xA0, 0xB7, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026}
EXTENDED = set(range(0xA0, 0x180))
# Features Chromium's HarfBuzz shaper applies to horizontal Latin text by default.
DEFAULT_FEATURES = [
    "abvm", "blwm", "calt", "ccmp", "clig", "curs", "dist", "kern",
    "liga", "locl", "mark", "mkmk", "rclt", "rlig", "rvrn",
]
VITE_INLINE_LIMIT = 4096


def source(path):
    file = CACHE / path
    if not file.exists():
        file.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(UPSTREAM + path.replace("[", "%5B").replace("]", "%5D")) as res:
            file.write_bytes(res.read())
    digest = hashlib.sha256(file.read_bytes()).hexdigest()
    if digest != SHA256[path]:
        sys.exit(f"{path}: sha256 {digest} does not match the pinned upstream file")
    return file


def match_weight(wanted, available):
    """CSS Fonts 4 font-weight matching against the declared static faces."""
    if wanted in available:
        return wanted
    lighter = sorted((w for w in available if w < wanted), reverse=True)
    heavier = sorted(w for w in available if w > wanted)
    if 400 <= wanted <= 500:
        up_to_500 = [w for w in heavier if w <= 500]
        return (up_to_500 + lighter + [w for w in heavier if w > 500])[0]
    return (lighter + heavier)[0] if wanted < 400 else (heavier + lighter)[0]


def langsys_to_keep(path, langs):
    """Default language systems plus any the page languages select."""
    primary = {lang.split("-")[0].lower() for lang in langs}
    font = TTFont(path)
    keep = set()
    for tag in ("GSUB", "GPOS"):
        if tag not in font:
            continue
        for record in font[tag].table.ScriptList.ScriptRecord:
            keep.add(f"{record.ScriptTag}.dflt")
            for lang in record.Script.LangSysRecord:
                if hb.ot_tag_to_language(str(lang.LangSysTag)).split("-")[0] in primary:
                    keep.add(f"{record.ScriptTag}.{lang.LangSysTag.strip()}")
    return sorted(keep)


def options(features, scripts):
    o = subset.Options()
    o.flavor = None
    o.layout_features = features
    o.layout_scripts = scripts
    o.name_IDs = [0, 1, 2, 3, 4, 5, 6, 14]
    o.drop_tables += ["meta"]
    # A post table without glyph names (format 3) changes macOS Chrome's
    # rasterization at 8-9px, so keep the names the source has.
    o.glyph_names = True
    o.prune_unicode_ranges = False
    o.prune_codepage_ranges = False
    return o


def build(path, codepoints, features, scripts, rename):
    o = options(features, scripts)
    font = subset.load_font(str(path), o)
    subsetter = subset.Subsetter(o)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    if rename:
        old, new = rename
        for record in font["name"].names:
            if record.nameID in (1, 3, 4, 6, 16, 17, 18, 21, 22, 25):
                text = record.toUnicode()
                text = text.replace(old, new).replace(old.replace(" ", ""), new.replace(" ", ""))
                record.string = text
                if "plex" in text.lower():
                    sys.exit(f"{path.name}: name {record.nameID} still uses the reserved name: {text}")
    buf = io.BytesIO()
    subset.save_font(font, buf, o)
    return buf.getvalue()


def shape_all(data, text, wght, features):
    face = hb.Face(data)
    font = hb.Font(face)
    font.scale = (face.upem * 64, face.upem * 64)
    if wght is not None:
        font.set_variations({"wght": wght})
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, features)
    outlines = {}
    result = []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        if info.codepoint not in outlines:
            pen = RecordingPen()
            font.draw_glyph_with_pen(info.codepoint, pen)
            outlines[info.codepoint] = tuple(pen.value)
        # HarfBuzz deletes default ignorables (U+00AD) in fonts without a space
        # glyph instead of drawing an empty one; neither draws anything.
        if pos.x_advance or outlines[info.codepoint]:
            result.append((info.cluster, pos.x_advance, pos.x_offset, pos.y_offset, outlines[info.codepoint]))
    return result


def metrics(data, wght):
    font = hb.Font(hb.Face(data))
    if wght is not None:
        font.set_variations({"wght": wght})
    return {tag: font.get_metric_position(tag) for tag in hb.OTMetricsTag}


class RecordingPen:
    def __init__(self):
        self.value = []

    def __getattr__(self, name):
        return lambda *args: self.value.append((name, args))


def verify(name, woff2, reference, codepoints, weights, opt_in):
    """Shaping every ordered pair must match the unsubsetted upstream font."""
    if woff2.stat().st_size <= VITE_INLINE_LIMIT:
        sys.exit(f"{name}: {woff2.stat().st_size} bytes would be inlined by Vite")
    font = TTFont(woff2)
    font.flavor = None
    buf = io.BytesIO()
    font.save(buf, reorderTables=False)
    data = buf.getvalue()
    got = set(font.getBestCmap())
    if got != codepoints:
        sys.exit(f"{name}: cmap differs from the requested set: {sorted(got ^ codepoints)}")
    chars = [chr(c) for c in sorted(codepoints)]
    text = "".join(a + b for a in chars for b in chars)
    ref = reference.read_bytes()
    feature_sets = [{}] + [{tag: True} for tag in opt_in]
    for wght in weights:
        for features in feature_sets:
            if shape_all(data, text, wght, features) != shape_all(ref, text, wght, features):
                sys.exit(f"{name}: shaping differs from upstream at wght={wght} features={features}")
        if metrics(data, wght) != metrics(ref, wght):
            sys.exit(f"{name}: font metrics differ from upstream at wght={wght}")
    ref_font = TTFont(reference)
    for table, attrs in {
        "head": ["unitsPerEm"],
        "hhea": ["ascent", "descent", "lineGap"],
        "OS/2": ["sTypoAscender", "sTypoDescender", "sTypoLineGap", "usWinAscent", "usWinDescent", "fsSelection"],
    }.items():
        for attr in attrs:
            if getattr(font[table], attr) != getattr(ref_font[table], attr):
                sys.exit(f"{name}: {table}.{attr} changed")
    for tag in ("fpgm", "prep", "gasp"):
        if (tag in font) != (tag in ref_font):
            sys.exit(f"{name}: hinting table {tag} presence changed")


def unicode_range(codepoints):
    parts, start, prev = [], None, None
    for c in sorted(codepoints) + [None]:
        if start is not None and c == prev + 1:
            prev = c
            continue
        if start is not None:
            parts.append(f"U+{start:04X}" if start == prev else f"U+{start:04X}-{prev:04X}")
        start = prev = c
    return ", ".join(parts)


def main():
    usage = json.loads(Path(sys.argv[1]).read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.woff2"):
        old.unlink()
    rules, preloads, report = [], [], []
    for family in FAMILIES:
        used = usage["families"].get(family["css"])
        if not used:
            print(f"{family['css']}: not used by any page; skipped")
            continue
        chars = {ord(c) for c in used["chars"]}
        opt_in = sorted(set(used["features"]))
        features = sorted(set(DEFAULT_FEATURES) | set(opt_in))
        (OUT / f"{family['slug']}-OFL.txt").write_bytes(source(family["license"]).read_bytes())
        if "variable" in family:
            path, lo, hi = family["variable"]
            faces = {(lo, hi): source(path)}
        else:
            selected = {match_weight(w, list(family["static"])) for w in used["weights"]}
            faces = {(w, w): source(family["static"][w]) for w in sorted(selected)}
        for (lo, hi), path in faces.items():
            ref = TTFont(path)
            cmap = set(ref.getBestCmap()) & ELIGIBLE
            core = (ASCII | PUNCTUATION | chars) & cmap
            ext = (EXTENDED & cmap) - core
            scripts = langsys_to_keep(path, used["langs"])
            variable = "variable" in family
            weights = sorted({min(max(w, lo), hi) for w in used["weights"]}) if variable else [None]
            stem = family["slug"] if variable else f"{family['slug']}-{lo}"
            for part, codepoints in (("core", core), ("ext", ext)):
                name = f"{stem}-{part}.woff2"
                ttf = build(path, codepoints, features, scripts, family.get("rename"))
                font = TTFont(io.BytesIO(ttf), recalcTimestamp=False)
                font.flavor = "woff2"
                font.save(OUT / name)
                verify(name, OUT / name, path, codepoints, weights, opt_in)
                size = (OUT / name).stat().st_size
                report.append(f"{name:28} {size:7} B {font['maxp'].numGlyphs:4} glyphs {len(codepoints):4} chars")
                rules.append(
                    "@font-face {\n"
                    f'  font-family: "{family["css"]}";\n'
                    "  font-style: normal;\n"
                    "  font-display: swap;\n"
                    f"  font-weight: {lo if lo == hi else f'{lo} {hi}'};\n"
                    f'  src: url("./{name}") format("{family["format"]}");\n'
                    f"  unicode-range: {unicode_range(codepoints)};\n"
                    "}\n"
                )
            # Pages without any managed family (the static 404) do not use the layout.
            on_every_page = all(
                any(variable or match_weight(w, list(family["static"])) == lo for w in page.get(family["css"], []))
                for page in usage["pages"].values()
                if any(f["css"] in page for f in FAMILIES)
            )
            if on_every_page:
                preloads.append(f"{stem}-core.woff2")
        report.append(f"  {family['css']}: weights {sorted(used['weights'])}, faces {list(faces)}, features {features}")
    header = (
        "/* Generated by scripts/www-fonts.mjs; do not edit. Rerun it after changing site copy,\n"
        "   font weights or styles, font-variant/font-feature-settings, text-transform or hyphens,\n"
        "   or the pinned upstream fonts. */\n"
    )
    (OUT / "fonts.css").write_text(header + "\n".join(rules))
    imports = [f'import font{i} from "./{name}?url";' for i, name in enumerate(preloads)]
    (OUT / "preload.ts").write_text(
        "// Generated by scripts/www-fonts.mjs; do not edit.\n"
        + "\n".join(imports)
        + f"\n\nexport const fontPreloads = [{', '.join(f'font{i}' for i in range(len(preloads)))}];\n"
    )
    print("\n".join(report))
    print("preload:", ", ".join(preloads))


main()
