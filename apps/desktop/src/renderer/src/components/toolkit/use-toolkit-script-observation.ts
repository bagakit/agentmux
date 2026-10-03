import { useEffect, useRef, useState } from 'react'
import type { ToolkitDesktopApi, ToolkitScriptSnapshot, ToolkitSnapshot } from '../../../../shared/toolkit'
import { presentError } from '@agentmux/client-ui/error-presentation'

/** Selected, visible reading only. Closing releases this reader and never calls stop. */
export function useToolkitScriptObservation(api: Pick<ToolkitDesktopApi, 'get' | 'observe'>, toolId: string, active: boolean) {
  const [reading, setReading] = useState<{ toolId: string; snapshot: ToolkitScriptSnapshot | null; sourceReason: string }>({ toolId, snapshot: null, sourceReason: '' })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  function accept(value: ToolkitSnapshot) {
    if (value.toolId !== toolId || value.kind !== 'script' && value.kind !== 'package-unavailable') throw new Error('Another tool returned this result.')
    const snapshot = value.kind === 'script' ? value : value.retained
    setReading(current => ({ toolId, sourceReason: value.kind === 'package-unavailable' ? value.reason : '',
      snapshot: snapshot && current.toolId === toolId && current.snapshot && current.snapshot.sequence > snapshot.sequence ? current.snapshot : snapshot }))
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
  return { snapshot: reading.toolId === toolId ? reading.snapshot : null, sourceReason: reading.toolId === toolId ? reading.sourceReason : '', pending, error, check }
}
