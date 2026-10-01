import { useEffect, useRef, useState } from 'react'
import type { ToolkitDesktopApi, ToolkitScriptSnapshot, ToolkitSnapshot } from '../../../../shared/toolkit'
import { presentError } from '../../lib/error-presentation'

/** Selected, visible reading only. Closing releases this reader and never calls stop. */
export function useToolkitScriptObservation(api: Pick<ToolkitDesktopApi, 'get' | 'observe'>, toolId: string, active: boolean) {
  const [snapshot, setSnapshot] = useState<ToolkitScriptSnapshot | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  function accept(value: ToolkitSnapshot) {
    if (value.kind !== 'script' || value.toolId !== toolId) throw new Error('Another tool returned this result.')
    setSnapshot(current => !current || current.toolId !== toolId || value.sequence >= current.sequence ? value : current)
  }
  useEffect(() => {
    const generation = ++epoch.current
    if (!active) { setPending(false); return }
    let ended = false
    let lease: { dispose(): void } | undefined
    setPending(true); setError('')
    try {
      lease = api.observe(toolId, value => {
        if (generation !== epoch.current || ended) return
        try { accept(value); setPending(false) } catch (cause) { setPending(false); setError(presentError(cause)) }
      }, reason => {
        if (generation !== epoch.current) return
        ended = true; setPending(false); setError(reason || 'The result could not be confirmed.'); lease?.dispose()
      })
      if (ended) lease.dispose()
    } catch (cause) { setPending(false); setError(presentError(cause)) }
    return () => { ++epoch.current; lease?.dispose() }
  }, [api, toolId, active])
  async function check() {
    const generation = epoch.current
    setPending(true)
    try {
      const value = await api.get(toolId)
      if (generation !== epoch.current) return
      accept(value); setError('')
    } catch (cause) { if (generation === epoch.current) setError(presentError(cause)) }
    finally { if (generation === epoch.current) setPending(false) }
  }
  return { snapshot: snapshot?.toolId === toolId ? snapshot : null, pending, error, check }
}
