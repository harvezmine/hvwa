# labs/r04-postcard/app/templating.py — Postcard's card renderer, per level. The flaw is that at acolyte/templar the
# operator's message becomes Jinja2 TEMPLATE SOURCE; at divine it is a bound value. Real Jinja2 is used deliberately
# (spec §2: real execution inside the isolated container).
import re
from flask import render_template_string

# Templar's naive blacklist: refuse the obvious gadget words and double underscores in the raw message.
_BLOCKED = re.compile(r"__|os|popen|import|subprocess|eval|exec", re.IGNORECASE)

# The card shell only carries classes and empty ornament hooks here; all colour, border and typography live in the app's
# CSS. Keep this string free of literal braces other than the two format fields below (`.format` would treat them as
# fields, and at Divine `{body}` is the constant `{{ message }}`).
_CARD = (
    '<article class="card {cls}">'
    '<div class="card-paper">'
    '<span class="orn orn-tl" aria-hidden="true"></span>'
    '<span class="orn orn-tr" aria-hidden="true"></span>'
    '<span class="orn orn-bl" aria-hidden="true"></span>'
    '<span class="orn orn-br" aria-hidden="true"></span>'
    '<p class="kicker">Postcard studio</p>'
    '<p class="msg">{body}</p>'
    '<p class="sign">with love, Postcard</p>'
    "</div>"
    "</article>"
)

_REJECTED = (
    '<article class="card card-reject">'
    '<div class="card-paper">'
    '<p class="kicker">Press note</p>'
    '<p class="msg">That message was rejected by the print filter.</p>'
    '<p class="sign">Nothing was printed.</p>'
    "</div>"
    "</article>"
)

_PRESS_JAM = (
    '<article class="card card-error">'
    '<div class="card-paper">'
    '<p class="kicker">Press note</p>'
    '<p class="msg">The press could not print that card.</p>'
    '<p class="sign">Please adjust the message and try again.</p>'
    "</div>"
    "</article>"
)


def render_card(level: str, style_class: str, message: str) -> str:
    if level == "divine":
        # The message is a bound value, never template source: Jinja autoescapes it as data.
        card = _CARD.format(cls=style_class, body="{{ message }}")
        return render_template_string(card, message=message)
    if level == "templar" and _BLOCKED.search(message or ""):
        return _REJECTED
    # acolyte and templar: the message is concatenated into the template string, so Jinja parses it.
    card = _CARD.format(cls=style_class, body=message)
    try:
        return render_template_string(card)
    except Exception:
        return _PRESS_JAM
