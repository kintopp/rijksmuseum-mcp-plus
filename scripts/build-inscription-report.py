#!/usr/bin/env python3
"""Build a standalone HTML report characterising artworks.inscription_text.

Parses the entire inscription population (not a sample), derives the
type/placement/technique taxonomies, the collector-mark boilerplate split,
content categories of transcribed text, an (approximate) language signal,
and an inscription-coverage-by-object-type cross-tab. Emits one self-contained
HTML file with inline CSS charts (no external dependencies). stdlib only.

Usage:  python3 scripts/build-inscription-report.py
Output: inscription-field-analysis.html (repo root)
"""
import html
import re
import sqlite3
import statistics
from collections import Counter

DB = "data/vocabulary.db"
OUT = "offline/explorations/inscription-field-analysis.html"

# ---------------------------------------------------------------- vocab maps
# Canonical English label for both Dutch and English type tokens.
TYPE_CANON = {
    "verzamelaarsmerk": "collector's mark", "collector's mark": "collector's mark",
    "signatuur": "signature", "signature": "signature",
    "signatuur en datum": "signature and date", "signature and date": "signature and date",
    "datum": "date", "date": "date", "datering": "date",
    "opschrift": "inscription", "inscription": "inscription", "inscriptie": "inscription",
    "annotatie": "annotation", "annotation": "annotation",
    "nummer": "number", "number": "number",
    "stempel": "stamp", "stamp": "stamp",
    "onderschrift": "caption", "caption": "caption",
    "adres": "address", "address": "address",
    "monogram": "monogram",
    "watermerk": "watermark", "watermark": "watermark",
    "merk": "mark", "mark": "mark",
    "titel": "title", "title": "title",
    "etiket": "label", "label": "label",
    "naam": "name", "name": "name",
    "tekst": "text", "text": "text",
    "blindstempel": "blind stamp", "blind stamp": "blind stamp",
    "fabrieksmerk": "factory mark", "factory mark": "factory mark",
    "atelierstempel": "workshop stamp", "workshop stamp": "workshop stamp",
    "oplage": "edition", "edition": "edition",
    "kleurnotitie": "colour note", "colour note": "colour note", "color note": "colour note",
    "poststempel": "postmark", "postmark": "postmark",
    "postzegel": "postage stamp", "postage stamp": "postage stamp",
    "controlestempel": "check stamp", "keurstempel": "check stamp", "check stamp": "check stamp",
    "clicheaanwijzing": "cliché instruction", "clichéaanwijzing": "cliché instruction",
    "prijs": "price", "price": "price",
    "drukkersmerk": "printer's mark", "printer's mark": "printer's mark",
}
METHODS = {
    "gestempeld": "stamped", "handgeschreven": "handwritten", "gedrukt": "printed",
    "potlood": "pencil", "geschreven": "written", "gegraveerd": "engraved",
    "geëtst": "etched", "geetst": "etched", "pen": "pen", "krijt": "chalk",
    "inkt": "ink", "blinddruk": "blind-embossed", "geprent": "printed",
    "geschilderd": "painted", "geplakt": "affixed", "gekrast": "scratched",
}
LOCS = ["verso", "recto", "linksboven", "rechtsboven", "linksonder", "rechtsonder",
        "midden", "boven", "onder", "links", "rechts", "rand", "passe-partout",
        "opzetvel", "lijst"]

lugt_re = re.compile(r"\bLugt\s*\d+", re.I)
quote_re = re.compile(r"[‘'\"]([^‘’'\"]{1,})[’'\"]")
year_re = re.compile(r"\b(1[0-9]{3}|20[0-2][0-9])\b")
latin_re = re.compile(r"\b(fecit|pinxit|delineavit|sculpsit|excudit|invenit|"
                      r"del|sc|inv|exc|fec|pinx|ad vivum|anno|imp)\b\.?", re.I)
money_re = re.compile(r"(ƒ|fl\.|gulden|\bcts?\b|cents?|francs?|€|\$|\bf\s*\d)", re.I)
street_re = re.compile(r"\b(straat|gracht|dijk|\bweg\b|laan|plein|kade|rue|stra(ss|ß)e|"
                       r"str\.|no\.|nr\.)\b", re.I)
numeric_re = re.compile(r"^[\W\d\s]+$")

# Approximate language stopword fingerprints (illustrative only).
LANG_WORDS = {
    "nl": {"van", "het", "de", "een", "en", "kerk", "gezicht", "te", "met", "den", "der"},
    "de": {"und", "der", "die", "das", "von", "mit", "kirche", "bei", "nach", "und."},
    "fr": {"de", "la", "le", "les", "rue", "et", "à", "des", "imprimerie", "paris"},
    "en": {"the", "view", "of", "and", "near", "from", "house"},
    "la": {"anno", "fecit", "pinxit", "excudit", "et", "sanctus", "sancti", "ad"},
}


def norm_type(tok: str) -> str:
    t = tok.strip().lower().rstrip(".")
    return TYPE_CANON.get(t, t)


def categorize(s: str) -> str:
    s = s.strip()
    if not s:
        return "empty"
    if "[...]" in s or "[…]" in s:
        return "illegible / partial"
    if numeric_re.match(s):
        return "number (inventory / portfolio)"
    if latin_re.search(s) and len(s) < 60:
        return "Latin artist formula (fecit / pinxit…)"
    if money_re.search(s):
        return "price / monetary"
    if street_re.search(s):
        return "address / topographic"
    if year_re.search(s):
        return "contains a date / year"
    letters = sum(c.isalpha() for c in s)
    if letters and len(s.split()) <= 4 and s[:1].isupper():
        return "name / short signature"
    if len(s) > 40:
        return "free text (caption / annotation)"
    return "other short text"


def guess_lang(s: str) -> str:
    toks = re.findall(r"[a-zA-Zàâäáéèêëïîôöûüùç]+", s.lower())
    if len(toks) < 3:
        return None
    scores = {lang: sum(t in words for t in toks) for lang, words in LANG_WORDS.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] >= 2 else "undetermined"


# ---------------------------------------------------------------- gather data
con = sqlite3.connect(DB)
total_art = con.execute("SELECT COUNT(*) FROM artworks").fetchone()[0]

type_xtab = con.execute("""
    SELECT COALESCE(NULLIF(v.label_en,''), v.label_nl, '(unlabelled)') AS type,
           COUNT(*) total,
           SUM(CASE WHEN a.inscription_text IS NOT NULL
                     AND TRIM(a.inscription_text)<>'' THEN 1 ELSE 0 END) with_ins
    FROM mappings m
    JOIN artworks a ON a.art_id = m.artwork_id
    JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
    WHERE m.field_id = 15
    GROUP BY type HAVING total > 2500
    ORDER BY total DESC LIMIT 22
""").fetchall()

cur = con.execute("""
    SELECT inscription_text FROM artworks
    WHERE inscription_text IS NOT NULL AND TRIM(inscription_text) <> ''
""")

n = 0
seg_counts = []
lengths = []
type_rec = Counter()        # records containing canonical type
place_rec = Counter()
method_rec = Counter()
lugt_marks = Counter()
transcribed = Counter()     # non-Lugt transcribed strings
content_cat = Counter()
lang_cat = Counter()
transcribed_lens = []
composition = Counter()     # mutually-exclusive record bucket
n_html_entity = 0
n_illegible = 0

for (txt,) in cur:
    n += 1
    lengths.append(len(txt))
    segs = [s.strip() for s in txt.split("|") if s.strip()]
    seg_counts.append(len(segs))
    rec_types, rec_place, rec_method = set(), set(), set()
    has_lugt = bool(lugt_re.search(txt))
    has_colon = ":" in txt
    rec_quoted = []
    for s in segs:
        header = s.split(":", 1)[0] if ":" in s else s
        fields = [f.strip() for f in header.split(",")]
        rec_types.add(norm_type(fields[0]))
        for f in fields[1:]:
            fl = f.lower()
            for k, v in METHODS.items():
                if k in fl:
                    rec_method.add(v)
            for loc in LOCS:
                if loc in fl:
                    rec_place.add(loc)
    for m in lugt_re.findall(txt):
        lugt_marks[re.sub(r"\s+", " ", m.strip())] += 1
    for q in quote_re.findall(txt):
        qs = q.strip()
        if lugt_re.search(qs) or qs.lower().startswith("lugt"):
            continue
        rec_quoted.append(qs)
        transcribed[qs] += 1
        transcribed_lens.append(len(qs))
        content_cat[categorize(qs)] += 1
        lg = guess_lang(qs)
        if lg:
            lang_cat[lg] += 1
    for t in rec_types:
        type_rec[t] += 1
    for p in rec_place:
        place_rec[p] += 1
    for mth in rec_method:
        method_rec[mth] += 1
    if "&lt;" in txt or "&gt;" in txt or "&amp;" in txt:
        n_html_entity += 1
    if "[...]" in txt or "[…]" in txt:
        n_illegible += 1
    # mutually-exclusive composition
    if rec_quoted:
        composition["Transcribed text present"] += 1
    elif has_lugt:
        composition["Collector-mark only (Lugt)"] += 1
    elif not has_colon:
        composition["Type label only (no value)"] += 1
    else:
        composition["Described mark, no transcription"] += 1

# representative live examples
def example(where, limit=1):
    return [r[0] for r in con.execute(
        f"SELECT inscription_text FROM artworks WHERE inscription_text IS NOT NULL "
        f"AND TRIM(inscription_text)<>'' AND {where} "
        f"ORDER BY LENGTH(inscription_text) LIMIT {limit}").fetchall()]

examples = []
examples.append(("Collector-mark only — the museum's own verso stamp",
                 example("inscription_text LIKE '%Lugt 2228%' AND inscription_text NOT LIKE '%‘%'")[0]))
examples.append(("Signature",
                 example("inscription_text LIKE 'signature%' AND LENGTH(inscription_text) BETWEEN 40 AND 90")[0]))
examples.append(("Signature and date",
                 example("inscription_text LIKE '%signature and date%' AND LENGTH(inscription_text) BETWEEN 40 AND 110")[0]))
examples.append(("Watermark",
                 example("inscription_text LIKE 'watermark%‘%' AND LENGTH(inscription_text) BETWEEN 40 AND 120")[0]))
examples.append(("Printer / publisher imprint (address)",
                 example("inscription_text LIKE '%adres%‘%' AND LENGTH(inscription_text) BETWEEN 40 AND 140")[0]))
examples.append(("Topographic annotation",
                 example("inscription_text LIKE 'annotation%kerk%' AND LENGTH(inscription_text) BETWEEN 50 AND 160")[0]))
examples.append(("Type label only — value never transcribed",
                 "datum | date"))
examples.append(("Illegible / partial transcription",
                 example("inscription_text LIKE '%[...]%‘%' AND LENGTH(inscription_text) BETWEEN 40 AND 150")[0]))
examples.append(("Complex multi-mark record",
                 example("inscription_text LIKE '%|%|%|%|%|%' AND LENGTH(inscription_text) BETWEEN 200 AND 360")[0]))

with_ins = n
con.close()

# ---------------------------------------------------------------- HTML render
def esc(s):
    return html.escape(str(s))

def pct(part, whole):
    return 100.0 * part / whole if whole else 0.0

TEAL = "#2f8f87"
def bars(items, total, palette=None, unit="%", show_n=True):
    """Horizontal CSS bars. items=[(label,count)]; widths relative to max."""
    if not items:
        return ""
    mx = max(c for _, c in items) or 1
    rows = []
    for i, (label, c) in enumerate(items):
        w = 100.0 * c / mx
        p = pct(c, total)
        color = (palette[i % len(palette)] if palette else TEAL)
        val = f"{p:.1f}%" if unit == "%" else f"{c:,}"
        meta = f"{p:.1f}% &nbsp;·&nbsp; {c:,}" if (unit == "%" and show_n) else val
        rows.append(
            f'<div class="bar-row"><div class="bar-label">{esc(label)}</div>'
            f'<div class="bar-track"><div class="bar-fill" style="width:{w:.1f}%;'
            f'background:{color}"></div></div>'
            f'<div class="bar-val">{meta}</div></div>')
    return '<div class="bars">' + "".join(rows) + "</div>"

def stacked(items, total, palette):
    segs, legend = [], []
    for i, (label, c) in enumerate(items):
        p = pct(c, total)
        color = palette[i % len(palette)]
        segs.append(f'<div class="seg" style="width:{p:.2f}%;background:{color}" '
                    f'title="{esc(label)}: {p:.1f}%"></div>')
        legend.append(f'<div class="lg-item"><span class="sw" style="background:{color}"></span>'
                      f'{esc(label)} <b>{p:.1f}%</b> <span class="muted">({c:,})</span></div>')
    return ('<div class="stack">' + "".join(segs) + "</div>"
            '<div class="legend">' + "".join(legend) + "</div>")

# length buckets
len_buckets = Counter()
for L in lengths:
    b = ("1–25" if L <= 25 else "26–50" if L <= 50 else "51–100" if L <= 100
         else "101–250" if L <= 250 else "251–500" if L <= 500 else "500+")
    len_buckets[b] += 1
LB_ORDER = ["1–25", "26–50", "51–100", "101–250", "251–500", "500+"]

seg_buckets = Counter()
for s in seg_counts:
    b = "1" if s == 1 else "2" if s == 2 else "3–4" if s <= 4 else "5–8" if s <= 8 else "9+"
    seg_buckets[b] += 1
SB_ORDER = ["1", "2", "3–4", "5–8", "9+"]

PALETTE = ["#2f8f87", "#3a6ea5", "#b9772e", "#7a5ca5", "#5a9e6f", "#c44e52",
           "#4c8c9b", "#a36b8a", "#8a8d3f", "#5d7a8c"]
COMP_PAL = ["#2f8f87", "#c44e52", "#b9772e", "#7a5ca5"]

# anatomy diagram pieces
def chip(text, cls):
    return f'<span class="chip {cls}">{esc(text)}</span>'

anatomy = (
    '<div class="anatomy">'
    + chip("verzamelaarsmerk", "c-type") + chip(", ", "c-punc")
    + chip("verso", "c-place") + chip(", ", "c-punc")
    + chip("gestempeld", "c-tech") + chip(": ", "c-punc")
    + chip("Lugt 2228", "c-val")
    + chip(" | ", "c-sep")
    + chip("collector's mark", "c-type") + chip(": ", "c-punc")
    + chip("Lugt 2228", "c-val")
    + '</div>'
    '<div class="anatomy-legend">'
    + '<span><i class="sw" style="background:#1f6f68"></i>type</span>'
    + '<span><i class="sw" style="background:#b9772e"></i>placement (Dutch side)</span>'
    + '<span><i class="sw" style="background:#7a5ca5"></i>technique (Dutch side)</span>'
    + '<span><i class="sw" style="background:#475569"></i>transcribed value</span>'
    + '<span><i class="sw" style="background:#94a3b8"></i>NL&nbsp;|&nbsp;EN divider</span>'
    + '</div>'
)

# top types / places / methods
TOP_TYPES = type_rec.most_common(16)
TOP_PLACE = [(p, c) for p, c in place_rec.most_common(10)]
TOP_METHOD = method_rec.most_common(10)
TOP_LUGT = lugt_marks.most_common(12)
TOP_TRANSCRIBED = [(t, c) for t, c in transcribed.most_common(15)]
CONTENT = content_cat.most_common(12)
LANG = [(l, c) for l, c in lang_cat.most_common() if l != "undetermined"][:6]

LUGT_NOTE = {"Lugt 2228": "Rijksprentenkabinet, Amsterdam — the museum's own mark"}

# object-type cross-tab rows
xtab_rows = []
for t, tot, wi in type_xtab:
    xtab_rows.append((t, tot, wi, pct(wi, tot)))

def table(headers, rows):
    h = "".join(f"<th>{esc(x)}</th>" for x in headers)
    body = ""
    for r in rows:
        body += "<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>"
    return f'<table><thead><tr>{h}</tr></thead><tbody>{body}</tbody></table>'

xtab_html = table(
    ["Object type", "Artworks", "With inscription", "Coverage"],
    [(esc(t), f"{tot:,}", f"{wi:,}",
      f'<div class="mini"><div class="mini-fill" style="width:{p:.0f}%"></div>'
      f'<span>{p:.0f}%</span></div>') for t, tot, wi, p in xtab_rows])

lugt_html = table(
    ["Collector mark", "Occurrences", "Note"],
    [(esc(m), f"{c:,}", esc(LUGT_NOTE.get(m, "")) or "<span class='muted'>former-owner / institutional mark</span>")
     for m, c in TOP_LUGT])

transcribed_html = table(
    ["Transcribed text", "Records"],
    [(f"<code>{esc(t[:70])}</code>", f"{c:,}") for t, c in TOP_TRANSCRIBED])

examples_html = "".join(
    f'<div class="ex"><div class="ex-h">{esc(title)}</div>'
    f'<div class="ex-b"><code>{esc(val)}</code></div></div>'
    for title, val in examples)

med_len = int(statistics.median(lengths))
mean_len = statistics.mean(lengths)
med_seg = statistics.median(seg_counts)
med_tr = int(statistics.median(transcribed_lens)) if transcribed_lens else 0
n_transcribed_records = composition["Transcribed text present"]
n_marks_only = composition["Collector-mark only (Lugt)"]

HTML = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anatomy of the Rijksmuseum Inscription Field</title>
<style>
  :root {{ --teal:#2f8f87; --slate:#1e293b; --ink:#0f172a; --muted:#64748b;
           --line:#e2e8f0; --bg:#f8fafc; --card:#ffffff; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         color:var(--ink); background:var(--bg); }}
  .wrap {{ max-width:980px; margin:0 auto; padding:0 22px 80px; }}
  code {{ font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }}
  .muted {{ color:var(--muted); }}
  /* hero */
  .hero {{ background:linear-gradient(135deg,#15323a 0%,#1e293b 55%,#234e4a 100%);
           color:#e6f1f0; padding:54px 0 46px; }}
  .hero .wrap {{ padding-bottom:0; }}
  .hero h1 {{ margin:0 0 10px; font-size:34px; letter-spacing:-.5px; font-weight:700; }}
  .hero p {{ margin:0; max-width:680px; color:#bcd3d0; font-size:17px; }}
  .kpis {{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-top:34px; }}
  .kpi {{ background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12);
          border-radius:12px; padding:16px 16px 14px; }}
  .kpi .v {{ font-size:27px; font-weight:700; color:#fff; }}
  .kpi .l {{ font-size:12.5px; color:#a9c5c2; margin-top:3px; letter-spacing:.2px; }}
  /* sections */
  section {{ margin-top:46px; }}
  h2 {{ font-size:21px; margin:0 0 6px; letter-spacing:-.3px; }}
  h2 .num {{ color:var(--teal); font-weight:700; margin-right:9px; }}
  .lead {{ color:var(--muted); margin:0 0 20px; max-width:760px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:14px;
           padding:22px 24px; box-shadow:0 1px 2px rgba(15,23,42,.04); }}
  .grid2 {{ display:grid; grid-template-columns:1fr 1fr; gap:18px; }}
  @media (max-width:720px) {{ .grid2,.kpis {{ grid-template-columns:1fr 1fr; }} }}
  /* bars */
  .bars {{ display:flex; flex-direction:column; gap:9px; }}
  .bar-row {{ display:grid; grid-template-columns:160px 1fr 96px; align-items:center; gap:12px; }}
  .bar-label {{ font-size:13.5px; text-align:right; color:var(--slate); }}
  .bar-track {{ background:#eef2f6; border-radius:6px; height:18px; overflow:hidden; }}
  .bar-fill {{ height:100%; border-radius:6px; }}
  .bar-val {{ font-size:12.5px; color:var(--muted); }}
  @media (max-width:600px) {{ .bar-row {{ grid-template-columns:110px 1fr 76px; }}
                              .bar-label{{font-size:12px}} }}
  /* stacked */
  .stack {{ display:flex; height:30px; border-radius:8px; overflow:hidden; margin:4px 0 16px; }}
  .stack .seg {{ height:100%; }}
  .legend {{ display:grid; grid-template-columns:1fr 1fr; gap:7px 22px; }}
  .lg-item {{ font-size:13.5px; }}
  .sw {{ display:inline-block; width:11px; height:11px; border-radius:3px; margin-right:7px;
         vertical-align:baseline; }}
  /* anatomy */
  .anatomy {{ font:15px/2.4 ui-monospace,Menlo,monospace; background:#0f172a; color:#e2e8f0;
              padding:18px 20px; border-radius:12px; overflow-x:auto; white-space:nowrap; }}
  .chip {{ padding:2px 4px; border-radius:5px; }}
  .c-type {{ background:#1f6f68; color:#eafffb; }}
  .c-place {{ background:#b9772e; color:#fff; }}
  .c-tech {{ background:#7a5ca5; color:#fff; }}
  .c-val {{ background:#475569; color:#fff; }}
  .c-sep {{ color:#94a3b8; }}
  .c-punc {{ color:#64748b; }}
  .anatomy-legend {{ display:flex; flex-wrap:wrap; gap:16px; margin-top:14px; font-size:13px;
                     color:var(--muted); }}
  .anatomy-legend i.sw {{ width:11px; height:11px; }}
  /* tables */
  table {{ width:100%; border-collapse:collapse; font-size:13.5px; }}
  th,td {{ text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:middle; }}
  th {{ font-size:12px; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); }}
  td code {{ background:#f1f5f9; padding:1px 5px; border-radius:4px; }}
  .mini {{ position:relative; background:#eef2f6; border-radius:5px; height:16px; min-width:120px; }}
  .mini-fill {{ background:var(--teal); height:100%; border-radius:5px; }}
  .mini span {{ position:absolute; right:6px; top:-1px; font-size:11.5px; color:#334155; }}
  /* examples */
  .ex {{ border:1px solid var(--line); border-radius:10px; margin-bottom:10px; overflow:hidden; }}
  .ex-h {{ background:#f1f5f9; padding:7px 13px; font-size:12.5px; font-weight:600; color:var(--slate); }}
  .ex-b {{ padding:10px 13px; }}
  .ex-b code {{ color:#0f172a; white-space:pre-wrap; word-break:break-word; }}
  .note {{ font-size:13px; color:var(--muted); border-left:3px solid var(--teal);
           padding:4px 0 4px 14px; margin:14px 0 0; }}
  footer {{ margin-top:54px; padding-top:20px; border-top:1px solid var(--line);
            font-size:12.5px; color:var(--muted); }}
</style></head>
<body>
<div class="hero"><div class="wrap">
  <h1>Anatomy of the Inscription Field</h1>
  <p>A structural and statistical portrait of <code>artworks.inscription_text</code> across the
     full Rijksmuseum collection — what kinds of text it records, how each record is built, and
     where it captures (and misses) the writing visible on the works themselves.</p>
  <div class="kpis">
    <div class="kpi"><div class="v">{pct(with_ins,total_art):.0f}%</div>
      <div class="l">of {total_art:,} artworks carry an inscription</div></div>
    <div class="kpi"><div class="v">{with_ins:,}</div>
      <div class="l">inscription records analysed (full population)</div></div>
    <div class="kpi"><div class="v">{pct(n_marks_only,with_ins):.0f}%</div>
      <div class="l">are collector-mark boilerplate only</div></div>
    <div class="kpi"><div class="v">{pct(n_transcribed_records,with_ins):.0f}%</div>
      <div class="l">contain transcribed artwork text</div></div>
  </div>
</div></div>

<div class="wrap">

<section>
  <h2><span class="num">01</span>What one record looks like</h2>
  <p class="lead">The field is not free text. Every value is a <code>|</code>-delimited list of
     segments, and each physical inscription is stored <b>twice</b> — a richly-detailed Dutch form
     (<code>type, placement, technique: value</code>) paired with a reduced English gloss
     (<code>type: value</code>). To recover placement and technique you mine the Dutch side.</p>
  <div class="card">{anatomy}</div>
  <p class="note">Median record = {med_seg:.0f} segments (the NL/EN pair); records describing
     several distinct marks run to 8 or more. Median length {med_len} characters
     (mean {mean_len:.0f}).</p>
</section>

<section>
  <h2><span class="num">02</span>What the field is made of</h2>
  <p class="lead">Classifying every record into one mutually-exclusive bucket. The dominant content
     is the museum's <b>own collection stamps</b> on the verso — not text borne by the artwork.
     Transcribed text is a real but minority component.</p>
  <div class="card">
    {stacked(composition.most_common(), with_ins, COMP_PAL)}
  </div>
</section>

<section>
  <h2><span class="num">03</span>Type taxonomy</h2>
  <p class="lead">Share of inscription records containing each canonical type (Dutch and English
     labels unified). Collector's marks alone appear in nearly half of all records.</p>
  <div class="card">{bars(TOP_TYPES, with_ins, PALETTE)}</div>
</section>

<section class="grid2">
  <div>
    <h2><span class="num">04</span>Placement</h2>
    <p class="lead">Where the mark sits. Two-thirds are on the <b>verso</b> — consistent with
       ownership stamps and curatorial notes rather than image-borne text.</p>
    <div class="card">{bars(TOP_PLACE, with_ins, ["#b9772e"])}</div>
  </div>
  <div>
    <h2><span class="num">05</span>Technique</h2>
    <p class="lead">How the mark was applied. Stamping dominates, again pointing to collection
       marks over hand-written or printed artwork text.</p>
    <div class="card">{bars(TOP_METHOD, with_ins, ["#7a5ca5"])}</div>
  </div>
</section>

<section>
  <h2><span class="num">06</span>The collector-mark concentration</h2>
  <p class="lead">More than half of all inscriptions contain a <b>Lugt number</b> (Frits Lugt's
     reference catalogue of collectors' marks). A single mark — the Rijksprentenkabinet's own —
     dominates the entire population. Marks can be resolved at
     <code>marquesdecollections.fr</code>.</p>
  <div class="card">{lugt_html}</div>
</section>

<section>
  <h2><span class="num">07</span>What the transcribed text actually says</h2>
  <p class="lead">Looking only at quoted <code>‘…’</code> values that are <i>not</i> collector
     marks — the text genuinely written on or applied to the work. Categories assigned by priority
     rule.</p>
  <div class="grid2">
    <div class="card">{bars(CONTENT, sum(content_cat.values()), PALETTE)}</div>
    <div class="card">
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px">
        Approximate language signal (heuristic, illustrative — short strings excluded)</div>
      {bars([(l.upper(),c) for l,c in LANG], sum(c for _,c in LANG), ["#3a6ea5"])}
      <p class="note" style="margin-top:16px">Median transcribed string = {med_tr} characters.
         {pct(n_illegible,with_ins):.1f}% of records flag an illegible passage
         <code>[...]</code>; {pct(n_html_entity,with_ins):.2f}% leak HTML entities
         (<code>&amp;lt;</code> / <code>&amp;gt;</code>) — a cataloguing artefact.</p>
    </div>
  </div>
</section>

<section>
  <h2><span class="num">08</span>Most frequent transcribed strings</h2>
  <p class="lead">Excluding Lugt numbers. Note the empty <code>date</code> / <code>datum</code>
     placeholders — the cataloguer recorded that a date inscription <i>exists</i> but never
     transcribed its value.</p>
  <div class="card">{transcribed_html}</div>
</section>

<section>
  <h2><span class="num">09</span>Coverage by object type</h2>
  <p class="lead">The field's reach is wildly uneven. Prints and cartes-de-visite are near-saturated
     (driven by verso stamps and captions); <b>coins, posters and medals are nearly empty</b> —
     their abundant legend and printed text was simply never entered here.</p>
  <div class="card">{xtab_html}</div>
</section>

<section>
  <h2><span class="num">10</span>Record gallery</h2>
  <p class="lead">Real records from the collection, one per characteristic shape.</p>
  <div class="card">{examples_html}</div>
</section>

<section>
  <h2><span class="num">11</span>Why this matters</h2>
  <div class="card">
    <p style="margin-top:0"><b>For search.</b> The Dutch grammar
       (<code>type, placement, technique: value</code>) is regular enough for a light parser to
       expose structured facets — search for a <i>handwritten signature on the recto</i>, or every
       work bearing <i>Lugt 240</i> — instead of blunt full-text matching over the whole blob.</p>
    <p><b>For semantic search.</b> The embedding source text currently ingests the raw
       <code>inscription_text</code>, so a near-identical collector-stamp string is baked into a
       large fraction of the corpus's vectors — adding little discriminative signal. Keeping only
       the transcribed <code>‘…’</code> content is worth evaluating at the next embeddings
       regeneration.</p>
    <p style="margin-bottom:0"><b>For interpretation.</b> Treat this field as a conservator's
       mark-and-annotation log: high precision, low recall for image-borne text. What is here is
       reliable; a great deal of writing visible <i>in</i> the images — coin legends, poster copy,
       untranscribed dates — was never entered.</p>
  </div>
</section>

<footer>
  Generated from the local v0.40 vocabulary database
  (<code>artworks.inscription_text</code>, full population of {with_ins:,} records).
  Charts computed by <code>scripts/build-inscription-report.py</code> (stdlib only).
  Type / placement / technique taxonomies parsed from the bilingual segment grammar; language
  signal is a heuristic stopword fingerprint and is illustrative only.
</footer>

</div></body></html>
"""

with open(OUT, "w") as f:
    f.write(HTML)
print(f"wrote {OUT}  ({len(HTML):,} bytes)  from {with_ins:,} inscription records")
