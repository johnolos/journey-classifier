import type { Decision } from './server/model'

export type Formatted =
  | { kind: 'refused' }
  | { kind: 'no-destination' }
  | { kind: 'ok'; rows: { label: string; value: string }[] }

const MODES = { now: 'now', depart_at: 'depart-at', arrive_by: 'arrive-by' } as const

export function formatDecision(d: Decision, hasLocation: boolean): Formatted {
  if (d.injection) return { kind: 'refused' }
  if (d.to === null) return { kind: 'no-destination' }
  const { mode, at } = d.time
  // `at` is already Oslo-offset; slice as written instead of converting zones.
  const [date, time] =
    mode === 'now' ? ['Now', 'Now'] : at ? [at.slice(0, 10), at.slice(11, 16)] : ['—', '—']
  return {
    kind: 'ok',
    rows: [
      { label: 'From', value: d.from_name ?? d.from ?? (hasLocation ? 'Your location' : 'Not specified') },
      { label: 'To', value: d.to_name ?? d.to },
      { label: 'Date', value: date },
      { label: 'Time', value: time },
      { label: 'Mode', value: MODES[mode] },
    ],
  }
}
