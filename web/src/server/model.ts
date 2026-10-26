import * as v from 'valibot'

const MODEL_TIMEOUT_MS = 30_000

// Messages safe to show users; the queue replaces any other error with a generic one.
export class UserError extends Error {}

export const Stop = v.object({ id: v.string(), name: v.string(), lat: v.number(), lon: v.number() })

export type Loc = { lat: number; lon: number }

export const round4 = (n: number) => Math.round(n * 1e4) / 1e4

export const Decision = v.object({
  injection: v.boolean(),
  from: v.nullable(v.string()),
  to: v.nullable(v.string()),
  from_name: v.nullable(v.string()),
  to_name: v.nullable(v.string()),
  from_stop: v.nullable(Stop),
  to_stop: v.nullable(Stop),
  time: v.object({
    mode: v.picklist(['now', 'depart_at', 'arrive_by']),
    at: v.nullable(v.string()),
  }),
})
export type Decision = v.InferOutput<typeof Decision>

async function post(path: string, contentType: string, body: string | ArrayBuffer): Promise<unknown> {
  const base = process.env.JOURNEY_URL ?? 'http://127.0.0.1:8001'
  const abort = new AbortController()
  // setTimeout rather than AbortSignal.timeout: fake timers can drive it in tests
  const timer = setTimeout(() => abort.abort(new Error('model endpoint timed out')), MODEL_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      signal: abort.signal,
    }).catch((e: unknown) => {
      console.error('[model] request failed:', e)
      throw new UserError(
        abort.signal.aborted
          ? 'The model took too long to answer. Please try again.'
          : 'Cannot reach the model right now. Please try again in a moment.',
      )
    })
    const json: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const msg = v.safeParse(v.object({ error: v.string() }), json)
      throw new UserError(msg.success ? msg.output.error : 'The model failed to answer. Please try again.')
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

export async function callModel(query: string, loc?: Loc): Promise<Decision> {
  return v.parse(Decision, await post('/classify', 'application/json', JSON.stringify({ query, ...loc })))
}

export async function callTranscribe(audio: Blob): Promise<string> {
  const out = await post('/transcribe', audio.type, await audio.arrayBuffer())
  return v.parse(v.object({ text: v.string() }), out).text
}
