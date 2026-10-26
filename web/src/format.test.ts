import { describe, expect, it } from 'vitest'

import { formatDecision } from './format'
import type { Decision } from './server/model'

const base: Decision = {
  injection: false,
  from: 'NSR:StopPlace:1',
  to: 'NSR:StopPlace:2',
  from_name: 'Oslo S',
  to_name: 'Bergen stasjon',
  from_stop: null,
  to_stop: null,
  time: { mode: 'now', at: null },
}

const rows = (d: Decision, hasLocation = false) => {
  const r = formatDecision(d, hasLocation)
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`)
  return r.rows
}

describe('formatDecision', () => {
  it('refuses injections, even with a destination', () => {
    expect(formatDecision({ ...base, injection: true }, false)).toEqual({ kind: 'refused' })
  })

  it('refuses injections without a destination', () => {
    expect(formatDecision({ ...base, injection: true, to: null, to_name: null }, false)).toEqual({
      kind: 'refused',
    })
  })

  it('reports a missing destination', () => {
    expect(formatDecision({ ...base, to: null, to_name: null }, false)).toEqual({ kind: 'no-destination' })
  })

  it('shows "Your location" when from is null and a location was sent', () => {
    expect(rows({ ...base, from: null, from_name: null }, true)[0]).toEqual({
      label: 'From',
      value: 'Your location',
    })
  })

  it('shows "Not specified" when from is null and no location was sent', () => {
    expect(rows({ ...base, from: null, from_name: null }, false)[0]).toEqual({
      label: 'From',
      value: 'Not specified',
    })
  })

  it('prefers a named origin whether or not a location was sent', () => {
    expect(rows(base, true)[0].value).toBe('Oslo S')
    expect(rows(base, false)[0].value).toBe('Oslo S')
  })

  it('formats depart_at date, time and mode as written', () => {
    expect(
      rows({ ...base, time: { mode: 'depart_at', at: '2026-10-22T08:00:00+02:00' } }),
    ).toEqual([
      { label: 'From', value: 'Oslo S' },
      { label: 'To', value: 'Bergen stasjon' },
      { label: 'Date', value: '2026-10-22' },
      { label: 'Time', value: '08:00' },
      { label: 'Mode', value: 'depart-at' },
    ])
  })

  it('formats arrive_by mode', () => {
    expect(
      rows({ ...base, time: { mode: 'arrive_by', at: '2026-10-22T17:30:00+02:00' } }).slice(2),
    ).toEqual([
      { label: 'Date', value: '2026-10-22' },
      { label: 'Time', value: '17:30' },
      { label: 'Mode', value: 'arrive-by' },
    ])
  })

  it('shows Now for date and time in now mode', () => {
    expect(rows(base).slice(2)).toEqual([
      { label: 'Date', value: 'Now' },
      { label: 'Time', value: 'Now' },
      { label: 'Mode', value: 'now' },
    ])
  })

  it('shows a dash, not Now, when a timed mode has no time', () => {
    expect(rows({ ...base, time: { mode: 'depart_at', at: null } }).slice(2)).toEqual([
      { label: 'Date', value: '—' },
      { label: 'Time', value: '—' },
      { label: 'Mode', value: 'depart-at' },
    ])
  })

  it('uses the stop ID when the name is missing', () => {
    expect(rows({ ...base, to_name: null })[1].value).toBe('NSR:StopPlace:2')
  })
})
