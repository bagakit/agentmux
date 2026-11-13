import type { AgentMuxSpatialGraph, AgentMuxSpatialState, AgentMuxSpatialCommit, SpatialJson } from '@agentmux/core/spatial-graph';
import { reconcileSpatialGraphs, sameSpatialValue, type SpatialConflict } from './spatial-merge';
export { reconcileSpatialGraphs, sameSpatialValue, type SpatialConflict, type SpatialMerge } from './spatial-merge';
import { spatialSources, type SpaceZoneBindings } from '../../../shared/space-addresses';
import type { ScratchTopicSnapshot } from '../../../shared/scratch-topics';
import { spatialCatalog, type SpatialWorkbench } from './space-agent-control';
import { categoriesFromSpatial, categoryResource } from '@agentmux/host/topic-categories';
import { reducePersistedTab, type PersistedWorkbench } from './workbench-persistence';
import { closeWorktreeGraph } from '../../../shared/worktree-closeout';
import { sessionPresentationById } from './session-presentation';
import { desktopAgentPresentationFromSpatial } from './desktop-agent-presentation';
/** Host resource descriptors, never a second entity or topology store. */
const tabKey = (id: string) => 'tab:' + id;
const regionKey = (id: string) => 'region:' + id;
const zoneKey = (id: string) => 'zone:' + id;
const json = (value: unknown): SpatialJson => JSON.parse(JSON.stringify(value)) as SpatialJson;
export function desktopSpatialGraph(state: SpatialWorkbench, topics: readonly ScratchTopicSnapshot[], previous: AgentMuxSpatialGraph | null = null, removed: ReadonlySet<string> = new Set()): AgentMuxSpatialGraph {
  const closingWorkspaces = new Set(state.config?.workspaces.filter(workspace => workspace.closeout).map(workspace => workspace.id));
  // Explicit entity removal retires the original Zone, but its resource must reach
  // closeWorktreeGraph once so public Files retain their exact original owner.
  const closingZones = new Set(previous?.zones.filter(zone => closingWorkspaces.has(zone.workspaceId)).map(zone => zone.zoneId));
  const categories = [...new Map([...(previous ? categoriesFromSpatial(previous) : []), ...(state.topicCategories ?? [])].map(category => [category.spaceId, category])).values()];
  const catalog = spatialCatalog({ ...state, topicCategories: categories }, topics);
  const { locations: _, ...facts } = catalog;
  if (state.projectGroups === undefined && previous?.projectGroups) facts.projectGroups = previous.projectGroups;
  const persisted = { tabs: Object.fromEntries(Object.values(state.tabs).map(tab => [tab.id, reducePersistedTab(tab)])), layouts: state.layouts };
  const sessions = sessionPresentationById(state.sessions);
  const regionFacts = new Map(facts.regions.map(region => [region.regionId, region]));
  const originalRegions = new Map(previous?.regions.map(region => [region.regionId, region]));
  const resources: AgentMuxSpatialGraph['resources'] = {}, tabLayouts: AgentMuxSpatialGraph['tabLayouts'] = {};
  for (const category of categories) resources['space:' + category.spaceId] = categoryResource(category);
  for (const tab of Object.values(persisted.tabs)) {
    const { id: _, workspaceId: __, name: ___, layout, regions, ...metadata } = tab;
    resources[tabKey(tab.id)] = json(metadata);
    tabLayouts[tab.id] = layout;
    for (const surface of Object.values(regions)) {
      const { regionId: _, kind, ...metadata } = surface;
      if (kind === 'agent') {
        const region = regionFacts.get(surface.regionId);
        const session = sessions.get(surface.sessionId);
        const original = originalRegions.get(surface.regionId);
        // A local pending surface is not a Core creation receipt. Keep the original
        // Launcher until the real producer confirms its exact Agent and position.
        if (surface.phase === 'launching' && !session && original?.tabId === tab.id && original.kind === 'launcher') {
          const index = facts.regions.findIndex(fact => fact.regionId === surface.regionId && fact.tabId === tab.id);
          if (index >= 0) facts.regions[index] = structuredClone(original);
          const previousResource = previous?.resources[regionKey(surface.regionId)];
          if (previousResource !== undefined) resources[regionKey(surface.regionId)] = structuredClone(previousResource);
          continue;
        }
        const retained = previous && original?.tabId === tab.id ? desktopAgentPresentationFromSpatial(previous, original) : null;
        const presentation = session?.control.kind === 'agent'
          ? { sessionId: surface.sessionId, agentSessionId: session.control.agentSessionId, hostId: session.control.hostId }
          : !session && retained?.sessionId === surface.sessionId ? retained : null;
        // A missing observation does not rebind the original Core Session to its UI key.
        if (!session && presentation && region) region.agentSessionId = presentation.agentSessionId;
        delete (metadata as {
          sessionId?: string;
        }).sessionId;
        if (presentation) Object.assign(metadata, { agentPresentation: presentation });
      }
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
    const { relations: _, resource: _resource, workspacePath: _workspacePath, ...origin } = binding;
    const saved = previous?.resources[zoneKey(id)];
    const workspace = state.config?.workspaces.find(workspace => workspace.id === zone.workspaceId);
    const followsWorkspace = binding.directoryPath === undefined && zone.kind !== 'home' && zone.kind !== 'unknown' &&
      workspace?.hostId === zone.hostId && workspace.path === zone.directoryPath;
    const descriptor = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved } : {};
    delete descriptor.workspacePath;
    const originalKind = originalSources.spaces.find(space => space.spaceId === origin.spaceId)?.kind;
    resources[zoneKey(id)] = json({ ...descriptor, ...origin,
      ...(followsWorkspace ? { workspacePath: workspace.path } : {}),
      ...(originalKind === 'topic' || originalKind === 'mote' ? { contentKind: originalKind } : {}) });
  }
  if (previous) {
    for (const field of ['spaces', 'zones', 'tabs', 'regions'] as const) {
      const key = { spaces: 'spaceId', zones: 'zoneId', tabs: 'tabId', regions: 'regionId' }[field];
      const known = new Set(facts[field].map(v => String((v as unknown as Record<string, unknown>)[key])));
      const retained = previous[field].filter(v => { const id = String((v as unknown as Record<string, unknown>)[key]); return !known.has(id) && (!removed.has(id) || field === 'zones' && closingZones.has(id)) && !(field === 'regions' && removed.has((v as AgentMuxSpatialGraph['regions'][number]).tabId)); });
      (facts as unknown as Record<string, unknown>)[field] = [...facts[field], ...retained];
    }
    for (const fact of facts.regions) {
      const original = originalRegions.get(fact.regionId);
      const old = original?.tabId === fact.tabId && original.agentSessionId === fact.agentSessionId ? original : undefined;
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
      if (!Object.hasOwn(resources, id) && (!removed.has(id.slice(id.indexOf(':') + 1)) || id.startsWith('zone:') && closingZones.has(id.slice(5)) || id.startsWith('zone:') && data && typeof data === 'object' && !Array.isArray(data) && typeof data.closeoutTargetWorkspaceId === 'string') && !previous.regions.some(r => regionKey(r.regionId) === id && removed.has(r.tabId)))
        resources[id] = data;
    for (const [id, layout] of Object.entries(previous.tabLayouts))
      if (!Object.hasOwn(tabLayouts, id) && !removed.has(id))
        tabLayouts[id] = layout;
  }
  let graph: AgentMuxSpatialGraph = { ...facts, layouts: { ...previous?.layouts, ...persisted.layouts }, tabLayouts, resources };
  const owners = new Set([...graph.zones.map(zone => zone.workspaceId), ...graph.tabs.map(tab => tab.workspaceId), ...Object.keys(graph.layouts)]);
  for (const workspace of state.config?.workspaces ?? []) {
    if (!workspace.closeout || !owners.has(workspace.id)) continue;
    const target = state.config!.workspaces.find(item => item.id === workspace.closeout!.targetWorkspaceId && !item.closeout);
    if (target) graph = closeWorktreeGraph(graph, workspace, target).graph;
  }
  return graph;
}
/** One reading of which Space and Topic a Zone holds, shared by Zone bindings and the Tabs placed in it. */
function zoneContent(graph: AgentMuxSpatialGraph, zoneId: string) {
  const original = graph.resources[zoneKey(zoneId)];
  const origin = original && typeof original === 'object' && !Array.isArray(original) ? original : null;
  const relationships = graph.bindings.filter(binding => binding.zoneId === zoneId);
  const declaredSpaceId = typeof origin?.spaceId === 'string' ? origin.spaceId : null;
  const spaceId = declaredSpaceId ?? (relationships.length === 1 ? relationships[0]!.spaceId : null);
  if (!spaceId)
    return null;
  const originalSpace = graph.spaces.find(space => space.spaceId === spaceId);
  const topicId = typeof origin?.topicId === 'string' ? origin.topicId : originalSpace?.topicId;
  return { spaceId, declaredSpaceId, origin, originalSpace, topicId, relationships };
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
      // Earlier descriptors used the Tab resource for every Region. An explicit Region
      // resource now survives both save ACK hydration and a fresh client process.
      const { agentPresentation: _, ...resource } = data;
      const presentation = desktopAgentPresentationFromSpatial(graph, region);
      regions[id] = { workspaceId: fact.workspaceId, ...resource, regionId: id, kind: region.kind,
        ...(region.kind === 'agent' ? { sessionId: presentation?.sessionId ?? region.agentSessionId } : {}) } as PersistedWorkbench['tabs'][string]['regions'][string];
    }
    if (Object.keys(regions).length !== fact.regionIds.length) {
      onUnavailable?.(fact.tabId);
      continue;
    }
    const content = fact.zoneId === null ? null : zoneContent(graph, fact.zoneId);
    const descriptor = metadata.space && typeof metadata.space === 'object' && !Array.isArray(metadata.space) ? metadata.space : null;
    // Core's exact Tab→Zone survives older host descriptors. Multiple display bindings
    // never select an arbitrary Space; the original resource context remains separate.
    const space = fact.zoneId === null ? undefined : descriptor ? { ...descriptor, ...(content?.declaredSpaceId ? { spaceId: content.declaredSpaceId } : {}), zoneId: fact.zoneId }
      : content?.spaceId ? { spaceId: content.spaceId, zoneId: fact.zoneId } : undefined;
    // A Tab that Core placed in a Topic or Mote Zone belongs to that Topic even when no client
    // wrote the binding: Core admission records only the Tab entity, never a client descriptor.
    const topicId = typeof metadata.topicId === 'string' ? undefined : content?.topicId;
    // Unavailable host data is reported by the consumer, not fabricated here.
    tabs[fact.tabId] = { ...metadata, ...(topicId ? { topicId } : {}), space, id: fact.tabId, workspaceId: fact.workspaceId, layout, regions,
      ...(fact.name === null ? {} : { name: fact.name }) } as PersistedWorkbench['tabs'][string];
  }
  return { tabs, layouts: graph.layouts };
}
export function desktopBindingsFromSpatial(graph: AgentMuxSpatialGraph, config?: Pick<import('../../../shared/contracts').AppConfig, 'workspaces'> | null): SpaceZoneBindings {
  const result: SpaceZoneBindings = {};
  for (const zone of graph.zones) {
    const content = zoneContent(graph, zone.zoneId);
    if (!content)
      continue;
    const { spaceId, origin, originalSpace, topicId, relationships } = content;
    const originalKind = origin?.contentKind ?? originalSpace?.kind;
    const workspace = config?.workspaces.find(workspace => workspace.id === zone.workspaceId);
    // Absence of an explicit descriptor is not evidence that an updated Core path is a default.
    // The saved anchor also recognizes an older default ACK after a Workspace path rebind.
    const followsWorkspace = zone.kind !== 'home' && zone.kind !== 'unknown' && zone.directoryPath !== null &&
      origin?.workspaceId === zone.workspaceId && typeof origin.spaceId === 'string' && !Object.hasOwn(origin, 'directoryPath') && (
        origin.workspacePath === zone.directoryPath ||
        workspace?.hostId === zone.hostId && workspace.path === zone.directoryPath ||
        origin.workspacePath === undefined && zone.kind === 'directory' && originalSpace?.hostId === zone.hostId && originalSpace.directoryPath === zone.directoryPath);
    const { zoneId: _, workspaceId: __, ...resource } = zone;
    result[zone.zoneId] = { spaceId, workspaceId: zone.workspaceId,
      ...(originalKind === 'topic' || originalKind === 'mote' ? { contentKind: originalKind } : {}),
      ...(topicId ? { topicId } : {}),
      ...(!followsWorkspace && zone.directoryPath !== null ? { directoryPath: zone.directoryPath }
        : !followsWorkspace && typeof origin?.directoryPath === 'string' ? { directoryPath: origin.directoryPath } : {}),
      ...(followsWorkspace ? { workspacePath: zone.directoryPath! } : {}),
      resource,
      relations: Object.fromEntries(graph.spaces.map(s => [s.spaceId, relationships.some(b => b.spaceId === s.spaceId)])) };
  }
  return result;
}
export type DesktopSpatialPort = import('../../../shared/contracts').AgentMuxDesktopApi['spatial'];
/** Another writer changed these exact keys to different values; their committed values were kept. */
export class SpatialConflictError extends Error {
  readonly code = 'SPATIAL_ENTITY_CONFLICT';
  constructor(readonly conflicts: readonly SpatialConflict[]) {
    super(`Another writer changed ${conflicts.length === 1 ? 'one workface item' : conflicts.length + ' workface items'} you also edited (${conflicts.map(conflict => conflict.key).join(', ')}). Their saved version is kept and every other change was saved; edit the item again to apply yours.`);
  }
}
/** A save re-merges against a newer revision this many times before reporting it as unconfirmed. */
const STALE_REVISION_ATTEMPTS = 3;
/** One client's pending edit and revision, with no resource or Session lifecycle. */
export class DesktopSpatialPersistence {
  private state: AgentMuxSpatialState | null = null;
  // Exact resource readers can observe ahead without consuming the UI's apply frontier.
  private applied: AgentMuxSpatialState | null = null;
  private readConfirmed = false;
  private startup: { baseline: AgentMuxSpatialGraph; graph: AgentMuxSpatialGraph } | null = null;
  private pending: {
    graph: AgentMuxSpatialGraph;
    baseline: AgentMuxSpatialState;
  } | null = null;
  private saving: Promise<void> | null = null;
  private unconfirmed: { baseline: AgentMuxSpatialState; input: AgentMuxSpatialGraph; graph: AgentMuxSpatialGraph } | null = null;
  // Keys another writer changed to a different value. The committed graph keeps that value; the local
  // intent stays named here until the user's view or the other writer agrees again.
  private retained = new Map<string, SpatialConflict>();
  private readonly removed = new Set<string>();
  private readonly removedProjectGroups = new Set<string>();
  removeProjectGroup(id: string): void { this.removedProjectGroups.add(id); }
  removeEntity(id: string): void { this.removed.add(id); }
  closeWorkspace(workspaceId: string): void {
    for (const zone of this.state?.graph.zones ?? []) if (zone.workspaceId === workspaceId) this.removed.add(zone.zoneId);
  }
  get removedEntities(): ReadonlySet<string> { return this.removed; }
  private apply: ((state: AgentMuxSpatialState, baseline: AgentMuxSpatialGraph | null) => void) | null = null;
  private acknowledgeName: ((state: AgentMuxSpatialState) => void) | undefined;
  private unsubscribe: (() => void) | null = null;
  constructor(private readonly port: DesktopSpatialPort, private readonly warn: (error: unknown) => void) { }
  get ready(): boolean { return this.state !== null && this.readConfirmed; }
  /** Read-only observation: equal graphs cannot settle an in-flight or unknown write. */
  get pendingChanges(): boolean { return !!(this.startup || this.pending || this.saving || this.unconfirmed); }
  get current(): AgentMuxSpatialState | null { return this.state; }
  /** Exact keys whose local intent conflicts with another writer's committed value. */
  get conflicts(): SpatialConflict[] { return [...this.retained.values()]; }
  /** Record the latest merge's conflicts once per key; a key that agrees again is settled. */
  private retain(conflicts: readonly SpatialConflict[]): void {
    const next = new Map(conflicts.map(conflict => [conflict.key, conflict]));
    const fresh = conflicts.filter(conflict => !this.retained.has(conflict.key));
    this.retained = next;
    if (fresh.length) this.warn(new SpatialConflictError(fresh));
  }
  acceptNames(state: AgentMuxSpatialState): void {
    if (this.state && state.revision < this.state.revision) return;
    // The serialized save owns an in-flight or unconfirmed input relationship.
    // Keep that intent and mark the newer observation so an older layout ACK
    // cannot apply before flush reconciles the independent name facts.
    if (this.pending && !this.saving && !this.unconfirmed) {
      const merged = reconcileSpatialGraphs(this.pending.baseline.graph, this.pending.graph, state.graph);
      this.pending = { baseline: state, graph: merged.graph };
      this.retain(merged.conflicts);
    } else if (this.pending) this.pending = { ...this.pending };
    this.state = state;
  }
  async read(): Promise<AgentMuxSpatialState | null> {
    const observed = await this.port.read();
    if (observed === null && this.state !== null)
      throw new Error('The original Core spatial document was not returned. Its confirmed references are retained; re-read the original owner.');
    this.state = observed;
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
      const merged = reconcileSpatialGraphs(startup.baseline, startup.graph, remote.graph);
      this.state = remote;
      this.readConfirmed = true;
      this.startup = null;
      this.retain(merged.conflicts);
      if (sameSpatialValue(merged.graph, remote.graph)) this.publish(remote, startup.graph);
      else this.pending = { baseline: remote, graph: merged.graph };
    } else {
      const graph = startup.graph;
      const next = await this.port.commit({ expectedRevision: 0, graph });
      this.state = next;
      this.readConfirmed = true;
      this.startup = null;
      if (startup.graph === graph) this.publish(next, graph);
      else this.pending = { baseline: next, graph: reconcileSpatialGraphs(graph, startup.graph, next.graph).graph };
    }
  }
  connect(apply: (state: AgentMuxSpatialState, baseline: AgentMuxSpatialGraph | null) => void, acknowledgeName?: (state: AgentMuxSpatialState) => void): () => void {
    this.apply = apply;
    this.applied = this.state;
    this.acknowledgeName = acknowledgeName;
    this.unsubscribe = this.port.onChange(state => this.observe(state));
    return () => { this.unsubscribe?.(); this.unsubscribe = null; this.apply = null; this.acknowledgeName = undefined; };
  }
  /** Explicit refresh and subscription observations use the same revision and pending-edit owner. */
  async refresh(): Promise<void> {
    await this.flush();
    const state = await this.port.read();
    if (!state) throw new Error('The original Core spatial document is unconfirmed. Its workface and pending edits are retained; refresh the original owner.');
    this.observe(state);
  }
  private observe(state: AgentMuxSpatialState): void {
    // A pure read can arrive first at the same revision; only the producer ACK
    // carries name durability, and it must reach its consumer despite rebase.
    if (state.nameCommit) this.acknowledgeName?.(state);
    if (this.state && state.revision < this.state.revision || this.applied && state.revision <= this.applied.revision)
      return;
    if (this.startup || this.pending || this.saving)
      return; // flush reconciles from the original revision.
    const baseline = this.applied?.graph ?? null;
    this.state = state;
    this.publish(state, baseline);
  }
  private publish(state: AgentMuxSpatialState, baseline: AgentMuxSpatialGraph | null): void {
    this.applied = state;
    this.apply?.(state, baseline);
  }
  stage(graph: AgentMuxSpatialGraph): void {
    if (!this.ready) {
      if (this.startup) this.startup.graph = graph;
      this.warn(new Error('Core spatial state has not been confirmed. Original work is retained; restore storage and retry.'));
      return;
    }
    // Compare with the latest intent: returning to the confirmed graph can undo
    // an in-flight edit, while repeating that edit should not enqueue another write.
    if (sameSpatialValue(graph, this.pending?.graph ?? this.applied?.graph ?? this.state!.graph))
      return;
    this.pending = { graph, baseline: this.pending?.baseline ?? this.applied ?? this.state! };
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
      const groupRemovals = new Set(this.removedProjectGroups);
      // Another writer may commit between this read and the commit; a refused stale revision is
      // merged again against the newer document a bounded number of times before it is reported.
      let remote: AgentMuxSpatialState | null = null, merged: ReturnType<typeof reconcileSpatialGraphs> | null = null, next: AgentMuxSpatialState | null = null;
      let observed: AgentMuxSpatialState | null = null;
      for (let attempt = 0; attempt < STALE_REVISION_ATTEMPTS && !next; attempt++) {
        remote = observed ?? await this.port.read();
        observed = null;
        if (!remote)
          throw new Error('The durable spatial document is unavailable. Pending work is retained.');
        const uncertain = this.unconfirmed;
        // A lost ACK may have saved the intermediate edit. Carry the subsequent
        // input delta onto that attempted graph, retaining unrelated observed data.
        // Equal values permit a merge; they never prove who applied the write.
        // Each key merges on its own: a conflict keeps the committed remote value for that
        // key and is retained by name, while every other change is still committed.
        merged = uncertain ? reconcileSpatialGraphs(uncertain.baseline.graph,
          reconcileSpatialGraphs(uncertain.input, local, uncertain.graph).graph, remote.graph, uncertain.graph)
          : remote.revision === baseline.revision ? { graph: local, conflicts: [] } : reconcileSpatialGraphs(baseline.graph, local, remote.graph);
        try {
          next = await this.port.commit({ expectedRevision: remote.revision, graph: merged.graph, allowEntityRemoval: removals.size > 0,
            ...(groupRemovals.size ? { removedProjectGroupIds: [...groupRemovals] } : {}) });
        } catch (error) {
          // When the document has moved on, merge again against that newer revision right away. The
          // attempted graph is recorded as the unconfirmed intermediate, so the next pass is exact both
          // when another writer won the race (Core applied nothing) and when our write landed and only
          // its reply was lost: a value already present on the remote side counts as agreement.
          this.unconfirmed = { baseline: remote, input: local, graph: merged.graph };
          if (attempt + 1 < STALE_REVISION_ATTEMPTS) {
            observed = await this.port.read().catch(() => null);
            if (observed && observed.revision > remote.revision) continue;
            observed = null;
          }
          // Each successful read supplies the next baseline, including after
          // repeated lost replies. Do not apply an unconfirmed projection.
          throw error;
        }
      }
      if (!next || !merged) throw new Error('The durable spatial document kept changing during this save. Pending work is retained.');
      this.unconfirmed = null;
      this.state = next;
      this.retain(merged.conflicts);
      for (const id of removals)
        this.removed.delete(id);
      for (const id of groupRemovals) this.removedProjectGroups.delete(id);
      if (this.pending === pending) {
        this.pending = null;
        // `local` is the baseline the UI already shows. A retained conflict then applies the
        // committed value for that key, so the next capture starts from what Core holds.
        this.publish(next, local);
      }
      else if (this.pending) {
        // Later local edits were made against our in-flight graph. Preserve the
        // remote changes accepted by that write, without treating our own ACK as a conflict.
        this.pending = { baseline: next, graph: reconcileSpatialGraphs(local, this.pending.graph, next.graph).graph };
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
