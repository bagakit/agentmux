import { useEffect } from 'react'

/** Code preparation overlaps original source opening; readiness still belongs to the actual reader. */
export function usePreparePdfReader(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const lifetime = new AbortController()
    void import('@agentmux/editor-extensions/pdf').then(module => {
      if (!lifetime.signal.aborted) return module.preparePdfReader(lifetime.signal)
    }).catch(() => {
      // This optional overlap grants no readiness. The actual reader awaits the same imports
      // and presents their failure in its existing in-band error surface.
    })
    return () => lifetime.abort()
  }, [enabled])
}
