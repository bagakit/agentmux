import { useCallback, useEffect, useRef, useState } from 'react'
import {
  parseRendererSceneCaptureResult, parseRendererSceneInspection,
  type RendererPerformanceScene, type RendererSceneCaptureResult, type RendererSceneInspection, type RendererV8ProfileTarget,
} from '@agentmux/core/control'
import { api } from './api'

/** Main owns the material. This mounted panel only retains the original request receipt. */
export function usePerformanceScene(visible: boolean) {
  const [material, setMaterial] = useState<{ scene: RendererPerformanceScene; persistence: RendererSceneCaptureResult['persistence'] | null } | null>(null)
  const [inspection, setInspection] = useState<(Omit<RendererSceneInspection, 'scene'> & { captureId: string | null }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true), inFlight = useRef(false), revision = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!visible || inFlight.current) return
    let connected = true
    const originalRevision = revision.current
    setReading(true)
    void (async () => {
      try {
        const input = {}, result = parseRendererSceneInspection(await api.performance.inspectScene(input), input)
        if (!connected || originalRevision !== revision.current) return
        setInspection({ status: result.status, issue: result.issue, captureId: result.scene?.captureId ?? null })
        // A read confirms readability, never the earlier writer's durability ACK.
        setMaterial(previous => {
          // Keep material from a failed/unknown save available across a close/reopen.
          // An older readable file must not silently erase that request's only copy.
          if (previous?.persistence && previous.persistence.status !== 'confirmed') return previous
          if (result.status !== 'available' || !result.scene) return previous
          return previous?.scene.captureId === result.scene.captureId ? previous : { scene: result.scene, persistence: null }
        })
        setError(null)
      } catch (reason) {
        if (connected && originalRevision === revision.current) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (connected && originalRevision === revision.current) setReading(false)
      }
    })()
    return () => { connected = false }
  }, [visible])
  const collect = useCallback(async (target: RendererV8ProfileTarget) => {
    if (inFlight.current) return
    inFlight.current = true; revision.current++; setBusy(true); setReading(false); setError(null)
    const input = { target: { ...target } }
    try {
      const result = parseRendererSceneCaptureResult(await api.performance.captureScene(input), input)
      if (mounted.current) { setMaterial(result); setInspection(null) }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }, [])
  return { scene: material?.scene ?? null, persistence: material?.persistence ?? null,
    inspection, busy, reading, error, collect }
}

export type PerformanceSceneState = ReturnType<typeof usePerformanceScene>
