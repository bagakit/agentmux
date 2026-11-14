import type { AgentMuxSpatialGraph, AgentMuxSpatialState, AgentMuxSpatialCommit, SpatialJson } from '@agentmux/core/spatial-graph';
import { retainAdmittedAgentIdentity } from '@agentmux/core/spatial-graph';
import { retainFolderDirectoryIdentity } from '@agentmux/core/space-folder-resources';
import { reconcileSpatialGraphs, sameSpatialValue, type SpatialConflict, type SpatialMerge } from './spatial-merge';
import { spatialSources, type SpaceZoneBindings } from '../../../shared/space-addresses';
import type { ScratchTopicSnapshot } from '@agentmux/host/mote-model';
import { spatialCatalog, type SpatialWorkbench } from './space-agent-control';
import { categoriesFromSpatial, categoryResource } from '@agentmux/host/topic-categories';
import { reducePersistedTab, type PersistedWorkbench } from './workbench-persistence';
import { closeWorktreeGraph } from '../../../shared/worktree-closeout';
import { sessionPresentationById } from './session-presentation';
import { desktopAgentExecutionFromSpatial, desktopAgentPresentationFromSpatial } from './desktop-agent-presentation';
import { isOriginalSourceWorkspaceProjection } from './original-space-navigation';
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
  const ordinaryTabs = Object.fromEntries(Object.entries(state.tabs).filter(([, tab]) => !tab.source));
  const ordinaryLayouts = Object.fromEntries(Object.entries(state.layouts).filter(([workspaceId]) => !isOriginalSourceWorkspaceProjection(workspaceId) &&
    !Object.values(state.tabs).some(tab => tab.source?.workspaceId && tab.workspaceId === workspaceId)));
  const catalog = spatialCatalog({ ...state, tabs: ordinaryTabs, layouts: ordinaryLayouts, topicCategories: categories }, topics);
  const { locations: _, ...facts } = catalog;
  if (state.projectGroups === undefined && previous?.projectGroups) facts.projectGroups = previous.projectGroups;
  const persisted = { tabs: Object.fromEntries(Object.values(ordinaryTabs).map(tab => [tab.id, reducePersistedTab(tab)])), layouts: ordinaryLayouts };
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
        const runtimeId = session && original?.tabId === tab.id ? desktopAgentExecutionFromSpatial(original, session)?.runtimeId : undefined;
        if (region?.execution && runtimeId !== undefined) region.execution.runtimeId = runtimeId;
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
  if (previous) retainFolderDirectoryIdentity(graph,previous);
  retainAdmittedAgentIdentity(graph,previous);
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
const withConflicts = (merge: SpatialMerge, earlier: readonly SpatialConflict[]): SpatialMerge =>
  earlier.length ? { graph: merge.graph, conflicts: [...earlier, ...merge.conflicts] } : merge;
/** A save re-merges against a newer revision this many times before reporting it as unconfirmed. */
const STALE_REVISION_ATTEMPTS = 3;
/**
 * Unconfirmed structural intent older than this is announced while the user works. A normal save
 * settles in milliseconds; this only has to exceed a slow disk sync and a Core lock wait (5 s).
 */
export const SAVE_STALL_AFTER_MS = 15_000;
/** Background retries back off to at most this interval; they never stop while intent is unsaved. */
const SAVE_RETRY_MAX_MS = 120_000;
export type SpatialSaveClock = {
  now(): number
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
};
const defaultSaveClock: SpatialSaveClock = { now: () => Date.now(), setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
export type SpatialSaveObservation = { pendingSince: number | null; lastConfirmedAt: number | null; stalled: boolean;
  lastFailureCode: string | null; conflicts: number };
/**
 * A storage reply still missing when the watchdog finds it older than the stall bound is treated as lost: the
 * write may or may not have landed, exactly like a lost acknowledgement, so the next attempt re-reads and merges
 * against it, and Core's revision check keeps a late write from replacing anything newer. Waiting longer would
 * only hold every later save and checkpoint behind it. The stall notice already says the save has not answered.
 */
export class SpatialReplyOverdueError extends Error {
  readonly code = 'SPATIAL_REPLY_OVERDUE';
  constructor() { super('Workface storage did not answer this save. The changes stay on screen and are retried.'); }
}
/** Workface changes have stayed unconfirmed past the bound. The original work stays visible and retried. */
export class SpatialSaveStalledError extends Error {
  readonly code = 'SPATIAL_SAVE_STALLED';
  constructor(readonly pendingSince: number, readonly lastFailureCode: string | null) {
    super('Workface changes have not reached storage for a while. They stay on screen and are retried automatically'
      + (lastFailureCode ? ` (last failure ${lastFailureCode}).` : '; the current save has not answered yet.'));
  }
}
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
  private readonly warn: (error: unknown) => void;
  constructor(private readonly port: DesktopSpatialPort, warn: (error: unknown) => void,
    private readonly clock: SpatialSaveClock = defaultSaveClock) {
    // A replaced owner's late save outcome belongs to nobody; the next owner re-captures the workbench.
    this.warn = error => { if (!this.disposed) warn(error); };
  }
  get ready(): boolean { return this.state !== null && this.readConfirmed; }
  /** Read-only observation: equal graphs cannot settle an in-flight or unknown write. */
  get pendingChanges(): boolean { return !!(this.startup || this.pending || this.saving || this.unconfirmed); }
  // When unconfirmed structural intent first appeared, and when Core last confirmed a save.
  private pendingSince: number | null = null;
  private lastConfirmedAt: number | null = null;
  private lastFailureCode: string | null = null;
  private failures = 0;
  private watchdog: ReturnType<SpatialSaveClock['setTimeout']> | null = null;
  private stalled = false;
  /** The facts app.inspect and the installer read; no user content. */
  get saveObservation(): SpatialSaveObservation {
    return { pendingSince: this.pendingChanges ? this.pendingSince : null, lastConfirmedAt: this.lastConfirmedAt,
      stalled: this.stalled, lastFailureCode: this.lastFailureCode, conflicts: this.retained.size };
  }
  /** Start the bounded check once per unconfirmed period; edits inside the period add no timer. */
  private markPending(): void {
    this.pendingSince ??= this.clock.now();
    this.arm(SAVE_STALL_AFTER_MS);
  }
  private arm(delay: number): void {
    if (this.watchdog !== null || this.disposed) return;
    this.watchdog = this.clock.setTimeout(() => { this.watchdog = null; this.check(); }, delay);
  }
  // The storage reply this save is waiting for. The watchdog stops waiting for an overdue one; the
  // request itself is never cancelled.
  private reply: { since: number; abandon: (error: Error) => void } | null = null;
  private awaitReply<T>(request: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const reply = { since: this.clock.now(), abandon: reject };
      this.reply = reply;
      request.then(resolve, reject).finally(() => { if (this.reply === reply) this.reply = null; });
    });
  }
  private check(): void {
    if (!this.pendingChanges || this.pendingSince === null) return;
    if (this.saving) {
      this.arm(SAVE_STALL_AFTER_MS);
      this.reportStall();
      if (this.reply && this.clock.now() - this.reply.since >= SAVE_STALL_AFTER_MS) this.reply.abandon(new SpatialReplyOverdueError());
      return;
    }
    // Nothing is in flight: the last attempt failed or nothing has retried it yet. Retry with backoff.
    this.reportStall();
    this.arm(Math.min(SAVE_RETRY_MAX_MS, SAVE_STALL_AFTER_MS * 2 ** Math.min(this.failures, 4)));
    void this.flush().catch(() => undefined);
  }
  private reportStall(): void {
    if (this.stalled || this.pendingSince === null || this.clock.now() - this.pendingSince < SAVE_STALL_AFTER_MS) return;
    this.stalled = true;
    this.warn(new SpatialSaveStalledError(this.pendingSince, this.lastFailureCode));
  }
  private confirmed(): void {
    this.lastConfirmedAt = this.clock.now();
    this.failures = 0;
    this.lastFailureCode = null;
    if (this.pendingChanges) return;
    this.pendingSince = null;
    if (this.watchdog !== null) { this.clock.clearTimeout(this.watchdog); this.watchdog = null; }
    if (this.stalled) { this.stalled = false; if (!this.disposed) this.onRecovered?.(); }
  }
  private failed(error: unknown): void {
    this.failures++;
    this.lastFailureCode = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code : 'UNKNOWN';
    this.markPending();
  }
  /** Called once when a reported stall is confirmed saved again. */
  onRecovered: (() => void) | null = null;
  private disposed = false;
  /** A replaced owner never retries or reports again; its pending intent belongs to the next owner. */
  dispose(): void {
    this.disposed = true;
    if (this.watchdog !== null) this.clock.clearTimeout(this.watchdog);
    this.watchdog = null;
  }
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
      if (this.startup) { this.startup.graph = graph; this.markPending(); }
      this.warn(new Error('Core spatial state has not been confirmed. Original work is retained; restore storage and retry.'));
      return;
    }
    // Compare with the latest intent: returning to the confirmed graph can undo
    // an in-flight edit, while repeating that edit should not enqueue another write.
    if (sameSpatialValue(graph, this.pending?.graph ?? this.applied?.graph ?? this.state!.graph))
      return;
    this.pending = { graph, baseline: this.pending?.baseline ?? this.applied ?? this.state! };
    this.markPending();
    // Coalesce synchronous structural changes; this never opens a resource or Run.
    // An overdue reply is the stall this owner has already announced, not a second failure.
    queueMicrotask(() => { void this.flush().catch(error => { if (!(error instanceof SpatialReplyOverdueError)) this.warn(error); }); });
  }
  /**
   * Merge `local` onto the current document and commit it. Another writer may commit between the read and
   * the commit; a refused stale revision is merged again against the newer document, a bounded number of
   * times, before the failure is reported. The attempted graph is recorded as the unconfirmed intermediate,
   * so the next pass is exact both when another writer won the race (Core applied nothing) and when our
   * write landed and only its reply was lost: a value already present on the remote side counts as agreement.
   */
  private async commitMerged(local: AgentMuxSpatialGraph, baseline: AgentMuxSpatialState, removals: ReadonlySet<string>,
    groupRemovals: ReadonlySet<string>): Promise<{ next: AgentMuxSpatialState; merged: SpatialMerge }> {
    let remote = await this.awaitReply(this.port.read());
    for (let attempt = 1; ; attempt++) {
      if (!remote) throw new Error('The durable spatial document is unavailable. Pending work is retained.');
      const uncertain = this.unconfirmed;
      // A lost ACK may have saved the attempted graph. Carry the later input delta onto it, keeping unrelated
      // observed data; equal values permit a merge but never prove who applied the write. A later local edit
      // the attempted graph had already changed elsewhere is a conflict like any other.
      const carried = uncertain && reconcileSpatialGraphs(uncertain.input, local, uncertain.graph);
      const merged = uncertain && carried ? withConflicts(reconcileSpatialGraphs(uncertain.baseline.graph, carried.graph, remote.graph, uncertain.graph), carried.conflicts)
        : remote.revision === baseline.revision ? { graph: local, conflicts: [] } : reconcileSpatialGraphs(baseline.graph, local, remote.graph);
      try {
        const next = await this.awaitReply(this.port.commit({ expectedRevision: remote.revision, graph: merged.graph, allowEntityRemoval: removals.size > 0,
          ...(groupRemovals.size ? { removedProjectGroupIds: [...groupRemovals] } : {}) }));
        return { next, merged };
      } catch (error) {
        this.unconfirmed = { baseline: remote, input: local, graph: merged.graph };
        // Only a document that has moved on is worth merging again right away; anything else is reported, and
        // the next successful read supplies the baseline. An unconfirmed projection is never applied.
        const newer = attempt < STALE_REVISION_ATTEMPTS ? await this.awaitReply(this.port.read()).catch(() => null) : null;
        if (!newer || newer.revision <= remote.revision) throw error;
        remote = newer;
      }
    }
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
      const { next, merged } = await this.commitMerged(local, baseline, removals, groupRemovals);
      this.unconfirmed = null;
      this.state = next;
      // Later local edits were made against our in-flight graph. Preserve the remote changes accepted by
      // that write, without treating our own ACK as a conflict; a later edit to a key another writer changed
      // meanwhile is reported with this save's conflicts.
      const later = this.pending !== pending && this.pending ? reconcileSpatialGraphs(local, this.pending.graph, next.graph) : null;
      this.retain(later ? [...merged.conflicts, ...later.conflicts] : merged.conflicts);
      for (const id of removals)
        this.removed.delete(id);
      for (const id of groupRemovals) this.removedProjectGroups.delete(id);
      if (later) this.pending = { baseline: next, graph: later.graph };
      else if (this.pending === pending) {
        this.pending = null;
        // `local` is the baseline the UI already shows. A conflicting key then applies the
        // committed value, so the next capture starts from what Core holds.
        this.publish(next, local);
      }
    })();
    try {
      await this.saving;
    }
    catch (error) {
      this.failed(error);
      throw error;
    }
    finally {
      this.saving = null;
    }
    if (this.pending)
      await this.flush();
    else this.confirmed();
  }
}
