import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import { api } from './api'
import { presentError } from '@agentmux/client-ui/error-presentation'

/** Metadata for this mounted reader, never a Session registry or body cache. */
export function useFocusHistorySources(enabled: boolean) {
  const [sources, setSources] = useState<readonly AgentSessionHistoryDescriptor[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden')
  const [revision, retry] = useState(0)
  const loaded = useRef(false)
  const wanted = useRef(0), observed = useRef(-1), generation = useRef(0)
  const active = useRef(false), reading = useRef(false)
  // Invalidation bookkeeping only; the catalogue remains the source of lifecycle facts.
  const known = useRef(new Map<string, { active: boolean; revision: number }>())
  const refresh = useCallback(() => { wanted.current++; retry(value => value + 1) }, [])
  const read = useCallback(function readCatalogue() {
    if (!active.current || reading.current || observed.current >= wanted.current) return
    const episode = generation.current, requested = wanted.current
    const current = () => active.current && generation.current === episode
    reading.current = true; setLoading(true)
    void api.sessions.historySources({ observation: true }).then(({ sources: values, warnings }) => {
      if (!current()) return
      for (const source of values) {
        const key = JSON.stringify([source.hostId, source.agentSessionId])
        if ((known.current.get(key)?.revision ?? -1) < requested)
          known.current.set(key, { active: source.state === 'active', revision: requested })
      }
      loaded.current = true; observed.current = requested
      const failed = new Set(warnings.map(warning => warning.hostId))
      setSources(previous => failed.size ? [...values, ...previous.filter(source => failed.has(source.hostId))] : values)
      setError(warnings.length ? warnings.map(warning => `${warning.hostId}: ${warning.message}`).join(' · ') : null)
    }).catch(cause => {
      if (!current()) return
      observed.current = requested; setError(presentError(cause))
    }).finally(() => {
      reading.current = false
      if (current()) setLoading(false)
      // A lifecycle event during a read belongs to a later observation, never to this result.
      readCatalogue()
    })
  }, [])
  useEffect(() => api.sessions.onEvent(event => {
    if (event.type !== 'core') return
    const core = event.event
    if (core.type !== 'agent-session' && core.type !== 'run-removed') return
    const id = core.type === 'agent-session' ? core.session.agentSessionId : core.agentSessionId
    if (!id) return
    const key = JSON.stringify([event.hostId, id]), isActive = core.type === 'agent-session'
    if (isActive && known.current.get(key)?.active) return
    refresh(); known.current.set(key, { active: isActive, revision: wanted.current })
  }), [refresh])
  useEffect(() => {
    if (!enabled) return
    const update = () => setDocumentVisible(document.visibilityState !== 'hidden')
    update(); document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [enabled])
  useEffect(() => {
    active.current = enabled && documentVisible
    if (active.current) read()
    else setLoading(false)
    return () => { active.current = false; generation.current++ }
  }, [enabled, documentVisible, read])
  useEffect(() => { read() }, [revision, read])
  const available = loaded.current && !loading && error === null
  return useMemo(() => ({ sources, loading, error, refresh, available }), [sources, loading, error, refresh, available])
}
export type FocusHistoryCatalogue = ReturnType<typeof useFocusHistorySources>
