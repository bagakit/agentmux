import { useEffect, useState } from 'react'

/** Whole seconds a Stop has been in flight, ticking once a second; null when no Stop is in flight. */
export function useSessionStopElapsed(busy: boolean): string | null {
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) { setStartedAt(null); return }
    const started = Date.now()
    setStartedAt(started); setNow(started)
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [busy])
  return busy && startedAt !== null ? `${Math.max(0, Math.floor((now - startedAt) / 1000))}s` : null
}
