import { useEffect, useState } from 'react'
import type { NativeBrowserVisibility, NativeOverlayRegion } from '../../../shared/native-overlay'
import { api } from '../lib/api'
import { rendererPerformance } from '../lib/renderer-performance'
import { observeNativeOverlayRegions } from '../lib/native-overlay-regions'
import { guardNativeOverlayBlur, sameNativeOverlayDocument } from '../../../shared/native-overlay'
import type { WorkbenchWindowDocument } from '../../../shared/workbench-windows'

/** The only window consumer. Coalesce portal changes while a native frame is in flight. */
export function useNativeOverlayChrome(doc: Document = document, scope?: WorkbenchWindowDocument): string | undefined {
  const [warning, setWarning] = useState<string>()
  const windowId = scope?.windowId, documentGeneration = scope?.documentGeneration
  useEffect(() => {
    const scope = windowId !== undefined && documentGeneration !== undefined ? { windowId, documentGeneration } : undefined
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
            const receipt = await (scope ? api.ui.publishNativeOverlays(next.regions, scope) : api.ui.publishNativeOverlays(next.regions))
            if (!disposed) setWarning(next.warning ?? receipt.warning)
          } catch {
            if (!disposed) setWarning('Native floating content could not be updated. The Browser remains available; close and reopen the floating panel.')
          }
        }
      } finally { draining = false }
    }
    const unsubscribe = api.ui.onNativeOverlayWarning(setWarning, scope)
    let zoomFactor = scope ? Number.NaN : api.ui.getZoomFactor()
    const overlays = observeNativeOverlayRegions(doc.body, () => zoomFactor, (regions, notice) => {
      pending = { regions, ...(notice ? { warning: notice } : {}) }
      void drain()
    }, reading => rendererPerformance.observeOverlay(reading), scope ? { revision: -1, bounds: [], document: scope } : undefined)
    let demandRevision = -1
    const onDemand = (visibility: NativeBrowserVisibility): void => {
      if (disposed || !sameNativeOverlayDocument(visibility.document, scope) || visibility.revision <= demandRevision) return
      if (visibility.zoomFactor !== undefined) {
        if (!Number.isFinite(visibility.zoomFactor) || visibility.zoomFactor <= 0) return
        zoomFactor = visibility.zoomFactor
      }
      if (!Number.isFinite(zoomFactor)) {
        setWarning('The native document scale could not be observed. Original Browser content remains available.')
        return
      }
      demandRevision = visibility.revision
      overlays.setNativeDemand(visibility)
    }
    const unsubscribeDemand = api.ui.onNativeBrowserVisibility(onDemand, scope)
    // Subscribe first. A delayed initial IPC result cannot replace a newer owner event.
    void api.ui.nativeBrowserVisibility(scope).then(onDemand).catch(() => {
      if (!disposed) setWarning('Native Browser visibility could not be observed. Original content remains available; reopen this floating control to check again.')
    })
    const unsubscribeInput = api.ui.onNativeBrowserInput(input => {
      if (sameNativeOverlayDocument(input.document, scope)) overlays.handleNativeInput(input)
    }, scope)
    const releaseBlurGuard = scope && doc.defaultView ? guardNativeOverlayBlur(doc.defaultView, () => api.ui.nativeOverlayFocus(scope)) : () => {}
    return () => {
      disposed = true
      pending = undefined
      overlays.dispose()
      unsubscribeInput()
      unsubscribeDemand()
      unsubscribe()
      releaseBlurGuard()
      void (scope ? api.ui.publishNativeOverlays([], scope) : api.ui.publishNativeOverlays([])).catch(() => {})
    }
  }, [doc, windowId, documentGeneration])
  return warning
}
