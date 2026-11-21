# labs/r04-postcard/app/app.py — Postcard. Start hook: read the one-shot flag file (HVWA_FLAG_FILE) once and unlink it,
# then write it (or a Divine decoy) to /tmp/postcard/flag.txt (spec §6). POST /preview renders the operator's message per
# level (templating.render_card). No page renders the flag file. Serves on 0.0.0.0:$HVWA_PORT with Flask's threaded
# server (debug OFF — debug would be its own vulnerability).
import json
import os
import pathlib
import sys
import time
from flask import Flask, request, render_template_string
from markupsafe import escape
from templating import render_card

LEVELS = ("acolyte", "templar", "divine")
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
flag_dir = pathlib.Path("/tmp/postcard")
flag_dir.mkdir(parents=True, exist_ok=True)
_body = (_flag if (_flag and LEVEL != "divine")
         else "Divine is the secure reference: your message is printed as data, so there is nothing to inject.")
flag_path = flag_dir / "flag.txt"
flag_path.write_text(_body + "\n")
flag_path.chmod(0o444)

CARDS = json.loads((HERE / "seed" / "cards.json").read_text())
STYLE_CLASS = {"Birthday": "birthday", "Thank you": "thanks", "Congratulations": "congrats"}

app = Flask(__name__)

CSS = """
:root{--rose:#e7a6b8;--plum:#6d4466;--cream:#fbf4ef;--ink:#4a3340;--line:#efd9df}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 "Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--cream)}
header{background:var(--plum);color:#fff;padding:18px 24px}header h1{margin:0;font-size:20px}
main{max-width:720px;margin:26px auto;padding:0 16px}nav a{color:var(--plum);font-weight:600;text-decoration:none;margin-right:16px}
form{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
select,textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font:inherit;margin:6px 0}
button{background:var(--rose);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer}
.card{background:#fff;border:2px solid var(--rose);border-radius:16px;padding:28px;margin:18px 0;text-align:center}
.card .flourish{color:var(--rose);font-size:28px}.card .msg{font-size:20px;margin:14px 0}.card .sign{color:var(--plum);font-style:italic}
footer{color:#a98ea0;font-size:12px;text-align:center;margin:40px 0 20px}
"""

SHELL = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1">'
    "<title>{{ title }} — Postcard</title><style>{{ css }}</style></head><body>"
    '<header><h1>Postcard</h1></header><main>'
    '<nav><a href="/">Make a card</a><a href="/gallery">Gallery</a></nav>{{ inner|safe }}'
    "<footer>Postcard • Handmade cards, printed to order</footer></main></body></html>"
)

def shell(title, inner):
    # The chrome is a CONSTANT template; only `inner` (built per route) is marked safe. User text reaches Jinja only
    # through render_card (the intentional flaw) — never through this shell.
    return render_template_string(SHELL, title=title, css=CSS, inner=inner)

@app.get("/healthz")
def healthz():
    return {"status": "ok"}

@app.get("/")
def index():
    options = "".join(f'<option value="{escape(c["style"])}">{escape(c["style"])}</option>' for c in CARDS)
    inner = (
        "<h2>Make a card</h2>"
        '<form method="post" action="/preview">'
        f"<label>Style<select name=\"style\">{options}</select></label>"
        '<label>Message<textarea name="message" rows="3" placeholder="Write your message"></textarea></label>'
        "<button>Preview</button></form>"
    )
    return shell("Make a card", inner)

@app.post("/preview")
def preview():
    style = request.form.get("style", "Birthday")
    message = request.form.get("message", "")
    card = render_card(LEVEL, STYLE_CLASS.get(style, "birthday"), message)
    return shell("Your card", f"<h2>Your card</h2>{card}")

@app.get("/gallery")
def gallery():
    cards = "".join(f'<div class="card {STYLE_CLASS.get(c["style"],"birthday")}"><div class="flourish">&#10047;</div>'
                    f'<p class="msg">{escape(c["sample"])}</p><div class="sign">— Postcard</div></div>' for c in CARDS)
    return shell("Gallery", f"<h2>Gallery</h2>{cards}")

if __name__ == "__main__":
    print(f"postcard on :{PORT} ({LEVEL})")
    app.run(host="0.0.0.0", port=PORT, threaded=True, debug=False)
