# labs/r04-postcard/app/templating.py — Postcard's card renderer, per level. The flaw is that at acolyte/templar the
# operator's message becomes Jinja2 TEMPLATE SOURCE; at divine it is a bound value. Real Jinja2 is used deliberately
# (spec §2: real execution inside the isolated container).
import re
from flask import render_template_string

# Templar's naive blacklist: refuse the obvious gadget words and double underscores in the raw message.
_BLOCKED = re.compile(r"__|os|popen|import|subprocess|eval|exec", re.IGNORECASE)

_CARD = (
    '<div class="card {cls}">'
    '<div class="flourish">&#10047;</div>'
    '<p class="msg">{body}</p>'
    '<div class="sign">— with love from Postcard</div>'
    "</div>"
)

def render_card(level: str, style_class: str, message: str) -> str:
    if level == "divine":
        # The message is a bound value, never template source: Jinja autoescapes it as data.
        card = _CARD.format(cls=style_class, body="{{ message }}")
        return render_template_string(card, message=message)
    if level == "templar" and _BLOCKED.search(message or ""):
        return '<div class="card"><p class="msg">That message was rejected by the print filter.</p></div>'
    # acolyte and templar: the message is concatenated into the template string, so Jinja parses it.
    card = _CARD.format(cls=style_class, body=message)
    try:
        return render_template_string(card)
    except Exception:
        return '<div class="card"><p class="msg">The press could not print that card.</p></div>'
