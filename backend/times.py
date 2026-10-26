"""Deterministic datetime candidates from a query. The model picks; we never guess."""
import re
from whenever import ZonedDateTime, OffsetDateTime

TZ = "Europe/Oslo"
_REL = re.compile(r"\b(?:om|in)\s+(\d{1,2})\s*(timer?|hours?|t|h|minutter?|minutes?|min|m)\b", re.I)
_CLOCK = re.compile(r"\b(?:kl\.?|klokka|klokken|at|innen|by|før|before|etter|after)?\s*(\d{1,2})(?:[:.](\d{2}))?\b")
_HOUR_WORDS = {"ett": 1, "en": 1, "to": 2, "tre": 3, "fire": 4, "fem": 5, "seks": 6, "sju": 7, "syv": 7,
               "åtte": 8, "ni": 9, "ti": 10, "elleve": 11, "tolv": 12}
# Limitation: number words only after kl/klokka ("vi er to" is not a time); "halv tre" (02:30) not handled
_CLOCK_WORD = re.compile(rf"\b(kl\.?|klokka|klokken)\s+({'|'.join(_HOUR_WORDS)})\b", re.I)
_TOMORROW = re.compile(r"\b(i morgen|imorgen|tomorrow)\b", re.I)

# (pattern, hour). Order matters only for dict insertion; "i morgen" is a day shift, never a day-part.
_PARTS = [
    (re.compile(r"\b(?:tidlig|morgenen|morgens|early)\b|(?<!late )\bmorning\b", re.I), 8),
    (re.compile(r"\b(?:formiddag|formiddagen|noon)\b|\blate morning\b", re.I), 12),
    (re.compile(r"\b(?:ettermiddag|ettermiddagen|afternoon)\b", re.I), 16),
    (re.compile(r"\b(?:kveld|kvelden|evening|tonight)\b", re.I), 20),
    (re.compile(r"\b(?:midnatt|midnight)\b", re.I), 0),
]

_NIGHT = re.compile(r"\b(?:natta|natten|natt|night|overnight)\b", re.I)
_DAYS = ["i dag", "i morgen", "overmorgen"]

_WEEKDAYS = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"]
_EN = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_WEEKDAY = re.compile(rf"\b({'|'.join(_WEEKDAYS + _EN)})\b", re.I)
_NEXT_WEEK = re.compile(r"\b(neste uke|next week)\b", re.I)
DEFAULT_HOUR = 8  # a day with no clock time or day-part


def parse_now(s: str | None) -> ZonedDateTime:
    return OffsetDateTime.parse_iso(s).to_tz(TZ) if s else ZonedDateTime.now(TZ)


def _iso(dt: ZonedDateTime) -> str:
    return dt.to_fixed_offset().format_iso()


def candidates(query: str, now: ZonedDateTime) -> dict[str, str]:
    out: dict[str, str] = {}
    for n, unit in _REL.findall(query):
        n = int(n)
        if unit.lower().startswith(("t", "h")):
            dt, label = now.add(hours=n), f"om {n} timer ({now.add(hours=n).time().format_iso()[:5]})"
        else:
            dt, label = now.add(minutes=n), f"om {n} minutter ({now.add(minutes=n).time().format_iso()[:5]})"
        out[_iso(dt)] = label
    stripped = _REL.sub(" ", query)  # Note: a number used as a duration is not also a clock hour
    stripped = _CLOCK_WORD.sub(lambda m: f"{m[1]} {_HOUR_WORDS[m[2].lower()]}", stripped)
    wd = _WEEKDAY.search(query)
    if wd:
        target = (_WEEKDAYS + _EN).index(wd.group(1).lower()) % 7
        today = now.date().day_of_week().value - 1
        # "neste søndag" = coming Sunday (a week ahead if today is Sunday); "X neste uke" = X in the following Mon–Sun week
        ahead = 7 - today + target if _NEXT_WEEK.search(query) else (target - today) % 7 or 7
        base, day = now.add(days=ahead), wd.group(1).lower()
    else:
        base = now.add(days=1) if _TOMORROW.search(query) else now
        day = "i morgen" if base is not now else "i dag"
    for h, m in _CLOCK.findall(stripped):
        h, m = int(h), int(m or 0)
        if h > 23 or m > 59:
            continue
        hours = [h] if (m or h > 12) else [h % 12, h % 12 + 12]  # bare 1–12 → both am and pm
        for hh in hours:
            dt = base.replace(hour=hh, minute=m, second=0, nanosecond=0, disambiguation="compatible")
            out[_iso(dt)] = f"{day} kl {hh:02d}:{m:02d}"
            if base is now and dt.to_instant() <= now.to_instant():  # already passed today: next occurrence is tomorrow
                out[_iso(dt.add(days=1))] = f"i morgen kl {hh:02d}:{m:02d}"
    for pat, hh in _PARTS:
        m = pat.search(query)
        if not m:
            continue
        word = m.group(0).lower()
        # midnight is 00:00 at the start of the following day (no hour=24)
        d = base.add(days=1) if hh == 0 else base
        dt = d.replace(hour=hh, minute=0, second=0, nanosecond=0, disambiguation="compatible")
        out[_iso(dt)] = f"{day if wd else _DAYS[min(int(dt.date().since(now.date(), total='days')), 2)]} {word} ({hh:02d}:00)"
        if base is now and dt.to_instant() <= now.to_instant():
            out[_iso(dt.add(days=1))] = f"i morgen {word} ({hh:02d}:00)"
    if wd and not out:
        out[_iso(base.replace(hour=DEFAULT_HOUR, minute=0, second=0, nanosecond=0, disambiguation="compatible"))] = f"{day} {base.date()} ({DEFAULT_HOUR:02d}:00)"
    if _NIGHT.search(query):  # night = the coming 03:00 strictly after now; "i morgen" shifts one more day
        dt = now.replace(hour=3, minute=0, second=0, nanosecond=0, disambiguation="compatible")
        if dt.to_instant() <= now.to_instant():
            dt = dt.add(days=1)
        if _TOMORROW.search(query):
            dt = dt.add(days=1)
        out[_iso(dt)] = f"{'i morgen natt' if _TOMORROW.search(query) else 'i natt'} (03:00)"
    return dict(list(out.items())[:8])
