import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { api } from '../lib/api'
import { launcherNativeRecap, launcherTimelineRecap } from '../lib/launcher-resume'
import { useAppStore } from '../store'
import { formatRelativeAge } from '../lib/relative-age'
import { sessionPresentationById } from '../lib/session-presentation'

type RecapRead = { key: string; state: 'loading' | 'ready' | 'unavailable'; page: AgentSessionHistoryPage | null }

function transcriptSize(bytes: number): string {
  const unit = bytes < 1024 ? 0 : Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`
}

/** One visible recovery stage's excerpt. Its observation never owns recovery or input. */
export function SessionRecap({ session, visible, context = false }: { session: SessionHistoryReference; visible: boolean; context?: boolean }) {
  const { hostId, agentSessionId } = session
  const identified = Boolean(hostId && agentSessionId)
  const key = JSON.stringify([hostId, agentSessionId])
  const timeline = useAppStore(state => {
    if (!visible || !identified) return undefined
    // Captured Timeline is keyed by SID. The actual projection must confirm its Host;
    // a display workspace or an old Host's capture cannot establish that binding.
    if (context) {
      const projected = sessionPresentationById(state.sessions).get(agentSessionId)
      if (projected?.kind !== 'agent' || projected.control.hostId !== hostId) return undefined
    }
    return state.timelines[agentSessionId]
  })
  const captured = useMemo(() => timeline?.agentSessionId === agentSessionId
    ? launcherTimelineRecap(timeline) : null, [timeline, agentSessionId])
  const request = useRef<{ key: string; promise: Promise<AgentSessionHistoryPage> } | null>(null)
  const [read, setRead] = useState<RecapRead | null>(null)
  const capturedOnly = Boolean(captured && !context)

  useEffect(() => {
    if (!visible || !identified || capturedOnly) return
    // Re-showing this same stage reuses its observation, including failure. It never retries
    // the transport automatically or asks for another page of the native conversation.
    if (request.current?.key !== key) {
      request.current = { key, promise: (async () => {
        const page = await api.sessions.historyPage({ hostId, agentSessionId }, { limit: 6 })
        if (page.agentSessionId !== agentSessionId) throw new Error('Recap belongs to another Session.')
        return page
      })() }
    }
    const observation = request.current.promise
    let current = true
    setRead({ key, state: 'loading', page: null })
    void observation.then(page => {
      if (current) setRead({ key, state: 'ready', page })
    }).catch(() => {
      if (current) setRead({ key, state: 'unavailable', page: null })
    })
    return () => { current = false }
  }, [visible, identified, hostId, agentSessionId, key, capturedOnly])

  const currentRead = read?.key === key ? read : null
  const page = currentRead?.page
  const nativeRecap = useMemo(() => page ? launcherNativeRecap(page) : null, [page])
  const recordedAt = useMemo(() => {
    const times = page?.items.flatMap(item => [item.startedAt, item.completedAt])
      .filter((time): time is number => time !== undefined && Number.isSafeInteger(time) && time >= 0 && time <= 8.64e15) ?? []
    return times.length ? Math.max(...times) : undefined
  }, [page])

  if (!visible) return null
  const recap = captured ?? nativeRecap
  const state = recap ? 'ready' : !identified ? 'unknown' : currentRead?.state ?? 'loading'
  const bytes = page?.sourceSizeBytes
  const size = bytes !== undefined && Number.isSafeInteger(bytes) && bytes >= 0 ? transcriptSize(bytes) : null
  const count = !page ? null : page.items.length === 0 && page.nextCursor !== null ? 'Earlier records available'
    : `${page.items.length}${page.nextCursor === null ? '' : '+'} saved record${page.items.length === 1 && page.nextCursor === null ? '' : 's'}`
  const history = [size, count].filter(Boolean).join(' · ') || (currentRead?.state === 'loading' ? 'Reading saved history…' : 'Unconfirmed')
  return <section className="session-recap" aria-label="Session recap" data-recap-state={state}>
    {recap || context ?
      <details className="session-recap__source">
        <summary aria-label={recap ? `${recap.source === 'Last assistant message' ? 'Last reply' : 'Last request'} source: ${recap.source} · ${recap.origin === 'timeline' ? 'Captured conversation' : 'Native conversation'}` : 'Saved history source'}>{recap ? recap.source === 'Last assistant message' ? 'Last reply' : 'Last request' : 'Saved history'}</summary>
        {recap ? <p>Source: {recap.source} · {recap.origin === 'timeline' ? 'Captured conversation' : 'Native conversation'}</p> : null}
        {context ? <dl className="session-recap__details">
          <dt>Session</dt><dd>{agentSessionId || 'Unconfirmed'}</dd>
          <dt>Host</dt><dd>{hostId || 'Unconfirmed'}</dd>
          {page ? <><dt>History</dt><dd>{page.nextCursor === null ? 'All available saved records were read.' : 'The newest saved records were read; earlier history remains.'} Records include messages and activities.</dd>
            {size ? <><dt>Transcript</dt><dd>{bytes!.toLocaleString()} bytes in the native transcript snapshot, including provider metadata.</dd></> : null}
          </> : null}
          {recordedAt !== undefined ? <><dt>Record time</dt><dd>{new Date(recordedAt).toLocaleString()} · Most recent dated record in the saved excerpt.</dd></> : null}
        </dl> : null}
      </details> : null}
    {recap ? <p className="session-recap__excerpt">{recap.text}</p>
    : <p className="session-recap__notice">{state === 'unknown' ? 'Recap source is unconfirmed.'
      : state === 'unavailable' ? 'Recap could not be read.'
      : state === 'ready' ? 'No saved recap available.' : 'Reading saved conversation…'}</p>}
    {context ? <dl className="session-recap__metadata" aria-label="Saved session context">
      <div><dt>History</dt><dd>{history}</dd></div>
      <div><dt>Last recorded activity</dt><dd>{recordedAt !== undefined
        ? <time dateTime={new Date(recordedAt).toISOString()} title={new Date(recordedAt).toLocaleString()}>{formatRelativeAge(Date.now() - recordedAt, ' ago')}</time>
        : 'Unconfirmed'}</dd></div>
    </dl> : null}
    {context && captured && currentRead?.state === 'unavailable' ? <p className="session-recap__notice">Saved history could not be read. Captured conversation remains available.</p> : null}
  </section>
}
