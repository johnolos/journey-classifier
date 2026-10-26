import * as v from 'valibot'
import { describe, expect, it } from 'vitest'

import { TranscribeInput } from './transcribe'

const form = (audio?: Blob) => {
  const f = new FormData()
  if (audio) f.set('audio', audio)
  return f
}
const blob = (size: number, type = 'audio/webm') => new Blob([new Uint8Array(size)], { type })

describe('TranscribeInput', () => {
  it('accepts a small audio blob', () => {
    const out = v.parse(TranscribeInput, form(blob(10, 'audio/webm;codecs=opus')))
    expect(out).toBeInstanceOf(Blob)
    expect(out.size).toBe(10)
  })

  it.each([
    ['empty', form(blob(0)), /empty/],
    ['too long', form(blob(1_000_001)), /too long/],
    ['not audio', form(blob(10, 'text/plain')), /audio/],
    ['missing', form(), /audio/],
  ])('rejects %s', (_name, input, message) => {
    expect(() => v.parse(TranscribeInput, input)).toThrow(message)
  })
})
