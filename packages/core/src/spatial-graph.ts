import { AgentMuxError } from './errors.js';
import { displayLabelDocument, nameTargetKey } from './display-label.js';
export * from './display-label.js';
export * from './spatial-tab-composition.js';
import type { AgentMuxSpaceCatalog, AgentMuxSpaceSelector } from './space-control.js';
export type { AgentMuxProjectGroupFact } from './space-control.js';
import { regionIds, groupIds, regionInDirection, workbenchRegionBounds, leafIdsMatchRecords, type WorkspaceLayout, type WorkbenchViewLayout, type SplitDirection } from './spatial-layout.js';
/** Resource metadata is JSON supplied and interpreted by its original host. */
export type SpatialJson = null | boolean | number | string | SpatialJson[] | {
  [key: string]: SpatialJson;
};
export type AgentMuxSpatialGraph = Omit<AgentMuxSpaceCatalog, 'locations'> & {
  layouts: Record<string, WorkspaceLayout>;
  tabLayouts: Record<string, WorkbenchViewLayout>;
  resources: Record<string, SpatialJson>;
};
export type AgentMuxSpatialState = {
  schemaVersion: 1;
  revision: number;
  graph: AgentMuxSpatialGraph;
  /** Ephemeral producer ACK, never reconstructed from a read or stored in the graph. */
  nameCommit?: { operationId: string; target: import('./display-label.js').AgentMuxNameTarget;
    applied: boolean; diskDurability: 'confirmed' | 'unconfirmed'; issue: string | null };
};
export type AgentMuxSpatialCommit = {
  expectedRevision: number;
  graph: AgentMuxSpatialGraph;
  allowEntityRemoval?: boolean;
  /** Exact organization removals, distinct from spatial entity deletion. */
  removedProjectGroupIds?: string[];
};
export type AgentMuxSpatialResolve = {
  tabId: string;
  regionId: string;
  direction: SplitDirection;
};
function invalid(message: string): never {
  // Reject this malformed write/read, never remove an entity or stop a healthy Run.
  throw new AgentMuxError(message, 'SPATIAL_STATE_INVALID');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('A spatial object is required.');
  return value as Record<string, unknown>;
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.includes('\0'))
    invalid('A stable spatial ID is required.');
}
function nullableId(value: unknown): void { if (value !== null)
  id(value); }
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value))
    invalid('Spatial IDs must be an array.');
  value.forEach(id);
  if (new Set(value).size !== value.length)
    invalid('Spatial IDs cannot repeat in one record.');
}
function tree(value: unknown, leaf: 'groupId' | 'regionId', depth = 0): void {
  if (depth > 256)
    invalid('Spatial topology is too deep.');
  const n = record(value);
  if (n.type === 'leaf') {
    id(n[leaf]);
    return;
  }
  if (n.type !== 'split' || !['horizontal', 'vertical'].includes(String(n.direction)) ||
    typeof n.ratio !== 'number' || !Number.isFinite(n.ratio) || n.ratio <= 0 || n.ratio >= 1)
    invalid('Invalid spatial split.');
  tree(n.first, leaf, depth + 1);
  tree(n.second, leaf, depth + 1);
}
function json(value: unknown, depth = 0): void {
  if (depth > 256)
    invalid('Spatial JSON is too deep.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number' && Number.isFinite(value))
    return;
  if (Array.isArray(value)) {
    value.forEach(v => json(v, depth + 1));
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    Object.values(value).forEach(v => json(v, depth + 1));
    return;
  }
  invalid('Spatial metadata must be finite JSON, without undefined or executable values.');
}
function facts(value: unknown, key: string, check: (entry: Record<string, unknown>) => void): void {
  if (!Array.isArray(value))
    invalid('Spatial facts must be arrays.');
  const ids = new Set<string>();
  for (const item of value) {
    const entry = record(item);
    id(entry[key]);
    const stable = entry[key] as string;
    if (ids.has(stable))
      invalid('Duplicate spatial identity.');
    ids.add(stable);
    check(entry);
  }
}
/** Bulk view writes retain the original Core occurrence address. This preserves
 * pointers even when their admission record is unknown; it does not validate an
 * admission, grant access or decide a Session's current Run. Business owners
 * settle their original operations outside this bulk projection. */
export function retainAdmittedAgentIdentity(graph: AgentMuxSpatialGraph, previous: AgentMuxSpatialGraph | null): AgentMuxSpatialGraph {
  if (!previous) return graph;
  const original = new Map(previous.regions.map(region => [JSON.stringify([region.tabId, region.regionId]), region]));
  graph.regions = graph.regions.map(region => {
    const old = original.get(JSON.stringify([region.tabId, region.regionId]));
    if (region.kind === 'agent' && old?.kind === 'agent' && old.association && old.agentSessionId === null && region.agentSessionId === null) {
      const { creationOperationId: _creation, ...retained } = region;
      return { ...retained, association: { ...old.association }, agentSessionId: null, runId: null, execution: null };
    }
    if (region.kind !== 'agent' || old?.kind !== 'agent' || !old.creationOperationId ||
        !old.agentSessionId || region.agentSessionId !== old.agentSessionId) return region;
    return { ...region, creationOperationId: old.creationOperationId, runId: old.runId,
      execution: old.execution === null ? null : { ...old.execution } };
  });
  return graph;
}
/** Validation preserves unknown references; observation gaps never delete facts. */
export function assertAgentMuxSpatialGraph(value: unknown): asserts value is AgentMuxSpatialGraph {
  const g = record(value);
  if (g.projectGroups !== undefined) {
    facts(g.projectGroups, 'groupId', group => {
      if (typeof group.name !== 'string' || !group.name.trim()) invalid('A project group needs a name.');
      strings(group.projectIds);
      if (group.projectIds.length < 2) invalid('A project group needs at least two Projects.');

    });
  }
  facts(g.spaces, 'spaceId', s => {
    id(s.hostId);
    id(s.directoryPath);
    nullableId(s.projectId);
    if (typeof s.name !== 'string' || !['folder', 'topic', 'mote', 'container'].includes(String(s.kind)))
      invalid('Invalid Space fact.');
  });
  facts(g.zones, 'zoneId', z => {
    id(z.workspaceId);
    nullableId(z.hostId);
    nullableId(z.directoryPath);
    nullableId(z.branch);
    if (!['directory', 'worktree', 'home', 'unknown'].includes(String(z.kind)))
      invalid('Invalid Zone fact.');
  });
  facts(g.tabs, 'tabId', t => {
    id(t.workspaceId);
    nullableId(t.zoneId);
    strings(t.regionIds);
    if (t.name !== null && typeof t.name !== 'string')
      invalid('Invalid Tab name.');
  });
  facts(g.regions, 'regionId', r => {
    id(r.tabId);
    nullableId(r.agentSessionId);
    if (r.creationOperationId !== undefined) id(r.creationOperationId);
    if (r.association !== undefined) {
      const association = record(r.association); id(association.operationId);
      if (Object.keys(association).length !== 1 || r.kind !== 'agent' || r.agentSessionId !== null || r.runId !== null || r.execution !== null || r.creationOperationId !== undefined) invalid('An external association is not a local creation or execution.');
    }
    nullableId(r.runId);
    if (!['agent', 'terminal', 'browser', 'file', 'git', 'git-diff', 'launcher'].includes(String(r.kind)))
      invalid('Invalid Region kind.');
    if (r.execution !== null) {
      const e = record(r.execution);
      id(e.hostId);
      id(e.cwd);
      if (e.runtimeId !== undefined) id(e.runtimeId);
    }
  });
  if (!Array.isArray(g.bindings))
    invalid('Spatial bindings must be an array.');
  const bindings = new Set<string>();
  for (const value of g.bindings) {
    const b = record(value);
    id(b.zoneId);
    id(b.spaceId);
    const key = JSON.stringify([b.zoneId, b.spaceId]);
    if (bindings.has(key))
      invalid('Duplicate spatial binding.');
    bindings.add(key);
  }
  for (const [workspaceId, value] of Object.entries(record(g.layouts))) {
    id(workspaceId);
    const l = record(value);
    tree(l.root, 'groupId');
    id(l.activeGroupId);
    if (!Array.isArray(l.groups))
      invalid('Spatial Groups must be an array.');
    const ids: string[] = [];
    for (const value of l.groups) {
      const group = record(value);
      id(group.id);
      strings(group.tabOrder);
      strings(group.recentTabIds);
      nullableId(group.activeTabId);
      if (group.activeTabId !== null && !group.tabOrder.includes(group.activeTabId as string))
        invalid('Selected Tab must belong to its Group.');
      if (group.recentTabIds.some(t => !(group.tabOrder as string[]).includes(t)))
        invalid('Recent Tabs must belong to their Group.');
      ids.push(group.id);
    }
    const leaves = groupIds(l.root as WorkspaceLayout['root']);
    if (new Set(ids).size !== ids.length || !leafIdsMatchRecords(leaves, ids) || !ids.includes(l.activeGroupId))
      invalid('Group records and topology must agree.');
  }
  const tabs = new Map((g.tabs as AgentMuxSpatialGraph['tabs']).map(t => [t.tabId, t]));
  for (const [tabId, value] of Object.entries(record(g.tabLayouts))) {
    id(tabId);
    const l = record(value);
    tree(l.root, 'regionId');
    id(l.activeRegionId);
    const leaves = regionIds(l.root as WorkbenchViewLayout['root']);
    if (new Set(leaves).size !== leaves.length || !leaves.includes(l.activeRegionId) || (tabs.has(tabId) && !leafIdsMatchRecords(leaves, tabs.get(tabId)!.regionIds)))
      invalid('Invalid Region selection or repeated leaf.');
  }
  json(g);
  record(g.resources);
}
/** Take an independent graph when the input is still owned by a caller. */
export function parseAgentMuxSpatialGraph(value: unknown): AgentMuxSpatialGraph {
  assertAgentMuxSpatialGraph(value);
  return JSON.parse(JSON.stringify(value)) as AgentMuxSpatialGraph;
}
export function spatialCatalog(graph: AgentMuxSpatialGraph, target: AgentMuxSpaceSelector = {}, agentRegions?: ReadonlyMap<string, ReadonlySet<string>>): AgentMuxSpaceCatalog {
  const labels = displayLabelDocument(graph).labels;
  const nameTab = (tab: AgentMuxSpatialGraph['tabs'][number]) => ({ ...tab, nameRevision: labels[nameTargetKey({ kind: 'tab', id: tab.tabId })]?.nameRevision ?? 0 });
  const spacesByZone = new Map<string, string[]>();
  for (const binding of graph.bindings) {
    if (target.spaceId && binding.spaceId !== target.spaceId) continue;
    const spaces = spacesByZone.get(binding.zoneId);
    if (spaces) spaces.push(binding.spaceId);
    else spacesByZone.set(binding.zoneId, [binding.spaceId]);
  }
  const scoped = agentRegions !== undefined || Object.keys(target).length > 0;
  const candidates = scoped ? graph.tabs.filter(tab =>
    (!agentRegions || tab.regionIds.some(regionId => agentRegions.get(tab.tabId)?.has(regionId))) &&
    (!target.tabId || tab.tabId === target.tabId) &&
    (!target.zoneId || tab.zoneId === target.zoneId) &&
    (!target.spaceId || tab.zoneId !== null && spacesByZone.has(tab.zoneId)) &&
    (!target.regionId || tab.regionIds.includes(target.regionId))) : graph.tabs;
  const tabs = new Map(candidates.map(tab => [tab.tabId, tab]));
  const locations: AgentMuxSpaceCatalog['locations'] = [];
  for (const [displayWorkspaceId, layout] of Object.entries(graph.layouts)) {
    if (target.displayWorkspaceId && displayWorkspaceId !== target.displayWorkspaceId) continue;
    for (const group of layout.groups) {
      if (target.groupId && group.id !== target.groupId) continue;
      for (const tabId of group.tabOrder) {
        const tab = tabs.get(tabId);
        if (!tab) continue;
        const spaces = tab.zoneId === null ? undefined : spacesByZone.get(tab.zoneId);
        for (const regionId of agentRegions ? tab.regionIds.filter(id => agentRegions.get(tabId)?.has(id)) : (target.regionId ? [target.regionId] : tab.regionIds))
          for (const spaceId of spaces ?? [null])
            locations.push({ spaceId, zoneId: tab.zoneId, workspaceId: tab.workspaceId,
              displayWorkspaceId, groupId: group.id, tabId, regionId });
      }
    }
  }
  const projectGroups = !agentRegions && graph.projectGroups ? { projectGroups: graph.projectGroups } : {};
  if (!scoped)
    return { ...projectGroups, spaces: graph.spaces, zones: graph.zones, tabs: candidates.map(nameTab), regions: graph.regions, bindings: graph.bindings, locations };
  const placed = target.displayWorkspaceId || target.groupId ? new Set(locations.map(location => location.tabId)) : null;
  const selectedTabs = placed ? candidates.filter(tab => placed.has(tab.tabId)) : candidates;
  const selectedTabIds = new Set(selectedTabs.map(tab => tab.tabId));
  const zoneIds = new Set(selectedTabs.map(t => t.zoneId));
  if (target.zoneId && !target.tabId && !target.regionId)
    zoneIds.add(target.zoneId);
  if (target.spaceId && !target.tabId && !target.regionId && !target.zoneId)
    for (const zoneId of spacesByZone.keys()) zoneIds.add(zoneId);
  const bindings = graph.bindings.filter(b => zoneIds.has(b.zoneId) && (!target.spaceId || b.spaceId === target.spaceId));
  const spaceIds = new Set(bindings.map(binding => binding.spaceId));
  if (target.spaceId) spaceIds.add(target.spaceId);
  return { ...projectGroups, spaces: graph.spaces.filter(space => spaceIds.has(space.spaceId)),
    zones: graph.zones.filter(zone => zoneIds.has(zone.zoneId)), tabs: selectedTabs.map(nameTab),
    regions: graph.regions.filter(region => (!target.regionId || region.regionId === target.regionId) && selectedTabIds.has(region.tabId) &&
      (!agentRegions || agentRegions.get(region.tabId)?.has(region.regionId) && tabs.get(region.tabId)?.regionIds.includes(region.regionId))),
    bindings, locations };
}

/** Read one original Runtime's saved local members. A missing display occurrence does not erase their business binding. */
export function spatialAgentLocationCatalog(graph: AgentMuxSpatialGraph, runtimeId: string, agentSessionIds: readonly string[]): AgentMuxSpaceCatalog {
  const requested = new Set(agentSessionIds), regions = new Map<string, Set<string>>();
  for (const region of graph.regions) {
    if (!region.agentSessionId || !requested.has(region.agentSessionId) || region.kind !== 'agent' || region.execution?.hostId !== 'local' ||
        region.execution.runtimeId !== undefined && region.execution.runtimeId !== runtimeId) continue;
    const ids = regions.get(region.tabId) ?? new Set<string>();
    ids.add(region.regionId); regions.set(region.tabId, ids);
  }
  return spatialCatalog(graph, {}, regions);
}
export function resolveSpatialRegion(graph: AgentMuxSpatialGraph, target: AgentMuxSpatialResolve) {
  const layout = graph.tabLayouts[target.tabId];
  if (!layout || !regionIds(layout.root).includes(target.regionId))
    return { region: null, locations: [] };
  const next = regionInDirection(workbenchRegionBounds(layout.root), target.regionId, target.direction);
  if (next === null) return { region: null, locations: [] };
  return { region: graph.regions.find(r => r.tabId === target.tabId && r.regionId === next) ?? null,
    locations: spatialCatalog(graph, { tabId: target.tabId, regionId: next }).locations };
}

export { AgentMuxSpatialTargetError, exactSpatialDisplayLayout, selectSpatialCatalog, spatialDestination, type AgentMuxSpatialDestination } from './spatial-destination.js';
export * from './spatial-agent-open-contract.js';
