import { createServerFn } from '@tanstack/react-start'
import * as v from 'valibot'

import { round4 } from './model'
import { status, submit } from './queue'

export const SearchInput = v.pipe(
  v.object({
    query: v.pipe(
      v.string('Query must be text'),
      v.trim(),
      v.minLength(1, 'Query must be 1-500 characters'),
      v.maxLength(500, 'Query must be 1-500 characters'),
    ),
    lat: v.optional(
      v.pipe(
        v.number('Latitude must be a number'),
        v.minValue(-90, 'Latitude must be between -90 and 90'),
        v.maxValue(90, 'Latitude must be between -90 and 90'),
      ),
    ),
    lon: v.optional(
      v.pipe(
        v.number('Longitude must be a number'),
        v.minValue(-180, 'Longitude must be between -180 and 180'),
        v.maxValue(180, 'Longitude must be between -180 and 180'),
      ),
    ),
  }),
  v.forward(
    v.partialCheck(
      [['lat'], ['lon']],
      (i) => (i.lat === undefined) === (i.lon === undefined),
      'Send both lat and lon, or neither',
    ),
    ['lon'],
  ),
  // Round once, here: ~11 m precision is plenty and keeps raw GPS out of tickets/logs.
  v.transform(({ query, lat, lon }) =>
    lat === undefined || lon === undefined ? { query } : { query, lat: round4(lat), lon: round4(lon) },
  ),
)

// Throw only the first issue's message; valibot's default error is a JSON dump.
export function parse<T extends v.GenericSchema>(schema: T) {
  return (input: unknown): v.InferOutput<T> => {
    const r = v.safeParse(schema, input)
    if (!r.success) throw new Error(r.issues[0].message)
    return r.output
  }
}

export const submitSearch = createServerFn({ method: 'POST' })
  .validator(parse(SearchInput))
  .handler(({ data }) => ({
    ticket: submit(data.query, data.lat === undefined ? undefined : { lat: data.lat, lon: data.lon }),
  }))

export const pollSearch = createServerFn({ method: 'POST' })
  .validator(parse(v.object({ ticket: v.string('Ticket must be text') })))
  .handler(({ data }) => status(data.ticket))
