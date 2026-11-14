import { useMemo } from 'react'
import { agentRegionLocationBindings, ordinaryAgentSpaceMember, useAppStore } from '../store'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import type { OrdinarySpaceMember } from '../lib/ordinary-space-member'
import { mountedSpaceRegions } from '../lib/space-mount-view'
import { mountedSessionFacts } from '../lib/space-mount-sessions'
import { spaceMountKey } from '../../../shared/space-mount'
import { MountedExecutionRelation } from './MountedExecutionRelation'
import { SpaceSourceReaders, useSpaceSourceReader } from './SpaceSourceReaders'

type Foreign = Extract<OrdinarySpaceMember, { kind: 'foreign' }>
type Location = { reference: WorkbenchProjectionSelection; occurrence: Foreign; name: string }
function Source({ locations, visible, onSelect }: { locations: Location[]; visible: boolean; onSelect(reference: WorkbenchProjectionSelection): void }) {
  const target = locations[0]!.occurrence.source, key = spaceMountKey(target.reference)
  const refresh = useSpaceSourceReader(target, visible)
  const observation = useAppStore(state => state.mountedSpaceObservations[key])
  const metadata = useAppStore(state => state.mountedSpaceSessions[key])
  const snapshot = observation?.snapshot
  const regions = useMemo(() => new Map((snapshot ? mountedSpaceRegions(snapshot) : []).map(item =>
    [JSON.stringify([item.region.regionId, item.region.creationOperationId]), item])), [snapshot])
  const facts = useMemo(() => mountedSessionFacts(snapshot, metadata), [snapshot, metadata])
  return <section className="mounted-space-focus__source" aria-label="Original project Agents">
    <header><strong>Original project Agents</strong><button type="button" className="small-button" onClick={refresh}>Refresh source</button></header>
    {observation?.error || metadata?.error ? <p role="status">{observation?.error ?? metadata?.error} Original locations and inputs are kept.</p> : null}
    <ul>{locations.map(location => {
      const original = location.occurrence.member.target
      const candidate = regions.get(JSON.stringify([original.regionId, location.occurrence.creationOperationId]))
      const region = candidate?.region.agentSessionId === original.agentSessionId && candidate.region.execution?.runtimeId === original.runtimeId ? candidate : undefined
      const fact = region && facts.get(region.key), state = fact?.current?.state
      return <li key={JSON.stringify(location.reference)}><button type="button" className="mounted-space-focus__member" onClick={() => onSelect(location.reference)}>
        <strong><MountedExecutionRelation member={region ?? location.occurrence.presentation} target={target} occurrence={fact?.occurrence} />{location.name}</strong><small>{original.agentSessionId} · Execution {original.runtimeId}</small>
        <span>{!observation?.error && !metadata?.error && !fact?.stale && state?.status === 'observed'
          ? state.session.semanticStatus?.state ?? 'Session observed'
          : 'Original Session state unconfirmed'}</span>
      </button></li>
    })}</ul>
  </section>
}

/** Ordinary Focus selects its original Region; source metadata never becomes a local Session. */
export function OrdinarySpaceMemberFocus({ visible, query, onSelect }: { visible: boolean; query: string; onSelect(reference: WorkbenchProjectionSelection): void }) {
  const catalog = useAppStore(workbenchSelectionCatalog), tabs = useAppStore(state => state.tabs)
  const bindings = useAppStore(agentRegionLocationBindings), hosts = useAppStore(state => state.config?.hosts)
  const groups = useMemo(() => {
    const sources = new Map<string, Location[]>()
    if (!visible) return sources
    for (const location of catalog.locations) {
      const tab = tabs[location.tabId], surface = tab?.regions[location.regionId]
      if (!tab || surface?.kind !== 'agent') continue
      const occurrence = ordinaryAgentSpaceMember({ tabId: location.tabId, regionId: location.regionId, sessionId: surface.sessionId })
      if (occurrence.kind !== 'foreign') continue
      const name = tab.name ?? 'Original Agent', target = occurrence.member.target
      if (query && ![name, target.agentSessionId, target.runtimeId].some(value => value.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) continue
      const key = spaceMountKey(occurrence.source.reference), rows = sources.get(key) ?? []
      rows.push({ reference: { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }, occurrence, name })
      sources.set(key, rows)
    }
    return sources
  }, [visible, query, catalog, tabs, bindings, hosts])
  return <SpaceSourceReaders>{[...groups].map(([key, locations]) => <Source key={key} locations={locations} visible={visible} onSelect={onSelect} />)}</SpaceSourceReaders>
}
