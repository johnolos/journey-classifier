import { callModel, callTranscribe, UserError, type Decision, type Loc } from './model'

const QUEUED_TTL_MS = 30_000
const FINISHED_TTL_MS = 60_000
const MAX_QUEUED = 15

type Job = { kind: 'search'; query: string; loc?: Loc } | { kind: 'transcribe'; audio: Blob }
type Result = { decision: Decision } | { text: string }

type Ticket = { job: Job; polledAt: number } & (
  | { state: 'queued' }
  | { state: 'running' }
  | ({ state: 'done'; ms: number; at: number } & Result)
  | { state: 'error'; message: string; at: number }
)

export type Status =
  | { state: 'queued'; position: number }
  | { state: 'running' }
  | ({ state: 'done'; ms: number } & Result)
  | { state: 'error'; message: string }
  | { state: 'gone' }

const tickets = new Map<string, Ticket>() // insertion order = FIFO
let busy = false

function sweep() {
  const now = Date.now()
  for (const [id, t] of tickets) {
    const expired =
      t.state === 'queued'
        ? now - t.polledAt > QUEUED_TTL_MS
        : (t.state === 'done' || t.state === 'error') && now - t.at > FINISHED_TTL_MS
    if (expired) tickets.delete(id)
  }
}

async function pump() {
  if (busy) return
  sweep()
  const next = [...tickets.entries()].find(([, t]) => t.state === 'queued')
  if (!next) return
  const [id, queued] = next
  busy = true
  const base = { job: queued.job, polledAt: queued.polledAt }
  tickets.set(id, { ...base, state: 'running' })
  const started = Date.now()
  try {
    const { job } = queued
    const result: Result =
      job.kind === 'search'
        ? { decision: await callModel(job.query, job.loc) }
        : { text: await callTranscribe(job.audio) }
    tickets.set(id, { ...base, state: 'done', ...result, ms: Date.now() - started, at: Date.now() })
  } catch (e) {
    if (!(e instanceof UserError)) console.error('[queue] job failed:', e)
    const message = e instanceof UserError ? e.message : 'Something went wrong. Please try again.'
    tickets.set(id, { ...base, state: 'error', message, at: Date.now() })
  }
  busy = false
  void pump()
}

function enqueue(job: Job): string {
  sweep()
  const waiting = [...tickets.values()].filter((t) => t.state === 'queued').length
  if (waiting >= MAX_QUEUED) throw new Error('The demo is busy right now. Please try again in a moment.')
  const id = crypto.randomUUID()
  tickets.set(id, { job, polledAt: Date.now(), state: 'queued' })
  void pump()
  return id
}

export const submit = (query: string, loc?: Loc) => enqueue({ kind: 'search', query, loc })
export const submitTranscribe = (audio: Blob) => enqueue({ kind: 'transcribe', audio })

export function status(id: string): Status {
  sweep()
  const t = tickets.get(id)
  if (!t) return { state: 'gone' }
  t.polledAt = Date.now()
  switch (t.state) {
    case 'queued': {
      let position = 0
      for (const [otherId, o] of tickets) {
        if (o.state === 'queued') position++
        if (otherId === id) break
      }
      return { state: 'queued', position }
    }
    case 'running':
      return { state: 'running' }
    case 'done':
      return 'decision' in t
        ? { state: 'done', decision: t.decision, ms: t.ms }
        : { state: 'done', text: t.text, ms: t.ms }
    case 'error':
      return { state: 'error', message: t.message }
  }
}
