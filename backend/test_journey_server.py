import http.client
import json
import os
import threading
import urllib.error
import urllib.request

import journey_server
import stops

OSLO, BERGEN_T = "NSR:StopPlace:337", "NSR:StopPlace:548"


def result(frm, to):
    return {"injection": False, "from": frm, "to": to, "time": {"mode": "now", "at": None}, "debug": {}}


def label(stop_id):
    return stops.render(stops.STOPS.filter(stops.STOPS["stop_id"] == stop_id).to_dicts()[0])


def test_adds_names_from_registry(monkeypatch):
    monkeypatch.setattr(journey_server, "classify", lambda *a, **k: result(OSLO, BERGEN_T))
    status, body = journey_server.handle({"query": "x"})
    assert status == 200
    assert body["from_name"] == label(OSLO)
    assert body["to_name"] == "Bergen stasjon (tog, 60.390,5.333)"
    assert body["from"] == OSLO


def test_null_ids_give_null_names_and_unknown_id_falls_back_to_id(monkeypatch):
    monkeypatch.setattr(journey_server, "classify", lambda *a, **k: result(None, "NSR:StopPlace:0"))
    status, body = journey_server.handle({"query": "x"})
    assert status == 200
    assert body["from_name"] is None
    assert body["to_name"] == "NSR:StopPlace:0"


def test_rejects_empty_and_overlong_query(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("classify must not be called")
    monkeypatch.setattr(journey_server, "classify", boom)
    for payload in ({"query": ""}, {"query": "   "}, {"query": "a" * 501}, {}):
        status, body = journey_server.handle(payload)
        assert status == 400 and body["error"]


def test_classify_failure_is_500(monkeypatch):
    def fail(*a, **k):
        raise RuntimeError("clef down")
    monkeypatch.setattr(journey_server, "classify", fail)
    status, body = journey_server.handle({"query": "x"})
    assert status == 500 and "clef down" not in body["error"] and "try again" in body["error"]


def test_clef_not_listening_is_503_with_friendly_message(monkeypatch):
    import backends

    monkeypatch.setenv("CLEF_URL", "http://127.0.0.1:1/v1/systemone")  # nothing listens on port 1
    monkeypatch.setattr(journey_server, "classify", lambda *a, **k: backends.decide_clef({}, {}))
    status, body = journey_server.handle({"query": "x"})
    assert status == 503 and "still starting" in body["error"]


def test_http_roundtrip(monkeypatch):
    monkeypatch.setattr(journey_server, "classify", lambda *a, **k: result(OSLO, BERGEN_T))
    server = journey_server.make_server(0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/classify"
    try:
        req = urllib.request.Request(url, json.dumps({"query": "x"}).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as r:
            assert r.status == 200
            assert json.load(r)["to_name"] == "Bergen stasjon (tog, 60.390,5.333)"
        bad = urllib.request.Request(url, b"{not json", {"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(bad)
            raise AssertionError("expected 400")
        except urllib.error.HTTPError as e:
            assert e.code == 400
    finally:
        server.shutdown()
        server.server_close()


def registry(stop_id):
    return stops.STOPS.filter(stops.STOPS["stop_id"] == stop_id).to_dicts()[0]


def test_adds_plain_stop_objects(monkeypatch):
    monkeypatch.setattr(journey_server, "classify", lambda *a, **k: result(OSLO, BERGEN_T))
    _, body = journey_server.handle({"query": "x"})
    oslo = registry(OSLO)
    assert body["from_stop"] == {"id": OSLO, "name": "Oslo S", "lat": oslo["stop_lat"], "lon": oslo["stop_lon"]}
    assert body["to_stop"]["name"] == "Bergen stasjon"
    assert body["from_name"] == label(OSLO)


def test_unknown_or_null_id_gives_null_stop(monkeypatch):
    monkeypatch.setattr(journey_server, "classify", lambda *a, **k: result(None, "NSR:StopPlace:0"))
    _, body = journey_server.handle({"query": "x"})
    assert body["from_stop"] is None
    assert body["to_stop"] is None


def test_rejects_bad_coordinates_and_passes_valid_ones(monkeypatch):
    calls = []

    def spy(*a, **k):
        calls.append(a)
        return result(OSLO, BERGEN_T)
    monkeypatch.setattr(journey_server, "classify", spy)
    bad = (
        {"lat": 91, "lon": 10}, {"lat": -90.5, "lon": 10}, {"lat": 59.9, "lon": 181},
        {"lat": 59.9}, {"lon": 10}, {"lat": "59.9", "lon": 10}, {"lat": True, "lon": 10},
        {"lat": None, "lon": 10}, {"lat": float("nan"), "lon": 10},
        {"lat": 10**400, "lon": 1},
    )
    for coords in bad:
        status, body = journey_server.handle({"query": "x"} | coords)
        assert status == 400 and body["error"], coords
    assert calls == []
    status, _ = journey_server.handle({"query": "x", "lat": 59, "lon": 10.7})
    assert status == 200
    lat, lon = calls[0][1], calls[0][2]
    assert (lat, lon) == (59.0, 10.7) and isinstance(lat, float)


def model_present(monkeypatch, tmp_path, fake):
    monkeypatch.setattr(journey_server, "WHISPER_MODEL", tmp_path)
    (tmp_path / "weights.safetensors").touch()
    monkeypatch.setattr(journey_server, "_transcribe", fake)


def no_call(path):
    raise AssertionError("_transcribe must not be called")


def test_transcribe_strips_text(monkeypatch, tmp_path):
    seen = []

    def fake(path):
        seen.append(path)
        assert open(path, "rb").read() == b"audio"
        return "  Oslo S til Lillestrøm. "

    model_present(monkeypatch, tmp_path, fake)
    assert journey_server.handle_transcribe(b"audio") == (200, {"text": "Oslo S til Lillestrøm."})
    assert not os.path.exists(seen[0])  # temp file removed
    monkeypatch.setattr(journey_server, "_transcribe", lambda p: "   ")
    assert journey_server.handle_transcribe(b"audio") == (200, {"text": ""})


def test_transcribe_rejects_empty_and_oversize(monkeypatch, tmp_path):
    model_present(monkeypatch, tmp_path, no_call)
    for body in (b"", b"x" * (journey_server.MAX_AUDIO + 1)):
        status, out = journey_server.handle_transcribe(body)
        assert status == 400 and out["error"]


def test_transcribe_without_model_is_503(monkeypatch, tmp_path):
    monkeypatch.setattr(journey_server, "WHISPER_MODEL", tmp_path / "missing")
    assert journey_server.handle_transcribe(b"audio") == (503, {"error": "voice model not installed, see README"})


def test_transcribe_failure_is_500_and_cleans_up(monkeypatch, tmp_path):
    seen = []

    def fake(path):
        seen.append(path)
        raise RuntimeError("ffmpeg failed")

    model_present(monkeypatch, tmp_path, fake)
    status, out = journey_server.handle_transcribe(b"audio")
    assert status == 500 and "ffmpeg" not in out["error"] and "try again" in out["error"]
    assert not os.path.exists(seen[0])


def test_transcribe_http_roundtrip(monkeypatch, tmp_path):
    model_present(monkeypatch, tmp_path, lambda p: "hei")
    server = journey_server.make_server(0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{server.server_port}/transcribe", b"audio", {"Content-Type": "audio/webm"}
        )
        with urllib.request.urlopen(req) as r:
            assert r.status == 200
            assert json.load(r) == {"text": "hei"}
    finally:
        server.shutdown()
        server.server_close()


def test_transcribe_http_rejects_oversize_without_model(monkeypatch, tmp_path):
    model_present(monkeypatch, tmp_path, no_call)
    server = journey_server.make_server(0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port)
        conn.putrequest("POST", "/transcribe")
        conn.putheader("Content-Type", "audio/webm")
        conn.putheader("Content-Length", str(journey_server.MAX_AUDIO + 1))
        conn.endheaders(b"short")
        resp = conn.getresponse()
        assert resp.status == 400
        conn.close()
    finally:
        server.shutdown()
        server.server_close()


def _whisper(monkeypatch, tmp_path, result):
    import mlx_whisper

    model_present(monkeypatch, tmp_path, journey_server._transcribe)
    calls = []

    def fake(path, **kw):
        calls.append(kw)
        return result

    monkeypatch.setattr(mlx_whisper, "transcribe", fake)
    return calls


def test_transcribe_drops_low_confidence_segments(monkeypatch, tmp_path):
    result = {
        "text": "x Oslo S",
        "segments": [{"text": "x", "avg_logprob": -2.6}, {"text": " Oslo S", "avg_logprob": -0.1}],
    }
    calls = _whisper(monkeypatch, tmp_path, result)
    assert journey_server.handle_transcribe(b"audio") == (200, {"text": "Oslo S"})
    assert calls[0]["temperature"] == 0.0
    assert calls[0]["language"] == "no" and calls[0]["without_timestamps"] is True


def test_transcribe_silence_gives_empty_text(monkeypatch, tmp_path):
    result = {"text": ".", "segments": [{"text": ".", "avg_logprob": -2.4}]}
    _whisper(monkeypatch, tmp_path, result)
    assert journey_server.handle_transcribe(b"audio") == (200, {"text": ""})
