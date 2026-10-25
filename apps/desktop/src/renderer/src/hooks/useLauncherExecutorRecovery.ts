import { useEffect, useRef, useState } from 'react'
import type { HostConfig } from '../../../shared/contracts'
import { useAppStore } from '../store'

// A visible input surface gives transient startup failures a bounded opportunity
// to settle. This schedules the existing observation owner, never Agent lifecycle.
const RETRY_DELAYS = [1000, 3000, 10000] as const

export function useLauncherExecutorRecovery(host: HostConfig | undefined, active: boolean, unconfirmed: boolean, source?: 'host') {
  const detect = useAppStore(state => state.detectExecutors)
  const [retrying, setRetrying] = useState(false)
  const scope = active && host ? JSON.stringify([host, source]) : null
  const budget = useRef<{ scope: string | null; attempts: number }>({ scope: null, attempts: 0 })
  useEffect(() => {
    if (budget.current.scope !== scope) budget.current = { scope, attempts: 0 }
    if (!scope || !host || !unconfirmed) { setRetrying(false); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      const delay = RETRY_DELAYS[budget.current.attempts]
      if (cancelled) return
      if (delay === undefined) { setRetrying(false); return }
      setRetrying(true)
      timer = setTimeout(() => {
        budget.current.attempts++
        // Each check keeps its own in-flight/error state in the detector. A slow
        // sibling must not hold the next retry of an already failed configuration.
        void detect(host.id, { onlyUnconfirmed: true, ...(source ? { source } : {}) })
        schedule()
      }, delay)
    }
    schedule()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [scope, unconfirmed, detect])
  return retrying
}
