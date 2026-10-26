import { createServerFn } from '@tanstack/react-start'
import * as v from 'valibot'

import { submitTranscribe } from './queue'
import { parse } from './search'

// keep in sync with MAX_AUDIO in journey_server.py
const MAX_AUDIO_BYTES = 1_000_000

const Audio = v.pipe(
  v.blob('Recording must be audio'),
  v.minSize(1, 'Recording is empty'),
  v.maxSize(MAX_AUDIO_BYTES, 'Recording is too long'),
  v.check((b) => b.type.startsWith('audio/'), 'Recording must be audio'),
)

export const TranscribeInput = v.pipe(
  v.instance(FormData, 'Recording must be audio'),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    const r = v.safeParse(Audio, dataset.value.get('audio'))
    if (r.success) return r.output
    addIssue({ message: r.issues[0].message })
    return NEVER
  }),
)

export const submitTranscribeFn = createServerFn({ method: 'POST' })
  .validator(parse(TranscribeInput))
  .handler(({ data }) => ({ ticket: submitTranscribe(data) }))
