import { useEffect, useState } from 'react'
import type { NativeBrowserVisibility, NativeOverlayRegion } from '../../../shared/native-overlay'
import { api } from '../lib/api'
import { rendererPerformance } from '../lib/renderer-performance'
import { observeNativeOverlayRegions } from '../lib/native-overlay-regions'
import { guardNativeOverlayBlur, sameNativeOverlayDocument } from '../../../shared/native-overlay'
import type { WorkbenchWindowDocument } from '../../../shared/workbench-windows'
import { MODAL_PRESENTATION_FAILURE_EVENT } from '@agentmux/client-ui/components/Modal'

/** The only window consumer. Coalesce portal changes while a native frame is in flight. */
export function useNativeOverlayChrome(doc: Document = document, scope?: WorkbenchWindowDocument): string | undefined {
  const [warning, setWarning] = useState<string>()
  const windowId = scope?.windowId, documentGeneration = scope?.documentGeneration
  useEffect(() => {
    const scope = windowId !== undefined && documentGeneration !== undefined ? { windowId, documentGeneration } : undefined
    let disposed = false
    let draining = false
    let pending: { regions: NativeOverlayRegion[]; warning?: string } | undefined
    // Publication demand only; Main still owns the actual native focus decision.
    // Keep it until removal is confirmed, including failed or in-flight publication.
    let mayHaveProjection = false
    const releaseBlurGuard = doc.defaultView ? guardNativeOverlayBlur(doc.defaultView, () => mayHaveProjection &&
      (scope ? api.ui.nativeOverlayFocus(scope) : api.ui.nativeOverlayFocus())) : () => {}
    const failModal = (modalId: string, message: string): void => {
      if (disposed || !doc.defaultView) return
      const node = doc.getElementById(modalId)
      if (node?.getAttribute('data-overlay-modal-scope') === modalId) node.dispatchEvent(new doc.defaultView.CustomEvent(MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message } }))
    }
    const drain = async (): Promise<void> => {
      if (draining || disposed) return
      draining = true
      try {
        while (pending && !disposed) {
          const next = pending
          pending = undefined
          try {
            const receipt = await (scope ? api.ui.publishNativeOverlays(next.regions, scope) : api.ui.publishNativeOverlays(next.regions))
            if (!disposed) {
              if (next.regions.length === 0 && receipt.projected === 0 && !pending) mayHaveProjection = false
              setWarning(next.warning ?? receipt.warning)
              for (const failure of receipt.failures ?? []) if (next.regions.some(region => region.modal?.id === failure.modalId)) failModal(failure.modalId, failure.message)
            }
          } catch {
            if (!disposed) {
              const message = 'Native floating content could not be updated. The Browser remains available; retry displaying the original dialog.'
              setWarning(message)
              for (const modalId of new Set(next.regions.flatMap(region => region.modal ? [region.modal.id] : []))) failModal(modalId, message)
            }
          }
        }
      } finally { draining = false }
    }
    const unsubscribe = api.ui.onNativeOverlayWarning((message, modalId) => {
      setWarning(message)
      if (modalId) failModal(modalId, message)
    }, scope)
    let zoomFactor = scope ? Number.NaN : api.ui.getZoomFactor()
    const overlays = observeNativeOverlayRegions(doc.body, () => zoomFactor, (regions, notice) => {
      if (regions.length) mayHaveProjection = true
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
