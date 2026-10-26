import * as v from 'valibot'
import { round4, Stop, type Decision, type Loc } from './server/model'

const From = v.nullable(
  v.variant('kind', [
    v.object({ kind: v.literal('stop'), stop: Stop }),
    v.object({ kind: v.literal('here'), lat: v.number(), lon: v.number() }),
  ]),
)

export const Journey = v.variant('mode', [
  v.object({ mode: v.literal('now'), at: v.null(), from: From, to: Stop }),
  v.object({ mode: v.picklist(['depart_at', 'arrive_by']), at: v.string(), from: From, to: Stop }),
])
export type Journey = v.InferOutput<typeof Journey>
type StopT = v.InferOutput<typeof Stop>

export function buildJourney(d: Decision, loc: Loc | null): Journey | null {
  if (d.injection || d.to_stop === null) return null
  const from: Journey['from'] =
    d.from !== null
      ? d.from_stop
        ? { kind: 'stop', stop: d.from_stop }
        : null
      : loc
        ? { kind: 'here', lat: round4(loc.lat), lon: round4(loc.lon) }
        : null
  const timed = d.time.mode !== 'now' && d.time.at !== null && !Number.isNaN(Date.parse(d.time.at))
  return v.parse(Journey, {
    from,
    to: d.to_stop,
    mode: timed ? d.time.mode : 'now',
    at: timed ? d.time.at : null,
  })
}

const enc = encodeURIComponent
const query = (pairs: [string, string | number][], value: (k: string, x: string) => string) =>
  pairs.map(([k, x]) => `${k}=${value(k, String(x))}`).join('&')

const ENTUR_MODES = 'rail,tram,bus,coach,water,car_ferry,metro,flytog,flybuss'

export function toEnturUrl(j: Journey): string {
  const stop = (p: string, s: StopT): [string, string | number][] => [
    [`${p}Id`, s.id],
    [`${p}Label`, s.name],
    [`${p}Lat`, s.lat],
    [`${p}Lon`, s.lon],
  ]
  const pairs: [string, string | number][] = [
    ['transportModes', ENTUR_MODES],
    ['tripMode', 'oneway'],
    ['timepickerMode', j.mode === 'arrive_by' ? 'arriveBefore' : 'departAfter'],
  ]
  if (j.at !== null) pairs.push(['date', Date.parse(j.at)])
  if (j.from?.kind === 'stop') pairs.push(...stop('start', j.from.stop))
  if (j.from?.kind === 'here')
    pairs.push(['startLabel', 'Min posisjon'], ['startLat', j.from.lat], ['startLon', j.from.lon])
  pairs.push(...stop('stop', j.to))
  return `https://entur.no/reiseresultater?${query(pairs, (_, x) => enc(x))}`
}

export function toRuterUrl(j: Journey): string {
  const stop = (p: string, s: StopT): [string, string | number][] => [
    [`${p}Id`, s.id.replaceAll(':', '-')],
    [`${p}Type`, 'STOP_PLACE'],
    [`${p}Name`, s.name],
    [`${p}Longitude`, s.lon],
    [`${p}Latitude`, s.lat],
  ]
  const pairs: [string, string | number][] = []
  if (j.from?.kind === 'stop') pairs.push(...stop('from', j.from.stop))
  if (j.from?.kind === 'here') pairs.push(['fromId', 'myLocation'], ['fromType', 'LOCATION'])
  pairs.push(...stop('to', j.to))
  pairs.push([
    'schedulingMode',
    j.at === null ? 'leave-now' : j.mode === 'arrive_by' ? 'arrive-by' : 'depart-at',
  ])
  if (j.at !== null) {
    const [day, time] = new Date(Date.parse(j.at)).toISOString().split('T')
    pairs.push(['date', `${day}T${time.replaceAll(':', '-')}`])
  }
  return `https://reise.ruter.no/?${query(pairs, (k, x) => {
    const e = enc(x).replaceAll('%20', '+')
    return /(Longitude|Latitude)$/.test(k) ? e : `__${e}__`
  })}`
}
