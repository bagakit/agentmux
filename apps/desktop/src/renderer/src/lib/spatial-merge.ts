import { AGENTMUX_DISPLAY_LABEL_RESOURCE, AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE, type AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph';
import { groupIds, leafIdsMatchRecords, regionIds, type TabGroup, type WorkbenchViewLayout, type WorkspaceLayout } from '@agentmux/layout';

/** Compare persisted facts without treating JSON property order as a content change. */
export function sameSpatialValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length &&
    keys.every(key => Object.hasOwn(right, key) && sameSpatialValue(left[key], right[key]));
}

/** One key that two writers changed to different values. The committed graph keeps the remote value. */
export type SpatialConflict = { key: string };
export type SpatialMerge = { graph: AgentMuxSpatialGraph; conflicts: SpatialConflict[] };

type Layout = WorkspaceLayout;
type TabLayout = WorkbenchViewLayout;
type Tab = AgentMuxSpatialGraph['tabs'][number];
const ENTITY_FIELDS = [['spaces', 'spaceId'], ['zones', 'zoneId'], ['tabs', 'tabId'], ['regions', 'regionId'], ['bindings', null], ['projectGroups', 'groupId']] as const;

/**
 * Three-way merge of one value. Local is unchanged only when it equals both the base and an attempted
 * write whose acknowledgement was lost (`middle`), so returning to the base after such a write is still a
 * local edit. Local wins whenever remote matches any of base, middle or local. Only a remote value that
 * differs from all three is a conflict: that key keeps the remote value and is reported.
 */
function choose<T>(key: string, before: T | undefined, middle: T | undefined, after: T | undefined, remote: T | undefined,
  conflicts: SpatialConflict[]): { take: 'remote' | 'local' } {
  if (sameSpatialValue(before, after) && sameSpatialValue(middle, after)) return { take: 'remote' };
  if (sameSpatialValue(remote, before) || sameSpatialValue(remote, middle) || sameSpatialValue(remote, after)) return { take: 'local' };
  conflicts.push({ key });
  return { take: 'remote' };
}

/**
 * A Group's Tab order. A Tab is closed when this side dropped one it knew (including one its attempted write
 * added) or the other side dropped one of the base; every other Tab either side holds stays. The order comes
 * from the side that alone moved existing Tabs, else the remote, and the other side's new Tabs follow it, so a
 * one-sided change keeps its exact order. Both moving the same Tabs differently is a conflict on the order.
 */
function mergeOrder(key: string, before: readonly string[] | undefined, middle: readonly string[] | undefined,
  local: readonly string[], remote: readonly string[], conflicts: SpatialConflict[]): string[] {
  const base = before ?? middle ?? [];
  const closed = new Set([...base, ...middle ?? []].filter(id => !local.includes(id)).concat((before ?? []).filter(id => !remote.includes(id))));
  const existing = (side: readonly string[]) => side.filter(id => base.includes(id) && !closed.has(id));
  const unmoved = existing(base), localMoved = !sameSpatialValue(existing(local), unmoved), remoteMoved = !sameSpatialValue(existing(remote), unmoved);
  if (localMoved && remoteMoved && !sameSpatialValue(existing(local), existing(remote)))
    conflicts.push({ key: key + ':order' });
  const [first, second] = localMoved && !remoteMoved ? [local, remote] : [remote, local];
  const merged = first.filter(id => !closed.has(id));
  return [...merged, ...second.filter(id => !closed.has(id) && !merged.includes(id))];
}

function mergeGroup(key: string, before: TabGroup | undefined, middle: TabGroup | undefined, local: TabGroup, remote: TabGroup,
  conflicts: SpatialConflict[]): TabGroup {
  const tabOrder = mergeOrder(key, before?.tabOrder, middle?.tabOrder, local.tabOrder, remote.tabOrder, conflicts);
  const selection = (group: TabGroup | undefined) => group && { activeTabId: group.activeTabId, recentTabIds: group.recentTabIds };
  const chosen = choose(key + ':selection', selection(before), selection(middle), selection(local), selection(remote), conflicts).take === 'local' ? local : remote;
  const members = new Set(tabOrder);
  const activeTabId = chosen.activeTabId !== null && members.has(chosen.activeTabId) ? chosen.activeTabId : tabOrder[0] ?? null;
  return { ...remote, tabOrder, activeTabId, recentTabIds: chosen.recentTabIds.filter(id => members.has(id)) };
}

/** Every Tab shown in some Group of this display Workspace. */
const placed = (layout: Layout | undefined) => new Set(layout?.groups.flatMap(group => group.tabOrder) ?? []);

/**
 * A Tab that either side shows here and neither side closed stays shown, even when the other side's split
 * tree won and dropped the Group it was in. It returns to a Group either side had it in, else the active one.
 */
function keepPlaced(merged: Layout, before: Layout | undefined, local: Layout, remote: Layout, tabs: ReadonlySet<string>): Layout {
  const was = placed(before), mine = placed(local), theirs = placed(remote), shown = placed(merged);
  const missing = [...new Set([...mine, ...theirs])].filter(id => tabs.has(id) && !shown.has(id) && (!was.has(id) || mine.has(id) && theirs.has(id)));
  if (!missing.length) return merged;
  const home = (id: string) => [local, remote].map(side => side.groups.find(group => group.tabOrder.includes(id))?.id)
    .find(groupId => merged.groups.some(group => group.id === groupId)) ?? merged.activeGroupId;
  return { ...merged, groups: merged.groups.map(group => {
    const added = missing.filter(id => home(id) === group.id);
    return added.length ? { ...group, tabOrder: [...group.tabOrder, ...added], activeTabId: group.activeTabId ?? added[0]! } : group;
  }) };
}

/** A display Workspace merges per Group; only its split tree and active Group compare as whole values. */
function mergeLayout(key: string, before: Layout | undefined, middle: Layout | undefined, local: Layout, remote: Layout,
  tabs: ReadonlySet<string>, conflicts: SpatialConflict[]): Layout {
  const tree = (layout: Layout | undefined) => layout && { root: layout.root, activeGroupId: layout.activeGroupId };
  const structure = choose(key + ':tree', tree(before), tree(middle), tree(local), tree(remote), conflicts).take === 'local' ? local : remote;
  const leaves = new Set(groupIds(structure.root));
  const groups = [...leaves].flatMap(id => {
    const mine = local.groups.find(group => group.id === id), theirs = remote.groups.find(group => group.id === id);
    if (!mine || !theirs) return [mine ?? theirs!];
    return [mergeGroup(`${key}:${id}`, before?.groups.find(group => group.id === id), middle?.groups.find(group => group.id === id), mine, theirs, conflicts)];
  });
  return keepPlaced({ root: structure.root, activeGroupId: structure.activeGroupId, groups }, before ?? middle, local, remote, tabs);
}

/** A Tab's split tree and its active Region are independent facts; the selection must stay a leaf. */
function mergeTabLayout(key: string, before: TabLayout | undefined, middle: TabLayout | undefined, local: TabLayout, remote: TabLayout,
  conflicts: SpatialConflict[]): TabLayout {
  const root = choose(key + ':tree', before?.root, middle?.root, local.root, remote.root, conflicts).take === 'local' ? local.root : remote.root;
  const active = choose(key + ':selection', before?.activeRegionId, middle?.activeRegionId, local.activeRegionId, remote.activeRegionId, conflicts)
    .take === 'local' ? local.activeRegionId : remote.activeRegionId;
  const leaves = regionIds(root);
  return { ...remote, root, activeRegionId: leaves.includes(active) ? active : leaves.includes(remote.activeRegionId) ? remote.activeRegionId : leaves[0]! };
}

/**
 * Rebase local intent onto the committed remote graph. Every key merges independently; a conflict on one
 * key keeps the remote value for that key, is returned by name, and never blocks the other keys.
 */
export function reconcileSpatialGraphs(base: AgentMuxSpatialGraph, local: AgentMuxSpatialGraph, remote: AgentMuxSpatialGraph,
  intermediate: AgentMuxSpatialGraph = base): SpatialMerge {
  const result = structuredClone(remote), conflicts: SpatialConflict[] = [];
  for (const [field, key] of ENTITY_FIELDS) {
    if (field === 'projectGroups' && !base.projectGroups && !local.projectGroups && !remote.projectGroups && !intermediate.projectGroups) continue;
    const identity = (value: unknown) => key ? String((value as Record<string, unknown>)[key])
      : JSON.stringify([(value as { zoneId: string }).zoneId, (value as { spaceId: string }).spaceId]);
    const index = (values: readonly unknown[] | undefined) => new Map((values ?? []).map(value => [identity(value), value]));
    const original = index(base[field]), changed = index(local[field]), current = index(remote[field]);
    const between = intermediate === base ? original : index(intermediate[field]);
    for (const id of new Set([...original.keys(), ...changed.keys(), ...between.keys()])) {
      let before = original.get(id), after = changed.get(id), middle = between.get(id);
      // A name has its own exact label revision and a Tab's Regions follow its merged split tree, so
      // neither decides the Tab entity: the rebase keeps the confirmed remote name and projects the Regions.
      if (field === 'tabs' && current.has(id)) {
        const { name, regionIds } = current.get(id) as Tab;
        const owned = (tab: unknown) => tab && { ...tab as Tab, name, regionIds };
        before = owned(before); after = owned(after); middle = owned(middle);
      }
      if (choose(`${field}:${id}`, before, middle, after, current.get(id), conflicts).take !== 'local') continue;
      if (after === undefined) current.delete(id);
      else current.set(id, after);
    }
    (result as unknown as Record<string, unknown>)[field] = [...current.values()];
  }
  const tabs = new Set(result.tabs.map(tab => tab.tabId));
  for (const field of ['layouts', 'tabLayouts', 'resources'] as const) {
    for (const id of new Set([...Object.keys(base[field]), ...Object.keys(local[field]), ...Object.keys(intermediate[field])])) {
      if (field === 'resources' && (id === AGENTMUX_DISPLAY_LABEL_RESOURCE || id === AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE)) continue;
      const before = base[field][id], after = local[field][id], middle = intermediate[field][id], current = remote[field][id];
      if (field === 'layouts' && after && current && !sameSpatialValue(after, current)) {
        result.layouts[id] = mergeLayout(`layout:${id}`, before as Layout | undefined, middle as Layout | undefined, after as Layout, current as Layout, tabs, conflicts);
        continue;
      }
      if (field === 'tabLayouts' && after && current && !sameSpatialValue(after, current)) {
        result.tabLayouts[id] = mergeTabLayout(`tabLayout:${id}`, before as TabLayout | undefined, middle as TabLayout | undefined, after as TabLayout, current as TabLayout, conflicts);
        continue;
      }
      if (choose(`${field}:${id}`, before, middle, after, current, conflicts).take !== 'local') continue;
      if (after === undefined) delete result[field][id];
      else (result[field] as Record<string, unknown>)[id] = after;
    }
  }
  return { graph: withShownRegions(result, local, remote), conflicts };
}

/**
 * A Tab holds exactly the Regions its merged split tree shows, as Core requires. A Region one side closed
 * stays, with its resource, while the other side's winning tree still shows it; restore needs every one.
 */
function withShownRegions(graph: AgentMuxSpatialGraph, local: AgentMuxSpatialGraph, remote: AgentMuxSpatialGraph): AgentMuxSpatialGraph {
  const find = (source: AgentMuxSpatialGraph, tabId: string, regionId: string) =>
    source.regions.find(region => region.regionId === regionId && region.tabId === tabId);
  graph.tabs = graph.tabs.map(tab => {
    const layout = graph.tabLayouts[tab.tabId];
    if (!layout) return tab;
    const leaves = regionIds(layout.root);
    for (const regionId of leaves) {
      if (find(graph, tab.tabId, regionId)) continue;
      const source = [remote, local].find(side => find(side, tab.tabId, regionId));
      if (!source) continue;
      graph.regions.push(structuredClone(find(source, tab.tabId, regionId)!));
      const resource = source.resources['region:' + regionId];
      if (resource !== undefined && !Object.hasOwn(graph.resources, 'region:' + regionId)) graph.resources['region:' + regionId] = structuredClone(resource);
    }
    return leafIdsMatchRecords(leaves, tab.regionIds) ? tab : { ...tab, regionIds: leaves };
  });
  return graph;
}
