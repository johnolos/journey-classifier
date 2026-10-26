from whenever import ZonedDateTime
import times

NOW = ZonedDateTime(2026, 10, 7, 12, 35, tz="Europe/Oslo")

def test_relative_hours():
    c = times.candidates("jeg drar om 2 timer", NOW)
    assert "2026-10-07T14:35:00+02:00" in c

def test_relative_minutes_and_english():
    assert "2026-10-07T13:05:00+02:00" in times.candidates("leaving in 30 minutes", NOW)

def test_bare_hour_fans_out_to_am_and_pm():
    c = times.candidates("må være der innen 6", NOW)
    assert {"2026-10-07T06:00:00+02:00", "2026-10-07T18:00:00+02:00"} <= set(c)

def test_clock_time_and_tomorrow():
    c = times.candidates("i morgen kl 08:15", NOW)
    assert "2026-10-08T08:15:00+02:00" in c
    assert all(not k.startswith("2026-10-07T08") for k in c)

def test_no_time_tokens():
    assert times.candidates("fra Oslo S til Bergen", NOW) == {}

def test_parse_now_roundtrip():
    assert times.parse_now("2026-10-07T12:35:00+02:00") == NOW

def test_bare_twelve_does_not_crash():
    c = times.candidates("kl 12", NOW)
    assert "2026-10-07T12:00:00+02:00" in c

def test_past_clock_time_rolls_to_tomorrow():
    c = times.candidates("må være der innen 6", NOW)
    assert "2026-10-08T06:00:00+02:00" in c

def test_tomorrow_early_is_tomorrow_morning():
    assert "2026-10-08T08:00:00+02:00" in times.candidates("jeg må være der i morgen tidlig", NOW)

def test_evening_today():
    assert "2026-10-07T20:00:00+02:00" in times.candidates("jeg reiser i kveld", NOW)

def test_midnight_is_start_of_next_day():
    assert "2026-10-08T00:00:00+02:00" in times.candidates("avgang midnatt", NOW)

def test_tomorrow_alone_is_not_a_day_part():
    assert times.candidates("jeg reiser i morgen", NOW) == {}

def test_night_means_the_coming_night():
    c = times.candidates("Jeg drar fra Oslo S til Bergen stasjon i natt", NOW)
    assert [k for k, v in c.items() if "natt" in v] == ["2026-10-08T03:00:00+02:00"]
    assert "2026-10-07T03:00:00+02:00" not in c

def test_night_before_three_is_tonight_at_three():
    now = ZonedDateTime(2026, 10, 7, 1, 0, tz="Europe/Oslo")
    assert list(times.candidates("jeg må være fremme i løpet av natta", now)) == ["2026-10-07T03:00:00+02:00"]

def test_definite_day_part_forms():
    assert "2026-10-08T03:00:00+02:00" in times.candidates("i løpet av natten", NOW)
    assert "2026-10-07T20:00:00+02:00" in times.candidates("på kvelden", NOW)
    assert "2026-10-07T16:00:00+02:00" in times.candidates("på ettermiddagen", NOW)


# NOW is Wednesday 2026-10-07: the coming Sunday is the 11th, Friday the 9th.
def test_bare_weekday_is_next_occurrence_at_default_hour():
    for q in ("jeg reiser på søndag", "jeg reiser neste søndag", "I travel next Sunday"):
        assert list(times.candidates(q, NOW)) == ["2026-10-11T08:00:00+02:00"], q

def test_weekday_that_is_today_means_a_week_ahead():
    assert list(times.candidates("jeg reiser på onsdag", NOW)) == ["2026-10-14T08:00:00+02:00"]

def test_weekday_combines_with_clock_and_day_part():
    c = times.candidates("fra Oslo S på søndag kl 10:30", NOW)
    assert "2026-10-11T10:30:00+02:00" in c and not any(k.startswith("2026-10-07") for k in c)
    assert "2026-10-09T20:00:00+02:00" in times.candidates("fredag kveld", NOW)

def test_weekday_next_week_is_following_monday_to_sunday_week():
    assert list(times.candidates("søndag neste uke", NOW)) == ["2026-10-18T08:00:00+02:00"]
    assert list(times.candidates("friday next week", NOW)) == ["2026-10-16T08:00:00+02:00"]

def test_place_names_that_resemble_weekdays_are_not_weekdays():
    assert times.candidates("til Søndre Nordstrand", NOW) == {}

def test_spelled_out_clock_hour_fans_out_to_am_and_pm():
    c = times.candidates("fra Trondheim til Bergen på søndag klokka to", NOW)
    assert set(c) == {"2026-10-11T02:00:00+02:00", "2026-10-11T14:00:00+02:00"}
    assert "2026-10-07T23:00:00+02:00" in times.candidates("kl elleve", NOW)

def test_number_words_without_clock_prefix_are_not_times():
    assert times.candidates("vi er to som skal til Bergen", NOW) == {}
