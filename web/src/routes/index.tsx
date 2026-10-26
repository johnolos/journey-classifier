import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { formatDecision } from '../format'
import { buildJourney, toEnturUrl, toRuterUrl } from '../links'
import type { Decision, Loc } from '../server/model'
import type { Status } from '../server/queue'
import { pollSearch, submitSearch } from '../server/search'
import { submitTranscribeFn } from '../server/transcribe'

export const Route = createFileRoute('/')({ component: Home })

const POLL_MS = 500
const MAX_RECORD_MS = 30_000

type View = Status | { state: 'submitting' }
type Geo =
  | { state: 'idle' }
  | { state: 'requesting' }
  | { state: 'ready'; loc: Loc }
  | { state: 'failed'; message: string }

type Voice =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'recording' }
  | { state: 'sending' }
  | { state: 'queued'; position: number }
  | { state: 'transcribing' }
  | { state: 'failed'; message: string }

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

const hasGeolocation = () => typeof navigator !== 'undefined' && !!navigator.geolocation
const hasRecorder = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

// One request in flight per ticket: the next poll is scheduled only after a response.
// Cleanup cancels the pending timer on a new ticket and on unmount.
function usePoll(ticket: string | null, onStatus: (s: Status | { state: 'error'; message: string }) => void) {
  const latest = useRef(onStatus)
  latest.current = onStatus
  useEffect(() => {
    if (!ticket) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const s = await pollSearch({ data: { ticket: ticket! } })
        if (cancelled) return
        latest.current(s)
        if (s.state === 'queued' || s.state === 'running') timer = setTimeout(poll, POLL_MS)
      } catch (err) {
        if (cancelled) return
        latest.current({ state: 'error', message: errMsg(err) })
      }
    }
    timer = setTimeout(poll, POLL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ticket])
}

function Home() {
  const [query, setQuery] = useState('')
  const [ticket, setTicket] = useState<string | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [geo, setGeo] = useState<Geo>({ state: 'idle' })
  // Location sent with the search being shown; links and From row use this, not the live checkbox.
  const [sentLoc, setSentLoc] = useState<Loc | null>(null)
  const [canLocate, setCanLocate] = useState(true)
  // Id of the current geolocation request; callbacks from older requests are ignored.
  const geoReq = useRef(0)
  useEffect(() => () => void geoReq.current++, [])
  useEffect(() => setCanLocate(hasGeolocation()), [])

  const [canRecord, setCanRecord] = useState(true)
  const [voice, setVoice] = useState<Voice>({ state: 'idle' })
  const [voiceTicket, setVoiceTicket] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const starting = useRef(false) // sync guard: voice state lags the getUserMedia await
  const unmounted = useRef(false)
  useEffect(() => setCanRecord(hasRecorder()), [])
  // Release the mic if the page unmounts mid-recording (onstop is detached so it can't send).
  useEffect(() => {
    unmounted.current = false
    return () => {
      unmounted.current = true
      const r = recorder.current
      if (!r) return
      r.onstop = null
      if (r.state !== 'inactive') r.stop()
      r.stream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const busy = view?.state === 'submitting' || view?.state === 'queued' || view?.state === 'running'
  const voiceActive = voice.state !== 'idle' && voice.state !== 'failed'
  const voiceLocked = busy || voice.state === 'starting' || voice.state === 'sending' || voice.state === 'queued' || voice.state === 'transcribing'

  usePoll(ticket, setView)

  usePoll(voiceTicket, (s) => {
    if (s.state === 'queued') setVoice({ state: 'queued', position: s.position })
    else if (s.state === 'running') setVoice({ state: 'transcribing' })
    else if (s.state === 'done' && 'text' in s) {
      if (s.text.trim() === '') setVoice({ state: 'failed', message: "Didn't catch that — try again." })
      else {
        setQuery(s.text)
        setVoice({ state: 'idle' })
      }
    } else if (s.state === 'error') setVoice({ state: 'failed', message: s.message })
    else setVoice({ state: 'failed', message: 'Your recording expired. Please try again.' })
  })

  async function startRecording() {
    if (starting.current) return
    starting.current = true
    setVoiceTicket(null)
    setVoice({ state: 'starting' })
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (unmounted.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
    } catch (err) {
      starting.current = false
      if (unmounted.current) return
      console.error('getUserMedia failed', err)
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      setVoice({ state: 'failed', message: denied ? 'Microphone permission denied.' : 'Could not use the microphone.' })
      return
    }
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      stopTimer = setTimeout(() => rec.state !== 'inactive' && rec.stop(), MAX_RECORD_MS)
      rec.ondataavailable = (e) => chunks.push(e.data)
      rec.onstop = async () => {
        clearTimeout(stopTimer)
        stream.getTracks().forEach((t) => t.stop())
        recorder.current = null
        setVoice({ state: 'sending' })
        try {
          const form = new FormData()
          form.append('audio', new Blob(chunks, { type: rec.mimeType }))
          const r = await submitTranscribeFn({ data: form })
          setVoiceTicket(r.ticket)
        } catch (err) {
          setVoice({ state: 'failed', message: errMsg(err) })
        }
      }
      recorder.current = rec
      rec.start()
    } catch (err) {
      console.error('MediaRecorder failed', err)
      clearTimeout(stopTimer)
      recorder.current = null
      stream.getTracks().forEach((t) => t.stop())
      starting.current = false
      if (!unmounted.current) setVoice({ state: 'failed', message: 'Could not use the microphone.' })
      return
    }
    starting.current = false
    setVoice({ state: 'recording' })
  }

  function onSpeak() {
    if (voice.state === 'recording') recorder.current?.stop()
    else void startRecording()
  }

  function onToggleLocation(checked: boolean) {
    const id = ++geoReq.current
    if (!checked) {
      setGeo({ state: 'idle' })
      return
    }
    setGeo({ state: 'requesting' })
    navigator.geolocation.getCurrentPosition(
      (p) =>
        id === geoReq.current &&
        setGeo({ state: 'ready', loc: { lat: p.coords.latitude, lon: p.coords.longitude } }),
      (err) =>
        id === geoReq.current &&
        setGeo({
          state: 'failed',
          message: err.code === err.PERMISSION_DENIED ? 'Location permission denied.' : 'Could not get your location.',
        }),
      { timeout: 10_000 },
    )
  }

  async function onSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    setTicket(null)
    setView({ state: 'submitting' })
    const loc = geo.state === 'ready' ? geo.loc : null
    setSentLoc(loc)
    try {
      const r = await submitSearch({ data: loc ? { query, lat: loc.lat, lon: loc.lon } : { query } })
      setTicket(r.ticket)
    } catch (err) {
      setView({ state: 'error', message: errMsg(err) })
    }
  }

  return (
    <main>
      <h1>Journey demo</h1>
      <form onSubmit={onSubmit}>
        <label htmlFor="query">Where do you want to go?</label>{' '}
        <input
          id="query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={500}
          disabled={busy}
        />{' '}
        <button type="submit" disabled={busy || geo.state === 'requesting' || query.trim() === '' || voiceActive}>
          Search
        </button>{' '}
        {canRecord ? (
          <button type="button" onClick={onSpeak} disabled={voiceLocked}>
            {voice.state === 'recording' ? '■ Stop' : '🎤 Speak'}
          </button>
        ) : (
          <small> (mic needs https or localhost)</small>
        )}
        <div>
          <label>
            <input
              type="checkbox"
              checked={geo.state === 'requesting' || geo.state === 'ready'}
              disabled={!canLocate || busy}
              onChange={(e) => onToggleLocation(e.target.checked)}
            />{' '}
            Use my location
          </label>
          {!canLocate && <small> (needs https or localhost)</small>}
          <small role="status">{geo.state === 'requesting' && ' Locating…'}</small>
        </div>
      </form>
      {geo.state === 'failed' && <p role="alert">{geo.message}</p>}
      {voice.state === 'failed' && <p role="alert">{voice.message}</p>}
      <div role="status" aria-live="polite">
        {(busy || voice.state === 'sending' || voice.state === 'queued' || voice.state === 'transcribing') && (
          <span className="spinner" aria-hidden="true" />
        )}
        {voice.state === 'recording' && 'Listening…'}
        {voice.state === 'sending' && 'Sending…'}
        {voice.state === 'queued' && `You're #${voice.position} in line`}
        {voice.state === 'transcribing' && 'Transcribing…'}
        {view?.state === 'submitting' && 'Sending…'}
        {view?.state === 'queued' && `You're #${view.position} in line`}
        {view?.state === 'running' && 'Thinking…'}
        {view?.state === 'done' && 'decision' in view && (
          <>
            <Result decision={view.decision} loc={sentLoc} />
            <p>
              <small>Answered in {(view.ms / 1000).toFixed(1)} s</small>
            </p>
          </>
        )}
      </div>
      {view?.state === 'error' && <p role="alert">Error: {view.message}</p>}
      {view?.state === 'gone' && (
        <p role="alert">Your search expired. Please try again.</p>
      )}
    </main>
  )
}

function Result({ decision, loc }: { decision: Decision; loc: Loc | null }) {
  const f = formatDecision(decision, loc !== null)
  if (f.kind === 'refused') return <p>Can't help with that — ask for a journey.</p>
  if (f.kind === 'no-destination') return <p>Couldn't find a destination in that.</p>
  const journey = buildJourney(decision, loc)
  return (
    <>
      <dl>
        {f.rows.map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      {journey && (
        <p>
          <a href={toEnturUrl(journey)} target="_blank" rel="noopener">
            Open in Entur ↗
          </a>{' '}
          <a href={toRuterUrl(journey)} target="_blank" rel="noopener">
            Open in Ruter ↗
          </a>
        </p>
      )}
    </>
  )
}
