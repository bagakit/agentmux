import { useEffect, useState } from 'react'
import type { NativeOverlayRegion } from '../../../shared/native-overlay'
import { api } from '../lib/api'
import { observeNativeOverlayRegions } from '../lib/native-overlay-regions'

/** The only window consumer. Coalesce portal changes while a native frame is in flight. */
export function useNativeOverlayChrome(): string | undefined {
  const [warning, setWarning] = useState<string>()
  useEffect(() => {
    let disposed = false
    let draining = false
    let pending: { regions: NativeOverlayRegion[]; warning?: string } | undefined
    const drain = async (): Promise<void> => {
      if (draining || disposed) return
      draining = true
      try {
        while (pending && !disposed) {
          const next = pending
          pending = undefined
          try {
            const receipt = await api.ui.publishNativeOverlays(next.regions)
            if (!disposed) setWarning(next.warning ?? receipt.warning)
          } catch {
            if (!disposed) setWarning('Native floating content could not be updated. The Browser remains available; close and reopen the floating panel.')
          }
        }
      } finally { draining = false }
    }
    const unsubscribe = api.ui.onNativeOverlayWarning(setWarning)
    const overlays = observeNativeOverlayRegions(document.body, api.ui.getZoomFactor, (regions, notice) => {
      pending = { regions, ...(notice ? { warning: notice } : {}) }
      void drain()
    })
    const unsubscribePointer = api.ui.onNativeBrowserPointer(overlays.dismissAtPoint)
    return () => {
      disposed = true
      pending = undefined
      overlays.dispose()
      unsubscribePointer()
      unsubscribe()
      void api.ui.publishNativeOverlays([]).catch(() => {})
    }
  }, [])
  return warning
}
