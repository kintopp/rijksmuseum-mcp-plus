#!/usr/bin/env python3
"""Build a standalone report characterising artworks.inscription_text.

The report is intentionally explanatory rather than dashboard-like: it shows
why the inscription field is better understood as a mark-and-annotation log
than as a complete corpus of text visible on artworks.

Usage:  python3 scripts/build-inscription-report.py
Output: offline/explorations/inscription-field-analysis.html
"""

import html
import re
import sqlite3
import statistics
from collections import Counter

DB = "data/vocabulary.db"
OUT = "offline/explorations/inscription-field-analysis.html"

TYPE_CANON = {
    "verzamelaarsmerk": "collector's mark",
    "collector's mark": "collector's mark",
    "signatuur": "signature",
    "signature": "signature",
    "signatuur en datum": "signature and date",
    "signature and date": "signature and date",
    "datum": "date",
    "date": "date",
    "datering": "date",
    "opschrift": "inscription",
    "inscription": "inscription",
    "inscriptie": "inscription",
    "annotatie": "annotation",
    "annotation": "annotation",
    "nummer": "number",
    "number": "number",
    "stempel": "stamp",
    "stamp": "stamp",
    "onderschrift": "caption",
    "caption": "caption",
    "adres": "address",
    "address": "address",
    "monogram": "monogram",
    "watermerk": "watermark",
    "watermark": "watermark",
    "merk": "mark",
    "mark": "mark",
    "titel": "title",
    "title": "title",
    "etiket": "label",
    "label": "label",
    "naam": "name",
    "name": "name",
    "tekst": "text",
    "text": "text",
    "blindstempel": "blind stamp",
    "blind stamp": "blind stamp",
    "fabrieksmerk": "factory mark",
    "factory mark": "factory mark",
    "atelierstempel": "workshop stamp",
    "workshop stamp": "workshop stamp",
    "oplage": "edition",
    "edition": "edition",
    "kleurnotitie": "colour note",
    "colour note": "colour note",
    "color note": "colour note",
    "poststempel": "postmark",
    "postmark": "postmark",
    "postzegel": "postage stamp",
    "postage stamp": "postage stamp",
    "controlestempel": "check stamp",
    "keurstempel": "check stamp",
    "check stamp": "check stamp",
    "prijs": "price",
    "price": "price",
    "drukkersmerk": "printer's mark",
    "printer's mark": "printer's mark",
}

METHODS = {
    "gestempeld": "stamped",
    "handgeschreven": "handwritten",
    "geschreven": "written",
    "gedrukt": "printed",
    "geprent": "printed",
    "gegraveerd": "engraved",
    "geëtst": "etched",
    "geetst": "etched",
    "potlood": "pencil",
    "inkt": "ink",
    "pen": "pen",
    "krijt": "chalk",
    "blinddruk": "blind-embossed",
    "geschilderd": "painted",
    "geplakt": "affixed",
    "gesneden": "cut",
    "gekrast": "scratched",
}

POSITIONS = (
    "linksboven",
    "rechtsboven",
    "linksonder",
    "rechtsonder",
    "midden onder",
    "midden boven",
    "midden",
    "boven",
    "onder",
    "links",
    "rechts",
    "rand",
    "marge",
    "passe-partout",
    "opzetvel",
    "lijst",
)

LUGT_RE = re.compile(r"\bLugt\s*(\d+[a-z]?)\b", re.I)
QUOTE_PATTERNS = (re.compile(r"‘([^’]*)’"), re.compile(r'"([^"]*)"'))
YEAR_RE = re.compile(r"\b(1[0-9]{3}|20[0-2][0-9])\b")
LATIN_RE = re.compile(
    r"\b(fecit|pinxit|delineavit|sculpsit|excudit|invenit|"
    r"lith|del|sc|inv|exc|fec|pinx|ad vivum|anno|imp)\b\.?",
    re.I,
)
MONEY_RE = re.compile(r"(ƒ|fl\.|gulden|\bcts?\b|cents?|francs?|€|\$|\bf\s*\d)", re.I)
PLACE_RE = re.compile(
    r"\b(amsterdam|paris|haarlem|rotterdam|leiden|utrecht|"
    r"straat|gracht|dijk|weg|laan|plein|kade|rue|strasse|straße|str\.|no\.|nr\.)\b",
    re.I,
)
NUMERIC_RE = re.compile(r"^[\W\d\s]+$")

STOPWORDS = {
    "aan",
    "aber",
    "ad",
    "al",
    "als",
    "and",
    "anno",
    "auf",
    "bij",
    "ce",
    "ces",
    "da",
    "das",
    "de",
    "deze",
    "den",
    "der",
    "des",
    "die",
    "dit",
    "du",
    "een",
    "en",
    "et",
    "for",
    "het",
    "i",
    "ii",
    "iii",
    "in",
    "is",
    "la",
    "le",
    "les",
    "met",
    "naar",
    "of",
    "op",
    "ou",
    "par",
    "pour",
    "que",
    "qui",
    "te",
    "the",
    "tot",
    "und",
    "van",
    "voor",
    "von",
    "voorzijde",
    "with",
}

NOISE_WORDS = {
    "lugt",
    "rpk",
    "recto",
    "verso",
    "datum",
    "date",
    "signature",
    "signatuur",
    "nummer",
    "number",
    "inscription",
    "opschrift",
    "collector",
    "mark",
    "gestempeld",
    "handgeschreven",
    "gedrukt",
}

MONTHS = {
    "jan",
    "januari",
    "feb",
    "februari",
    "mrt",
    "maart",
    "apr",
    "april",
    "mei",
    "jun",
    "juni",
    "jul",
    "juli",
    "aug",
    "augustus",
    "sep",
    "sept",
    "september",
    "oct",
    "okt",
    "october",
    "oktober",
    "nov",
    "november",
    "dec",
    "december",
}


def esc(value):
    return html.escape(str(value), quote=True)


def pct(part, whole):
    return 100.0 * part / whole if whole else 0.0


def norm_type(token):
    token = token.strip().lower().strip(". ")
    return TYPE_CANON.get(token, token)


def lugt_marks(text):
    return {f"Lugt {m.group(1).upper()}" for m in LUGT_RE.finditer(text)}


def quoted_strings(text):
    found = []
    for pattern in QUOTE_PATTERNS:
        found.extend(q.strip() for q in pattern.findall(text) if q.strip())
    return found


def parse_segments(text):
    types = set()
    surfaces = set()
    positions = set()
    methods = set()
    for segment in [s.strip() for s in text.split("|") if s.strip()]:
        header = segment.split(":", 1)[0] if ":" in segment else segment
        parts = [p.strip().lower() for p in header.split(",") if p.strip()]
        if parts:
            kind = norm_type(parts[0])
            if kind:
                types.add(kind)
        detail = " ".join(parts[1:])
        for source, label in (("verso", "verso"), ("achterzijde", "verso"), ("recto", "recto"), ("voorzijde", "recto")):
            if re.search(rf"(^|\W){re.escape(source)}($|\W)", detail):
                surfaces.add(label)
        for raw, label in METHODS.items():
            if re.search(rf"(^|\W){re.escape(raw)}($|\W)", detail):
                methods.add(label)
        for pos in POSITIONS:
            if re.search(rf"(^|\W){re.escape(pos)}($|\W)", detail):
                positions.add(pos)
    return types, surfaces, positions, methods


def low_signal_quote(text):
    t = text.strip().casefold()
    if not t or LUGT_RE.search(t):
        return True
    if t in {"rpk", "[...]", "[…]", "pc"}:
        return True
    if NUMERIC_RE.match(t):
        return True
    return False


def content_category(text):
    s = text.strip()
    folded = s.casefold()
    if not s:
        return "empty"
    if "[...]" in s or "[…]" in s:
        return "illegible / partial"
    if folded in {"rpk", "pc"} or "copyright" in folded or folded == "agfa":
        return "institutional / photo stamp"
    if NUMERIC_RE.match(s):
        return "number or code"
    if MONEY_RE.search(s):
        return "price or monetary note"
    if LATIN_RE.search(s):
        return "maker formula / imprint"
    if PLACE_RE.search(s):
        return "place, address, or publisher line"
    if YEAR_RE.search(s):
        return "date-bearing text"
    if len(re.findall(r"\w+", s)) <= 4 and sum(c.isalpha() for c in s) >= 2:
        return "name, initials, or signature"
    if len(s) >= 50:
        return "long caption or annotation"
    return "short text"


def tokens_for_content(text):
    raw = re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]{2,}", text.casefold())
    tokens = []
    for tok in raw:
        tok = tok.strip("'.-")
        if not tok or tok in STOPWORDS or tok in NOISE_WORDS or tok in MONTHS:
            continue
        if len(tok) < 3 or tok.isdigit():
            continue
        tokens.append(tok)
    return tokens


def bar_rows(items, total, color="#33658f", max_items=None, value="pct"):
    items = list(items[:max_items] if max_items else items)
    if not items:
        return ""
    max_count = max(count for _, count in items) or 1
    rows = []
    for label, count in items:
        width = 100.0 * count / max_count
        meta = f"{pct(count, total):.1f}% · {count:,}" if value == "pct" else f"{count:,}"
        rows.append(
            f'<div class="bar-row"><div class="bar-label">{esc(label)}</div>'
            f'<div class="bar-track"><div class="bar-fill" style="width:{width:.1f}%;background:{color}"></div></div>'
            f'<div class="bar-value">{meta}</div></div>'
        )
    return '<div class="bars">' + "".join(rows) + "</div>"


def compact_table(headers, rows):
    head = "".join(f"<th>{esc(h)}</th>" for h in headers)
    body = []
    for row in rows:
        body.append("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>")
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"


def example_query(con, where, order="LENGTH(inscription_text)", limit=1):
    rows = con.execute(
        f"""
        SELECT object_number, inscription_text
        FROM artworks
        WHERE inscription_text IS NOT NULL
          AND TRIM(inscription_text) <> ''
          AND {where}
        ORDER BY {order}
        LIMIT {limit}
        """
    ).fetchall()
    return rows[0] if rows else ("", "")


con = sqlite3.connect(DB)
total_artworks = con.execute("SELECT COUNT(*) FROM artworks").fetchone()[0]
rows = con.execute(
    """
    SELECT object_number, inscription_text
    FROM artworks
    WHERE inscription_text IS NOT NULL AND TRIM(inscription_text) <> ''
    """
).fetchall()

record_count = len(rows)
composition = Counter()
type_counts = Counter()
surface_counts = Counter()
position_counts = Counter()
method_counts = Counter()
segment_buckets = Counter()
lengths = []
segment_counts = []
lugt_record_counts = Counter()
exact_record_values = Counter()
quote_record_counts = Counter()
quote_categories = Counter()
word_counts = Counter()
phrase_counts = Counter()
html_entity_records = 0
illegible_records = 0
substantive_quote_lengths = []

for _object_number, text in rows:
    lengths.append(len(text))
    segments = [s.strip() for s in text.split("|") if s.strip()]
    segment_counts.append(len(segments))
    segment_bucket = "1" if len(segments) == 1 else "2" if len(segments) == 2 else "3-4" if len(segments) <= 4 else "5-8" if len(segments) <= 8 else "9+"
    segment_buckets[segment_bucket] += 1

    types, surfaces, positions, methods = parse_segments(text)
    type_counts.update(types)
    surface_counts.update(surfaces)
    position_counts.update(positions)
    method_counts.update(methods)

    marks = lugt_marks(text)
    lugt_record_counts.update(marks)
    if marks:
        exact_record_values[text] += 1

    unique_quotes = set(quoted_strings(text))
    non_lugt_quotes = {q for q in unique_quotes if not LUGT_RE.search(q)}
    substantive_quotes = {q for q in non_lugt_quotes if not low_signal_quote(q)}

    if substantive_quotes or non_lugt_quotes:
        composition["Transcribed string present"] += 1
    elif marks:
        composition["Lugt collector mark only"] += 1
    elif ":" not in text:
        composition["Type label only"] += 1
    else:
        composition["Described mark, no quoted value"] += 1

    if "&lt;" in text or "&gt;" in text or "&amp;" in text:
        html_entity_records += 1
    if "[...]" in text or "[…]" in text:
        illegible_records += 1

    for quote in non_lugt_quotes:
        quote_record_counts[quote] += 1
        quote_categories[content_category(quote)] += 1
        if not low_signal_quote(quote):
            substantive_quote_lengths.append(len(quote))

    record_words = set()
    record_phrases = set()
    for quote in substantive_quotes:
        tokens = tokens_for_content(quote)
        record_words.update(tokens)
        for i in range(len(tokens) - 1):
            if tokens[i] != tokens[i + 1]:
                record_phrases.add(f"{tokens[i]} {tokens[i + 1]}")
    word_counts.update(record_words)
    phrase_counts.update(record_phrases)

object_type_rows = con.execute(
    """
    SELECT COALESCE(NULLIF(v.label_en,''), v.label_nl, '(unlabelled)') AS object_type_label,
           COUNT(DISTINCT m.artwork_id) AS total,
           COUNT(DISTINCT CASE
             WHEN a.inscription_text IS NOT NULL AND TRIM(a.inscription_text) <> ''
             THEN m.artwork_id END) AS with_inscription
    FROM mappings m
    JOIN artworks a ON a.art_id = m.artwork_id
    JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
    WHERE m.field_id = 15
      AND COALESCE(NULLIF(v.label_en,''), v.label_nl, '') <> ''
    GROUP BY COALESCE(NULLIF(v.label_en,''), v.label_nl, '(unlabelled)')
    HAVING total >= 2500
    ORDER BY total DESC
    """
).fetchall()

examples = [
    (
        "The dominant boilerplate shape",
        *example_query(con, "inscription_text LIKE '%Lugt 2228%' AND inscription_text NOT LIKE '%‘%'", "LENGTH(inscription_text)"),
    ),
    (
        "Type label recorded, value absent",
        *example_query(con, "inscription_text IN ('datum | date', 'signature | signatuur', 'signatuur | signature')"),
    ),
    (
        "A normal signature or artist mark",
        *example_query(con, "inscription_text LIKE '%signature%' AND inscription_text LIKE '%‘%' AND LENGTH(inscription_text) BETWEEN 40 AND 130"),
    ),
    (
        "Publisher/address line",
        *example_query(con, "inscription_text LIKE '%adres%' AND inscription_text LIKE '%‘%' AND LENGTH(inscription_text) BETWEEN 60 AND 190"),
    ),
    (
        "Long image-borne or object-borne text",
        *example_query(con, "inscription_text LIKE '%‘%' AND LENGTH(inscription_text) > 450", "LENGTH(inscription_text) DESC"),
    ),
]
con.close()

coverage_focus = [
    row
    for row in object_type_rows
    if row[0]
    in {
        "popular print",
        "carte-de-visite",
        "print",
        "painting",
        "photograph",
        "drawing",
        "poster",
        "history medal",
        "coin",
        "book",
        "letter",
        "text sheet",
    }
]
coverage_focus.sort(key=lambda row: pct(row[2], row[1]), reverse=True)

composition_order = [
    "Transcribed string present",
    "Lugt collector mark only",
    "Type label only",
    "Described mark, no quoted value",
]
composition_items = [(label, composition[label]) for label in composition_order]
composition_palette = ["#1f7a72", "#b04a45", "#b07a2e", "#6a5a93"]
stack_segments = []
stack_legend = []
for (label, count), color in zip(composition_items, composition_palette):
    share = pct(count, record_count)
    stack_segments.append(f'<div style="width:{share:.2f}%;background:{color}" title="{esc(label)}: {share:.1f}%"></div>')
    stack_legend.append(
        f'<div><span class="swatch" style="background:{color}"></span>'
        f'<b>{share:.1f}%</b> {esc(label)} <span class="muted">({count:,})</span></div>'
    )

lugt_table = compact_table(
    ["Mark", "Records Bearing Mark", "Share of Inscribed Records"],
    [
        (esc(mark), f"{count:,}", f"{pct(count, record_count):.1f}%")
        for mark, count in lugt_record_counts.most_common(10)
    ],
)

exact_table = compact_table(
    ["Repeated Exact Value", "Records"],
    [
        (f"<code>{esc(value[:130])}{'...' if len(value) > 130 else ''}</code>", f"{count:,}")
        for value, count in exact_record_values.most_common(6)
    ],
)

top_quotes = [
    (quote, count)
    for quote, count in quote_record_counts.most_common(80)
    if not low_signal_quote(quote)
][:14]
quote_table = compact_table(
    ["Quoted String", "Records"],
    [(f"<code>{esc(quote[:110])}{'...' if len(quote) > 110 else ''}</code>", f"{count:,}") for quote, count in top_quotes],
)

word_table = compact_table(
    ["Filtered Word", "Records"],
    [(esc(word), f"{count:,}") for word, count in word_counts.most_common(18)],
)

phrase_table = compact_table(
    ["Filtered Phrase", "Records"],
    [(esc(phrase), f"{count:,}") for phrase, count in phrase_counts.most_common(14)],
)

coverage_table = compact_table(
    ["Object Type", "Artworks", "With Inscription", "Coverage"],
    [
        (
            esc(kind),
            f"{total:,}",
            f"{with_inscription:,}",
            f'<div class="mini"><div style="width:{pct(with_inscription, total):.1f}%"></div><span>{pct(with_inscription, total):.1f}%</span></div>',
        )
        for kind, total, with_inscription in coverage_focus
    ],
)

examples_html = ""
for title, object_number, value in examples:
    display_value = value if len(value) <= 900 else value[:900].rstrip() + " ..."
    examples_html += (
        f'<article class="example"><h3>{esc(title)}</h3><p class="object">{esc(object_number)}</p>'
        f'<code>{esc(display_value)}</code></article>'
    )

median_length = int(statistics.median(lengths))
mean_length = statistics.mean(lengths)
median_segments = statistics.median(segment_counts)
median_quote_length = int(statistics.median(substantive_quote_lengths)) if substantive_quote_lengths else 0
records_with_any_lugt = sum(1 for _object_number, text in rows if lugt_marks(text))

HTML = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rijksmuseum Inscription Field: Structure, Boilerplate, and Content</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {{
  --ink:#1b2530; --muted:#5b6672; --soft:#8a94a0;
  --paper:#f6f5f1; --panel:#ffffff;
  --line:rgba(27,37,48,.12); --line-soft:rgba(27,37,48,.07); --track:rgba(27,37,48,.06);
  --teal:#1f7a72; --blue:#33658f; --ochre:#b07a2e; --red:#b04a45; --violet:#6a5a93; --slate:#475569;
  --serif:"Instrument Serif",Georgia,"Times New Roman",serif;
  --sans:"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; color:var(--ink); background:var(--paper);
  font:15px/1.6 var(--sans); -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }}
main {{ max-width:1120px; margin:0 auto; padding:0 24px 80px; }}

/* hero */
.hero {{ background:linear-gradient(135deg,#1e293b 0%,#334155 100%); color:#e6edf3; border-bottom:4px solid var(--teal); }}
.hero-inner {{ max-width:1120px; margin:0 auto; padding:56px 24px 40px; }}
.eyebrow {{ margin:0 0 16px; color:#7fcabf; font:500 11px/1.4 var(--mono); text-transform:uppercase; letter-spacing:.16em; }}
.eyebrow code {{ font-family:var(--mono); color:#a7ded4; }}
h1 {{ margin:0; max-width:860px; font:400 46px/1.06 var(--serif); letter-spacing:.005em; color:#f4f7fa; }}
.hero p {{ max-width:780px; margin:20px 0 0; color:#9fb0c0; font-size:17px; line-height:1.6; }}
.kpis {{ display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin-top:36px; }}
.kpi {{ border:1px solid rgba(255,255,255,.14); border-top:2px solid var(--teal);
  padding:16px; background:rgba(255,255,255,.05); border-radius:8px; }}
.kpi b {{ display:block; font:500 30px/1.1 var(--mono); color:#e2e8f0; font-variant-numeric:tabular-nums; }}
.kpi span {{ display:block; margin-top:8px; color:#93a4b4; font-size:12px; line-height:1.45; }}

/* sections + headings */
section {{ margin-top:56px; }}
.sec-head {{ display:flex; align-items:baseline; gap:12px; margin:0 0 8px; }}
.sec-index {{ flex:none; font:500 13px/1 var(--mono); color:var(--teal); letter-spacing:.08em; }}
h2 {{ margin:0; font:400 27px/1.15 var(--serif); letter-spacing:.005em; color:var(--ink); }}
h3 {{ margin:0 0 12px; font:500 11px/1.3 var(--mono); text-transform:uppercase; letter-spacing:.12em; color:var(--muted); }}
.lead {{ margin:0 0 20px; max-width:820px; color:var(--muted); font-size:14.5px; }}

/* panels + grids */
.panel {{ background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:24px; overflow-x:auto; }}
.grid-2 {{ display:grid; grid-template-columns:1fr 1fr; gap:20px; }}
.grid-3 {{ display:grid; grid-template-columns:repeat(3,1fr); gap:20px; }}
code {{ font:13px/1.5 var(--mono); }}
.muted {{ color:var(--muted); }}

/* grammar strip */
.grammar {{ padding:18px 20px; overflow-x:auto; white-space:nowrap; color:#e7eef4;
  background:#1e293b; border-radius:8px; font:13px/1.6 var(--mono); }}
.chip {{ display:inline-block; padding:3px 7px; border-radius:4px; font-weight:500; color:#fff; }}
.type {{ background:var(--teal); }} .place {{ background:var(--ochre); }} .method {{ background:var(--violet); }}
.value {{ background:var(--slate); }} .sep {{ color:#7d8a98; padding:0 2px; }}
.legend {{ display:flex; gap:18px; flex-wrap:wrap; margin-top:16px; color:var(--muted); font-size:12.5px; }}
.swatch {{ display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:8px; vertical-align:-1px; }}

/* stack bar */
.stack {{ display:flex; height:32px; overflow:hidden; border-radius:8px; background:var(--track); }}
.stack > div {{ height:100%; }}
.stack-legend {{ display:grid; grid-template-columns:1fr 1fr; gap:12px 24px; margin-top:20px; font-size:13px; color:var(--ink); }}
.stack-legend b {{ font-family:var(--mono); font-weight:500; font-variant-numeric:tabular-nums; }}

/* bar charts */
.bars {{ display:flex; flex-direction:column; gap:10px; }}
.bar-row {{ display:grid; grid-template-columns:152px 1fr 108px; gap:12px; align-items:center; }}
.bar-label {{ color:var(--ink); font-size:13px; text-align:right; line-height:1.25; }}
.bar-track {{ height:16px; border-radius:4px; background:var(--track); overflow:hidden; }}
.bar-fill {{ height:100%; border-radius:4px; }}
.bar-value {{ color:var(--muted); font:12px/1 var(--mono); font-variant-numeric:tabular-nums; }}

/* tables */
table {{ width:100%; border-collapse:collapse; font-size:13.5px; }}
th,td {{ padding:10px; border-bottom:1px solid var(--line-soft); text-align:left; vertical-align:middle; }}
th {{ color:var(--muted); font:500 10.5px/1.3 var(--mono); letter-spacing:.1em; text-transform:uppercase; border-bottom:1px solid var(--line); }}
tbody tr:last-child td {{ border-bottom:none; }}
tbody tr:hover {{ background:rgba(31,122,114,.04); }}
td:not(:first-child) {{ font-variant-numeric:tabular-nums; color:var(--muted); }}
td:first-child {{ color:var(--ink); }}
td code {{ display:inline-block; max-width:100%; padding:2px 6px; border-radius:4px; background:var(--track); color:var(--ink); white-space:normal; word-break:break-word; }}

/* coverage mini-bars */
.mini {{ position:relative; height:16px; min-width:140px; border-radius:4px; overflow:hidden; background:var(--track); }}
.mini div {{ height:100%; background:var(--teal); opacity:.85; }}
.mini span {{ position:absolute; right:8px; top:0; line-height:16px; color:var(--ink); font:11px/16px var(--mono); }}

/* asides + callouts */
.note {{ margin:18px 0 0; padding:2px 0 2px 16px; border-left:2px solid var(--teal);
  color:var(--muted); font:italic 14px/1.5 var(--serif); }}
.note code {{ font-style:normal; font-family:var(--mono); font-size:12px; }}
.callout {{ margin-top:16px; border-left:3px solid var(--red); padding:14px 18px; background:#fbf3f2;
  color:#43302e; border-radius:0 6px 6px 0; font-size:13.5px; line-height:1.55; }}
.callout b {{ color:var(--red); }}

/* example cards */
.example {{ border:1px solid var(--line); border-radius:8px; padding:16px; background:var(--panel); }}
.example h3 {{ margin:0 0 4px; font:600 13px/1.3 var(--sans); text-transform:none; letter-spacing:0; color:var(--ink); }}
.example .object {{ margin:0 0 12px; color:var(--teal); font:11px/1.3 var(--mono); letter-spacing:.04em; }}
.example code {{ white-space:pre-wrap; word-break:break-word; color:var(--muted); font-size:12px; line-height:1.5; }}

/* implications */
.implications p {{ margin:0 0 14px; font-size:14.5px; line-height:1.6; }}
.implications p:last-child {{ margin-bottom:0; }}
.implications b {{ color:var(--teal); }}

footer {{ margin-top:64px; padding-top:20px; border-top:1px solid var(--line); color:var(--soft); font:12px/1.6 var(--mono); }}
footer code {{ font-family:var(--mono); color:var(--muted); }}

@media (max-width:780px) {{
  main,.hero-inner {{ padding-left:16px; padding-right:16px; }}
  h1 {{ font-size:34px; }}
  .kpis,.grid-2,.grid-3 {{ grid-template-columns:1fr; }}
  .bar-row {{ grid-template-columns:110px 1fr 92px; }}
  .stack-legend {{ grid-template-columns:1fr; }}
}}
</style>
</head>
<body>
<header class="hero">
  <div class="hero-inner">
    <p class="eyebrow">Full-population analysis of <code>artworks.inscription_text</code></p>
    <h1>The inscription field is a structured mark log, not a complete inventory of visible text.</h1>
    <p>It records signatures, captions, dates, imprints, watermarks, and annotations, but nearly half of the populated records are Lugt collector-mark boilerplate. The useful parser target is the bilingual segment grammar; the interpretive risk is treating collection stamps as semantic artwork content.</p>
    <div class="kpis">
      <div class="kpi"><b>{pct(record_count, total_artworks):.1f}%</b><span>of {total_artworks:,} artworks have a populated inscription field</span></div>
      <div class="kpi"><b>{record_count:,}</b><span>records analysed from the local vocabulary DB</span></div>
      <div class="kpi"><b>{pct(records_with_any_lugt, record_count):.1f}%</b><span>contain at least one Lugt collector-mark number</span></div>
      <div class="kpi"><b>{pct(composition['Transcribed string present'], record_count):.1f}%</b><span>contain at least one non-Lugt quoted string</span></div>
    </div>
  </div>
</header>

<main>
  <section>
    <div class="sec-head"><span class="sec-index">01</span><h2>The Recoverable Grammar</h2></div>
    <p class="lead">A typical physical mark appears twice: a Dutch segment that carries the operational metadata, and an English gloss that usually keeps only the type and value. A parser should privilege the Dutch side for placement and method.</p>
    <div class="panel">
      <div class="grammar">
        <span class="chip type">verzamelaarsmerk</span><span>, </span><span class="chip place">verso</span><span>, </span><span class="chip method">gestempeld</span><span>: </span><span class="chip value">Lugt 2228</span><span class="sep"> | </span><span class="chip type">collector's mark</span><span>: </span><span class="chip value">Lugt 2228</span>
      </div>
      <div class="legend">
        <span><span class="swatch" style="background:#1f7a72"></span>type</span>
        <span><span class="swatch" style="background:#b07a2e"></span>surface or position</span>
        <span><span class="swatch" style="background:#6a5a93"></span>method</span>
        <span><span class="swatch" style="background:#4b5563"></span>value</span>
      </div>
      <p class="note">Median record: {median_segments:.0f} segments and {median_length} characters; mean length: {mean_length:.0f}. Multi-mark records create 4, 6, 8, or more segments because each physical mark can add another Dutch/English pair.</p>
    </div>
  </section>

  <section>
    <div class="sec-head"><span class="sec-index">02</span><h2>What The Population Is Made Of</h2></div>
    <p class="lead">The most important distinction is not type frequency; it is whether the record contains a transcription that might matter semantically, or only describes collection-management marks.</p>
    <div class="panel">
      <div class="stack">{''.join(stack_segments)}</div>
      <div class="stack-legend">{''.join(stack_legend)}</div>
      <p class="callout"><b>Reading rule:</b> the green segment is not guaranteed to be image-borne text. It includes repeated stamped strings such as <code>RPK</code> and photo/copyright stamps. The red segment is pure Lugt collector-mark boilerplate.</p>
    </div>
  </section>

  <section class="grid-3">
    <div>
      <div class="sec-head"><span class="sec-index">03</span><h2>Type Facets</h2></div>
      <p class="lead">Record-level counts after unifying Dutch and English labels.</p>
      <div class="panel">{bar_rows(type_counts.most_common(12), record_count, '#1f7a72')}</div>
    </div>
    <div>
      <div class="sec-head"><span class="sec-index">04</span><h2>Surface</h2></div>
      <p class="lead">Verso dominance explains why the field is skewed toward collection marks.</p>
      <div class="panel">{bar_rows(surface_counts.most_common(), record_count, '#b07a2e')}</div>
    </div>
    <div>
      <div class="sec-head"><span class="sec-index">05</span><h2>Method</h2></div>
      <p class="lead">Stamped and written marks dominate over printed inscriptions.</p>
      <div class="panel">{bar_rows(method_counts.most_common(10), record_count, '#6a5a93')}</div>
    </div>
  </section>

  <section class="grid-2">
    <div>
      <div class="sec-head"><span class="sec-index">06</span><h2>Collector-Mark Concentration</h2></div>
      <p class="lead">These are record counts bearing each mark, not raw segment occurrences, so Dutch/English pairs are not double-counted.</p>
      <div class="panel">{lugt_table}</div>
    </div>
    <div>
      <div class="sec-head"><span class="sec-index">07</span><h2>Repeated Exact Values</h2></div>
      <p class="lead">The most common complete field values show how much of the corpus is boilerplate copied across many objects.</p>
      <div class="panel">{exact_table}</div>
    </div>
  </section>

  <section>
    <div class="sec-head"><span class="sec-index">08</span><h2>Actual Quoted Content Needs Filtering</h2></div>
    <p class="lead">Raw frequency tables mostly surface cataloguing artefacts: short codes, numbers, collection stamps, and paper/manufacturer marks. The tables below remove Lugt values, pure numbers, common field labels, months, and high-frequency function words across Dutch, French, English, German, and Latin so repeated names, places, imprints, and formulas can surface.</p>
    <div class="grid-3">
      <div class="panel">
        <h3>Content Categories</h3>
        {bar_rows(quote_categories.most_common(9), sum(quote_categories.values()), '#33658f')}
        <p class="note">Median substantive quoted string: {median_quote_length} characters.</p>
      </div>
      <div class="panel">
        <h3>Filtered Words</h3>
        {word_table}
      </div>
      <div class="panel">
        <h3>Filtered Phrases</h3>
        {phrase_table}
      </div>
    </div>
  </section>

  <section class="grid-2">
    <div>
      <div class="sec-head"><span class="sec-index">09</span><h2>Repeated Quoted Strings</h2></div>
      <p class="lead">After removing Lugt numbers, pure numbers, and the shortest collection codes, the remaining repeats are a mix of photographer stamps, names, paper brands, and recurring publisher/imprint text.</p>
      <div class="panel">{quote_table}</div>
    </div>
    <div>
      <div class="sec-head"><span class="sec-index">10</span><h2>Known Data-Quality Signals</h2></div>
      <p class="lead">These are small but useful parser flags: they indicate places where the value is present but incomplete, escaped, or metadata-like.</p>
      <div class="panel">
        {bar_rows([('records with [...] / […]', illegible_records), ('records with escaped HTML entities', html_entity_records)], record_count, '#b04a45')}
        <p class="note">Escaped HTML matters because some long strings include markup fragments such as <code>&amp;lt;p&amp;gt;</code>. A parser should preserve the fact of the transcription but clean the display text.</p>
      </div>
    </div>
  </section>

  <section>
    <div class="sec-head"><span class="sec-index">11</span><h2>Coverage Is Selective By Object Type</h2></div>
    <p class="lead">The field is high-coverage for prints and some photographic formats, but low-coverage for object types with plenty of visible text of their own. That is the strongest evidence that absence from this field does not mean absence of writing on the object.</p>
    <div class="panel">{coverage_table}</div>
  </section>

  <section>
    <div class="sec-head"><span class="sec-index">12</span><h2>Record Gallery</h2></div>
    <p class="lead">Representative live records from the DB. These examples show why a useful parser should expose type, surface, method, Lugt number, and quoted-value facets separately.</p>
    <div class="grid-2">{examples_html}</div>
  </section>

  <section>
    <div class="sec-head"><span class="sec-index">—</span><h2>Implications</h2></div>
    <div class="panel implications">
      <p><b>Structured search:</b> parse <code>type, placement, method: value</code> into facets. Useful queries become possible: handwritten recto signatures, works bearing <code>Lugt 240</code>, printed captions, watermarks, or type-label-only placeholders.</p>
      <p><b>Semantic search:</b> do not embed raw <code>inscription_text</code> without testing. Lugt boilerplate and repeated museum stamps add shared text to large neighbourhoods of unrelated works. A better candidate source is cleaned quoted content plus selected non-collector inscription types.</p>
      <p><b>Interpretation:</b> treat the field as high precision but low recall for image-borne text. It captures many real inscriptions, yet systematically misses abundant visible text on coins, medals, posters, and other formats.</p>
    </div>
  </section>

  <footer>
    Generated from <code>data/vocabulary.db</code> over {record_count:,} populated <code>artworks.inscription_text</code> records on 2026-06-08.
    Object-type coverage uses <code>COUNT(DISTINCT artwork_id)</code> over <code>mappings.field_id = 15</code>; collector-mark counts are record-level, not segment-level.
  </footer>
</main>
</body>
</html>
"""

with open(OUT, "w", encoding="utf-8") as handle:
    handle.write(HTML)

print(f"wrote {OUT} ({len(HTML):,} bytes) from {record_count:,} inscription records")
