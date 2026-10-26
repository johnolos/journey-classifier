"""POST /classify -> journey.classify output plus from_name/to_name.
POST /transcribe (raw audio body) -> {"text"} via local mlx-whisper. Serves 127.0.0.1."""
import argparse
import json
import os
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import stops
from backends import BackendUnavailable
from journey import classify

MAX_QUERY = 500
MAX_AUDIO = 1_000_000  # keep in sync with MAX_AUDIO_BYTES in web/src/server/transcribe.ts
WHISPER_MODEL = Path(__file__).parent / "modules" / "nb-whisper-small"
WHISPER_KWARGS = {"language": "no", "without_timestamps": True, "temperature": 0.0}
# Measured at temperature 0: silence -2.44, hiss -2.02, real speech -0.07, TTS -0.11 (nb-whisper's no_speech_prob is always 0).
MIN_LOGPROB = -1.0
_STOPS: dict[str, dict] = {r["stop_id"]: r for r in stops.STOPS.iter_rows(named=True)}


def _name(stop_id: str | None) -> str | None:
    if stop_id is None:
        return None
    row = _STOPS.get(stop_id)
    return stops.render(row) if row else stop_id


def _stop(stop_id: str | None) -> dict | None:
    row = _STOPS.get(stop_id)
    return row and {"id": row["stop_id"], "name": row["stop_name"], "lat": row["stop_lat"], "lon": row["stop_lon"]}


def _coords(payload: dict) -> tuple[float | None, float | None]:
    """(lat, lon); (None, None) when both absent; ValueError when present but invalid."""
    if "lat" not in payload and "lon" not in payload:
        return None, None
    vals = (payload.get("lat"), payload.get("lon"))
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
        raise ValueError("lat and lon must both be numbers")
    lat, lon = float(vals[0]), float(vals[1])
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("lat must be within -90..90 and lon within -180..180")
    return lat, lon


def handle(payload: dict) -> tuple[int, dict]:
    query = payload.get("query")
    if not isinstance(query, str) or not query.strip() or len(query) > MAX_QUERY:
        return 400, {"error": f"query must be a non-empty string of at most {MAX_QUERY} characters"}
    try:
        lat, lon = _coords(payload)
    except (ValueError, OverflowError) as e:
        return 400, {"error": str(e)}
    try:
        out = classify(query, lat, lon, None)
    except BackendUnavailable as e:
        print(f"[journey] {e}")
        return 503, {"error": "The model is still starting. Try again in a few seconds."}
    except Exception as e:  # noqa: BLE001  (surface any backend failure as 500)
        traceback.print_exc()
        return 500, {"error": "Something went wrong on our side. Please try again."}
    return 200, out | {
        "from_name": _name(out["from"]),
        "to_name": _name(out["to"]),
        "from_stop": _stop(out["from"]),
        "to_stop": _stop(out["to"]),
    }


def _installed() -> bool:
    return (WHISPER_MODEL / "weights.safetensors").exists()


def _transcribe(path) -> str:
    import mlx_whisper  # lazy: heavy, and /classify never needs it

    out = mlx_whisper.transcribe(path, path_or_hf_repo=str(WHISPER_MODEL), **WHISPER_KWARGS)
    return "".join(s["text"] for s in out["segments"] if s["avg_logprob"] >= MIN_LOGPROB)


def handle_transcribe(body: bytes) -> tuple[int, dict]:
    if not body or len(body) > MAX_AUDIO:
        return 400, {"error": f"audio must be 1..{MAX_AUDIO} bytes"}
    if not _installed():
        return 503, {"error": "voice model not installed, see README"}
    f = tempfile.NamedTemporaryFile(delete=False)
    try:
        with f:
            f.write(body)
        return 200, {"text": _transcribe(f.name).strip()}
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        return 500, {"error": "Could not transcribe the recording. Please try again."}
    finally:
        os.unlink(f.name)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path == "/transcribe":
            try:
                n = int(self.headers.get("Content-Length", ""))
            except ValueError:
                n = -1
            if not 0 <= n <= MAX_AUDIO:
                return self._send(400, {"error": f"Content-Length must be 0..{MAX_AUDIO}"})
            return self._send(*handle_transcribe(self.rfile.read(n)))
        if self.path != "/classify":
            return self._send(404, {"error": "not found"})
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if not isinstance(payload, dict):
                raise ValueError
        except ValueError:
            return self._send(400, {"error": "body must be a JSON object"})
        self._send(*handle(payload))


def make_server(port: int) -> HTTPServer:
    return HTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8001)
    server = make_server(ap.parse_args().port)
    try:
        if _installed():
            import mlx_whisper
            import numpy

            mlx_whisper.transcribe(
                numpy.zeros(16000, numpy.float32), path_or_hf_repo=str(WHISPER_MODEL), **WHISPER_KWARGS
            )
            print("voice model ready", flush=True)
        else:
            print("voice model not installed (see README); /transcribe will return 503", flush=True)
    except Exception:  # noqa: BLE001  (a voice failure must never break text search)
        traceback.print_exc()
        print("voice warm-up failed; /transcribe will error", flush=True)
    server.serve_forever()
