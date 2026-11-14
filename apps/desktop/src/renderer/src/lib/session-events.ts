import type { AgentMuxDesktopApi, RuntimeEvent } from '../../../shared/contracts'

type Listener = (event: RuntimeEvent) => void
type Registration = { listener: Listener }

/** One bridge subscription; terminal bytes only enter their current host/Run consumers. */
export function createRendererSessionEvents(
  subscribe: (listener: Listener) => () => void
): AgentMuxDesktopApi['sessions']['onEvent'] {
  const semantic = new Set<Registration>()
  const hosts = new Map<string, Map<string, Set<Registration>>>()
  const observations = new Map<string, Set<Registration>>()
  let count = 0
  let unsubscribe: (() => void) | null = null

  const dispatch = (event: RuntimeEvent): void => {
    const core = event.event
    const registrations = core.type === 'terminal-output' || core.type === 'terminal-resized' || core.type === 'terminal-snapshot' || core.type === 'attachment-state'
      ? hosts.get(event.hostId)?.get(core.run.runId)
      : core.type === 'connection-state'
        ? [...semantic, ...(observations.get(event.hostId) ?? []), ...[...(hosts.get(event.hostId)?.values() ?? [])].flatMap(readers => [...readers])]
      : core.type === 'session-observation-state'
        ? [...semantic, ...(observations.get(event.hostId) ?? [])]
      : semantic
    if (!registrations) return
    // A callback can subscribe or dispose synchronously. This event belongs to its original snapshot.
    let failed = false
    let failure: unknown
    for (const registration of [...registrations]) {
      try { registration.listener(event) } catch (error) {
        if (!failed) failure = error
        failed = true
      }
    }
    // Preserve the original error channel after delivering the other matching consumers.
    if (failed) throw failure
  }

  return (listener, control) => {
    const registration = { listener }
    const hostId = control?.hostId
    const hostObservation = control?.kind === 'host-observation'
    const runId = control && !hostObservation ? control.run.runId : undefined
    let registrations = semantic
    if (hostObservation) {
      const current = observations.get(control.hostId)
      if (current) registrations = current
      else { registrations = new Set(); observations.set(control.hostId, registrations) }
    } else if (hostId !== undefined && runId !== undefined) {
      let runs = hosts.get(hostId)
      if (!runs) { runs = new Map(); hosts.set(hostId, runs) }
      const current = runs.get(runId)
      if (current) registrations = current
      else { registrations = new Set(); runs.set(runId, registrations) }
    }
    registrations.add(registration)
    count++
    let active = true
    const dispose = (): void => {
      if (!active) return
      active = false
      registrations.delete(registration)
      count--
      if (hostObservation && registrations.size === 0) observations.delete(control.hostId)
      if (hostId !== undefined && runId !== undefined && registrations.size === 0) {
        const runs = hosts.get(hostId)!
        runs.delete(runId)
        if (runs.size === 0) hosts.delete(hostId)
      }
      if (count === 0 && unsubscribe) {
        const release = unsubscribe
        unsubscribe = null
        release()
      }
    }
    if (!unsubscribe) {
      try { unsubscribe = subscribe(dispatch) } catch (error) { dispose(); throw error }
    }
    return dispose
  }
}
