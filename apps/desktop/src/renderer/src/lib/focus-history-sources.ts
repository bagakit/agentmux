import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import { api } from './api'
import { presentError } from './error-presentation'

/** Metadata for this mounted reader, never a Session registry or body cache. */
export function useFocusHistorySources(enabled: boolean) {
  const [sources, setSources] = useState<readonly AgentSessionHistoryDescriptor[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, retry] = useState(0)
  const loaded = useRef(false)
  const refresh = useCallback(() => { loaded.current = false; retry(value => value + 1) }, [])
  useEffect(() => {
    if (!enabled || loaded.current) return
    let current = true
    setLoading(true); setError(null)
    void api.sessions.historySources().then(values => {
      if (!current) return
      if (values.length > 512) throw new Error('Retained input sources exceed the Core catalogue limit.')
      loaded.current = true; setSources(values)
    }).catch(cause => {
      if (!current) return
      loaded.current = true; setError(presentError(cause))
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [enabled, revision])
  return { sources, loading, error, refresh }
}
