import type { AgentMuxSpatialGraph, AgentMuxSpatialState, AgentMuxSpatialCommit, SpatialJson } from '@agentmux/core/spatial-graph';
import { spatialSources, type SpaceZoneBindings } from '../../../shared/space-addresses';
import type { ScratchTopicSnapshot } from '../../../shared/scratch-topics';
import { spatialCatalog, type SpatialWorkbench } from './space-agent-control';
import { reducePersistedTab, type PersistedWorkbench } from './workbench-persistence';
/** Host resource descriptors, never a second entity or topology store. */
const tabKey = (id: string) => 'tab:' + id;
const regionKey = (id: string) => 'region:' + id;
const zoneKey = (id: string) => 'zone:' + id;
const json = (value: unknown): SpatialJson => JSON.parse(JSON.stringify(value)) as SpatialJson;
export function desktopSpatialGraph(state: SpatialWorkbench, topics: readonly ScratchTopicSnapshot[], previous: AgentMuxSpatialGraph | null = null, removed: ReadonlySet<string> = new Set()): AgentMuxSpatialGraph {
  const catalog = spatialCatalog(state, topics);
  const { locations: _, ...facts } = catalog;
  const persisted = { tabs: Object.fromEntries(Object.values(state.tabs).map(tab => [tab.id, reducePersistedTab(tab)])), layouts: state.layouts };
  const resources: AgentMuxSpatialGraph['resources'] = {}, tabLayouts: AgentMuxSpatialGraph['tabLayouts'] = {};
  for (const tab of Object.values(persisted.tabs)) {
    const { id: _, workspaceId: __, name: ___, layout, regions, ...metadata } = tab;
    resources[tabKey(tab.id)] = json(metadata);
    tabLayouts[tab.id] = layout;
    for (const surface of Object.values(regions)) {
      const { regionId: _, kind, workspaceId: __, ...metadata } = surface;
      if (kind === 'agent')
        delete (metadata as {
          sessionId?: string;
        }).sessionId;
      resources[regionKey(surface.regionId)] = json(metadata);
    }
  }
  const originalSources = spatialSources(state.config, topics);
  for (const zone of facts.zones) {
    const id = zone.zoneId;
    const original = originalSources.bindings.filter(binding => binding.zoneId === id);
    const binding = state.spaceZoneBindings[id] ?? (original.length === 1 ? { spaceId: original[0]!.spaceId, workspaceId: zone.workspaceId } : undefined);
    if (!binding)
      continue;
    const { relations: _, ...origin } = binding;
    resources[zoneKey(id)] = json(origin);
  }
  if (previous) {
    for (const field of ['spaces', 'zones', 'tabs', 'regions'] as const) {
      const key = { spaces: 'spaceId', zones: 'zoneId', tabs: 'tabId', regions: 'regionId' }[field];
      const known = new Set(facts[field].map(v => String((v as unknown as Record<string, unknown>)[key])));
      const retained = previous[field].filter(v => { const id = String((v as unknown as Record<string, unknown>)[key]); return !known.has(id) && !removed.has(id) && !(field === 'regions' && removed.has((v as AgentMuxSpatialGraph['regions'][number]).tabId)); });
      (facts as unknown as Record<string, unknown>)[field] = [...facts[field], ...retained];
    }
    for (const fact of facts.regions) {
      const old = previous.regions.find(r => r.regionId === fact.regionId && r.agentSessionId === fact.agentSessionId);
      if (old) {
        if (fact.runId === null)
          fact.runId = old.runId;
        if (fact.execution === null)
          fact.execution = old.execution;
      }
    }
    const knownSpaces = new Set(catalog.spaces.map(s => s.spaceId)), knownZones = new Set(catalog.zones.map(z => z.zoneId));
    const keys = new Set(facts.bindings.map(b => JSON.stringify(b)));
    for (const binding of previous.bindings)
      if ((!knownSpaces.has(binding.spaceId) || !knownZones.has(binding.zoneId)) && !keys.has(JSON.stringify(binding)))
        facts.bindings.push(binding);
    for (const [id, data] of Object.entries(previous.resources))
      if (!Object.hasOwn(resources, id) && !removed.has(id.slice(id.indexOf(':') + 1)) && !previous.regions.some(r => regionKey(r.regionId) === id && removed.has(r.tabId)))
        resources[id] = data;
    for (const [id, layout] of Object.entries(previous.tabLayouts))
      if (!Object.hasOwn(tabLayouts, id) && !removed.has(id))
        tabLayouts[id] = layout;
  }
  return { ...facts, layouts: { ...previous?.layouts, ...persisted.layouts }, tabLayouts, resources };
}
export function desktopWorkbenchFromSpatial(graph: AgentMuxSpatialGraph, onUnavailable?: (tabId: string) => void): PersistedWorkbench {
  const tabs: PersistedWorkbench['tabs'] = {};
  for (const fact of graph.tabs) {
    const metadata = graph.resources[tabKey(fact.tabId)], layout = graph.tabLayouts[fact.tabId];
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !layout) {
      onUnavailable?.(fact.tabId);
      continue;
    }
    const regions: PersistedWorkbench['tabs'][string]['regions'] = {};
    for (const id of fact.regionIds) {
      const region = graph.regions.find(r => r.regionId === id && r.tabId === fact.tabId), data = graph.resources[regionKey(id)];
      if (!region || !data || typeof data !== 'object' || Array.isArray(data))
        continue;
      regions[id] = { ...data, regionId: id, kind: region.kind, workspaceId: fact.workspaceId,
        ...(region.kind === 'agent' ? { sessionId: region.agentSessionId } : {}) } as PersistedWorkbench['tabs'][string]['regions'][string];
    }
    if (Object.keys(regions).length !== fact.regionIds.length) {
      onUnavailable?.(fact.tabId);
      continue;
    }
    const space = metadata.space && typeof metadata.space === 'object' && !Array.isArray(metadata.space) && fact.zoneId !== null ? { ...metadata.space, zoneId: fact.zoneId } : undefined;
    // Unavailable host data is reported by the consumer, not fabricated here.
    tabs[fact.tabId] = { ...metadata, space, id: fact.tabId, workspaceId: fact.workspaceId, layout, regions,
      ...(fact.name === null ? {} : { name: fact.name }) } as PersistedWorkbench['tabs'][string];
  }
  return { tabs, layouts: graph.layouts };
}
export function desktopBindingsFromSpatial(graph: AgentMuxSpatialGraph): SpaceZoneBindings {
  const result: SpaceZoneBindings = {};
  for (const zone of graph.zones) {
    const original = graph.resources[zoneKey(zone.zoneId)];
    const origin = original && typeof original === 'object' && !Array.isArray(original) ? original : null;
    const relationships = graph.bindings.filter(b => b.zoneId === zone.zoneId);
    const spaceId = typeof origin?.spaceId === 'string' ? origin.spaceId : relationships.length === 1 ? relationships[0]!.spaceId : null;
    if (!spaceId)
      continue;
    result[zone.zoneId] = { spaceId, workspaceId: zone.workspaceId, relations: Object.fromEntries(graph.spaces.map(s => [s.spaceId, relationships.some(b => b.spaceId === s.spaceId)])) };
  }
  return result;
}
export type DesktopSpatialPort = import('../../../shared/contracts').AgentMuxDesktopApi['spatial'];
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
/** Rebase only disjoint document edits. Overlapping edits stay visible and unsaved. */
export function reconcileSpatialGraphs(base: AgentMuxSpatialGraph, local: AgentMuxSpatialGraph, remote: AgentMuxSpatialGraph): AgentMuxSpatialGraph {
  const result = structuredClone(remote), same = sameSpatialValue;
  const arrays = [['spaces', 'spaceId'], ['zones', 'zoneId'], ['tabs', 'tabId'], ['regions', 'regionId'], ['bindings', null]] as const;
  for (const [field, key] of arrays) {
    const identity = (value: unknown) => key ? String((value as Record<string, unknown>)[key]) : JSON.stringify([(value as {
        zoneId: string;
      }).zoneId, (value as {
        spaceId: string;
      }).spaceId]);
    const original = new Map(base[field].map(v => [identity(v), v])), changed = new Map(local[field].map(v => [identity(v), v])), current = new Map(remote[field].map(v => [identity(v), v]));
    for (const id of new Set([...original.keys(), ...changed.keys()])) {
      const before = original.get(id), after = changed.get(id);
      if (same(before, after))
        continue;
      if (!same(current.get(id), before) && !same(current.get(id), after))
        throw new Error('The same spatial entity was edited elsewhere. Local changes are retained; inspect the current graph before retrying.');
      if (after === undefined)
        current.delete(id);
      else
        current.set(id, after);
    }
    ;
    (result as unknown as Record<string, unknown>)[field] = [...current.values()];
  }
  for (const field of ['layouts', 'tabLayouts', 'resources'] as const) {
    for (const id of new Set([...Object.keys(base[field]), ...Object.keys(local[field])])) {
      const before = base[field][id], after = local[field][id];
      if (same(before, after))
        continue;
      if (!same(remote[field][id], before) && !same(remote[field][id], after))
        throw new Error('The same spatial layout or resource was edited elsewhere. Local changes are retained; inspect the current graph before retrying.');
      if (after === undefined)
        delete result[field][id];
      else
        (result[field] as Record<string, unknown>)[id] = after;
    }
  }
  return result;
}
/** One client's pending edit and revision, with no resource or Session lifecycle. */
export class DesktopSpatialPersistence {
  private state: AgentMuxSpatialState | null = null;
  private readConfirmed = false;
  private startup: { baseline: AgentMuxSpatialGraph; graph: AgentMuxSpatialGraph } | null = null;
  private pending: {
    graph: AgentMuxSpatialGraph;
    baseline: AgentMuxSpatialState;
  } | null = null;
  private saving: Promise<void> | null = null;
  private readonly removed = new Set<string>();
  removeEntity(id: string): void { this.removed.add(id); }
  get removedEntities(): ReadonlySet<string> { return this.removed; }
  private apply: ((state: AgentMuxSpatialState) => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  constructor(private readonly port: DesktopSpatialPort, private readonly warn: (error: unknown) => void) { }
  get ready(): boolean { return this.state !== null && this.readConfirmed; }
  get current(): AgentMuxSpatialState | null { return this.state; }
  async read(): Promise<AgentMuxSpatialState | null> {
    this.state = await this.port.read();
    this.readConfirmed = true;
    return this.state;
  }
  async bootstrap(graph: AgentMuxSpatialGraph): Promise<void> {
    if (this.ready) return;
    this.startup ??= { baseline: graph, graph };
    if (!this.readConfirmed)
      throw new Error('The Core spatial document has not been read. Original work is retained.');
    await this.flush();
  }
  private async restoreStorage(): Promise<void> {
    const startup = this.startup;
    if (!startup)
      throw new Error('The original workbench is still loading. Retry saving when it is ready.');
    // A failed read is unknown, never an absent document. Read again before any write.
    const remote = await this.port.read();
    if (remote) {
      const graph = reconcileSpatialGraphs(startup.baseline, startup.graph, remote.graph);
      this.state = remote;
      this.readConfirmed = true;
      this.startup = null;
      if (sameSpatialValue(graph, remote.graph)) this.apply?.(remote);
      else this.pending = { baseline: remote, graph };
    } else {
      const graph = startup.graph;
      const next = await this.port.commit({ expectedRevision: 0, graph });
      this.state = next;
      this.readConfirmed = true;
      this.startup = null;
      if (startup.graph === graph) this.apply?.(next);
      else this.pending = { baseline: next, graph: reconcileSpatialGraphs(graph, startup.graph, next.graph) };
    }
  }
  connect(apply: (state: AgentMuxSpatialState) => void): () => void {
    this.apply = apply;
    this.unsubscribe = this.port.onChange(state => {
      if (this.state && state.revision <= this.state.revision)
        return;
      if (this.startup || this.pending || this.saving)
        return; // flush reconciles from the original revision.
      this.state = state;
      apply(state);
    });
    return () => { this.unsubscribe?.(); this.unsubscribe = null; this.apply = null; };
  }
  stage(graph: AgentMuxSpatialGraph): void {
    if (!this.ready) {
      if (this.startup) this.startup.graph = graph;
      this.warn(new Error('Core spatial state has not been confirmed. Original work is retained; restore storage and retry.'));
      return;
    }
    if (sameSpatialValue(graph, this.state!.graph))
      return;
    this.pending = { graph, baseline: this.state! };
    // Coalesce synchronous structural changes; this never opens a resource or Run.
    queueMicrotask(() => { void this.flush().catch(this.warn); });
  }
  async flush(): Promise<void> {
    if (this.saving) {
      await this.saving;
      if (this.pending)
        await this.flush();
      return;
    }
    this.saving = (async () => {
      if (!this.ready) await this.restoreStorage();
      if (!this.pending) return;
      const pending = this.pending, local = pending.graph, baseline = pending.baseline;
      const removals = new Set(this.removed);
      const remote = await this.port.read();
      if (!remote)
        throw new Error('The durable spatial document is unavailable. Pending work is retained.');
      const graph = remote.revision === baseline.revision ? local : reconcileSpatialGraphs(baseline.graph, local, remote.graph);
      const next = await this.port.commit({ expectedRevision: remote.revision, graph, allowEntityRemoval: removals.size > 0 });
      this.state = next;
      for (const id of removals)
        this.removed.delete(id);
      if (this.pending === pending) {
        this.pending = null;
        this.apply?.(next);
      }
      else if (this.pending) {
        // Later local edits were made against our in-flight graph. Preserve the
        // remote changes accepted by that write, without treating our own ACK as a conflict.
        this.pending = { baseline: next, graph: reconcileSpatialGraphs(local, this.pending.graph, next.graph) };
      }
    })();
    try {
      await this.saving;
    }
    finally {
      this.saving = null;
    }
    if (this.pending)
      await this.flush();
  }
}
