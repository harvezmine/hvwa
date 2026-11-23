# labs/r04-postcard/app/app.py — Postcard. Start hook: read the one-shot flag file (HVWA_FLAG_FILE) once and unlink it,
# then plant it where the level expects (spec §6): Acolyte keeps the whole flag at /tmp/postcard/flag.txt; Templar tears
# it into a random pair under /tmp/postcard/outbox; Inquisitor tears it into a random pair under
# /tmp/postcard/archive/<random>. Each split directory also holds decoy pairs, so the path a lower tier taught is a dead
# end next door. POST /preview renders the operator's message per level (templating.render_card). No page renders the
# flag in full; only the template primitive does. Serves on 0.0.0.0:$HVWA_PORT with Flask's threaded server (debug OFF —
# debug would be its own vulnerability).
import json
import os
import pathlib
import re
import secrets
import sys
import threading
import time
from collections import OrderedDict
from urllib.parse import quote
from flask import Flask, Response, abort, request, render_template_string
from markupsafe import escape
from templating import render_card

LEVELS = ("acolyte", "templar", "inquisitor", "divine")
LEVEL = os.environ.get("HVWA_LEVEL") if os.environ.get("HVWA_LEVEL") in LEVELS else "acolyte"
PORT = int(os.environ.get("HVWA_PORT", "5000"))
HERE = pathlib.Path(__file__).resolve().parent
FLAG_SOURCE = os.environ.get("HVWA_FLAG_FILE", "/tmp/.hvwa-flag")


def _read_flag():
    """Poll for the one-shot flag file, read it once and unlink it. Below Divine only."""
    deadline = time.monotonic() + 10
    while True:
        try:
            with open(FLAG_SOURCE, "r", encoding="utf-8") as f:
                value = f.read().strip()
            if value:
                try:
                    os.unlink(FLAG_SOURCE)
                except FileNotFoundError:
                    pass
                return value
        except FileNotFoundError:
            pass  # the warden has not written it yet
        if time.monotonic() >= deadline:
            print("postcard: the flag file never appeared", flush=True)  # never the flag itself
            sys.exit(1)
        time.sleep(0.1)


_flag = None if LEVEL == "divine" else _read_flag()
FLAG_BASE = pathlib.Path("/tmp/postcard")
FLAG_BASE.mkdir(parents=True, exist_ok=True)
_DIVINE_BODY = "Divine is the secure reference: your message is printed as data, so there is nothing to inject."


def _write_secret(path: pathlib.Path, value: str) -> None:
    path.write_text(value, encoding="utf-8")
    path.chmod(0o444)


def _plant_parts(directory: pathlib.Path, value: str) -> None:
    """Tear the flag into a random pair beside decoy pairs; only the real pair joins into a valid HVWA{...}."""
    directory.mkdir(parents=True, exist_ok=True)
    cut = len(value) // 2
    token = secrets.token_hex(4)
    _write_secret(directory / f"part-1-{token}", value[:cut])
    _write_secret(directory / f"part-2-{token}", value[cut:])
    for _ in range(2):
        decoy = secrets.token_hex(4)
        _write_secret(directory / f"part-1-{decoy}", f"FAKE-{decoy}-1")
        _write_secret(directory / f"part-2-{decoy}", f"FAKE-{decoy}-2")


if LEVEL == "divine" or not _flag:
    _write_secret(FLAG_BASE / "flag.txt", _DIVINE_BODY + "\n")
elif LEVEL == "acolyte":
    _write_secret(FLAG_BASE / "flag.txt", _flag + "\n")
elif LEVEL == "templar":
    _write_secret(FLAG_BASE / "flag.txt", "This card was moved to the outbox.\n")
    _plant_parts(FLAG_BASE / "outbox", _flag)
else:  # inquisitor: a deeper, random archive directory; the print stage is the only way to read it
    _write_secret(FLAG_BASE / "flag.txt", "This card was moved to the archive.\n")
    _plant_parts(FLAG_BASE / "archive" / secrets.token_hex(4), _flag)

CARDS = json.loads((HERE / "seed" / "cards.json").read_text())


def _slug(value):
    """Seed occasions become CSS class names; keep them to a safe alphabet."""
    return value if isinstance(value, str) and re.fullmatch(r"[a-z]+", value) else "birthday"


STYLE_INFO = {c["style"]: c for c in CARDS}
STYLES = [c["style"] for c in CARDS]
STYLE_CLASS = {c["style"]: _slug(c.get("occasion", "")) for c in CARDS}
DEFAULT_STYLE = STYLES[0] if STYLES else "Birthday"
DEFAULT_OCC = STYLE_CLASS.get(DEFAULT_STYLE, "birthday")
OCCASIONS = []
for _card in CARDS:
    _occ = STYLE_CLASS.get(_card["style"], "birthday")
    if all(_occ != o for o, _ in OCCASIONS):
        OCCASIONS.append((_occ, _card["style"]))

# Inquisitor's print stage: POST /preview only SAVES the message, and GET /orders/<id>/print renders it. The store is
# bounded (the studio keeps at most 32 waiting drafts, oldest evicted) and ids are random so a draft cannot be guessed.
# This is process memory only; nothing is written to disk.
MAX_DRAFTS = 32
DRAFTS = OrderedDict()
DRAFTS_LOCK = threading.Lock()


def draft_save(style, message):
    with DRAFTS_LOCK:
        while True:
            draft_id = secrets.token_hex(8)
            if draft_id not in DRAFTS:
                break
        DRAFTS[draft_id] = {"style": style, "message": message}
        while len(DRAFTS) > MAX_DRAFTS:
            DRAFTS.popitem(last=False)
    return draft_id


def draft_get(draft_id):
    with DRAFTS_LOCK:
        draft = DRAFTS.get(draft_id)
        return dict(draft) if draft is not None else None


def esc(value):
    """Escape any value before it is concatenated into the page HTML."""
    return str(escape("" if value is None else value))


def occ_for(style):
    return STYLE_CLASS.get(style, DEFAULT_OCC)


def shell(title, inner, active=""):
    # The chrome is a CONSTANT template; only `inner` (built per route) is marked safe. User text reaches Jinja only
    # through render_card (the intentional flaw) — never through this shell.
    return render_template_string(SHELL, title=title, css=CSS, inner=inner, active=active)


app = Flask(__name__)
# Every route that reads a form (/preview, /contact) is bounded: a bigger body gets the friendly 413 below, never a
# debug trace (Flask's debug mode is off; the handler is what makes Werkzeug's 413 look like the rest of the studio).
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024

CSS = """
:root{
  --rose:#e7a6b8; --plum:#6d4466; --plum-deep:#43253e; --cream:#fbf4ef; --ink:#4a3340;
  --line:#efd9df; --gold:#c9a45c; --shadow:0 18px 40px -22px rgba(74,51,64,.55);
  --c1:#e7a6b8; --c2:#f4c9a8; --c3:#d98b6a; --paper:#fffaf6; --edge:#e7a6b8; --accent:#b56a86;
  --font:Georgia,"Times New Roman",serif;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;font:16px/1.65 "Segoe UI",system-ui,-apple-system,sans-serif;color:var(--ink);min-height:100vh;
  background:
    radial-gradient(1100px 480px at 10% -12%,#fde9ee 0%,rgba(253,233,238,0) 60%),
    radial-gradient(900px 560px at 100% 0%,#f0e1d4 0%,rgba(240,225,212,0) 55%),
    repeating-linear-gradient(0deg,rgba(120,80,90,.025) 0 2px,rgba(120,80,90,0) 2px 4px),
    var(--cream);
}
h1,h2,h3{font-family:Georgia,"Times New Roman",serif;line-height:1.15;color:var(--plum-deep)}
h1{margin:0 0 10px}
h2{font-size:clamp(22px,3vw,30px);margin:0 0 14px}
p{margin:0 0 12px}
a{color:var(--accent)}
.wrap{width:min(1100px,100% - 32px);margin-inline:auto}
.skip-link{position:absolute;left:-999px;top:8px;background:#fff;color:var(--plum-deep);padding:10px 16px;border-radius:8px;z-index:20}
.skip-link:focus{left:16px}

/* ---------- header + studio status ---------- */
.site-head{background:linear-gradient(135deg,var(--plum-deep),var(--plum) 55%,#8a5a7c);color:#fff;box-shadow:0 12px 30px -22px #000}
.head-inner{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 0;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px;color:#fff;text-decoration:none}
.brand-mark{display:grid;place-items:center;width:46px;height:46px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.3);border-radius:14px}
.brand-text{display:flex;flex-direction:column;font-family:Georgia,"Times New Roman",serif;font-size:20px;font-weight:700;letter-spacing:.02em;line-height:1.05}
.brand-text small{font-family:"Segoe UI",system-ui,sans-serif;font-size:10px;letter-spacing:.22em;text-transform:uppercase;opacity:.72;font-weight:700;margin-top:4px}
.site-nav{display:flex;flex-wrap:wrap;gap:4px}
.site-nav a{color:#f6e9ef;text-decoration:none;font-size:14px;font-weight:600;padding:8px 11px;border-radius:999px;transition:background .18s ease,color .18s ease}
.site-nav a:hover{background:rgba(255,255,255,.12)}
.site-nav a.is-active{background:#fff;color:var(--plum-deep)}
.studio-bar{background:#3a2136;color:#f0dbe4;font-size:12.5px;padding:7px 0}
.studio-bar .wrap{display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;text-align:center}
.studio-bar .status{display:inline-flex;align-items:center;gap:7px;font-weight:700}
.dot{width:8px;height:8px;border-radius:50%;background:#8fd6a2;animation:pulse 2.6s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(143,214,162,.55)}70%{box-shadow:0 0 0 7px rgba(143,214,162,0)}100%{box-shadow:0 0 0 0 rgba(143,214,162,0)}}
.bar-sep{opacity:.45}

/* ---------- layout ---------- */
main{padding:34px 0 10px;display:block}
.eyebrow{text-transform:uppercase;letter-spacing:.2em;font-size:11px;font-weight:800;color:var(--accent);margin:0 0 8px}
.page-title{font-size:clamp(28px,4vw,40px);margin:0 0 6px}
.page-lede{color:#6b5262;max-width:64ch;margin-bottom:22px}
.page-note{margin-top:18px;font-size:13px;color:#8a6f7e}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px}
.section-head h2{margin:0}
.section-head a{font-weight:700;font-size:14px}

/* ---------- hero ---------- */
.hero{display:grid;grid-template-columns:1.15fr .85fr;gap:30px;align-items:center;margin-bottom:34px}
.hero h1{font-size:clamp(32px,5vw,54px);margin:0 0 12px;letter-spacing:-.01em}
.hero .lede{font-size:clamp(16px,2vw,19px);max-width:46ch;color:#5d4452}
.hero-meta{font-size:13px;color:#8a6f7e}
.hero-art{display:grid;place-items:center}
.hero-art svg{width:100%;max-width:360px;height:auto;filter:drop-shadow(0 24px 30px rgba(90,50,70,.18))}

/* ---------- form + swatches ---------- */
.maker{background:linear-gradient(180deg,#fff,#fdf7f3);border:1px solid var(--line);border-radius:22px;padding:clamp(18px,3vw,28px);box-shadow:var(--shadow);margin-bottom:34px}
.swatch-field{border:0;padding:0;margin:0 0 16px}
.swatch-field legend{font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8a6f7e;margin-bottom:10px}
.swatch-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.swatch-card{position:relative;cursor:pointer}
.swatch-card input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;margin:0}
.swatch{display:flex;flex-direction:column;gap:4px;padding:12px;border:1.5px solid var(--edge);border-radius:14px;background:var(--paper);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.swatch-card:hover .swatch{transform:translateY(-2px)}
.swatch-card input:checked + .swatch{border-color:var(--accent);box-shadow:0 0 0 3px rgba(181,106,134,.22),0 12px 24px -16px rgba(80,40,60,.6);transform:translateY(-1px)}
.swatch-card input:focus-visible + .swatch{outline:2px solid var(--plum);outline-offset:2px}
.swatch-dots{display:flex;gap:5px;margin-bottom:4px}
.swatch-dots i{width:18px;height:18px;border-radius:50%;border:1px solid rgba(0,0,0,.06)}
.swatch-dots i:nth-child(1){background:var(--c1)}
.swatch-dots i:nth-child(2){background:var(--c2)}
.swatch-dots i:nth-child(3){background:var(--c3)}
.swatch-name{font-family:var(--font);font-weight:700;font-size:15px;color:var(--ink);line-height:1.2}
.swatch-meta{font-size:11.5px;color:#8a6f7e}
.field{display:block;margin:0 0 14px}
.field span{display:block;font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#8a6f7e;margin-bottom:6px}
input,textarea,select{width:100%;padding:12px 14px;border:1.5px solid var(--line);border-radius:12px;font:inherit;color:var(--ink);background:#fff;transition:border-color .18s ease,box-shadow .18s ease}
textarea{resize:vertical;min-height:120px}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--rose);box-shadow:0 0 0 4px rgba(231,166,184,.25)}
.form-actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.form-hint{font-size:12.5px;color:#8a6f7e}

/* ---------- buttons ---------- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,var(--rose),#d98aa4);color:#3c1f30;border:1.5px solid rgba(60,31,48,.12);border-radius:999px;padding:12px 22px;font:inherit;font-weight:800;font-size:14.5px;cursor:pointer;text-decoration:none;box-shadow:0 12px 24px -14px rgba(140,60,90,.8);transition:transform .16s ease,box-shadow .16s ease,filter .16s ease}
.btn:hover{transform:translateY(-1px);filter:brightness(1.03)}
.btn:active{transform:translateY(0)}
.btn:focus-visible{outline:2px solid var(--plum);outline-offset:2px}
.btn.ghost{background:#fff;color:var(--plum-deep);border-color:var(--line);box-shadow:none}
.btn.plain{background:transparent;color:var(--accent);border-color:transparent;box-shadow:none;padding-inline:10px}
.btn[disabled]{opacity:.65;cursor:default;transform:none;filter:none}

/* ---------- card + occasion themes ---------- */
.card{position:relative;background:var(--paper);border:2px solid var(--edge);border-radius:18px;padding:0;margin:0;box-shadow:var(--shadow);color:var(--ink);font-family:var(--font);overflow:hidden;transition:transform .2s ease,box-shadow .2s ease}
.card-paper{position:relative;padding:clamp(22px,4vw,40px);min-height:240px;display:flex;flex-direction:column;justify-content:center;gap:10px;text-align:center;background:radial-gradient(120% 90% at 50% -10%,rgba(255,255,255,.85),rgba(255,255,255,0) 60%),repeating-linear-gradient(45deg,rgba(120,80,90,.03) 0 3px,rgba(120,80,90,0) 3px 6px)}
.card .kicker{font-family:"Segoe UI",system-ui,sans-serif;font-size:10.5px;letter-spacing:.24em;text-transform:uppercase;font-weight:800;color:var(--accent);margin:0}
.card .msg{font-family:var(--font);font-size:clamp(20px,2.6vw,27px);line-height:1.42;margin:6px 0;color:var(--ink);overflow-wrap:anywhere}
.card .sign{font-family:var(--font);font-style:italic;font-size:14.5px;color:var(--accent);margin:0}
.orn{position:absolute;font-size:22px;line-height:1;color:var(--accent);opacity:.85;pointer-events:none}
.orn::before{content:"\\2726"}
.orn-tl{top:10px;left:12px}
.orn-tr{top:10px;right:12px;transform:scaleX(-1)}
.orn-bl{bottom:10px;left:12px;transform:scaleY(-1)}
.orn-br{bottom:10px;right:12px;transform:scale(-1,-1)}

.birthday{--c1:#f2b8c6;--c2:#f6d6a8;--c3:#d98b6a;--paper:#fff6f7;--edge:#f0b9c8;--accent:#c25f7f;--ink:#5a3345;--font:Georgia,"Times New Roman",serif}
.card.birthday{border-style:double;border-width:4px;border-radius:20px}
.card.birthday .orn::before{content:"\\2740"}
.card.birthday .card-paper{background:radial-gradient(circle at 20% 16%,rgba(242,184,198,.4) 0 2px,transparent 3px),radial-gradient(circle at 82% 84%,rgba(246,214,168,.5) 0 2px,transparent 3px),var(--paper);background-size:28px 28px,34px 34px,auto}

.thanks{--c1:#b7c9a8;--c2:#e9e3cf;--c3:#8aa07c;--paper:#fbfcf6;--edge:#c3d2b4;--accent:#5f7a52;--ink:#3e4a37;--font:"Segoe UI",system-ui,sans-serif}
.card.thanks{border-left:7px solid var(--c3);border-radius:12px}
.card.thanks .orn::before{content:"\\2767"}
.card.thanks .card-paper{text-align:left;background:repeating-linear-gradient(135deg,rgba(183,201,168,.16) 0 2px,transparent 2px 12px),var(--paper)}
.card.thanks .kicker{text-align:right}

.congrats{--c1:#2f3444;--c2:#c9a45c;--c3:#8a6a2f;--paper:#fdfaf1;--edge:#c9a45c;--accent:#8a5f1d;--ink:#2b2f3d;--font:"Rockwell","Courier New",serif}
.card.congrats{border-style:double;border-width:5px;border-radius:6px}
.card.congrats .orn::before{content:"\\2726";font-size:18px}
.card.congrats .msg{font-weight:700;letter-spacing:.01em}
.card.congrats .card-paper{background:linear-gradient(0deg,rgba(201,164,92,.1),rgba(201,164,92,.1)),repeating-linear-gradient(90deg,transparent 0 10px,rgba(47,52,68,.05) 10px 11px),var(--paper)}

.wedding{--c1:#e8ddca;--c2:#f7e9e4;--c3:#c7a96f;--paper:#fffdf8;--edge:#dcc9a8;--accent:#9a7b4f;--ink:#4d4236;--font:"Segoe Script","Brush Script MT",cursive}
.card.wedding{border-width:1.5px;border-radius:18px;box-shadow:inset 0 0 0 5px #fff,inset 0 0 0 6px rgba(199,169,111,.5),var(--shadow)}
.card.wedding .orn::before{content:"\\2766"}
.card.wedding .msg{font-size:clamp(22px,3vw,30px)}
.card.wedding .card-paper{background:radial-gradient(120% 120% at 50% 0%,rgba(247,233,228,.9),rgba(255,253,248,0) 70%),var(--paper)}

.newbaby{--c1:#9fc6dc;--c2:#f4e2a1;--c3:#7fa9c4;--paper:#fbfdff;--edge:#a9cde0;--accent:#477c9b;--ink:#3c4c57;--font:"Trebuchet MS","Segoe UI",sans-serif}
.card.newbaby{border-style:dashed;border-radius:24px}
.card.newbaby .orn::before{content:"\\273F"}
.card.newbaby .card-paper{background:radial-gradient(circle at 18% 22%,rgba(244,226,161,.55) 0 3px,transparent 4px),radial-gradient(circle at 78% 78%,rgba(159,198,220,.5) 0 3px,transparent 4px),var(--paper);background-size:40px 40px,46px 46px,auto}

.anniversary{--c1:#9c4f63;--c2:#f0c3c9;--c3:#7a3547;--paper:#fff6f5;--edge:#c98894;--accent:#8c3f52;--ink:#4c2831;--font:Georgia,"Times New Roman",serif}
.card.anniversary{border-radius:16px;border-top:6px solid var(--c3);border-bottom:6px solid var(--c3)}
.card.anniversary .orn::before{content:"\\2765";color:var(--c3)}
.card.anniversary .msg{font-style:italic}
.card.anniversary .card-paper{background:repeating-linear-gradient(45deg,rgba(156,79,99,.07) 0 2px,transparent 2px 14px),var(--paper)}

.getwell{--c1:#a9c9b6;--c2:#f3efc9;--c3:#7fa88d;--paper:#f9fdf9;--edge:#b7d3c1;--accent:#4f7c60;--ink:#3c4a40;--font:"Verdana","Segoe UI",sans-serif}
.card.getwell{border-radius:22px;border-width:2px}
.card.getwell .orn::before{content:"\\273F";color:var(--c3)}
.card.getwell .card-paper{background:radial-gradient(circle at 25% 20%,rgba(243,239,201,.6) 0 3px,transparent 4px),radial-gradient(circle at 75% 80%,rgba(169,201,182,.45) 0 3px,transparent 4px),var(--paper);background-size:44px 44px,50px 50px,auto}

.sympathy{--c1:#9aa3ae;--c2:#e9ebe6;--c3:#77808b;--paper:#f5f4f1;--edge:#b3b8b8;--accent:#5f6873;--ink:#3f4650;--font:"Palatino Linotype","Book Antiqua",serif}
.card.sympathy{border-width:1.5px;border-radius:10px;box-shadow:0 16px 34px -26px rgba(60,70,80,.6)}
.card.sympathy .orn::before{content:"\\2741";opacity:.6}
.card.sympathy .card-paper{background:linear-gradient(180deg,rgba(255,255,255,.7),rgba(233,235,230,.5)),var(--paper)}

.justbecause{--c1:#d98b5f;--c2:#f4c95d;--c3:#b9633a;--paper:#fff8ee;--edge:#d98b5f;--accent:#a94f2a;--ink:#4a3226;--font:"Comic Sans MS","Segoe UI",sans-serif}
.card.justbecause{border-radius:18px;border-width:2.5px;transform:rotate(-.5deg)}
.card.justbecause:hover{transform:rotate(0deg) translateY(-2px)}
.card.justbecause .orn::before{content:"\\2605";color:var(--c2)}
.card.justbecause .msg{transform:rotate(-1deg)}
.card.justbecause .card-paper{background:radial-gradient(circle at 15% 85%,rgba(244,201,93,.35) 0 4px,transparent 5px),radial-gradient(circle at 88% 15%,rgba(217,139,95,.3) 0 4px,transparent 5px),var(--paper)}

.seasonal{--c1:#2f4a3e;--c2:#c9a45c;--c3:#e7c97a;--paper:#22352c;--edge:#c9a45c;--accent:#e7c97a;--ink:#f3ead9;--font:Georgia,"Times New Roman",serif}
.card.seasonal{border-style:double;border-width:4px;border-radius:14px}
.card.seasonal .orn::before{content:"\\2744";color:var(--c3)}
.card.seasonal .card-paper{background:radial-gradient(circle at 18% 18%,rgba(231,201,122,.28) 0 2px,transparent 3px),radial-gradient(circle at 80% 72%,rgba(231,201,122,.22) 0 2px,transparent 3px),var(--paper);background-size:30px 30px,38px 38px,auto}

.card-reject,.card-error{border-color:#d4a6a6;background:#fffaf9}
.card-reject .kicker,.card-error .kicker{color:#a44848}
.card-reject .msg,.card-error .msg{font-family:Georgia,serif;font-size:clamp(19px,2.4vw,24px);color:#7d3b3b}

/* ---------- gallery + recent ---------- */
.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:18px}
.gallery-card{display:flex;flex-direction:column}
.gallery-card .card-paper{min-height:210px}
.gallery-card:hover{transform:translateY(-3px) rotate(-.4deg)}
.gallery-meta{display:flex;flex-wrap:wrap;gap:6px 12px;justify-content:space-between;padding:10px 16px;font-family:"Segoe UI",system-ui,sans-serif;font-size:12px;color:#7b6272;border-top:1px dashed rgba(120,80,90,.18);background:rgba(255,255,255,.5)}
.gallery-meta b{color:var(--accent)}
.recent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.recent-grid .card-paper{min-height:170px;padding:22px}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px}
.chip{display:inline-flex;align-items:center;padding:8px 14px;border:1.5px solid var(--line);border-radius:999px;background:#fff;color:#6b5262;text-decoration:none;font-size:13px;font-weight:700;transition:border-color .16s ease,color .16s ease,background .16s ease}
.chip:hover{border-color:var(--rose);color:var(--plum-deep)}
.chip.is-active{background:var(--plum);border-color:var(--plum);color:#fff}
.empty{color:#8a6f7e;background:#fff;border:1px dashed var(--line);border-radius:14px;padding:20px;text-align:center}

/* ---------- preview ---------- */
.preview-head{margin-bottom:20px}
.preview-layout{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.6fr);gap:26px;align-items:start;margin-bottom:34px}
.preview-stage{perspective:1500px;display:flex;flex-direction:column;gap:16px;align-items:center}
.card-flip{position:relative;width:min(100%,460px);min-height:300px;transform-style:preserve-3d;transition:transform .6s cubic-bezier(.2,.8,.2,1)}
#flip:checked ~ .card-flip{transform:rotateY(180deg)}
.face{backface-visibility:hidden;-webkit-backface-visibility:hidden}
.face-back{position:absolute;inset:0;transform:rotateY(180deg)}
.face .card{height:100%}
.preview-controls{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;width:100%}
.flip-back-label{display:none}
#flip:checked ~ .preview-controls .flip-front-label{display:none}
#flip:checked ~ .preview-controls .flip-back-label{display:inline}
#flip:focus-visible ~ .preview-controls .flip-btn{outline:2px solid var(--plum);outline-offset:2px}
.sent-note{background:#eaf6ee;border:1px solid #bfe3c8;color:#2e5c3d;border-radius:12px;padding:12px 16px;font-size:14px;max-width:460px;text-align:center}
[hidden]{display:none !important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.card-back .kicker{color:var(--accent)}
.back-lines{display:grid;grid-template-columns:auto 1fr;gap:10px 12px;align-items:center;text-align:left;margin:10px 0;font-family:"Segoe UI",system-ui,sans-serif;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#9a8090}
.back-lines i{display:block;border-bottom:1.5px solid rgba(120,80,90,.28);height:18px}
.back-note{font-family:"Segoe UI",system-ui,sans-serif;font-size:11.5px;color:var(--accent);margin:6px 0 0}
.preview-meta{background:#fff;border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:var(--shadow)}
.preview-meta h2{margin:0 0 4px}
.meta-line{margin:0 0 6px;font-size:14px;color:#6b5262}
.meta-price{font-family:Georgia,serif;font-size:28px;color:var(--plum-deep);margin:8px 0}
.meta-note{font-size:12.5px;color:#8a6f7e;margin:12px 0 0;border-top:1px dashed var(--line);padding-top:12px}

/* ---------- orders / pricing / page blocks ---------- */
.orders{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.order{display:grid;grid-template-columns:110px 1fr auto auto;gap:12px;align-items:center;background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 16px;box-shadow:0 12px 26px -26px rgba(80,40,60,.7)}
.order-id{font-family:"Courier New",monospace;font-weight:700;color:var(--plum-deep);font-size:13px}
.order-style{font-size:14px}
.order-style small{display:block;color:#8a6f7e;font-size:12px}
.order-eta{font-size:12.5px;color:#7b6272;white-space:nowrap}
.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}
.pill.on-press{background:#fde8ee;color:#a33e60}
.pill.inking{background:#fdf0dc;color:#8a5a1b}
.pill.cutting{background:#e8f0fb;color:#31598a}
.pill.packing{background:#f0e9fb;color:#5a3b8a}
.pill.posted{background:#e9f6ec;color:#2e6b3f}

.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:26px}
.tier{background:#fff;border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:8px}
.tier.featured{border-color:var(--rose);box-shadow:0 20px 40px -26px rgba(180,80,120,.75)}
.tier h3{margin:0;font-size:20px}
.tier .price{font-family:Georgia,serif;font-size:34px;color:var(--plum-deep);margin:2px 0}
.tier ul{margin:6px 0 0;padding-left:18px;color:#6b5262;font-size:14px}
.tier li{margin:3px 0}
.table-wrap{overflow-x:auto;border-radius:14px;border:1px solid var(--line);background:#fff}
.spec{width:100%;border-collapse:collapse;min-width:460px}
.spec th,.spec td{padding:11px 14px;text-align:left;border-bottom:1px solid var(--line);font-size:14px}
.spec th{background:#faf0f3;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8a6f7e}
.spec tr:last-child td{border-bottom:0}

.notice{max-width:760px;margin:16px auto 50px;background:#fff;border:1px solid var(--line);border-radius:20px;padding:clamp(22px,4vw,40px);box-shadow:var(--shadow)}
.notice-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.faq{display:grid;gap:10px;max-width:820px}
details{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 18px}
summary{cursor:pointer;font-weight:700;color:var(--plum-deep)}
details[open] summary{margin-bottom:8px}
details p{margin:0;color:#6b5262;font-size:15px}
.contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:26px;align-items:start}
.contact-form{background:#fff;border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:var(--shadow)}
.studio-facts{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.studio-facts li{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:14px}
.studio-facts b{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8a6f7e;margin-bottom:3px}
.story{max-width:70ch}
.story h2{margin-top:26px}
.promise{margin:38px 0 10px}
.promise-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.promise-card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px 18px 16px;box-shadow:0 14px 30px -26px rgba(80,40,60,.7)}
.promise-card h3{margin:0 0 6px;font-size:17px}
.promise-card p{margin:0;font-size:14px;color:#6b5262}

/* ---------- footer ---------- */
.site-foot{margin-top:50px;background:#3a2136;color:#e9d3df;padding:30px 0 34px}
.foot-inner{display:grid;gap:10px;text-align:center}
.foot-brand{font-family:Georgia,serif;font-size:18px;color:#fff;margin:0}
.foot-nav{display:flex;gap:14px;flex-wrap:wrap;justify-content:center}
.foot-nav a{color:#e9c9da;text-decoration:none;font-size:13px;font-weight:600}
.foot-nav a:hover{color:#fff}
.foot-note{font-size:12px;opacity:.72;margin:0}

/* ---------- motion + responsive + print ---------- */
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.hero,.maker,.recent,.promise,.gallery-grid,.preview-layout,.orders,.tiers{animation:rise .5s ease both}
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important;scroll-behavior:auto !important}
  .card-flip{transition:none}
}
@media (max-width:820px){
  .hero{grid-template-columns:1fr}
  .hero-art{order:-1;max-width:280px;margin:0 auto}
  .preview-layout{grid-template-columns:1fr}
  .contact-grid{grid-template-columns:1fr}
}
@media (max-width:620px){
  .head-inner{padding:10px 0}
  .brand-text{font-size:18px}
  .site-nav a{padding:7px 9px;font-size:13px}
  main{padding-top:22px}
  .card .msg{font-size:20px}
  .order{grid-template-columns:1fr auto;gap:8px}
  .order-style{grid-column:1 / -1}
  .swatch-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .preview-controls .btn{width:100%}
  .form-actions .btn{width:100%}
}
@media print{
  body{background:#fff}
  .site-head,.studio-bar,.site-foot,.preview-head,.preview-meta,.preview-controls,.sent-note,.skip-link,.filters,.section-head a{display:none !important}
  main{width:100%;padding:0}
  .preview-layout{display:block}
  .preview-stage{perspective:none}
  .card-flip{transform:none !important;width:100%}
  .face-back{display:none !important}
  .face{position:static !important;transform:none !important}
  .card{box-shadow:none}
}
"""

SHELL = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1">'
    '<meta name="theme-color" content="#6d4466">'
    "<title>{{ title }} — Postcard</title>"
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">'
    "<style>{{ css|safe }}</style></head><body>"
    '<a class="skip-link" href="#main">Skip to content</a>'
    '<header class="site-head"><div class="wrap head-inner">'
    '<a class="brand" href="/" aria-label="Postcard home">'
    '<span class="brand-mark" aria-hidden="true">'
    '<svg viewBox="0 0 40 40" width="32" height="32">'
    '<rect x="3" y="6" width="34" height="28" rx="4" fill="#fbf4ef"/>'
    '<path d="M5 10l15 11 15-11" fill="none" stroke="#e7a6b8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
    '<path d="M5 30l11-9M35 30l-11-9" fill="none" stroke="#e7a6b8" stroke-width="2" stroke-linecap="round"/>'
    '</svg></span>'
    '<span class="brand-text">Postcard<small>handmade card studio</small></span></a>'
    '<nav class="site-nav" aria-label="Primary">'
    '<a href="/" {% if active == "home" %}class="is-active"{% endif %}>Make a card</a>'
    '<a href="/gallery" {% if active == "gallery" %}class="is-active"{% endif %}>Gallery</a>'
    '<a href="/orders" {% if active == "orders" %}class="is-active"{% endif %}>Orders</a>'
    '<a href="/pricing" {% if active == "pricing" %}class="is-active"{% endif %}>Pricing</a>'
    '<a href="/about" {% if active == "about" %}class="is-active"{% endif %}>About</a>'
    '<a href="/faq" {% if active == "faq" %}class="is-active"{% endif %}>FAQ</a>'
    '<a href="/contact" {% if active == "contact" %}class="is-active"{% endif %}>Contact</a>'
    '</nav></div></header>'
    '<div class="studio-bar"><div class="wrap">'
    '<span class="status"><span class="dot" aria-hidden="true"></span>Studio open</span>'
    '<span class="bar-sep" aria-hidden="true">&#183;</span><span>press queue: 3 cards ahead</span>'
    '<span class="bar-sep" aria-hidden="true">&#183;</span><span>order by 2 pm for same-day</span>'
    '</div></div>'
    '<main id="main" class="wrap">{{ inner|safe }}</main>'
    '<footer class="site-foot"><div class="wrap foot-inner">'
    '<p class="foot-brand">Postcard — printed by hand, posted with care.</p>'
    '<nav class="foot-nav" aria-label="Footer">'
    '<a href="/shipping">Shipping &amp; print</a><a href="/pricing">Pricing</a>'
    '<a href="/faq">FAQ</a><a href="/contact">Contact</a>'
    '</nav>'
    '<p class="foot-note">Studio hours Mon-Sat, 9-5. This is a demo studio; no real orders are taken.</p>'
    '</div></footer></body></html>'
)

FAVICON = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    '<rect width="64" height="64" rx="14" fill="#6d4466"/>'
    '<rect x="13" y="17" width="38" height="30" rx="4" fill="#fbf4ef"/>'
    '<path d="M16 22l16 12 16-12" fill="none" stroke="#e7a6b8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
    '<path d="M16 44l12-10M48 44l-12-10" fill="none" stroke="#e7a6b8" stroke-width="2.5" stroke-linecap="round"/>'
    '<circle cx="48" cy="18" r="5" fill="#c9a45c"/>'
    "</svg>"
)

HERO_ART = (
    '<svg viewBox="0 0 360 300" role="img" aria-label="A stack of handmade cards">'
    '<defs><linearGradient id="heroGrad" x1="0" y1="0" x2="1" y2="1">'
    '<stop offset="0" stop-color="#fbe3ea"/><stop offset="1" stop-color="#f6d6a8"/>'
    "</linearGradient></defs>"
    '<g transform="rotate(-8 180 150)"><rect x="55" y="55" width="250" height="170" rx="16" fill="#efe1d6"/></g>'
    '<g transform="rotate(5 180 150)"><rect x="55" y="55" width="250" height="170" rx="16" fill="url(#heroGrad)" stroke="#e7a6b8" stroke-width="2"/></g>'
    '<g transform="rotate(-2 180 150)"><rect x="55" y="55" width="250" height="170" rx="16" fill="#fffaf6" stroke="#e7a6b8" stroke-width="2"/>'
    '<circle cx="285" cy="90" r="12" fill="#e7a6b8"/><circle cx="285" cy="90" r="5" fill="#fff"/>'
    '<path d="M90 110h120M90 136h150M90 162h100" stroke="#d7a8b8" stroke-width="6" stroke-linecap="round"/>'
    '<path d="M228 186c10-18 30-18 36 0" fill="none" stroke="#c9a45c" stroke-width="3" stroke-linecap="round"/>'
    "</g></svg>"
)


def swatch(card, checked):
    style = esc(card["style"])
    occ = occ_for(card["style"])
    mark = " checked" if checked else ""
    return (
        '<label class="swatch-card">'
        f'<input type="radio" name="style" value="{style}"{mark}>'
        f'<span class="swatch {occ}">'
        '<span class="swatch-dots" aria-hidden="true"><i></i><i></i><i></i></span>'
        f'<span class="swatch-name">{style}</span>'
        f'<span class="swatch-meta">{esc(card.get("font", ""))}</span>'
        f'<span class="swatch-meta">{esc(card.get("price", ""))}</span>'
        "</span></label>"
    )


def gallery_card(card):
    occ = occ_for(card["style"])
    return (
        f'<article class="card gallery-card {occ}">'
        '<div class="card-paper">'
        '<span class="orn orn-tl" aria-hidden="true"></span>'
        '<span class="orn orn-tr" aria-hidden="true"></span>'
        '<span class="orn orn-bl" aria-hidden="true"></span>'
        '<span class="orn orn-br" aria-hidden="true"></span>'
        f'<p class="kicker">{esc(card["style"])}</p>'
        f'<p class="msg">{esc(card.get("sample", ""))}</p>'
        '<p class="sign">with love, Postcard</p>'
        "</div>"
        f'<div class="gallery-meta"><span>{esc(card.get("font", ""))}</span>'
        f'<span><b>{esc(card.get("price", ""))}</b></span>'
        f'<span>{esc(card.get("delivery", ""))}</span></div>'
        "</article>"
    )


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/favicon.svg")
def favicon():
    return Response(FAVICON, mimetype="image/svg+xml")


@app.get("/")
def index():
    requested = request.args.get("style", "")
    preselect = requested if requested in STYLE_INFO else DEFAULT_STYLE
    swatches = "".join(swatch(card, card["style"] == preselect) for card in CARDS)
    recent = "".join(gallery_card(card) for card in CARDS[:3])
    inner = (
        '<section class="hero"><div class="hero-copy">'
        '<p class="eyebrow">A tiny studio with a very big press</p>'
        "<h1>Cards worth keeping.</h1>"
        '<p class="lede">Hand-set type, cotton card stock, and a little extra flourish. '
        "Write something true and we will print it beautifully.</p>"
        '<p class="hero-meta">Free proof &#183; carbon-neutral delivery &#183; printed in batches of one</p>'
        "</div>"
        '<div class="hero-art" aria-hidden="true">' + HERO_ART + "</div></section>"
        '<section class="maker" id="make"><h2>Make a card</h2>'
        '<form method="post" action="/preview">'
        '<fieldset class="swatch-field"><legend>Choose a style</legend>'
        f'<div class="swatch-grid">{swatches}</div></fieldset>'
        '<label class="field"><span>Your message</span>'
        '<textarea name="message" rows="4" maxlength="800" '
        'placeholder="Write the thing you keep meaning to say..."></textarea></label>'
        '<div class="form-actions"><button class="btn" type="submit">Preview this card</button>'
        '<span class="form-hint">Free proof. No account, no fuss.</span></div>'
        "</form></section>"
        '<section class="recent"><div class="section-head"><h2>Fresh off the press</h2>'
        '<a href="/gallery">See the whole gallery</a></div>'
        f'<div class="recent-grid">{recent}</div></section>'
        '<section class="promise"><h2>Why Postcard</h2><div class="promise-grid">'
        '<div class="promise-card"><h3>Printed, not pixels</h3>'
        "<p>300gsm cotton stock, letterpress-soft edges, real ink.</p></div>"
        '<div class="promise-card"><h3>Written by you</h3>'
        "<p>Every word set by hand. Nothing you have seen a hundred times.</p></div>"
        '<div class="promise-card"><h3>Posted with care</h3>'
        "<p>Recycled envelope, wax seal, dispatched within a day.</p></div>"
        "</div></section>"
    )
    return shell("Make a card", inner, "home")


@app.post("/preview")
def preview():
    posted = request.form.get("style", DEFAULT_STYLE)
    style = posted if posted in STYLE_INFO else DEFAULT_STYLE
    message = request.form.get("message", "")
    occ = occ_for(style)
    info = STYLE_INFO[style]

    # Inquisitor and Divine save the message for the print stage; Inquisitor renders nothing here at all. Divine keeps
    # the safe bound preview below and lets the print stage print the same message as data.
    draft_id = draft_save(style, message) if LEVEL in ("inquisitor", "divine") else None

    if LEVEL == "inquisitor":
        inner = (
            '<section class="notice" data-draft="%s">'
            '<p class="eyebrow">Print stage</p>'
            "<h1>Draft saved for printing.</h1>"
            "<p>Your message is set aside for the press. Nothing is proofed here; the card is "
            "rendered when it reaches the print stage.</p>"
            '<p class="page-note">Style: <b>%s</b> &#183; %s &#183; %s</p>'
            '<div class="notice-actions"><a class="btn" href="/orders/%s/print">Print this card</a>'
            '<a class="btn ghost" href="/?style=%s">Edit message</a></div></section>'
        ) % (
            esc(draft_id), esc(style), esc(info.get("font", "")), esc(info.get("price", "")),
            quote(draft_id), quote(style),
        )
        return shell("Draft saved", inner, "orders")

    card = render_card(LEVEL, occ, message)
    draft_note = ""
    if LEVEL == "divine":
        draft_note = (
            '<p class="meta-note" data-draft="%s">Saved for the print stage: '
            '<a href="/orders/%s/print">print this card</a>.</p>'
        ) % (esc(draft_id), quote(draft_id))
    inner = (
        '<div class="preview-head"><h1 class="page-title">Your card</h1>'
        f'<p class="page-lede">A proof for a <b>{esc(style)}</b> card in {esc(info.get("palette", ""))}. '
        "Flip it to check the back, then send it when it feels right.</p></div>"
        '<div class="preview-layout"><section class="preview-stage">'
        '<input type="checkbox" id="flip" class="sr-only">'
        '<div class="card-flip"><div class="face face-front">' + card + "</div>"
        f'<div class="face face-back"><article class="card {occ} card-back"><div class="card-paper">'
        '<p class="kicker">The back</p>'
        '<div class="back-lines"><span>To</span><i></i><i></i><span>From</span><i></i><i></i></div>'
        '<p class="sign">Postcard studio</p>'
        f'<p class="back-note">300gsm cotton &#183; {esc(info.get("font", ""))} &#183; '
        f'{esc(info.get("palette", ""))}</p>'
        "</div></article></div></div>"
        '<div class="preview-controls">'
        '<label for="flip" class="btn ghost flip-btn">'
        '<span class="flip-front-label">Show the back</span>'
        '<span class="flip-back-label">Show the front</span></label>'
        '<button type="button" class="btn" id="send-card">Send this card</button>'
        f'<a class="btn plain" href="/?style={quote(style)}">Edit message</a>'
        "</div>"
        '<p class="sent-note" id="sent-note" hidden>Simulated: your card is queued for the press. '
        "Nothing is saved in this demo.</p>"
        "</section>"
        '<aside class="preview-meta"><p class="eyebrow">Chosen style</p>'
        f"<h2>{esc(style)}</h2>"
        f'<p class="meta-line">{esc(info.get("font", ""))}</p>'
        f'<p class="meta-line">Palette: {esc(info.get("palette", ""))}</p>'
        f'<p class="meta-price">{esc(info.get("price", ""))}</p>'
        f'<p class="meta-line">{esc(info.get("delivery", ""))}</p>'
        '<p class="meta-note">Proof shown on 300gsm cotton stock. The real card arrives with a '
        "matching envelope and a wax seal.</p>" + draft_note + "</aside></div>"
        '<script>(function(){var b=document.getElementById("send-card"),'
        'n=document.getElementById("sent-note");if(b&&n){b.addEventListener("click",function(){'
        'n.hidden=false;b.textContent="Queued for the press";b.disabled=true;});}})();</script>'
    )
    return shell("Your card", inner, "home")


@app.get("/orders/<draft_id>/print")
def print_draft(draft_id):
    draft = draft_get(draft_id)
    if draft is None:
        abort(404)
    style = draft["style"]
    if style not in STYLE_INFO:
        style = DEFAULT_STYLE
    occ = occ_for(style)
    info = STYLE_INFO[style]
    # The print stage is the designed second-order sink: at Inquisitor the saved message becomes template source, at
    # Divine it is passed as a bound, autoescaped value. Lower levels never save a draft, so this route 404s for them.
    card = render_card(LEVEL, occ, draft["message"])
    inner = (
        '<div class="preview-head"><p class="eyebrow">Print stage</p>'
        '<h1 class="page-title">Print proof</h1>'
        f'<p class="page-lede">Draft <b>{esc(draft_id)}</b>, a <b>{esc(style)}</b> card, ready for the press.</p></div>'
        '<div class="preview-layout"><section class="preview-stage">'
        '<div class="card-flip"><div class="face face-front">' + card + "</div></div>"
        '<div class="preview-controls">'
        '<button type="button" class="btn" onclick="window.print()">Print this card</button>'
        '<a class="btn ghost" href="/">Make another card</a>'
        "</div></section>"
        '<aside class="preview-meta"><p class="eyebrow">Saved style</p>'
        f'<h2>{esc(style)}</h2>'
        f'<p class="meta-line">{esc(info.get("font", ""))}</p>'
        f'<p class="meta-line">Palette: {esc(info.get("palette", ""))}</p>'
        f'<p class="meta-price">{esc(info.get("price", ""))}</p>'
        f'<p class="meta-line">{esc(info.get("delivery", ""))}</p>'
        '<p class="meta-note">This is the print proof. Your saved message is set at the press, '
        "not before it.</p></aside></div>"
    )
    return shell("Print proof", inner, "orders")


@app.get("/gallery")
def gallery():
    requested = request.args.get("occasion", "")
    active = requested if any(occ == requested for occ, _ in OCCASIONS) else ""
    filtered = [c for c in CARDS if not active or occ_for(c["style"]) == active]
    chips = '<a class="chip%s" href="/gallery">All</a>' % (" is-active" if not active else "")
    for occ, label in OCCASIONS:
        cls = "chip is-active" if occ == active else "chip"
        chips += '<a class="%s" href="/gallery?occasion=%s">%s</a>' % (cls, quote(occ), esc(label))
    cards = "".join(gallery_card(c) for c in filtered)
    if not cards:
        cards = '<p class="empty">No cards in this occasion yet.</p>'
    inner = (
        '<h1 class="page-title">The gallery</h1>'
        '<p class="page-lede">Every card starts blank. These are the studio samples, one for each '
        "occasion we print most. Pick one on the home page to make it your own.</p>"
        '<nav class="filters" aria-label="Filter by occasion">' + chips + "</nav>"
        '<div class="gallery-grid">' + cards + "</div>"
    )
    return shell("Gallery", inner, "gallery")


ORDERS = [
    ("PC-1057", "Birthday", "rose & marigold", "On the press", "ready 14:20", "on-press"),
    ("PC-1056", "Congratulations", "ink & brass", "Inking", "ready 14:05", "inking"),
    ("PC-1055", "Wedding", "ivory & pearl", "Cutting", "ready 13:40", "cutting"),
    ("PC-1054", "Thank you", "sage & cream", "Folding", "ready 13:15", "packing"),
    ("PC-1053", "New baby", "sky & butter", "Packed", "at the postbox 12:50", "posted"),
    ("PC-1052", "Just because", "terracotta & sun", "Posted", "delivered 11:30", "posted"),
    ("PC-1051", "Anniversary", "wine & blush", "Posted", "delivered 10:05", "posted"),
]


@app.get("/orders")
def orders():
    items = "".join(
        '<li class="order"><span class="order-id">%s</span>'
        '<span class="order-style">%s<small>%s</small></span>'
        '<span class="pill %s">%s</span><span class="order-eta">%s</span></li>'
        % (esc(oid), esc(style), esc(palette), esc(pill), esc(status), esc(eta))
        for oid, style, palette, status, eta, pill in ORDERS
    )
    inner = (
        '<h1 class="page-title">The print queue</h1>'
        '<p class="page-lede">Every card is printed in the order it arrives. Three cards are ahead '
        "of yours today; this is the view from the studio floor.</p>"
        f'<ol class="orders">{items}</ol>'
        '<p class="page-note">Queue times are approximate. Same-day orders placed after 2 pm print '
        "the next morning.</p>"
    )
    return shell("Orders", inner, "orders")


PRICING_TIERS = [
    ("Single card", "$6.50", "One card, one envelope, one wax seal.", False),
    ("Set of five", "$28.00", "Five cards from any occasion, posted together.", True),
    ("Studio box", "$52.00", "Twelve assorted cards in a keepsake box.", False),
]

PRICING_FEATURES = {
    "Single card": ["One 300gsm cotton card", "Matching recycled envelope", "Wax seal and hand-written address"],
    "Set of five": ["Five cards, mix any occasions", "Five envelopes and seals", "Free same-day proof", "Posted in one parcel"],
    "Studio box": ["Twelve assorted cards", "Keepsake box and ribbon", "Twelve envelopes", "Priority printing"],
}


@app.get("/pricing")
def pricing():
    tiers = ""
    for name, price, blurb, featured in PRICING_TIERS:
        feats = "".join("<li>%s</li>" % esc(f) for f in PRICING_FEATURES[name])
        tiers += (
            '<div class="tier%s"><h3>%s</h3><p class="price">%s</p><p>%s</p><ul>%s</ul></div>'
            % (" featured" if featured else "", esc(name), esc(price), esc(blurb), feats)
        )
    rows = "".join(
        "<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (esc(a), esc(b), esc(c))
        for a, b, c in [
            ("Card stock", "300gsm cotton", "Soft, thick, takes ink beautifully"),
            ("Printing", "Hand-fed letterpress", "Deep impression, slightly irregular edges"),
            ("Envelope", "Recycled kraft", "Matching wax seal"),
            ("Turnaround", "Same-day or 1-3 days", "Order by 2 pm for same-day"),
        ]
    )
    inner = (
        '<h1 class="page-title">Pricing</h1>'
        '<p class="page-lede">Honest prices, printed to order. Every proof is free and every card '
        "is made in a batch of one.</p>"
        f'<div class="tiers">{tiers}</div>'
        '<h2>What you get</h2>'
        '<div class="table-wrap"><table class="spec"><thead><tr><th>Detail</th><th>Standard</th>'
        "<th>Notes</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
        '<p class="page-note">Prices include a free digital proof. Postage is calculated at checkout; '
        "this demo does not take payment.</p>"
    )
    return shell("Pricing", inner, "pricing")


@app.get("/about")
def about():
    inner = (
        '<h1 class="page-title">A small studio, a slow press</h1>'
        '<p class="page-lede">Postcard is a two-room studio above a bakery: one room for the press, '
        "one for the kettle.</p>"
        '<div class="story">'
        "<h2>How we work</h2>"
        "<p>We set cards one at a time, by hand. The type is metal, the paper is cotton, and the "
        "press is older than everyone who works here. Nothing is auto-generated; if a card looks "
        "like it took an afternoon, it did.</p>"
        "<h2>What we believe</h2>"
        "<p>A card should feel like an object, not a notification. It should have weight, a rough "
        "edge, a little ink where the type pressed too hard. It should be worth keeping in a drawer.</p>"
        "<h2>The press</h2>"
        "<p>The studio's press is a 1962 letterpress we rebuilt ourselves. It has a queue, a habit "
        "of eating the first sheet of every run, and a name nobody can agree on. It prints every "
        "order that comes through the door.</p>"
        "<h2>Visiting</h2>"
        "<p>We are open Monday to Saturday, 9 to 5. Come for a proof, stay for the smell of ink and "
        "the bakery downstairs.</p>"
        "</div>"
        '<p class="page-note">Want to talk? <a href="/contact">Write to the studio</a> or read the '
        '<a href="/faq">FAQ</a>.</p>'
    )
    return shell("About", inner, "about")


FAQ_ITEMS = [
    ("How long does a card take?",
     "Same-day orders placed before 2 pm print that afternoon. Everything else ships in one to three days."),
    ("Can I write anything on the card?",
     "Almost anything. Messages up to 800 characters are set exactly as you write them, then proofed and printed."),
    ("Is the card really handmade?",
     "Every card is fed through the press by hand, one sheet at a time. The type is set in the studio."),
    ("What paper do you use?",
     "300gsm cotton stock with a soft, slightly irregular deckle edge. It takes ink and pencil beautifully."),
    ("Can I order more than one?",
     "Yes. Sets of five and studio boxes are on the pricing page, and you can mix occasions in a set."),
    ("Do you post outside the country?",
     "Not yet. The studio ships domestically; international post is on the list for next year."),
]


@app.get("/faq")
def faq():
    items = "".join(
        "<details><summary>%s</summary><p>%s</p></details>" % (esc(q), esc(a))
        for q, a in FAQ_ITEMS
    )
    inner = (
        '<h1 class="page-title">Questions, answered</h1>'
        '<p class="page-lede">The things people ask the studio most often. If yours is not here, '
        '<a href="/contact">send a note</a>.</p>'
        f'<div class="faq">{items}</div>'
    )
    return shell("FAQ", inner, "faq")


@app.get("/shipping")
def shipping():
    inner = (
        '<h1 class="page-title">Shipping &amp; print</h1>'
        '<p class="page-lede">What happens between pressing Send and the card landing on a mat.</p>'
        '<div class="story">'
        "<h2>Printing</h2>"
        "<p>Cards are letterpress printed on 300gsm cotton stock. The impression is deep enough to "
        "feel with a fingertip, and the deckle edge is cut by hand.</p>"
        "<h2>Same-day</h2>"
        "<p>Order by 2 pm and your card is printed and packed the same afternoon. The studio keeps "
        "three cards in the queue ahead of new orders, so a same-day card usually leaves by 4 pm.</p>"
        "<h2>Standard shipping</h2>"
        "<p>Standard orders ship in one to three days in a recycled kraft envelope with a wax seal. "
        "Delivery is usually two to four working days after dispatch.</p>"
        "<h2>Packaging</h2>"
        "<p>No plastic. The card is wrapped in tissue, sealed with wax, and posted in a rigid "
        "recycled envelope so the corners arrive sharp.</p>"
        "</div>"
        '<p class="page-note">A demo studio cannot post a real card, but the print queue on the '
        '<a href="/orders">orders page</a> shows how one would travel.</p>'
    )
    return shell("Shipping", inner, "shipping")


@app.get("/contact")
def contact():
    facts = "".join(
        '<li><b>%s</b>%s</li>' % (esc(k), esc(v))
        for k, v in [
            ("Studio", "12 Press Lane, above the bakery"),
            ("Hours", "Monday to Saturday, 9-5"),
            ("Email", "studio@postcard.example"),
            ("Phone", "555-0142"),
        ]
    )
    inner = (
        '<h1 class="page-title">Write to the studio</h1>'
        '<p class="page-lede">Questions about a card, a set, or the press itself? A real person '
        "reads every note.</p>"
        '<div class="contact-grid"><div>'
        f'<ul class="studio-facts">{facts}</ul>'
        '<p class="page-note">We reply within one working day.</p>'
        "</div>"
        '<form class="contact-form" method="post" action="/contact">'
        '<label class="field"><span>Your name</span>'
        '<input name="name" maxlength="80" autocomplete="name"></label>'
        '<label class="field"><span>Email</span>'
        '<input name="email" type="email" maxlength="120" autocomplete="email"></label>'
        '<label class="field"><span>Message</span>'
        '<textarea name="note" rows="4" maxlength="800"></textarea></label>'
        '<button class="btn" type="submit">Send note</button>'
        "</form></div>"
    )
    return shell("Contact", inner, "contact")


@app.post("/contact")
def contact_sent():
    name = request.form.get("name", "").strip()[:80]
    email = request.form.get("email", "").strip()[:120]
    note = request.form.get("note", "").strip()[:800]
    lines = ["<p>A real person will read this and reply within one working day.</p>"]
    if name:
        lines.append("<p>Thanks for writing, %s.</p>" % esc(name))
    if email:
        lines.append('<p class="page-note">We will reply to %s.</p>' % esc(email))
    if note:
        lines.append('<p class="page-note">Your note: &ldquo;%s&rdquo;</p>' % esc(note))
    inner = (
        '<section class="notice"><p class="eyebrow">Note received</p>'
        "<h1>Thank you.</h1>" + "".join(lines) +
        '<div class="notice-actions"><a class="btn" href="/">Make a card</a>'
        '<a class="btn ghost" href="/contact">Back to contact</a></div></section>'
    )
    return shell("Message received", inner, "contact")


@app.errorhandler(404)
def not_found(_error):
    inner = (
        '<section class="notice"><p class="eyebrow">404</p>'
        "<h1>That card slipped behind the press.</h1>"
        '<p>The page you asked for is not here. Try the gallery, or start a fresh card.</p>'
        '<div class="notice-actions"><a class="btn" href="/">Make a card</a>'
        '<a class="btn ghost" href="/gallery">Browse the gallery</a></div></section>'
    )
    return shell("Not found", inner), 404


@app.errorhandler(405)
def method_not_allowed(_error):
    inner = (
        '<section class="notice"><p class="eyebrow">405</p>'
        "<h1>The press does not work that way.</h1>"
        '<p>That page does not take this kind of request. Head back to the studio and try again.</p>'
        '<div class="notice-actions"><a class="btn" href="/">Back to the studio</a></div></section>'
    )
    return shell("Wrong request", inner), 405


@app.errorhandler(413)
def payload_too_large(_error):
    inner = (
        '<section class="notice"><p class="eyebrow">413</p>'
        "<h1>That card is too heavy for the press.</h1>"
        "<p>The message or note you sent is over the studio's 64 KiB limit. "
        "Shorten it and try again.</p>"
        '<div class="notice-actions"><a class="btn" href="/">Make a card</a>'
        '<a class="btn ghost" href="/contact">Back to contact</a></div></section>'
    )
    return shell("Too large", inner), 413


@app.errorhandler(500)
def server_error(_error):
    inner = (
        '<section class="notice"><p class="eyebrow">500</p>'
        "<h1>The press jammed.</h1>"
        '<p>Something went wrong on our side. A studio hand has been notified; please try again.</p>'
        '<div class="notice-actions"><a class="btn" href="/">Back to the studio</a></div></section>'
    )
    return shell("Press jam", inner), 500


if __name__ == "__main__":
    print(f"postcard on :{PORT} ({LEVEL})")
    app.run(host="0.0.0.0", port=PORT, threaded=True, debug=False)
