import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { api } from '../lib/api'
import { launcherNativeRecap, launcherTimelineRecap, type LauncherRecap } from '../lib/launcher-resume'
import { useAppStore } from '../store'

type RecapRead = { key: string; state: 'loading' | 'ready' | 'unavailable'; recap: LauncherRecap | null }

/** One visible recovery stage's excerpt. Its observation never owns recovery or input. */
export function SessionRecap({ session, visible }: { session: SessionHistoryReference; visible: boolean }) {
  const { hostId, agentSessionId } = session
  const identified = Boolean(hostId && agentSessionId)
  const key = JSON.stringify([hostId, agentSessionId])
  const timeline = useAppStore(state => visible && identified ? state.timelines[agentSessionId] : undefined)
  const captured = useMemo(() => timeline?.agentSessionId === agentSessionId
    ? launcherTimelineRecap(timeline) : null, [timeline, agentSessionId])
  const request = useRef<{ key: string; promise: Promise<LauncherRecap | null> } | null>(null)
  const [read, setRead] = useState<RecapRead | null>(null)

  useEffect(() => {
    if (!visible || !identified || captured) return
    // Re-showing this same stage reuses its observation, including failure. It never retries
    // the transport automatically or asks for another page of the native conversation.
    if (request.current?.key !== key) {
      request.current = { key, promise: (async () => {
        const page = await api.sessions.historyPage({ hostId, agentSessionId }, { limit: 6 })
        if (page.agentSessionId !== agentSessionId) throw new Error('Recap belongs to another Session.')
        return launcherNativeRecap(page)
      })() }
    }
    const observation = request.current.promise
    let current = true
    setRead({ key, state: 'loading', recap: null })
    void observation.then(recap => {
      if (current) setRead({ key, state: 'ready', recap })
    }).catch(() => {
      if (current) setRead({ key, state: 'unavailable', recap: null })
    })
    return () => { current = false }
  }, [visible, identified, hostId, agentSessionId, key, captured?.text])

  if (!visible) return null
  const currentRead = read?.key === key ? read : null
  const recap = captured ?? currentRead?.recap
  const state = recap ? 'ready' : !identified ? 'unknown' : currentRead?.state ?? 'loading'
  return <section className="session-recap" aria-label="Session recap" data-recap-state={state}>
    {recap ? <>
      <details className="session-recap__source">
        <summary aria-label={`${recap.source === 'Last assistant message' ? 'Last reply' : 'Last request'} source: ${recap.source} · ${recap.origin === 'timeline' ? 'Captured conversation' : 'Native conversation'}`}>{recap.source === 'Last assistant message' ? 'Last reply' : 'Last request'}</summary>
        <p>Source: {recap.source} · {recap.origin === 'timeline' ? 'Captured conversation' : 'Native conversation'}</p>
      </details>
      <p className="session-recap__excerpt">{recap.text}</p>
    </> : <p className="session-recap__notice">{state === 'unknown' ? 'Recap source is unconfirmed.'
      : state === 'unavailable' ? 'Recap could not be read.'
      : state === 'ready' ? 'No saved recap available.' : 'Reading saved conversation…'}</p>}
  </section>
}
