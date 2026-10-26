import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const decision = (to: string) => ({
  injection: false,
  from: null,
  to,
  from_name: null,
  to_name: to,
  from_stop: null,
  to_stop: null,
  time: { mode: 'now', at: null },
  debug: { ignored: true },
})

type Call = { url: string; raw: unknown; query: string; body: Record<string, unknown>; reply: (status: number, body: unknown) => void; fail: (e: Error) => void }

let calls: Call[]
let inFlight: number
let maxInFlight: number

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  calls = []
  inFlight = 0
  maxInFlight = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: { body: unknown; signal?: AbortSignal }) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          inFlight--
          reject(init.signal!.reason)
        })
        const json = url.endsWith('/classify') ? JSON.parse(init.body as string) : {}
        calls.push({
          url,
          raw: init.body,
          query: json.query,
          body: json,
          reply: (status, body) => {
            inFlight--
            resolve(new Response(JSON.stringify(body), { status }))
          },
          fail: (e) => {
            inFlight--
            reject(e)
          },
        })
      })
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const load = () => import('./queue')
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('queue', () => {
  it('queues first-come first-served, one model call at a time', async () => {
    const { submit, status } = await load()
    const a = submit('A')
    const b = submit('B')
    const c = submit('C')
    await settle()

    expect(status(a)).toEqual({ state: 'running' })
    expect(status(b)).toEqual({ state: 'queued', position: 1 })
    expect(status(c)).toEqual({ state: 'queued', position: 2 })
    expect(calls.map((x) => x.query)).toEqual(['A'])

    calls[0].reply(200, decision('A'))
    await settle()

    expect(status(a)).toMatchObject({ state: 'done', decision: { to: 'A' } })
    expect(status(b)).toEqual({ state: 'running' })
    expect(status(c)).toEqual({ state: 'queued', position: 1 })
    expect(calls.map((x) => x.query)).toEqual(['A', 'B'])
    expect(maxInFlight).toBe(1)
  })

  it('rejects submissions once 15 are waiting, and accepts again when one starts', async () => {
    const { submit, status } = await load()
    const first = submit('R') // runs at once, so does not count as waiting
    const waiting = Array.from({ length: 15 }, (_, i) => submit(`W${i}`))
    await settle()

    expect(() => submit('over')).toThrow(/busy/)
    expect(status(waiting[14])).toEqual({ state: 'queued', position: 15 })

    calls[0].reply(200, decision('R'))
    await settle()

    expect(status(first).state).toBe('done')
    expect(() => submit('again')).not.toThrow()
  })

  it('strips extra fields from the decision', async () => {
    const { submit, status } = await load()
    const a = submit('A')
    await settle()
    calls[0].reply(200, decision('A'))
    await settle()
    const s = status(a)
    expect(s).toEqual({
      state: 'done',
      ms: 0,
      decision: { injection: false, from: null, to: 'A', from_name: null, to_name: 'A', from_stop: null, to_stop: null, time: { mode: 'now', at: null } },
    })
  })

  it('reports how long the model call took, not the time spent queued', async () => {
    const { submit, status } = await load()
    const a = submit('A')
    const b = submit('B')
    await settle()
    await vi.advanceTimersByTimeAsync(4000) // B waits in the queue meanwhile
    calls[0].reply(200, decision('A'))
    await settle()
    await vi.advanceTimersByTimeAsync(2500)
    calls[1].reply(200, decision('B'))
    await settle()
    expect(status(a)).toMatchObject({ state: 'done', ms: 4000 })
    expect(status(b)).toMatchObject({ state: 'done', ms: 2500 })
  })

  it('drops queued ticket whose client stopped polling', async () => {
    const { submit, status } = await load()
    // H holds the model until its 30 s timeout, outliving B's unpolled TTL.
    const h = submit('H')
    const a = submit('A')
    const b = submit('B')
    const c = submit('C')
    await settle()

    for (let i = 0; i < 16; i++) {
      await vi.advanceTimersByTimeAsync(2_000)
      status(h)
      status(a)
      status(c)
    }
    expect(status(b)).toEqual({ state: 'gone' })
    expect(status(h).state).toBe('error')
    expect(status(a)).toEqual({ state: 'running' })

    calls[1].reply(200, decision('A'))
    await settle()

    expect(status(c)).toEqual({ state: 'running' })
    expect(calls.map((x) => x.query)).toEqual(['H', 'A', 'C'])
  })

  it('keeps finished tickets for 60 s, then gone', async () => {
    const { submit, status } = await load()
    const a = submit('A')
    await settle()
    calls[0].reply(200, decision('A'))
    await settle()

    await vi.advanceTimersByTimeAsync(59_000)
    expect(status(a).state).toBe('done')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(status(a)).toEqual({ state: 'gone' })
  })

  it('endpoint failure becomes error state and queue continues', async () => {
    const { submit, status } = await load()
    const a = submit('A')
    const b = submit('B')
    await settle()

    calls[0].fail(new Error('connection refused'))
    await settle()

    expect(status(a)).toEqual({ state: 'error', message: 'Cannot reach the model right now. Please try again in a moment.' })
    expect(status(b)).toEqual({ state: 'running' })
  })

  it('surfaces the endpoint error message on non-200', async () => {
    const { submit, status } = await load()
    const a = submit('A')
    await settle()
    calls[0].reply(500, { error: 'model exploded' })
    await settle()
    expect(status(a)).toEqual({ state: 'error', message: 'model exploded' })
  })

  it('hides a non-JSON failure body behind a friendly message', async () => {
    const { submit, status } = await load()
    const a = submit('A')
    await settle()
    calls[0].reply(502, '<html>Bad gateway</html>')
    await settle()
    expect(status(a)).toEqual({ state: 'error', message: 'The model failed to answer. Please try again.' })
  })

  it("rejects a reply that doesn't match the schema", async () => {
    const { submit, status } = await load()
    const a = submit('A')
    await settle()
    calls[0].reply(200, { ...decision('A'), time: { mode: 'sometime', at: null } })
    await settle()
    expect(status(a)).toEqual({ state: 'error', message: 'Something went wrong. Please try again.' })
  })

  it('a model call that never answers times out and the queue continues', async () => {
    const { submit, status } = await load()
    const a = submit('A')
    const b = submit('B')
    await settle()
    expect(status(a)).toEqual({ state: 'running' })

    for (let i = 0; i < 16; i++) {
      await vi.advanceTimersByTimeAsync(2_000)
      status(b)
    }

    expect(status(a)).toEqual({ state: 'error', message: 'The model took too long to answer. Please try again.' })
    expect(status(b)).toEqual({ state: 'running' })
  })

  it('sends coordinates only when given', async () => {
    const { submit } = await load()
    submit('A', { lat: 59.9357, lon: 10.8062 })
    submit('B')
    await settle()
    expect(calls[0].body).toEqual({ query: 'A', lat: 59.9357, lon: 10.8062 })
    calls[0].reply(200, decision('A'))
    await settle()
    expect(Object.keys(calls[1].body)).toEqual(['query'])
  })

  describe('stop objects', () => {
    const stop = { id: 'NSR:StopPlace:1', name: 'Oslo S', lat: 59.91, lon: 10.75 }
    const run = async (reply: unknown) => {
      const { submit, status } = await load()
      const a = submit('A')
      await settle()
      calls[0].reply(200, reply)
      await settle()
      return status(a)
    }

    it('accepts and exposes stop objects', async () => {
      expect(await run({ ...decision('A'), from_stop: stop, to_stop: stop })).toMatchObject({
        state: 'done',
        decision: { from_stop: stop, to_stop: stop },
      })
    })

    it('accepts a null stop', async () => {
      expect(await run({ ...decision('A'), from_stop: null, to_stop: stop })).toMatchObject({
        state: 'done',
        decision: { from_stop: null, to_stop: stop },
      })
    })

    it('rejects a malformed stop', async () => {
      const { lat: _lat, ...noLat } = stop
      expect((await run({ ...decision('A'), to_stop: noLat })).state).toBe('error')
    })
  })

  it('unknown ticket is gone', async () => {
    const { status } = await load()
    expect(status('nope')).toEqual({ state: 'gone' })
  })

  describe('transcribe jobs', () => {
    const blob = () => new Blob([new Uint8Array(10)], { type: 'audio/webm' })

    it('transcribe shares the FIFO with search', async () => {
      const { submit, submitTranscribe, status } = await load()
      submit('A')
      submit('B')
      const t3 = submitTranscribe(blob())
      await settle()

      expect(status(t3)).toEqual({ state: 'queued', position: 2 })
      expect(calls).toHaveLength(1)

      calls[0].reply(200, decision('A'))
      await settle()
      calls[1].reply(200, decision('B'))
      await settle()

      expect(calls).toHaveLength(3)
      expect(calls[2].url).toMatch(/\/transcribe$/)
      expect((calls[2].raw as ArrayBuffer).byteLength).toBe(10)
      calls[2].reply(200, { text: 'Oslo S' })
      await settle()

      expect(status(t3)).toEqual({ state: 'done', text: 'Oslo S', ms: expect.any(Number) })
      expect(maxInFlight).toBe(1)
    })

    it('transcribe error surfaces journey message', async () => {
      const { submitTranscribe, status } = await load()
      const t = submitTranscribe(blob())
      await settle()
      calls[0].reply(503, { error: 'voice model not installed, see README' })
      await settle()

      expect(status(t)).toEqual({ state: 'error', message: 'voice model not installed, see README' })
    })
  })
})
