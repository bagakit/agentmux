import { mintObjectId } from '@agentmux/core/object-id'
import { useCallback, useRef, useState } from 'react'
import { parseRendererHeapSnapshotResult, parseRendererHeapSnapshotInspection,
  type RendererHeapSnapshotCapture, type RendererHeapSnapshotResult, type RendererV8ProfileTarget } from '@agentmux/core/control'
import { api } from './api'

/** The panel retains small original receipts only; Main owns the native file/job. */
export function usePerformanceHeapSnapshot() {
  const [capture, setCapture] = useState<RendererHeapSnapshotCapture | null>(null)
  const [publication, setPublication] = useState<{ captureId: string; value: RendererHeapSnapshotResult['persistence'] } | null>(null)
  const [captureId, setCaptureId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const collect = useCallback(async (target: RendererV8ProfileTarget) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null)
    const input = { target: { ...target }, captureId: mintObjectId() }
    setCaptureId(input.captureId)
    try {
      const result = parseRendererHeapSnapshotResult(await api.performance.captureHeapSnapshot(input), input)
      setCapture(result.capture); setPublication({ captureId: result.capture.captureId, value: result.persistence })
    } catch (reason) {
      // Preserve the attempted ID even when the reply is lost; inspect, never retry.
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { inFlight.current = false; setBusy(false) }
  }, [])
  const inspect = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null)
    const input = captureId ? { captureId } : {}
    try {
      const result = parseRendererHeapSnapshotInspection(await api.performance.inspectHeapSnapshot(input), input)
      if (result.status === 'available') {
        setCapture(result.capture); setCaptureId(result.capture!.captureId)
        // A later readable file does not reconstruct the original write ACK.
      } else setError(result.issue?.message ?? 'No retained heap snapshot.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { inFlight.current = false; setBusy(false) }
  }, [captureId])
  const persistence = publication && publication.captureId === capture?.captureId ? publication.value : null
  const retryPublication = useCallback(async () => {
    if (inFlight.current || !capture || persistence?.phase !== 'before-replace') return
    inFlight.current = true; setBusy(true); setError(null)
    const input = { target: { ...capture.target }, captureId: capture.captureId }
    try {
      const result = parseRendererHeapSnapshotResult(await api.performance.captureHeapSnapshot(input), input)
      setCapture(result.capture); setPublication({ captureId: result.capture.captureId, value: result.persistence })
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { inFlight.current = false; setBusy(false) }
  }, [capture, persistence])
  return { capture, captureId, persistence, busy, error, collect, inspect, retryPublication }
}

export type PerformanceHeapSnapshotState = ReturnType<typeof usePerformanceHeapSnapshot>
