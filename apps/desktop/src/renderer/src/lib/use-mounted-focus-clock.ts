import { useEffect, useState } from 'react'
import { msUntilSemanticStatusStale } from '@agentmux/core/agent-status'
import type { MountedSessionObservation } from './space-mount-sessions'

/** One deadline for the supplied source metadata; cards and facets share its render. */
export function useMountedFocusClock(observations: Readonly<Record<string, MountedSessionObservation>>, visible: boolean) {
  const [tick, setTick] = useState(Date.now)
  useEffect(() => {
    if (!visible) return
    let next: number | undefined
    for (const observation of Object.values(observations)) {
      if (observation.error || observation.reading) continue
      for (const fact of Object.values(observation.members)) {
        const status = fact.state.status === 'observed' ? fact.state.session.semanticStatus : undefined
        const delay = status && msUntilSemanticStatusStale(status, Date.now())
        if (delay && (next === undefined || delay < next)) next = delay
      }
    }
    if (next !== undefined) { const timer = setTimeout(() => setTick(Date.now()), next); return () => clearTimeout(timer) }
  }, [observations, visible, tick])
  return Math.max(tick, Date.now())
}
