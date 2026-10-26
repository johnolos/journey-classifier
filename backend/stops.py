import re
from pathlib import Path

import polars as pl
from rapidfuzz import fuzz, process

MODE = {100: "tog", 700: "buss", 900: "trikk", 401: "t-bane", 1000: "båt", 1100: "fly", 1300: "taubane"}

DATA = Path(__file__).parent / "norway-gtfs" / "stops.txt"
if not DATA.exists():
    raise SystemExit(f"{DATA} not found; run `mise run fetch-stops` (see README)")

STOPS = (
    pl.read_csv(DATA, schema_overrides={"location_type": pl.Int64})
    .with_columns(pl.col("location_type").fill_null(0))
    .filter(pl.col("location_type") == 1)
    .select("stop_id", "stop_name", "stop_lat", "stop_lon", "vehicle_type")
)


def render(row: dict) -> str:
    mode = MODE.get(row["vehicle_type"], "ukjent")
    return f'{row["stop_name"]} ({mode}, {row["stop_lat"]:.3f},{row["stop_lon"]:.3f})'


STOPWORDS = {"jeg", "vil", "reise", "fra", "til", "from", "to", "i", "og", "på", "med", "en", "et",
             "the", "a", "want", "go", "travel", "ta", "meg", "hjem", "nå", "now", "kl", "om",
             "morgen", "tomorrow", "today", "idag", "innen", "by", "at", "timer", "minutter", "hours"}
NAMES = sorted(STOPS["stop_name"].unique().to_list())  # sorted: polars unique() order varies per run and rapidfuzz breaks ties by index
LOW = {n.lower(): n for n in NAMES}
_WORD = re.compile(r"[\wæøåÆØÅ.-]+")


def _ngrams(query: str, n_max: int = 3) -> list[str]:
    words = [w for w in (w.strip(".,?!;:") for w in _WORD.findall(query)) if w and w.lower() not in STOPWORDS and not w.isdigit()]
    return [" ".join(words[i:i + n]) for n in range(1, n_max + 1) for i in range(len(words) - n + 1)]


def candidates(query: str, limit_names: int = 3) -> list[dict]:
    # Limitation: WRatio over 42k unique names per n-gram, ~20-170 ms/query. Generic words like
    # 'stasjon' pull in noise ('Mo stasjon'); city names without a suffix ('Bergen') miss. Let the
    # eval's retrieval-miss list decide whether to add alias/suffix handling.
    scored: dict[str, float] = {}
    for gram in _ngrams(query):
        # Limitation: WRatio ties every "Bergen*" name at 90 and limit=3 keeps an arbitrary three, so bare city
        # names miss the main station. Exact "<gram> stasjon/busstasjon/s" lookup fixes that; ceiling: only
        # cities whose station follows that naming ("Tromsø" has none) and only names, no aliases.
        for suffix in (" stasjon", " busstasjon", " s"):
            if name := LOW.get(gram.lower() + suffix):
                scored[name] = max(scored.get(name, 0), 95)
        for name, score, _ in process.extract(gram, NAMES, scorer=fuzz.WRatio, limit=3, score_cutoff=85):
            scored[name] = max(scored.get(name, 0), score)
    best = sorted(scored, key=lambda n: (-scored[n], n))[:limit_names]
    return [row for name in best for row in STOPS.filter(STOPS["stop_name"] == name).to_dicts()]
