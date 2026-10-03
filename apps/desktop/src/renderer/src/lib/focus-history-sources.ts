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
  const refresh = useCallback(() => { loaded.current = false; retry(value => value + 1) }, [])
  useEffect(() => {
    if (!enabled) return
    const update = () => setDocumentVisible(document.visibilityState !== 'hidden')
    update(); document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [enabled])
  useEffect(() => {
    if (!enabled || !documentVisible || loaded.current) return
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
  }, [enabled, documentVisible, revision])
  const available = loaded.current && !loading && error === null
  return useMemo(() => ({ sources, loading, error, refresh, available }), [sources, loading, error, refresh, available])
}
export type FocusHistoryCatalogue = ReturnType<typeof useFocusHistorySources>
