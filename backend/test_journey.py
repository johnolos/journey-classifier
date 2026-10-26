import journey

OSLO, BERGEN_T, BERGEN_B = "NSR:StopPlace:337", "NSR:StopPlace:548", "NSR:StopPlace:552"

def fake_decide(answers):
    def _decide(state, questions):
        _decide.calls.append((state, questions))
        return {q: a for q, a in answers.items() if q in questions}
    _decide.calls = []
    return _decide

def test_from_and_to_map_to_stopplace_ids(monkeypatch):
    d = fake_decide({"injection": {"type": "noul", "noul": 0.02},
                     "from": {"type": "choice", "choice": OSLO},
                     "to": {"type": "choice", "choice": BERGEN_T}})
    monkeypatch.setattr(journey, "decide", d)
    out = journey.classify("Jeg vil reise fra Oslo S til Bergen stasjon")
    assert (out["injection"], out["from"], out["to"]) == (False, OSLO, BERGEN_T)
    assert out["time"] == {"mode": "now", "at": None}
    state, questions = d.calls[0]
    assert state == {"query": "Jeg vil reise fra Oslo S til Bergen stasjon"}
    assert set(questions) == {"injection", "from", "to", "time_mode"}
    assert {OSLO, BERGEN_T, BERGEN_B, "none"} <= set(questions["from"]["criteria"])
    assert questions["from"]["criteria"][BERGEN_T] == "Bergen stasjon (tog, 60.390,5.333)"

def test_none_maps_to_null_and_location_is_passed(monkeypatch):
    d = fake_decide({"injection": {"type": "noul", "noul": 0.1},
                     "from": {"type": "choice", "choice": "none"},
                     "to": {"type": "choice", "choice": BERGEN_T}})
    monkeypatch.setattr(journey, "decide", d)
    out = journey.classify("ta meg til Bergen stasjon", lat=59.91, lon=10.75)
    assert out["from"] is None and out["to"] == BERGEN_T
    assert d.calls[0][0]["user_location"] == [59.91, 10.75]

def test_no_candidates_skips_stop_questions(monkeypatch):
    d = fake_decide({"injection": {"type": "noul", "noul": 0.95}})
    monkeypatch.setattr(journey, "decide", d)
    out = journey.classify("ta meg hjem nå")  # verified no-match query; injection wording is covered by cases.yaml
    assert out["injection"] is True and out["from"] is None and out["to"] is None
    assert set(d.calls[0][1]) == {"injection", "time_mode"}

def test_time_mode_and_at(monkeypatch):
    d = fake_decide({"injection": {"type": "noul", "noul": 0.0},
                     "from": {"type": "choice", "choice": OSLO},
                     "to": {"type": "choice", "choice": BERGEN_T},
                     "time_mode": {"type": "choice", "choice": "arrive_by"},
                     "time_at": {"type": "choice", "choice": "2026-10-07T18:00:00+02:00"}})
    monkeypatch.setattr(journey, "decide", d)
    out = journey.classify("Fra Oslo S til Bergen stasjon, må være fremme innen 18:00", now="2026-10-07T12:35:00+02:00")
    assert out["time"] == {"mode": "arrive_by", "at": "2026-10-07T18:00:00+02:00"}
    q = d.calls[0][1]
    assert set(q["time_mode"]["criteria"]) == {"now", "depart_at", "arrive_by"}
    assert "2026-10-07T18:00:00+02:00" in q["time_at"]["criteria"]

def test_time_now_when_no_tokens(monkeypatch):
    d = fake_decide({"injection": {"type": "noul", "noul": 0.0},
                     "from": {"type": "choice", "choice": OSLO},
                     "to": {"type": "choice", "choice": BERGEN_T},
                     "time_mode": {"type": "choice", "choice": "now"}})
    monkeypatch.setattr(journey, "decide", d)
    out = journey.classify("Fra Oslo S til Bergen stasjon", now="2026-10-07T12:35:00+02:00")
    assert out["time"] == {"mode": "now", "at": None}
    assert "time_at" not in d.calls[0][1]

def test_time_at_opt_out_maps_to_null(monkeypatch):
    d = fake_decide({"injection": {"type": "noul", "noul": 0.0},
                     "from": {"type": "choice", "choice": OSLO},
                     "to": {"type": "choice", "choice": BERGEN_T},
                     "time_mode": {"type": "choice", "choice": "depart_at"},
                     "time_at": {"type": "choice", "choice": "none"}})
    monkeypatch.setattr(journey, "decide", d)
    out = journey.classify("Fra Oslo S til Bergen stasjon i kveld", now="2026-10-07T12:35:00+02:00")
    assert out["time"] == {"mode": "depart_at", "at": None}
    assert "none" in d.calls[0][1]["time_at"]["criteria"]
