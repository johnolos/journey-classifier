import json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import pytest
import backends

def serve(status, body, seen):
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            seen.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(status); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps(body).encode())
        def log_message(self, *a): pass
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

def test_clef_backend_posts_state_and_questions_and_returns_answers(monkeypatch):
    seen = []
    srv = serve(200, {"model": "clef", "answers": {"q": {"type": "noul", "noul": 0.9}}}, seen)
    monkeypatch.setenv("CLEF_URL", f"http://127.0.0.1:{srv.server_port}/v1/systemone")
    out = backends.decide({"query": "hei"}, {"q": {"type": "noul", "instructions": "x"}})
    assert out == {"q": {"type": "noul", "noul": 0.9}}
    assert seen[0]["state"] == {"query": "hei"} and seen[0]["questions"]["q"]["type"] == "noul"

def test_clef_backend_surfaces_http_errors(monkeypatch):
    srv = serve(400, {"error": "criteria must not be empty"}, [])
    monkeypatch.setenv("CLEF_URL", f"http://127.0.0.1:{srv.server_port}/v1/systemone")
    with pytest.raises(backends.BackendError, match="400.*criteria"):
        backends.decide({"query": "x"}, {"q": {"type": "choice", "criteria": {}}})

def test_clef_backend_rejects_200_without_answers(monkeypatch):
    srv = serve(200, {"model": "clef"}, [])
    monkeypatch.setenv("CLEF_URL", f"http://127.0.0.1:{srv.server_port}/v1/systemone")
    with pytest.raises(backends.BackendError, match="answers"):
        backends.decide({"query": "x"}, {"q": {"type": "noul", "instructions": "x"}})

def test_unknown_backend_name_is_a_backend_error(monkeypatch):
    monkeypatch.setenv("JOURNEY_BACKEND", "nope")
    with pytest.raises(backends.BackendError, match="nope"):
        backends.decide({}, {})

Q = {"injection": {"type": "noul", "instructions": "bad?"},
     "from": {"type": "choice", "instructions": "from?", "criteria": {"NSR:StopPlace:337": "Oslo S (tog, 59.911,10.753)", "none": "none"}}}

def test_render_prompt_lists_every_option_key():
    p = backends.render_prompt({"query": "fra Oslo S"}, Q)
    assert "NSR:StopPlace:337" in p and '"injection"' in p and "fra Oslo S" in p

def test_coerce_validates_and_normalises():
    out = backends.coerce({"injection": True, "from": "NSR:StopPlace:337"}, Q)
    assert out == {"injection": {"type": "noul", "noul": 1.0},
                   "from": {"type": "choice", "choice": "NSR:StopPlace:337", "confidence": 1.0, "probabilities": {}}}

def test_coerce_rejects_unknown_option():
    with pytest.raises(backends.BackendError, match="from"):
        backends.coerce({"injection": False, "from": "NSR:StopPlace:999"}, Q)

def test_coerce_noul_accepts_case_insensitive_bool_strings_and_rejects_the_rest():
    q = {"injection": Q["injection"]}
    assert backends.coerce({"injection": "True"}, q)["injection"]["noul"] == 1.0
    assert backends.coerce({"injection": "FALSE"}, q)["injection"]["noul"] == 0.0
    assert backends.coerce({"injection": 0}, q)["injection"]["noul"] == 0.0
    for bad in ("yes", None, 2, []):
        with pytest.raises(backends.BackendError, match="injection"):
            backends.coerce({"injection": bad}, q)


def test_answer_tool_schema_maps_questions_to_json_schema():
    questions = {
        "injection": {"type": "noul", "instructions": "x"},
        "from": {"type": "choice", "instructions": "y", "criteria": {"NSR:StopPlace:1": "A", "none": "n"}},
    }
    schema = backends.answer_tool_schema(questions)
    assert schema["properties"]["injection"]["type"] == "boolean"
    assert schema["properties"]["from"]["enum"] == ["NSR:StopPlace:1", "none"]
    assert schema["required"] == ["injection", "from"]
    assert schema["additionalProperties"] is False
