# journey-classifier

A proof of concept for a **journey planner with natural language**. Type or say a trip the way you would
to a person, in Norwegian or English. The app works out where you're going from and to, and when. It then
opens the trip in Entur or Ruter's journey planner.

> "Jeg må være i Stavanger stasjon i morgen tidlig" → To: Stavanger stasjon · Arrive by: tomorrow 08:00

With the default backend everything runs locally on a Mac: no text or audio leaves the machine.

Slides from the tech demo (Norwegian): [`docs/slides.pdf`](docs/slides.pdf).

## How it works

1. **Candidates, in plain code.** Fuzzy matching (`rapidfuzz`) finds stop places whose names match words in
   the request. Regular expressions turn time phrases ("om 2 timer", "i kveld", "neste fredag") into exact
   times in `Europe/Oslo`.
2. **One classifier call.** [Clef](https://huggingface.co/Cloudflare/clef-flash) gets the request plus these
   candidates as multiple-choice questions: which stop is *from*, which is *to*, depart now / at / arrive by,
   which time, and whether this is a prompt-injection attempt. Clef is a classifier, not a chat model: it
   picks among the options we give it and never writes free text. So it cannot invent a stop or a time.
3. **Planner links.** The chosen [NSR](https://developer.entur.no/) StopPlace IDs and time become links to
   Entur and Ruter. If you allow it, your location is used as the start when no origin is named.

Voice input goes through a local Norwegian Whisper model first, then follows the same path.

| Piece | What it is |
|---|---|
| `backend/journey.py`, `stops.py`, `times.py` | Classification: candidates → questions → decision |
| `backend/backends.py` | Model backends (Clef, plus exploratory ones, see below) |
| `backend/journey_server.py` | HTTP API on :8001 (`/classify`, `/transcribe`) |
| `web/` | Demo web app on :3000 (TanStack Start), with a one-at-a-time request queue |
| `backend/cases.yaml`, `promptfooconfig.yaml` | Evaluation suite (promptfoo) |

## Platform

**Only tested on macOS on Apple Silicon.** The models run on [MLX](https://github.com/ml-explore/mlx),
which is Apple-only.

The Clef loader (`backend/modules/clef-flash-4bit/clef_mlx.py`, shipped with the model) relies on internal parts of
`mlx-vlm` that change between releases. The loader's authors tested it with mlx-vlm 0.7.4; this repo runs
it with **mlx 0.32.3 and mlx-vlm 0.7.6** (see `backend/uv.lock`), and `backend/pyproject.toml` pins `mlx-vlm<0.8`. Newer
versions may break the loader. Clef flash 4-bit needs a Mac with **16 GB RAM or more**.

## Prerequisites

- `ffmpeg`, for voice input only: `brew install ffmpeg`
- [mise](https://mise.jdx.dev) is optional. With mise, `mise install` gives you pinned versions of
  `uv`, `pnpm`, `hf` (Hugging Face CLI) and `cloudflared`, and the `mise run …` tasks below.
  Without mise, install [uv](https://docs.astral.sh/uv/) and [pnpm](https://pnpm.io) yourself. `hf` comes
  with the Python dependencies (`uv run hf`).

## Setup

With mise:

```bash
mise install
mise run setup        # dependencies, stop data, Clef (~6 GB) and Whisper models
```

Without mise:

```bash
cd backend
uv sync
pnpm install
pnpm --dir ../web install

# Stop places (Entur, ~3 MB)
curl -fsSL -o stops.zip https://storage.googleapis.com/marduk-production/tiamat/Current_latest-gtfs.zip
rm -rf norway-gtfs && unzip -q stops.zip -d norway-gtfs && rm stops.zip

# Clef classifier (~6 GB)
uv run hf download mlx-community/clef-flash-4bit \
  --revision 140bf7e037f5fa95a96535feca112f46c15927cf --local-dir modules/clef-flash-4bit

# Norwegian Whisper, optional (voice input)
uv run hf download FredrikKarlssonSpeech/nb-whisper-small-mlx \
  --revision b175b02c9ea0039dbfb596422974c1139d5d0fcc --local-dir modules/nb-whisper-small
```

The model downloads are pinned to a revision, so the files cannot change under you. Without the Whisper
model, everything works except voice (`/transcribe` returns 503).

### Data

Stop places come from Entur's open stop place register:
<https://developer.entur.no/open-data/stops> (NLOD licence). `mise run fetch-stops` refreshes them.

## Run

```bash
mise run demo         # Clef :8000 + journey API :8001 + web :3000
```

Open <http://localhost:3000> once Clef has loaded (the journey API waits for it before starting).

Without mise, start each in its own terminal:

```bash
cd backend && uv run python modules/clef-flash-4bit/clef_mlx.py serve --port 8000 --no-truncate
cd backend && uv run python journey_server.py
cd web && pnpm build && pnpm start
```

To try it on a phone, `mise run tunnel` prints a public https URL and a QR code (Cloudflare quick tunnel).
Location and microphone need https or localhost.

## Tests and evaluation

```bash
(cd backend && uv run pytest) # Python unit tests (no model needed)
pnpm --dir web test           # web unit tests
```

Quality is measured with [promptfoo](https://promptfoo.dev) over 69 cases in `backend/cases.yaml`. Each case checks
from, to, time mode, time and the injection flag:

```bash
mise run eval                 # starts Clef, runs pytest + the full suite, writes results.json
mise run eval-view            # browse results per case on :15500
```

Without mise, start Clef first, then from `backend/` run `pnpm exec promptfoo eval --no-cache --filter-providers clef -o results.json`.

**Latest result (2026-10-26, Clef flash 4-bit): 63/69 (91%)**, about 3 s per case on an M-series Mac.
The six failures: five prompt-injection attempts it lets through (four of them from the held-out set),
and "next Friday" with no clock time.

## Other backends (exploratory)

`JOURNEY_BACKEND` selects the model behind the same questions:

| Backend | Env |
|---|---|
| `clef` (default) | `CLEF_URL` (default `http://127.0.0.1:8000/v1/systemone`), `JOURNEY_MODEL` |
| `openai` (any OpenAI-compatible server, e.g. Ollama) | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `JOURNEY_MODEL` |
| `anthropic` | `ANTHROPIC_API_KEY`, `JOURNEY_MODEL` |
| `d1` (Liquid d1 via `mlx_vlm` server) | `CLEF_URL`, `JOURNEY_MODEL` |

`backend/promptfooconfig.yaml` has a provider for each, plus `laya`, `winnow` and `h2o` (other Clef-compatible
servers), and `mise run laya` / `mise run demo-laya`. **These were explorative work and are not properly
tested.** The demo and the numbers above use Clef only. In one run on 2026-10-22, on an older copy of the
stop data, the scores were Clef 63/69, H2O-Lightning-4B 56/69, d1-3B 48/69 and Winnow-12B 44/69.

## Shortcomings

- **Place names.** A place is only found when it fuzzy-matches a stop name or has a "<city> stasjon /
  busstasjon / S" stop. "Bergen" works; a city without such a stop does not. There are no aliases or nicknames.
- **Prompt injection.** Detection catches the obvious attempts but misses some (5 of the eval's injection
  cases).
- **One request at a time.** Clef serves one request at a time. The web app queues searches in memory, and
  the queue is lost on restart. Not built for more than a handful of simultaneous users.
- **Speed.** Roughly 2–4 s per search.
- **Stops, not platforms.** It picks a stop place; choosing quay or platform is left to the planner.
- **Stop data includes unserved stops.** Entur's register lists stops no route currently serves. If one
  is picked, the planner link may find no trips.
- **Time phrases.** Common Norwegian and English phrases only. "halv tre" (02:30) and similar are not
  handled.
- **macOS on Apple Silicon only.**

## Licences

- This code: [MIT](LICENSE).
- Clef: `mlx-community/clef-flash-4bit`, an MLX conversion of
  [Cloudflare/clef-flash](https://huggingface.co/Cloudflare/clef-flash), Apache-2.0.
- Whisper: `FredrikKarlssonSpeech/nb-whisper-small-mlx`, an MLX conversion of
  [NbAiLab/nb-whisper-small](https://huggingface.co/NbAiLab/nb-whisper-small), Apache-2.0.
- Stop data: [Entur](https://developer.entur.no/open-data/stops), NLOD.
