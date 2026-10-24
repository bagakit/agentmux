import { useCallback, useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import type { ToolkitDesktopApi, ToolkitMetricsSnapshot } from '../../../shared/toolkit'

/** UI 只持有自己的可释放 lease；结果与趋势仍由 Toolkit owner 提供。 */
export function usePerformanceObservation(api: Pick<ToolkitDesktopApi, 'observe' | 'run'>, active: boolean) {
  const [snapshot, setSnapshot] = useState<ToolkitMetricsSnapshot | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recovering, setRecovering] = useState(false)
  const recovery = useRef<{ invocationId: string; expectedExecutionId: string } | null>(null)
  const recoveryPending = useRef(false)
  const observedExecutionId = useRef<string | null>(null)
  const startNewObservation = useCallback(async () => {
    if (recoveryPending.current || snapshot?.state !== 'unknown' || snapshot.run !== null || !snapshot.executionId) return
    const input = recovery.current?.expectedExecutionId === snapshot.executionId ? recovery.current
      : { invocationId: mintObjectId(), expectedExecutionId: snapshot.executionId }
    recovery.current = input; recoveryPending.current = true; setRecovering(true); setError(null)
    try {
      const value = await api.run('performance', input)
      if (value.kind !== 'metrics' || value.toolId !== 'performance' || value.executionId !== input.invocationId)
        throw new Error('Another execution returned this recovery.')
      // The stream may already hold newer facts for this same new execution.
      setSnapshot(current => current?.executionId === input.expectedExecutionId ? value : current)
    } catch (reason) {
      if (observedExecutionId.current === input.expectedExecutionId)
        setError(reason instanceof Error ? reason.message : String(reason))
    }
    finally { recoveryPending.current = false; setRecovering(false) }
  }, [api, snapshot])
  useEffect(() => {
    if (!active) { setPending(false); return }
    let connected = true, ended = false
    let lease: { dispose(): void } | undefined
    setPending(true); setError(null)
    try {
      // preload 同步返回跨桥可代理的 dispose；异步建立/失败仍归它持有。
      lease = api.observe('performance', value => {
        if (!connected || ended) return
        if (value.kind !== 'metrics' || value.toolId !== 'performance') { setPending(false); setError('Another tool returned this observation.'); return }
        observedExecutionId.current = value.executionId
        setSnapshot(value); setPending(false)
      }, reason => {
        if (!connected) return
        ended = true; setPending(false); setError(reason || 'The observation ended.')
        lease?.dispose()
      })
      if (ended) lease.dispose()
    } catch (reason) {
      ended = true; setPending(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
    return () => { connected = false; lease?.dispose() }
  }, [api, active])
  return { snapshot, pending, error, recovering, startNewObservation }
}
