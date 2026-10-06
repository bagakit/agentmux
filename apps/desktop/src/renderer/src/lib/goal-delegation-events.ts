import type { DemandDelegation } from '@agentmux/demand'
import type { RuntimeEvent } from '../../../shared/contracts'

type Registration = { goalId: string; changed(): void }
type Index = Map<string, Set<Registration>>
const key = (hostId: string, id: string) => JSON.stringify([hostId, id])

/** One bridge listener, indexed by original sources/Runs; notifications only request rereads. */
export function createGoalDelegationEvents(ports: {
  sessions(listener: (event: RuntimeEvent) => void): () => void
  demands(listener: (goalIds: string[]) => void): () => void
}) {
  const goals: Index = new Map(), sources: Index = new Map(), runs: Index = new Map(), hosts: Index = new Map()
  let count = 0, release: (() => void) | undefined
  const notify = (registrations: Iterable<Registration>) => {
    // Goal and Mote can display the same original Goal; its shared projection needs
    // only one reread for this notification, regardless of its display occurrences.
    for (const registration of new Map([...registrations].map(item => [item.goalId, item])).values()) registration.changed()
  }
  const event = ({ hostId, event: core }: RuntimeEvent) => {
    if (core.type === 'dispatch-changed') notify(sources.get(key(hostId, core.sourceMessageId)) ?? [])
    else if (core.type === 'process-state' || core.type === 'run-removed') notify(runs.get(key(hostId, core.run.runId)) ?? [])
    else if (core.type === 'connection-state') notify(hosts.get(hostId) ?? [])
  }
  return (goalId: string, delegations: readonly DemandDelegation[], changed: () => void) => {
    const registration: Registration = { goalId, changed }, entries: Array<[Index, string]> = []
    const add = (index: Index, id: string) => {
      const set = index.get(id) ?? new Set(); set.add(registration); index.set(id, set); entries.push([index, id])
    }
    add(goals, goalId)
    for (const delegation of delegations) {
      add(sources, key(delegation.hostId, delegation.sourceMessageId))
      add(runs, key(delegation.hostId, delegation.workerRunId))
      add(hosts, delegation.hostId)
    }
    count++
    if (!release) {
      const session = ports.sessions(event), domain = ports.demands(goalIds => notify(goalIds.flatMap(id => [...goals.get(id) ?? []])))
      release = () => { session(); domain() }
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      for (const [index, id] of entries) { const set = index.get(id); set?.delete(registration); if (!set?.size) index.delete(id) }
      count--
      if (!count && release) { release(); release = undefined }
    }
  }
}
