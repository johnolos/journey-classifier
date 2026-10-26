import * as v from 'valibot'
import { describe, expect, it } from 'vitest'

import { SearchInput } from './search'

describe('SearchInput', () => {
  it('trims the query', () => {
    expect(v.parse(SearchInput, { query: '  Oslo  ' })).toEqual({ query: 'Oslo' })
  })

  it.each(['', '   ', 'x'.repeat(501)])('rejects bad query %#', (query) => {
    expect(() => v.parse(SearchInput, { query })).toThrow(/Query must be/)
  })

  it('rounds coordinates to 4 decimals', () => {
    expect(v.parse(SearchInput, { query: 'x', lat: 59.935655, lon: 10.806185 })).toEqual({
      query: 'x',
      lat: 59.9357,
      lon: 10.8062,
    })
  })

  it('accepts no coordinates', () => {
    expect(v.parse(SearchInput, { query: 'x' })).toEqual({ query: 'x' })
  })

  it.each([
    [{ lat: 59.9 }, /both/i],
    [{ lon: 10.8 }, /both/i],
    [{ lat: 91, lon: 10 }, /Latitude/],
    [{ lat: 59, lon: -181 }, /Longitude/],
    [{ lat: '59', lon: 10 }, /Latitude must be a number/],
    [{ lat: 59, lon: null }, /Longitude must be a number/],
    [{ lat: NaN, lon: 10 }, /Latitude/],
  ])('rejects bad coordinates %j', (coords, message) => {
    const r = v.safeParse(SearchInput, { query: 'x', ...coords })
    expect(r.success).toBe(false)
    expect(r.issues?.[0].message).toMatch(message)
  })
})
