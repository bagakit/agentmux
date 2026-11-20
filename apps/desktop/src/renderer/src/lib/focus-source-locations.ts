import { useEffect, useMemo, useState } from 'react'
import type { SpaceSnapshot } from '@agentmux/core'
import type { HostConfig } from '../../../shared/contracts'
import { SOURCE_AGENT_LOCATIONS_UNSUPPORTED, spaceMountKey, type SourceAgentLocation, type SourceAgentLocations } from '../../../shared/space-mount'
import { api } from './api'

export type FocusSourceLocationObservation = {
  host: HostConfig
  value?: SourceAgentLocations
  issue?: { message: string; upgradeRuntimeId?: string }
  reading?: boolean
}
export const originalLocationReaderKey = (hostId: string) => JSON.stringify(['original-agent-locations', hostId])

type MemberLocation = Pick<SourceAgentLocation, 'tab' | 'zone' | 'region'>
function sourceMembership(space: SourceAgentLocation['space'] | null, entries: readonly MemberLocation[]) {
  return JSON.stringify([space?.kind, space?.name, space?.directoryPath, space?.topicId,
    [...new Set(entries.map(({ tab, zone, region }) => JSON.stringify([tab.tabId, zone.zoneId, zone.workspaceId, zone.directoryPath, zone.branch, region.regionId, region.agentSessionId])))].sort()])
}
function relevantMembers(snapshot: SpaceSnapshot, sessionIds: ReadonlySet<string>): MemberLocation[] {
  const tabs = new Map(snapshot.scope.tabs.map(tab => [tab.tabId, tab])), zones = new Map(snapshot.scope.zones.map(zone => [zone.zoneId, zone]))
  return snapshot.scope.regions.flatMap(region => {
    const tab = tabs.get(region.tabId), zone = tab?.zoneId ? zones.get(tab.zoneId) : undefined
    return region.kind === 'agent' && region.execution?.hostId === 'local' &&
      (region.execution.runtimeId === undefined || region.execution.runtimeId === snapshot.reference.runtimeId) &&
      region.agentSessionId && sessionIds.has(region.agentSessionId) && tab?.regionIds.includes(region.regionId) && zone ? [{ tab, zone, region }] : []
  })
}

/** One topology read for the relevant Sessions on this Source. Reconnect only refreshes the affected Source. */
export function useFocusSourceLocations(host: HostConfig, sessionIds: readonly string[], visible: boolean, revision: number,
  observation: SourceAgentLocations | undefined, mountedSourceKeys: ReadonlySet<string>,
  publish: (observation: FocusSourceLocationObservation) => void) {
  const ids = JSON.stringify(sessionIds), [refresh, setRefresh] = useState(0)
  const key = useMemo(() => JSON.parse(ids) as string[], [ids])
  useEffect(() => {
    if (!visible || !key.length) return
    const controller = new AbortController()
    let failed = false, recovered = false, reopening = false
    const reopen = () => {
      if (reopening || controller.signal.aborted) return
      reopening = true
      setRefresh(value => value + 1)
    }
    const unsubscribe = api.sessions.onEvent(({ hostId, event }) => {
      if (hostId !== host.id || controller.signal.aborted) return
      if (event.type === 'connection-state' && event.observationOrigin.boundary === 'consumer-core' && event.state !== 'restored') {
        failed = true
        recovered = false
        publish({ host, issue: { message: event.diagnostic?.message ?? 'The original Source connection is unconfirmed.' } })
        return
      }
      if (!(event.type === 'connection-state' && event.observationOrigin.boundary === 'consumer-core' && event.state === 'restored') &&
          !(event.type === 'session-observation-state' && event.observation.state === 'ready')) return
      recovered = true
      if (failed) reopen()
    }, { kind: 'host-observation', hostId: host.id })
    const expectedRuntimeId = host.kind === 'ssh' ? host.runtimeId : undefined
    publish({ host, reading: true })
    void api.spaceMounts.call('agentLocations', { hostId: host.id, agentSessionIds: key, ...(expectedRuntimeId ? { expectedRuntimeId } : {}) }, controller.signal).then(value => {
      if (!controller.signal.aborted) publish({ host, value })
    }, cause => {
      if (controller.signal.aborted) return
      failed = true
      const failure = cause instanceof Error ? cause as Error & { code?: string; detail?: string } : undefined
      const upgradeRuntimeId = failure?.code === SOURCE_AGENT_LOCATIONS_UNSUPPORTED ? failure.detail : undefined
      publish({ host, issue: { message: failure?.message ?? String(cause), ...(upgradeRuntimeId ? { upgradeRuntimeId } : {}) } })
      if (recovered) reopen()
    })
    return () => { controller.abort(); unsubscribe() }
  }, [host, key, visible, publish, refresh, revision])

  const boundSpaces = [...new Set(observation?.locations.map(location => location.space.spaceId))].sort()
  const watched = observation ? JSON.stringify([observation.runtimeId, boundSpaces.filter(spaceId =>
    !mountedSourceKeys.has(spaceMountKey({ runtimeId: observation.runtimeId, spaceId })))]) : ''
  useEffect(() => {
    if (!visible || !watched || !observation) return
    const [runtimeId, spaceIds] = JSON.parse(watched) as [string, string[]], wanted = new Set(key)
    const controller = new AbortController(), disposals = new Set<() => void>()
    for (const spaceId of spaceIds) {
      const known = observation.locations.filter(location => location.space.spaceId === spaceId && location.region.agentSessionId && wanted.has(location.region.agentSessionId))
      let signature = sourceMembership(known[0]?.space ?? null, known)
      const reportFailure = (message: string) => { if (!controller.signal.aborted) publish({ host, issue: { message } }) }
      void api.spaceMounts.watch({ hostId: host.id, reference: { runtimeId, spaceId } }, event => {
        if (controller.signal.aborted) return
        if (event.type === 'error') { reportFailure(event.error.message); return }
        const snapshot = event.snapshot
        if (snapshot.reference.runtimeId !== runtimeId || snapshot.reference.spaceId !== spaceId) return
        const next = sourceMembership(snapshot.scope.space, relevantMembers(snapshot, wanted))
        if (signature === next) return
        signature = next
        setRefresh(value => value + 1)
      }, controller.signal).then(reply => {
        if (controller.signal.aborted) reply.dispose()
        else disposals.add(reply.dispose)
      }).catch(cause => reportFailure(cause instanceof Error ? cause.message : String(cause)))
    }
    return () => { controller.abort(); for (const dispose of disposals) dispose() }
  }, [host, watched, key, visible, revision, publish])
}
