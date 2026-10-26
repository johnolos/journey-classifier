import { describe, expect, it } from 'vitest'
import type { Decision } from './server/model'
import * as v from 'valibot'
import { buildJourney, Journey, toEnturUrl, toRuterUrl } from './links'

const oslo = { id: 'NSR:StopPlace:59872', name: 'Oslo S', lat: 59.910357, lon: 10.753051 }
const bergen = { id: 'NSR:StopPlace:59983', name: 'Bergen stasjon', lat: 60.390434, lon: 5.333511 }
const osloR = { id: 'NSR:StopPlace:337', name: 'Oslo S', lat: 59.910925, lon: 10.753276 }
const bergenR = { id: 'NSR:StopPlace:548', name: 'Bergen stasjon', lat: 60.390332, lon: 5.333283 }
const storo = { id: 'NSR:StopPlace:58195', name: 'Storo', lat: 59.94527, lon: 10.778637 }

const modes = 'rail,tram,bus,coach,water,car_ferry,metro,flytog,flybuss'

function parts(href: string) {
  const u = new URL(href)
  return { base: u.origin + u.pathname, params: Object.fromEntries(u.searchParams) }
}

describe('toEnturUrl', () => {
  it('depart Oslo S to Bergen stasjon', () => {
    const j: Journey = {
      from: { kind: 'stop', stop: oslo },
      to: bergen,
      mode: 'depart_at',
      at: '2026-10-21T19:43:20.326+02:00',
    }
    expect(parts(toEnturUrl(j))).toEqual({
      base: 'https://entur.no/reiseresultater',
      params: {
        transportModes: modes,
        tripMode: 'oneway',
        timepickerMode: 'departAfter',
        date: '1792604600326',
        startId: 'NSR:StopPlace:59872',
        startLabel: 'Oslo S',
        startLat: '59.910357',
        startLon: '10.753051',
        stopId: 'NSR:StopPlace:59983',
        stopLabel: 'Bergen stasjon',
        stopLat: '60.390434',
        stopLon: '5.333511',
      },
    })
    expect(toEnturUrl(j)).toContain('transportModes=rail%2Ctram%2Cbus')
    expect(toEnturUrl(j)).toContain('startLabel=Oslo%20S')
  })

  it('arrive-by', () => {
    const j: Journey = {
      from: { kind: 'stop', stop: oslo },
      to: bergen,
      mode: 'arrive_by',
      at: '2026-10-24T05:00:59+02:00',
    }
    const { params } = parts(toEnturUrl(j))
    expect(params.timepickerMode).toBe('arriveBefore')
    expect(params.date).toBe('1792810859000')
  })

  it('own position, now', () => {
    const j: Journey = { from: { kind: 'here', lat: 59.9357, lon: 10.8062 }, to: storo, mode: 'now', at: null }
    expect(parts(toEnturUrl(j)).params).toEqual({
      transportModes: modes,
      tripMode: 'oneway',
      timepickerMode: 'departAfter',
      startLabel: 'Min posisjon',
      startLat: '59.9357',
      startLon: '10.8062',
      stopId: 'NSR:StopPlace:58195',
      stopLabel: 'Storo',
      stopLat: '59.94527',
      stopLon: '10.778637',
    })
  })

  it('from omitted', () => {
    const j: Journey = { from: null, to: storo, mode: 'now', at: null }
    expect(Object.keys(parts(toEnturUrl(j)).params).sort()).toEqual(
      ['stopId', 'stopLabel', 'stopLat', 'stopLon', 'timepickerMode', 'transportModes', 'tripMode'],
    )
  })
})

describe('toRuterUrl', () => {
  it('own position, now', () => {
    const j: Journey = { from: { kind: 'here', lat: 59.9, lon: 10.7 }, to: bergenR, mode: 'now', at: null }
    const href = toRuterUrl(j)
    expect(parts(href)).toEqual({
      base: 'https://reise.ruter.no/',
      params: {
        toId: '__NSR-StopPlace-548__',
        toType: '__STOP_PLACE__',
        toName: '__Bergen stasjon__',
        toLongitude: '5.333283',
        toLatitude: '60.390332',
        schedulingMode: '__leave-now__',
        fromId: '__myLocation__',
        fromType: '__LOCATION__',
      },
    })
    expect(href).toContain('toName=__Bergen+stasjon__')
  })

  it('depart with named From', () => {
    const j: Journey = {
      from: { kind: 'stop', stop: osloR },
      to: bergenR,
      mode: 'depart_at',
      at: '2026-10-21T19:43:20.326+02:00',
    }
    expect(parts(toRuterUrl(j)).params).toEqual({
      fromId: '__NSR-StopPlace-337__',
      fromType: '__STOP_PLACE__',
      fromName: '__Oslo S__',
      fromLongitude: '10.753276',
      fromLatitude: '59.910925',
      toId: '__NSR-StopPlace-548__',
      toType: '__STOP_PLACE__',
      toName: '__Bergen stasjon__',
      toLongitude: '5.333283',
      toLatitude: '60.390332',
      schedulingMode: '__depart-at__',
      date: '__2026-10-21T17-43-20.326Z__',
    })
  })

  it('arrive-by uses arrive-by', () => {
    const j: Journey = { from: null, to: bergenR, mode: 'arrive_by', at: '2026-10-24T05:00:59+02:00' }
    const { params } = parts(toRuterUrl(j))
    expect(params.schedulingMode).toBe('__arrive-by__')
    expect(params.date).toBe('__2026-10-24T03-00-59.000Z__')
  })

  it('from omitted', () => {
    const j: Journey = { from: null, to: bergenR, mode: 'now', at: null }
    expect(Object.keys(parts(toRuterUrl(j)).params).sort()).toEqual(
      ['schedulingMode', 'toId', 'toLatitude', 'toLongitude', 'toName', 'toType'],
    )
  })
})

describe('offsets and schema', () => {
  const j: Journey = { from: null, to: bergenR, mode: 'depart_at', at: '2026-12-01T08:00:00+01:00' }

  it('converts a +01:00 offset exactly', () => {
    expect(parts(toEnturUrl(j)).params.date).toBe('1796108400000')
    expect(parts(toRuterUrl(j)).params.date).toBe('__2026-12-01T07-00-00.000Z__')
  })

  it('converts microsecond timestamps to ms', () => {
    const at = '2026-10-21T22:21:00.147694+02:00'
    expect(parts(toEnturUrl({ ...j, at })).params.date).toBe('1792614060147')
    expect(parts(toRuterUrl({ ...j, at })).params.date).toBe('__2026-10-21T20-21-00.147Z__')
  })

  it('rejects a timed mode without a time', () => {
    expect(v.safeParse(Journey, { ...j, at: null }).success).toBe(false)
  })

  it('rejects now with a time', () => {
    expect(v.safeParse(Journey, { ...j, mode: 'now' }).success).toBe(false)
  })
})

describe('special characters', () => {
  const odd = { id: 'NSR:StopPlace:1', name: 'Ålesund & Co+ø/x', lat: 1, lon: 2 }
  const j: Journey = { from: null, to: odd, mode: 'now', at: null }

  it('Entur percent-encodes and round-trips', () => {
    const href = toEnturUrl(j)
    expect(href).toContain('stopLabel=%C3%85lesund%20%26%20Co%2B%C3%B8%2Fx')
    expect(parts(href).params.stopLabel).toBe('Ålesund & Co+ø/x')
  })

  it('Ruter uses + for spaces and %2B for plus, and round-trips', () => {
    const href = toRuterUrl(j)
    expect(href).toContain('toName=__%C3%85lesund+%26+Co%2B%C3%B8%2Fx__')
    expect(parts(href).params.toName).toBe('__Ålesund & Co+ø/x__')
  })
})

describe('buildJourney', () => {
  const base: Decision = {
    injection: false,
    from: null,
    to: bergen.id,
    from_name: null,
    to_name: null,
    from_stop: null,
    to_stop: bergen,
    time: { mode: 'now', at: null },
  }
  const loc = { lat: 59.9357, lon: 10.8062 }

  it('returns null for injection', () => {
    expect(buildJourney({ ...base, injection: true }, null)).toBeNull()
  })

  it('returns null without a destination stop', () => {
    expect(buildJourney({ ...base, to: null, to_stop: null }, null)).toBeNull()
  })

  it('text origin wins over location', () => {
    expect(buildJourney({ ...base, from: oslo.id, from_stop: oslo }, loc)?.from).toEqual({
      kind: 'stop',
      stop: oslo,
    })
  })

  it('uses location when text names no origin', () => {
    expect(buildJourney(base, loc)?.from).toEqual({ kind: 'here', ...loc })
  })

  it('rounds own-position coordinates to 4 decimals in both links', () => {
    const j = buildJourney(base, { lat: 59.93565512, lon: 10.80618477 })!
    expect(j.from).toEqual({ kind: 'here', lat: 59.9357, lon: 10.8062 })
    const entur = parts(toEnturUrl(j)).params
    expect(entur.startLat).toBe('59.9357')
    expect(entur.startLon).toBe('10.8062')
    expect(toRuterUrl(j)).not.toMatch(/59\.9|10\.8/)
  })

  it('omits From when an origin id has no stop', () => {
    expect(buildJourney({ ...base, from: oslo.id, from_stop: null }, loc)?.from).toBeNull()
  })

  it('treats an unparseable time as now', () => {
    const j = buildJourney({ ...base, time: { mode: 'depart_at', at: 'garbage' } }, null)
    expect(j).toMatchObject({ mode: 'now', at: null })
  })

  it('from is null with neither', () => {
    expect(buildJourney(base, null)?.from).toBeNull()
  })

  it('timed mode without a time becomes now', () => {
    const j = buildJourney({ ...base, time: { mode: 'depart_at', at: null } }, null)
    expect(j).toMatchObject({ mode: 'now', at: null })
  })

  it('keeps timed mode with a time', () => {
    const at = '2026-10-21T19:43:20.326+02:00'
    expect(buildJourney({ ...base, time: { mode: 'arrive_by', at } }, null)).toMatchObject({ mode: 'arrive_by', at })
  })
})
