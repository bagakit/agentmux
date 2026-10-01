import { useEffect, useState } from 'react'
import type { ToolkitDesktopApi, ToolkitMetricsSnapshot } from '../../../shared/toolkit'

/** UI 只持有自己的可释放 lease；结果与趋势仍由 Toolkit owner 提供。 */
export function usePerformanceObservation(api: Pick<ToolkitDesktopApi, 'observe'>, active: boolean) {
  const [snapshot, setSnapshot] = useState<ToolkitMetricsSnapshot | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  return { snapshot, pending, error }
}
