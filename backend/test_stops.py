import os
import shutil
import subprocess
import sys
from pathlib import Path

import stops

def test_registry_is_stopplaces_only():
    assert len(stops.STOPS) > 50_000
    assert stops.STOPS["stop_id"].str.starts_with("NSR:StopPlace:").all()
    assert "NSR:StopPlace:337" in stops.STOPS["stop_id"].to_list()  # Oslo S

def test_render_includes_mode_and_coords():
    row = stops.STOPS.filter(stops.STOPS["stop_id"] == "NSR:StopPlace:548").row(0, named=True)
    assert stops.render(row) == "Bergen stasjon (tog, 60.390,5.333)"


def ids(query):
    return {r["stop_id"] for r in stops.candidates(query)}

def test_candidates_find_named_stops():
    got = ids("Jeg vil reise fra Oslo S til Bergen stasjon i morgen")
    assert {"NSR:StopPlace:337", "NSR:StopPlace:548", "NSR:StopPlace:552"} <= got

def test_candidates_offer_every_stopplace_sharing_a_name():
    got = ids("til Jernbanetorget")
    assert len([i for i in got if stops.STOPS.filter(stops.STOPS["stop_id"] == i)["stop_name"][0] == "Jernbanetorget"]) >= 9

def test_candidates_ignore_stopwords_and_unknowns():
    assert stops.candidates("ta meg hjem nå") == []
    assert stops.candidates("fra til from to") == []

def test_candidates_find_main_station_from_bare_city_name():
    assert {"NSR:StopPlace:548", "NSR:StopPlace:552"} & ids("til Bergen")

def test_bare_city_names_offer_few_stations_including_the_main_ones():
    names = {c["stop_name"] for c in stops.candidates("Reiser fra Trondheim til Bergen på søndag klokka to.")}
    assert len(names) <= 3
    assert {"Trondheim S", "Bergen stasjon"} <= names


def test_stops_import_from_other_cwd(tmp_path):
    r = subprocess.run([sys.executable, "-c", "import stops; print(len(stops.STOPS))"],
                       cwd=tmp_path, env={**os.environ, "PYTHONPATH": str(Path(stops.__file__).parent)},
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert int(r.stdout) > 50_000


def test_missing_stops_file_names_fetch_task(tmp_path):
    shutil.copy(stops.__file__, tmp_path)  # alone, so its data path points at a missing file
    r = subprocess.run([sys.executable, "-c", "import stops"], cwd=tmp_path, capture_output=True, text=True)
    assert r.returncode != 0
    assert "mise run fetch-stops" in r.stderr
