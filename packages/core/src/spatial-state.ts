import { TAKEOVER_CANCELLATION_RESOURCE, takeoverCancellationRecord, type TakeoverCancellationAdmission } from './agent-takeover-cancellation-record.js';
import { SPACE_LINK_RESOURCE, spaceLinkDocument, type SpaceLinkTarget, type SpaceLinkAddress } from './space-link.js';
import { folderSpaceFacts, folderResourceIdentity, type FolderSpaceResource, type FolderDirectoryResource } from './space-folder.js';
import { folderDirectoryResourceKey, retainFolderDirectoryIdentity } from './space-folder-resources.js';
import { mintObjectId } from './object-id.js';
import { watch, type FSWatcher } from 'node:fs';
import { createRequire } from 'node:module';
import { lstat, mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { snapshotRecoveryFile, restoreMissingRecoveryFile, type RecoverySource, type RecoverySourceMember } from './storage-recovery.js';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { durableWriteFile, DurableWriteError } from './durable-write.js';
import { AgentMuxError } from './errors.js';
import { defaultAgentMuxStateDirectory } from './runtime-paths.js';
import type { AgentMuxSpaceBindingTarget } from './space-control.js';
import { addTabOccurrence, removeTab } from './spatial-layout.js';
import { assertAgentMuxSpatialGraph, parseAgentMuxSpatialGraph, retainAdmittedAgentIdentity, type AgentMuxSpatialGraph, type AgentMuxSpatialState, type AgentMuxSpatialCommit, type SpatialJson } from './spatial-graph.js';
import { AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE, spatialAgentOpenDigest, admitSpatialAgentOpen, admitSpatialAgentAssociation, spatialAgentAssociationRecord, spatialAgentOpenRecord, retainedMoteMainBindingReceipt, parseMoteMainBaseline, sameMoteMainBaseline, type MoteMainFollowUpInput, spatialAgentOpenDocument, matchesMoteMainBindingInput, validateMoteMainBindingObservation, type MoteMainBindingObservation } from './spatial-agent-open.js';
export * from './spatial-agent-open.js';
import { AGENTMUX_DISPLAY_LABEL_RESOURCE, displayLabelDocument, setDisplayLabelDocument, projectSpatialState, nameTargetKey, validateNameIntent,
  type AgentMuxNameTarget, type AgentMuxNameContext, type AgentMuxNameChangeIntent, type AgentMuxNameChangeRecord,
  type AgentMuxNameChangeAdmission, type AgentMuxNameChangeSettlement, type AgentMuxDisplayLabelMutation, type AgentMuxDisplayLabelResult } from './display-label.js';
export * from './spatial-graph.js';
function invalid(message: string): never { throw new AgentMuxError(message, 'SPATIAL_STATE_INVALID'); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value))
  invalid('A spatial object is required.'); return value as Record<string, unknown>; }
export function defaultAgentMuxSpatialStatePath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const selected = env.AGENTMUX_SPATIAL_STATE_STORE;
  if (selected && !isAbsolute(selected))
    invalid('AGENTMUX_SPATIAL_STATE_STORE must be absolute.');
  return selected || join(defaultAgentMuxStateDirectory(env), 'spatial-state.json');
}
type AgentRegionAttachment = { tabId: string; regionId: string; agentSessionId: string; runId: string;
  execution: { hostId: string; cwd: string }; resource: SpatialJson };
export type SpaceAgentRegion = {
  region: AgentMuxSpatialGraph['regions'][number]; zone: AgentMuxSpatialGraph['zones'][number];
  association?: import('./spatial-agent-open-contract.js').AgentMuxSpatialAgentAssociationRecord;
  admission?: Pick<import('./spatial-agent-open-contract.js').AgentMuxSpatialAgentOpenRecord, 'requestId' | 'agentSessionId' | 'address' | 'execution' | 'placement'>
};
type SpaceAgentIndex = Map<string, { kind: AgentMuxSpatialGraph['spaces'][number]['kind']; agents: Set<string>; regions: Map<string, SpaceAgentRegion> }>;
type SpaceAgentSnapshot = { stamp: string; index: SpaceAgentIndex; takeovers: Map<string, import('./spatial-agent-open-contract.js').AgentMuxSpatialAgentOpenRecord[]>; takeoverIssue?: string };
const spatialFileStamp = (file: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
  [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':');
const spatialAgentKey = (agent: { hostId: string; agentSessionId: string }) => JSON.stringify([agent.hostId, agent.agentSessionId]);
/** Read the original location using the same ownership check as the settlement write. */
export function originalAgentOpenRegion(graph: AgentMuxSpatialGraph, record: NonNullable<ReturnType<typeof spatialAgentOpenRecord>>) {
  const region = graph.regions.find(region => region.regionId === record.address.regionId && region.tabId === record.address.tabId);
  if (!region || region.kind !== 'agent' || region.agentSessionId !== record.agentSessionId) return null;
  if (record.execution.runtimeId && (region.execution?.runtimeId !== record.execution.runtimeId ||
      region.execution.hostId !== record.execution.hostId || region.execution.cwd !== record.execution.workspacePath)) return null;
  return region;
}
/**
 * Place a producer-confirmed Agent at its exact Region in `graph`. Only an empty Launcher, or a Region of the
 * same Session whose Run and execution location are still unset or equal, may take it; a newer Run of the
 * same Session is never replaced by an older creation receipt. `settled` means the Region already holds it.
 */
function placeAgentRegion(graph: AgentMuxSpatialGraph, agent: AgentRegionAttachment): 'absent' | 'conflict' | 'settled' | 'placed' {
  const tab = graph.tabs.find(tab => tab.tabId === agent.tabId);
  const index = graph.regions.findIndex(region => region.regionId === agent.regionId && region.tabId === agent.tabId);
  const original = graph.regions[index];
  if (!tab?.regionIds.includes(agent.regionId) || !original) return 'absent';
  const sameExecution = original.execution?.hostId === agent.execution.hostId && original.execution.cwd === agent.execution.cwd;
  const resourceKey = 'region:' + agent.regionId;
  if (original.kind === 'agent' && original.agentSessionId === agent.agentSessionId && original.runId === agent.runId && sameExecution &&
      isDeepStrictEqual(graph.resources[resourceKey], agent.resource)) return 'settled';
  if (!(original.kind === 'launcher' && original.agentSessionId === null) &&
      !(original.kind === 'agent' && original.agentSessionId === agent.agentSessionId &&
        (original.runId === null || original.runId === agent.runId) && (original.execution === null || sameExecution)))
    return 'conflict';
  graph.regions[index] = { tabId: agent.tabId, regionId: agent.regionId, kind: 'agent',
    agentSessionId: agent.agentSessionId, runId: agent.runId, execution: agent.execution };
  graph.resources[resourceKey] = agent.resource;
  return 'placed';
}
const REGION_CHANGED = 'The exact Region no longer matches this Agent attachment. Its original binding and all Runs are retained.';
const requireNative = createRequire(import.meta.url);
/** A single filesystem owner. Lock inode is never removed, including after process death. */
export class AgentMuxSpatialStateStore {
  private agentMembership: { stamp: string; load: Promise<SpaceAgentSnapshot> } | undefined;
  private readonly listeners = new Set<(state: AgentMuxSpatialState) => void>();
  private readonly observationErrors = new Map<(state: AgentMuxSpatialState) => void, (error: unknown) => void>();
  private watcher: FSWatcher | null = null;
  private watching = 0;
  private announcedRevision = 0;
  private announcedNameCommit: string | null = null;
  subscribe(listener: (state: AgentMuxSpatialState) => void, onError?: (error: unknown) => void): () => void {
    this.listeners.add(listener);
    if (onError) this.observationErrors.set(listener, onError);
    if (this.listeners.size === 1) {
      const generation = ++this.watching;
      void mkdir(dirname(this.path), { recursive: true, mode: 0o700 }).then(() => {
        if (generation !== this.watching || this.listeners.size === 0)
          return;
        this.watcher = watch(dirname(this.path), (_event, name) => {
          if (name !== null && String(name) !== basename(this.path))
            return;
          void this.read().then(state => { if (generation === this.watching) { if (state) this.announce(state); else if (this.observationErrors.size) this.observationFailure(new AgentMuxError('The original spatial document is absent; its last confirmed observation is retained.', 'SPATIAL_STATE_ABSENT')); } }).catch(error => this.observationFailure(error));
        });
        this.watcher.on('error', error => this.observationFailure(error));
        // Close the read/subscribe race, including a commit from another process.
        return this.read().then(state => { if (state && generation === this.watching)
          this.announce(state); });
      }).catch(error => this.observationFailure(error));
    }
    return () => {
      this.listeners.delete(listener);
      this.observationErrors.delete(listener);
      if (this.listeners.size === 0) {
        this.watching++;
        this.watcher?.close();
        this.watcher = null;
      }
    };
  }
  private observationFailure(error: unknown): void {
    for (const report of this.observationErrors.values()) { try { report(error); } catch { /* A reader failure cannot change the durable graph. */ } }
    this.observationWarning(error);
  }
  private observationWarning(error: unknown): void {
    process.emitWarning('Spatial observation failed; the durable document and Runs are retained. ' + (error instanceof Error ? error.message : String(error)), { code: 'SPATIAL_PROJECTION_NOTIFICATION_FAILED' });
  }
  private announce(state: AgentMuxSpatialState): void {
    if (state.revision < this.announcedRevision) return;
    const ack = state.nameCommit ? JSON.stringify(state.nameCommit) : null;
    if (state.revision === this.announcedRevision && (!ack || ack === this.announcedNameCommit)) return;
    if (state.revision > this.announcedRevision) this.announcedNameCommit = null;
    this.announcedRevision = state.revision;
    if (ack) this.announcedNameCommit = ack;
    const projection = projectSpatialState(state);
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(projection));
      }
      catch (error) {
        try { this.observationErrors.get(listener)?.(error); } catch { /* Only this consumer failed. */ }
        this.observationWarning(error);
      }
    }
  }
  constructor(readonly path = defaultAgentMuxSpatialStatePath()) {
    if (!isAbsolute(path))
      invalid('Spatial state path must be absolute.');
  }
  /** The original topology owner contributes data; reading/restoring never executes a stored operation. */
  storageRecoverySource(): RecoverySource {
    return { id: 'core.spatial', ownedPaths: [this.path, this.path + '.previous'],
      capture: async directory => {
        const members: RecoverySourceMember[] = [], gaps: Array<{ sourceId: string; memberId?: string; code: string }> = []
        let revision = 'unavailable'
        for (const [id, target] of [['original', this.path], ['previous', this.path + '.previous']] as const) {
          const file = join(directory, id)
          try {
            const stamp = await snapshotRecoveryFile(target, file), point = this.decode(await readFile(file, 'utf8'))
            members.push({ id, file, target, kind: 'file', revision: stamp, capturedAt: Date.now() })
            if (id === 'original') revision = 'original:' + point.revision
          } catch (error) { gaps.push({ sourceId: 'core.spatial', memberId: id, code: (error as NodeJS.ErrnoException).code ?? 'SPATIAL_RECOVERY_SOURCE_UNAVAILABLE' }) }
        }
        if (!members.some(member => member.id === 'original')) {
          const previous = members.find(member => member.id === 'previous')
          if (previous) {
            // This is an explicit retained recovery point, never a live-read
            // empty/default fallback or a reconstructed write acknowledgment.
            const point = this.decode(await readFile(previous.file, 'utf8')); revision = 'previous-original:' + point.revision
            members.unshift({ ...previous, id: 'original', target: this.path })
          }
        }
        return { revision, members, gaps }
      },
      restoreMissing: async member => {
        const target = member.id === 'original' ? this.path : member.id === 'previous' ? this.path + '.previous' : null
        if (member.kind !== 'file' || !target || target !== member.target) throw new AgentMuxError('The spatial restore selected another original owner.', 'STORAGE_RECOVERY_INVALID')
        const point = this.decode(await readFile(member.file, 'utf8'))
        return await this.locked(async () => {
          if (member.id === 'original') try {
            const previous = this.decode(await readFile(this.path + '.previous', 'utf8'))
            if (previous.revision > point.revision) throw new AgentMuxError('A newer retained original topology exists. Capture that original owner before restoring this earlier point.', 'SPATIAL_RECOVERY_NEWER_ORIGINAL_AVAILABLE')
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          return await restoreMissingRecoveryFile(member.file, target, member.sha256)
        })
      },
      subscribe: (changed, unavailable) => {
        const watcher = watch(dirname(this.path), (_event, name) => { if (name && [basename(this.path), basename(this.path) + '.previous'].includes(String(name))) changed() })
        watcher.on('error', error => { unavailable?.({ sourceId: 'core.spatial', code: (error as NodeJS.ErrnoException).code ?? 'RECOVERY_WATCH_UNAVAILABLE' }); changed() })
        return () => watcher.close()
      }
    }
  }
  async read(): Promise<AgentMuxSpatialState | null> {
    let source: string;
    try {
      source = await readFile(this.path, 'utf8');
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { await lstat(this.path + '.previous'); }
        catch (previousError) { if ((previousError as NodeJS.ErrnoException).code === 'ENOENT') return null; throw previousError; }
        throw new AgentMuxError('The original topology document is missing and its retained original remains available. Restore that owner; no empty topology was initialized.', 'SPATIAL_STATE_READ_UNCONFIRMED');
      }
      throw error;
    }
    return this.decode(source);
  }
  /** Read this opened file's exact membership. Missing storage is unknown, not a confirmed nonmember.
   * Stable files reuse a private index; public read/commit graphs remain independently mutable. */
  async readSpaceAgentMembership(input: { spaceId: string; hostId: string; agentSessionId: string }): Promise<{
    spaceKind: AgentMuxSpatialGraph['spaces'][number]['kind'] | null; member: boolean;
  } | null> {
    return await this.readAgentMembership(snapshot => {
      const space = snapshot.index.get(input.spaceId);
      return { spaceKind: space?.kind ?? null, member: space?.agents.has(spatialAgentKey(input)) ?? false };
    });
  }
  /** Exact member selectors share the opened-file membership index. No prompt,
   * environment, creator credential or resource grant is retained in this projection. */
  async readSpaceAgentRegion(input: { spaceId: string; regionId: string }): Promise<{ spaceKind: AgentMuxSpatialGraph['spaces'][number]['kind'] | null; member: SpaceAgentRegion | null } | null> {
    return await this.readAgentMembership((snapshot, stable) => {
      if (!stable) throw new AgentMuxError('The original member document changed during this read. Keep the target and inspect its original source.', 'SPACE_MEMBER_UNAVAILABLE');
      const space = snapshot.index.get(input.spaceId);
      return { spaceKind: space?.kind ?? null, member: structuredClone(space?.regions.get(input.regionId) ?? null) };
    });
  }
  /** Bounded related admission metadata from the same opened-file index; no Session bodies or Native calls. */
  async readTakeoverAdmissions(input: { direction: 'incoming' | 'outgoing'; subject: { runtimeId: string; agentSessionId: string }; after: string; limit: number }) {
    return await this.readAgentMembership((snapshot, stable) => {
      if (!stable) throw new AgentMuxError('The original Takeover admission document changed during this read.', 'SPACE_MEMBER_UNAVAILABLE');
      if (snapshot.takeoverIssue) throw new AgentMuxError('The original Takeover relation index is unconfirmed. Original membership and Sessions remain available.', 'AGENT_TAKEOVER_INDEX_UNCONFIRMED', snapshot.takeoverIssue);
      const values = (snapshot.takeovers.get(JSON.stringify([input.direction, input.subject.runtimeId, input.subject.agentSessionId])) ?? []).filter(value => value.requestId > input.after);
      const records = values.slice(0, input.limit).map(value => ({ requestId: value.requestId, agentSessionId: value.agentSessionId, execution: value.execution,
        ...(value.executionBinding ? { executionBinding: value.executionBinding } : {}), takeover: value.takeover }));
      return structuredClone({ records, hasMore: values.length > input.limit });
    });
  }
  private async readAgentMembership<T>(select: (snapshot: SpaceAgentSnapshot, stable: boolean) => T): Promise<T | null> {
    let file: FileHandle | undefined, selected = this.agentMembership;
    try {
      file = await open(this.path, 'r');
      const stamp = spatialFileStamp(await file.stat({ bigint: true }));
      selected = this.agentMembership;
      if (!selected || selected.stamp !== stamp) {
        selected = { stamp, load: this.readAgentIndex(file) };
        this.agentMembership = selected;
      }
      const snapshot = await selected.load;
      // A concurrent in-place write may change this handle while it is read. Keep
      // the original read semantics, but never reuse that unstable observation.
      if (snapshot.stamp !== stamp && this.agentMembership === selected) this.agentMembership = undefined;
      return select(snapshot, snapshot.stamp === stamp);
    } catch (error) {
      if (this.agentMembership === selected) this.agentMembership = undefined;
      if (!file && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    } finally {
      await file?.close();
    }
  }
  private async readAgentIndex(file: FileHandle): Promise<SpaceAgentSnapshot> {
    const { graph } = this.decode(await file.readFile('utf8'));
    const index: SpaceAgentIndex = new Map(graph.spaces.map(space => [space.spaceId, { kind: space.kind, agents: new Set<string>(), regions: new Map() }]));
    const spacesByZone = new Map<string, string[]>();
    for (const binding of graph.bindings) {
      const spaces = spacesByZone.get(binding.zoneId) ?? [];
      spaces.push(binding.spaceId); spacesByZone.set(binding.zoneId, spaces);
    }
    const zonesByTab = new Map(graph.tabs.map(tab => [tab.tabId, tab.zoneId]));
    const zones = new Map(graph.zones.map(zone => [zone.zoneId, zone]));
    for (const region of graph.regions) {
      if (region.kind !== 'agent' || !region.association && (!region.agentSessionId || !region.execution)) continue;
      const zone = zonesByTab.get(region.tabId);
      if (zone === null || zone === undefined) continue;
      const key = region.execution && region.agentSessionId ? spatialAgentKey({ hostId: region.execution.hostId, agentSessionId: region.agentSessionId }) : null;
      const resource = zones.get(zone);
      if (!resource) continue;
      let original: ReturnType<typeof spatialAgentOpenRecord> = null;
      try { if (region.creationOperationId) original = spatialAgentOpenRecord(graph, region.creationOperationId); }
      catch { /* An unreadable admission leaves only this foreign control unconfirmed, not other membership. */ }
      let association: ReturnType<typeof spatialAgentAssociationRecord> = null;
      try { if (region.association) association = spatialAgentAssociationRecord(graph, region.association.operationId); }
      catch { /* Keep the Region; only its unresolved association control is unavailable. */ }
      const member: SpaceAgentRegion = { region, zone: resource, ...(association ? { association } : {}), ...(original ? { admission: { requestId: original.requestId,
        agentSessionId: original.agentSessionId, address: original.address, execution: original.execution,
        ...(original.placement ? { placement: original.placement } : {}) } } : {}) };
      for (const spaceId of spacesByZone.get(zone) ?? []) {
        const space = index.get(spaceId); if (key) space?.agents.add(key); space?.regions.set(region.regionId, member);
      }
    }
    const takeovers: SpaceAgentSnapshot['takeovers'] = new Map();
    let takeoverIssue: string | undefined;
    // Unreadable relation metadata must not revoke healthy member control.
    try {
    // Index only relation headers. Validation and execution observation stay scoped to the selected page.
    for (const value of Object.values(spatialAgentOpenDocument(graph).requests)) {
      if ('kind' in value || !value.takeover || typeof value.requestId !== 'string') continue;
      if (!value.execution || typeof value.agentSessionId !== 'string' || !value.takeover.source || typeof value.takeover.source.runtimeId !== 'string') throw new AgentMuxError('The retained Takeover relation header is unreadable.', 'AGENT_TAKEOVER_INDEX_UNCONFIRMED');
      const keys: Array<[string, string, string]> = [['incoming', value.execution.runtimeId ?? '', value.agentSessionId]];
      if (value.takeover.source.agentSessionId) keys.push(['outgoing', value.takeover.source.runtimeId, value.takeover.source.agentSessionId]);
      for (const key of keys) { const scope = JSON.stringify(key), rows = takeovers.get(scope) ?? []; rows.push(value); takeovers.set(scope, rows); }
    }
    for (const rows of takeovers.values()) rows.sort((a, b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);
    } catch (cause) { takeoverIssue = cause instanceof Error ? cause.message : String(cause); }
    return { stamp: spatialFileStamp(await file.stat({ bigint: true })), index, takeovers, ...(takeoverIssue ? { takeoverIssue } : {}) };
  }
  async readForLayout(): Promise<AgentMuxSpatialState | null> {
    const state = await this.read();
    return state ? projectSpatialState(state) : null;
  }
  private decode(source: string): AgentMuxSpatialState {
    try {
      const d = record(JSON.parse(source));
      if (d.schemaVersion !== 1 || !Number.isSafeInteger(d.revision) || (d.revision as number) < 1)
        invalid('Invalid spatial revision.');
      const graph = d.graph;
      assertAgentMuxSpatialGraph(graph);
      if (displayLabelDocument(graph).history !== 'complete') invalid('A layout history projection cannot replace the original record owner.');
      return { schemaVersion: 1, revision: d.revision as number, graph };
    }
    catch (error) {
      throw new AgentMuxError('Spatial state could not be read. Original bytes are retained; repair or explicitly restore the previous document.', 'SPATIAL_STATE_READ_UNCONFIRMED', error instanceof Error ? error.message : String(error));
    }
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.path + '.lock', 'a+', 0o600);
    try {
      const native: {
        tryLock(fd: number): boolean;
      } = requireNative('fs-native-extensions');
      const deadline = Date.now() + 5000;
      while (!native.tryLock(handle.fd)) {
        if (Date.now() >= deadline)
          throw new AgentMuxError('Spatial writer is busy. Original data and Runs are kept; retry this write.', 'SPATIAL_STATE_BUSY');
        await delay(10);
      }
      return await operation();
    }
    finally {
      await handle.close();
    }
  }
  private async writeLocked(current: AgentMuxSpatialState | null, graph: AgentMuxSpatialState['graph'],
    nameCommit?: AgentMuxSpatialState['nameCommit']): Promise<AgentMuxSpatialState> {
    const next: AgentMuxSpatialState = { schemaVersion: 1, revision: (current?.revision ?? 0) + 1, graph };
    if (current) await durableWriteFile(this.path + '.previous', JSON.stringify(current) + '\n', { requireDirectorySync: true });
    await durableWriteFile(this.path, JSON.stringify(next) + '\n', { requireDirectorySync: true });
    const acknowledged = nameCommit ? { ...next, nameCommit } : next;
    this.announce(acknowledged);
    return acknowledged;
  }
  private async requiredState(): Promise<AgentMuxSpatialState> {
    const state = await this.read();
    if (!state) throw new AgentMuxError('The original spatial document is not ready. Keep original names and retry this change after restoring storage.', 'SPATIAL_STATE_ABSENT');
    return state;
  }
  /** Explicit registration of an already configured resource; reads never ensure it. */
  async registerFolder(resource: FolderSpaceResource) {
    const { space, zone } = folderSpaceFacts(resource);
    return this.locked(async () => {
      const current = await this.read();
      const graph: AgentMuxSpatialGraph = current ? structuredClone(current.graph) : { spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} };
      const originalSpace = graph.spaces.find(value => value.spaceId === space.spaceId);
      const originalZone = graph.zones.find(value => value.zoneId === zone.zoneId);
      if (originalSpace && (originalSpace.kind !== space.kind || originalSpace.hostId !== space.hostId ||
          originalSpace.directoryPath !== space.directoryPath || originalSpace.projectId !== space.projectId) ||
          originalZone && (originalZone.kind !== zone.kind || originalZone.workspaceId !== zone.workspaceId || originalZone.hostId !== zone.hostId || originalZone.directoryPath !== zone.directoryPath)) {
        throw new AgentMuxError('The registered Folder identity contradicts its original Space or Zone. Existing members, names and Runs are retained.', 'SPACE_RESOURCE_CHANGED');
      }
      const binding = graph.bindings.some(value => value.spaceId === space.spaceId && value.zoneId === zone.zoneId);
      const created = !originalSpace || !originalZone || !binding;
      if (!created) return { state: projectSpatialState(current!), spaceId: space.spaceId, zoneId: zone.zoneId, created: false };
      if (!originalSpace) graph.spaces.push(space);
      if (!originalZone) graph.zones.push(zone);
      if (!binding) graph.bindings.push({ spaceId: space.spaceId, zoneId: zone.zoneId });
      const state = await this.writeLocked(current, parseAgentMuxSpatialGraph(graph));
      return { state: projectSpatialState(state), spaceId: space.spaceId, zoneId: zone.zoneId, created: true };
    });
  }
  /** A new explicit Source directory shares the original graph and lock, never the client config writer. */
  async registerDirectory(input: { runtimeId: string; directory: FolderDirectoryResource; workspaceId?: string },
    configured: (graph: AgentMuxSpatialGraph) => Promise<readonly FolderSpaceResource[]>, assertCurrent: () => Promise<void>) {
    return this.locked(async () => {
      const current = await this.read();
      const graph: AgentMuxSpatialGraph = current ? structuredClone(current.graph) : { spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} };
      const expected = input.directory;
      const matches = (r: FolderSpaceResource) => { const actual = folderResourceIdentity(r); return actual.hostId === expected.hostId && actual.workspacePath === expected.workspacePath && actual.projectRootPath === expected.projectRootPath; };
      const configuredResources = await configured(graph);
      const registered = configuredResources.filter(r => matches(r) && (input.workspaceId === undefined || input.workspaceId === r.id));
      const spacesById = new Map(graph.spaces.map(space => [space.spaceId,space])), zonesById = new Map(graph.zones.map(zone => [zone.zoneId,zone]));
      const originals = graph.bindings.flatMap(binding => {
        const space = spacesById.get(binding.spaceId), zone = zonesById.get(binding.zoneId);
        return space?.kind === 'folder' && space.hostId === expected.hostId && space.directoryPath === expected.projectRootPath &&
          zone?.hostId === expected.hostId && zone.directoryPath === expected.workspacePath && ['directory','worktree'].includes(zone.kind) &&
          (input.workspaceId === undefined || zone.workspaceId === input.workspaceId) ? [{ space, zone }] : [];
      });
      const ids = new Set([...registered.map(r => r.id), ...originals.map(r => r.zone.workspaceId)]);
      if (ids.size > 1 || originals.length > 1 || registered.length > 1) throw new AgentMuxError('Several original Folder resources match this directory. Inspect them and choose an exact original Workspace or Space; no identity was selected.', 'SPACE_REGISTRATION_AMBIGUOUS');
      if (input.workspaceId !== undefined && !ids.has(input.workspaceId)) throw new AgentMuxError('The selected Workspace is not an original candidate for this directory.', 'SPACE_RESOURCE_CHANGED');
      const original = originals[0], id = ids.size ? [...ids][0]! : mintObjectId();
      if (configuredResources.some(r => r.id === id && !matches(r))) throw new AgentMuxError('The original Workspace ID now describes another configured resource. Keep both original records and inspect the Source.', 'SPACE_RESOURCE_CHANGED');
      const resource: FolderSpaceResource = registered[0] ?? { id, hostId: expected.hostId, path: expected.workspacePath,
        name: original?.space.name ?? basename(expected.workspacePath), kind: original?.zone.kind === 'worktree' ? 'worktree' : 'folder',
        ...(expected.projectRootPath === expected.workspacePath ? {} : { repoPath: expected.projectRootPath }),
        ...(original?.zone.branch ? { branch: original.zone.branch } : {}) };
      const facts = folderSpaceFacts(resource), space = original?.space ?? facts.space, zone = original?.zone ?? facts.zone;
      const existingSpace = graph.spaces.find(s => s.spaceId === space.spaceId), existingZone = graph.zones.find(z => z.zoneId === zone.zoneId);
      if (existingSpace && (existingSpace.kind !== 'folder' || existingSpace.hostId !== expected.hostId || existingSpace.directoryPath !== expected.projectRootPath) ||
          existingZone && (existingZone.workspaceId !== id || existingZone.hostId !== expected.hostId || existingZone.directoryPath !== expected.workspacePath)) throw new AgentMuxError('The original Folder identity names another resource. Existing work is retained.', 'SPACE_RESOURCE_CHANGED');
      const bound = graph.bindings.some(b => b.spaceId === space.spaceId && b.zoneId === zone.zoneId);
      let changed = !existingSpace || !existingZone || !bound;
      if (!existingSpace) graph.spaces.push(space);
      if (!existingZone) graph.zones.push(zone);
      if (!bound) graph.bindings.push({ spaceId: space.spaceId, zoneId: zone.zoneId });
      // Configured resources keep their original owner. Only a Core-owned directory adds this fact.
      const key = folderDirectoryResourceKey(id);
      if (!registered.length || Object.hasOwn(graph.resources,key)) {
        const fact = { runtimeId: input.runtimeId, resource, directory: input.directory, spaceId: space.spaceId, zoneId: zone.zoneId };
        if (!isDeepStrictEqual(graph.resources[key],fact)) { graph.resources[key] = fact; changed = true; }
      }
      await assertCurrent();
      if (!changed) return { state: projectSpatialState(current!), spaceId: space.spaceId, zoneId: zone.zoneId, workspaceId: id, created: false };
      const state = await this.writeLocked(current, parseAgentMuxSpatialGraph(graph));
      return { state: projectSpatialState(state), spaceId: space.spaceId, zoneId: zone.zoneId, workspaceId: id, created: true };
    });
  }
  async admitTakeoverCancellation(admission: TakeoverCancellationAdmission) {
    return this.locked(async () => {
      const current = await this.requiredState(), id = admission.input.request.operationId
      const original = spatialAgentOpenRecord(current.graph, id)
      const { operationId, ...body } = admission.input.request
      const request = { schemaVersion: 5 as const, operation: 'agent.open' as const, requestId: operationId, ...body }
      if (original && (!original.takeover || original.takeoverRequestDigest !== spatialAgentOpenDigest(request))) throw new AgentMuxError('The cancellation belongs to another original Takeover.', 'SPACE_REQUEST_CONFLICT')
      const previous = takeoverCancellationRecord(current.graph, id)
      if (previous && !isDeepStrictEqual(previous, admission)) throw new AgentMuxError('The original Takeover has another cancellation or actor. Keep its original control.', 'AGENT_TAKEOVER_CANCELLATION_CONFLICT')
      const graph = structuredClone(current.graph)
      const document = graph.resources[TAKEOVER_CANCELLATION_RESOURCE] ?? {}
      graph.resources[TAKEOVER_CANCELLATION_RESOURCE] = { ...document as Record<string, SpatialJson>, [id]: structuredClone(admission) as unknown as SpatialJson }
      return projectSpatialState(await this.writeLocked(current, graph))
    })
  }

  async admitAgentOpen(input: Parameters<typeof admitSpatialAgentOpen>[1], assertCurrent?: (admission: ReturnType<typeof admitSpatialAgentOpen>) => Promise<void>) {
    return this.locked(async () => {
      const current = await this.requiredState(), admission = admitSpatialAgentOpen(current.graph, input);
      if (!admission.admitted) return { ...admission, state: projectSpatialState(current) };
      await assertCurrent?.(admission);
      const state = await this.writeLocked(current, parseAgentMuxSpatialGraph(admission.graph));
      return { ...admission, state: projectSpatialState(state) };
    });
  }
  async associateAgentOpen(request: Parameters<typeof admitSpatialAgentAssociation>[1], sourceRuntimeId: string, assertCurrent: () => Promise<void>) {
    return this.locked(async () => {
      const current = await this.requiredState(), admission = admitSpatialAgentAssociation(current.graph, request, sourceRuntimeId);
      await assertCurrent();
      if (!admission.admitted) return { ...admission, state: projectSpatialState(current) };
      const state = await this.writeLocked(current, parseAgentMuxSpatialGraph(admission.graph));
      return { ...admission, state: projectSpatialState(state) };
    });
  }
  /** Claim only a follow-up on the original creation. Its outcomes remain at Files/dialogue owners. */
  async claimMoteMainFollowUp(input: MoteMainFollowUpInput) {
    return this.locked(async () => {
      const current = await this.requiredState(), record = spatialAgentOpenRecord(current.graph, input.requestId)
      if (!record?.moteMain || !['source','binding'].includes(input.step)) throw new AgentMuxError('The original Main creation admission is unconfirmed.', 'SPATIAL_CREATION_UNCONFIRMED')
      if (input.baselineChanged) {
        const observed = parseMoteMainBaseline(input.baselineChanged, record.moteMain.target)
        if (input.step !== 'binding' || input.receipt || record.moteMainFollowUps?.bindStarted || sameMoteMainBaseline(observed, record.moteMain.baseline)) throw new AgentMuxError('Inspect the original dispatched binding; it cannot become a pre-submission refusal.', 'SPATIAL_CREATION_UNCONFIRMED')
        record.moteMainFollowUps = { ...record.moteMainFollowUps, refusedBeforeBinding: observed }
      }
      const key = input.step === 'source' ? 'sourceStarted' : 'bindStarted'
      if (record.moteMainFollowUps?.refusedBeforeBinding && !input.baselineChanged) return { record, claimed: false }
      if (!input.receipt && record.moteMainFollowUps?.[key]) return { record, claimed: false }
      if (input.receipt && (input.step !== 'binding' || !record.moteMainFollowUps?.bindStarted)) throw new AgentMuxError('A binding receipt needs its original dispatched request.', 'SPATIAL_CREATION_UNCONFIRMED')
      if (!input.baselineChanged) record.moteMainFollowUps = { ...record.moteMainFollowUps, [key]: true, ...(input.receipt ? { bindingReceipt: retainedMoteMainBindingReceipt(record, input.receipt) } : {}) }
      const graph = structuredClone(current.graph), stored = graph.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE] as unknown as { requests: Record<string, typeof record> }
      stored.requests[record.requestId] = record
      // Validate the original receipt and its request pair before retaining it.
      spatialAgentOpenRecord(graph, record.requestId)
      await this.writeLocked(current, graph)
      return { record, claimed: true }
    })
  }
  /** Freeze only an original post-binding input key, never a replacement target. */
  async claimMoteMainInput(requestId: string, step: 'deferredInputKey'|'handoverInputKey', key: Extract<import('./agent-prompt-condition.js').AgentPromptInputKey,{kind:'prompt'}>) {
    return this.locked(async () => {
      const current=await this.requiredState(),record=spatialAgentOpenRecord(current.graph,requestId)
      if(!record?.moteMain) throw new AgentMuxError('The original Main creation is unavailable.','SPATIAL_CREATION_UNCONFIRMED')
      const prior=record.moteMainFollowUps?.[step]
      if(prior) return prior
      record.moteMainFollowUps={...record.moteMainFollowUps,[step]:key}
      const graph=structuredClone(current.graph),document=graph.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE] as unknown as {requests:Record<string,typeof record>}
      document.requests[requestId]=record;spatialAgentOpenRecord(graph,requestId);await this.writeLocked(current,graph)
      return key
    })
  }
  async observeMoteMainInput(requestId:string,outcome:'admitted'|'terminal-confirmed'|'not-applied') {
    return this.locked(async()=>{
      const current=await this.requiredState(),record=spatialAgentOpenRecord(current.graph,requestId)
      if(!record?.moteMain?.deferredInput||!record.moteMainFollowUps?.deferredInputKey)throw new AgentMuxError('The original deferred Main input key is unavailable.','SPATIAL_CREATION_UNCONFIRMED')
      if(record.moteMainFollowUps.deferredInputObserved)return
      record.moteMainFollowUps={...record.moteMainFollowUps,deferredInputObserved:outcome}
      const graph=structuredClone(current.graph),document=graph.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE] as unknown as {requests:Record<string,typeof record>};document.requests[requestId]=record;spatialAgentOpenRecord(graph,requestId);await this.writeLocked(current,graph)
    })
  }
  /** Called only with the result returned by the original writer, never with a client receipt. */
  async recordMoteMainBindingResult(input: import('./mote/preferences.js').MoteQuickPreferencesSaveParams, result: import('./mote/preferences.js').MoteQuickPreferencesSaveResult) {
    return this.locked(async () => {
      const current = await this.read()
      if (!current) return false
      const candidates = Object.keys(spatialAgentOpenDocument(current.graph).requests).flatMap(id => { const record = spatialAgentOpenRecord(current.graph,id); return record ? [record] : [] }).filter(record => matchesMoteMainBindingInput(record,input))
      if (candidates.length !== 1) return false
      const record = candidates[0]!
      if (record.moteMainFollowUps?.refusedBeforeBinding) return false
      const receipt = retainedMoteMainBindingReceipt(record,result)
      const prior = record.moteMainFollowUps?.bindingReceipt
      if (prior && prior.status !== 'unconfirmed') return false
      record.moteMainFollowUps = { ...record.moteMainFollowUps, bindStarted:true, bindingReceipt:receipt }
      const graph = structuredClone(current.graph)
      ;(graph.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE] as unknown as {requests:Record<string,typeof record>}).requests[record.requestId] = record
      spatialAgentOpenRecord(graph,record.requestId)
      await this.writeLocked(current,graph)
      return true
    })
  }
  /** Reconciliation evidence stays distinct from a native File save acknowledgement. */
  async observeMoteMainBinding(requestId: string, source: MoteMainBindingObservation) {
    return this.locked(async () => {
      const current = await this.requiredState(), record = spatialAgentOpenRecord(current.graph,requestId)
      if (!record?.moteMain) throw new AgentMuxError('The original creation admission is unavailable.', 'SPATIAL_CREATION_UNCONFIRMED')
      validateMoteMainBindingObservation(record,source)
      if (record.moteMainFollowUps?.bindingObserved) return record
      record.moteMainFollowUps = {...record.moteMainFollowUps,bindingObserved:source}
      const graph = structuredClone(current.graph)
      ;(graph.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE] as unknown as {requests:Record<string,typeof record>}).requests[record.requestId] = record
      spatialAgentOpenRecord(graph,requestId)
      await this.writeLocked(current,graph)
      return record
    })
  }
  /** The exact Session receipt fills its reserved Region; a changed binding is never replaced. */
  async settleAgentOpen(requestId: string, session: { agentSessionId: string; run: { runId: string } }, regionResource: import('./spatial-graph.js').SpatialJson) {
    return this.locked(async () => {
      const current = await this.requiredState(), record = spatialAgentOpenRecord(current.graph, requestId);
      if (!record || record.agentSessionId !== session.agentSessionId) throw new AgentMuxError('The original creation receipt names another reserved Session.', 'SPATIAL_CREATION_UNCONFIRMED');
      const graph = structuredClone(current.graph), region = originalAgentOpenRegion(graph, record);
      if (!region) return { state: projectSpatialState(current), attached: false };
      const descriptor = graph.resources['region:' + region.regionId];
      if (region.runId === session.run.runId && JSON.stringify(descriptor) === JSON.stringify(regionResource)) return { state: projectSpatialState(current), attached: true };
      region.runId = session.run.runId; graph.resources['region:' + region.regionId] = structuredClone(regionResource);
      return { state: projectSpatialState(await this.writeLocked(current, parseAgentMuxSpatialGraph(graph))), attached: true };
    });
  }
  /** An external owner records intent; this method never edits its actual object. */
  async beginNameChange(input: AgentMuxNameChangeIntent): Promise<AgentMuxNameChangeAdmission> {
    validateNameIntent(input);
    return this.locked(async () => {
      const current = await this.requiredState(), graph = structuredClone(current.graph), document = displayLabelDocument(graph);
      const old = document.records.find(record => record.id === input.operationId);
      if (old) {
        if (JSON.stringify({ target: old.target, before: old.before, requested: old.requested, context: old.context }) !==
            JSON.stringify({ target: input.target, before: input.before, requested: input.requested, context: input.context }))
          throw new AgentMuxError('The name operation ID belongs to a different change.', 'NAME_OPERATION_CONFLICT');
        return { ...old, replayed: true };
      }
      const record: AgentMuxNameChangeRecord = { ...structuredClone(input), id: input.operationId, status: 'pending', actual: null,
        startedAt: Date.now(), settledAt: null, reason: null };
      document.records.push(record); setDisplayLabelDocument(graph, document);
      await this.writeLocked(current, graph);
      return { ...record, replayed: false };
    });
  }
  /** A durable result acknowledges only the record; the external owner owns name persistence. */
  async settleNameChange(input: AgentMuxNameChangeSettlement): Promise<AgentMuxNameChangeRecord> {
    if (!input || typeof input.id !== 'string' || !['applied', 'failed', 'unknown'].includes(input.status) ||
        (input.actual !== undefined && input.actual !== null && typeof input.actual !== 'string')) invalid('An exact name operation result is required.');
    return this.locked(async () => {
      const current = await this.requiredState(), graph = structuredClone(current.graph), document = displayLabelDocument(graph);
      const record = document.records.find(record => record.id === input.id);
      if (!record) throw new AgentMuxError('The original name intent is unavailable. Do not invent or replay this change.', 'NAME_INTENT_ABSENT');
      if (record.status !== 'pending' && record.status !== 'unknown') {
        if (record.status !== input.status || (input.actual !== undefined && record.actual !== input.actual))
          throw new AgentMuxError('This name result was already settled differently.', 'NAME_OPERATION_CONFLICT');
        return record;
      }
      record.status = input.status; record.settledAt = Date.now(); record.reason = input.reason ?? null;
      if (input.actual !== undefined) record.actual = input.actual;
      else if (input.status === 'unknown') record.actual = null;
      if (input.ownerRevision !== undefined) record.ownerRevision = input.ownerRevision;
      setDisplayLabelDocument(graph, document); await this.writeLocked(current, graph);
      return record;
    });
  }
  async listNameChanges(target?: AgentMuxNameTarget, limit = 50): Promise<AgentMuxNameChangeRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid('Name history limit must be between 1 and 1000.');
    const current = await this.requiredState(), records = displayLabelDocument(current.graph).records;
    return records.filter(record => !target || nameTargetKey(record.target) === nameTargetKey(target)).slice(-limit);
  }
  /** Explicitly confirm the current document; never replay the original name edit. */
  async confirmNameCommit(operationId: string, expectedTarget?: AgentMuxNameTarget, assertCurrent?: () => void | Promise<void>): Promise<AgentMuxSpatialState> {
    return this.locked(async () => {
      await assertCurrent?.();
      const current = await this.requiredState();
      const document = displayLabelDocument(current.graph), record = document.records.find(record => record.id === operationId);
      if (!record)
        throw new AgentMuxError('The original name operation is unobserved. Keep the current name and inspect its owner.', 'NAME_INTENT_ABSENT');
      if (expectedTarget && nameTargetKey(record.target) !== nameTargetKey(expectedTarget))
        throw new AgentMuxError('The original name operation belongs to another exact target.', 'NAME_OPERATION_CONFLICT');
      if (!Object.hasOwn(document.labels, nameTargetKey(record.target)))
        throw new AgentMuxError('This name belongs to another owner. Confirm its actual data at that owner; this document only holds its audit record.', 'NAME_CONFIRM_OWNER_MISMATCH');
      return projectSpatialState(await this.writeLocked(current, current.graph, { operationId, target: record.target,
        applied: record.status === 'applied', diskDurability: 'confirmed', issue: null }));
    });
  }
  async queryNameChanges(input: { target?: AgentMuxNameTarget; afterId?: string; limit?: number } = {}): Promise<{ records: AgentMuxNameChangeRecord[]; nextCursor: string | null }> {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid('Name history limit must be between 1 and 1000.');
    const state = await this.requiredState(), all = displayLabelDocument(state.graph).records;
    const records = all.filter(record => !input.target || nameTargetKey(record.target) === nameTargetKey(input.target));
    const cursor = input.afterId === undefined ? -1 : records.findIndex(record => record.id === input.afterId);
    if (input.afterId !== undefined && cursor < 0) throw new AgentMuxError('Name history cursor is not in this target history.', 'NAME_CURSOR_UNAVAILABLE');
    const page = records.slice(cursor + 1, cursor + 1 + limit);
    return { records: page, nextCursor: cursor + 1 + page.length < records.length ? page.at(-1)!.id : null };
  }
  /** One exact label/operation read. ENOENT is absence; unreadable bytes remain an error. */
  async readDisplayLabel(target: AgentMuxNameTarget, operationId?: string): Promise<{ label: import('./display-label.js').AgentMuxDisplayLabel | null; value: string | null; record: AgentMuxNameChangeRecord | null }> {
    const current = await this.read();
    if (!current) return { label: null, value: null, record: null };
    const document = displayLabelDocument(current.graph), label = document.labels[nameTargetKey(target)] ?? null;
    const record = operationId === undefined ? null : document.records.find(record => record.id === operationId) ?? null;
    if (record && nameTargetKey(record.target) !== nameTargetKey(target)) throw new AgentMuxError('The original name operation belongs to another target.', 'NAME_OPERATION_CONFLICT');
    const tab = target.kind === 'tab' ? current.graph.tabs.find(tab => tab.tabId === target.id) : undefined;
    return { label, value: label?.value ?? tab?.name ?? null, record };
  }
  /** Label and history are one durable write under the same cross-process lock. */
  async mutateDisplayLabel(input: AgentMuxDisplayLabelMutation, context: AgentMuxNameContext, options: { initializeAgentLabel?: true; assertCurrent?: () => void | Promise<void> } = {}): Promise<AgentMuxDisplayLabelResult> {
    if (!Number.isSafeInteger(input.expectedNameRevision) || input.expectedNameRevision < 0 ||
        !['manual', 'launch', 'derived'].includes(input.source)) invalid('An exact name revision and writer source are required.');
    validateNameIntent({ operationId: input.operationId, target: input.target, before: null, requested: input.value, context });
    return this.locked(async () => {
      const stored = await this.read();
      if (!stored && !(options.initializeAgentLabel && input.target.kind === 'agent-session'))
        throw new AgentMuxError('The original spatial document is not ready. Keep original names and retry after restoring storage.', 'SPATIAL_STATE_ABSENT');
      await options.assertCurrent?.();
      const current = stored ?? { schemaVersion: 1 as const, revision: 0, graph: parseAgentMuxSpatialGraph({ spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} }) };
      const graph = structuredClone(current.graph), document = displayLabelDocument(graph);
      const key = nameTargetKey(input.target), label = document.labels[key] ?? null;
      const tab = input.target.kind === 'tab' ? graph.tabs.find(tab => tab.tabId === input.target.id) : null;
      if (input.target.kind === 'tab' && !tab) throw new AgentMuxError('The exact Tab is unobserved; original names are retained.', 'NAME_TARGET_UNAVAILABLE');
      const before = label?.value ?? tab?.name ?? null;
      const replay = document.records.find(record => record.id === input.operationId);
      if (replay) {
        if (nameTargetKey(replay.target) !== key || replay.requested !== input.value || JSON.stringify(replay.context) !== JSON.stringify(context))
          throw new AgentMuxError('The name operation ID belongs to another change.', 'NAME_OPERATION_CONFLICT');
        return { state: projectSpatialState(current), label, record: replay, changed: false, applied: replay.status === 'applied',
          diskDurability: 'unconfirmed', issue: 'This operation is already recorded. The current name is retained; inspect the original record before making a new edit.' };
      }
      const conflict = (label?.nameRevision ?? 0) !== input.expectedNameRevision;
      const protectedIntent = (label?.source === 'manual' || label?.source === 'retained' ||
        (label?.source === 'launch' && input.source === 'derived') || (!label && before !== null));
      const rejected = conflict || (input.source !== 'manual' && protectedIntent);
      const now = Date.now(), record: AgentMuxNameChangeRecord = {
        operationId: input.operationId, id: input.operationId, target: structuredClone(input.target), before, requested: input.value,
        context: structuredClone(context), status: rejected ? 'failed' : 'applied', actual: rejected ? before : input.value,
        startedAt: now, settledAt: now, ownerRevision: rejected ? label?.nameRevision ?? 0 : (label?.nameRevision ?? 0) + 1,
        reason: conflict ? 'Name changed since this request. Keep the edit and review the current name.'
          : rejected ? 'A later explicit or retained name intent is protected from automatic naming.' : null
      };
      document.records.push(record);
      if (!rejected) {
        document.labels[key] = { target: structuredClone(input.target), value: input.value, source: input.source,
          nameRevision: (label?.nameRevision ?? 0) + 1, operationId: input.operationId };
        if (tab) tab.name = input.value;
      }
      setDisplayLabelDocument(graph, document);
      let state: AgentMuxSpatialState, diskDurability: 'confirmed' | 'unconfirmed' = 'confirmed', issue: string | null = null;
      try { state = await this.writeLocked(stored, graph, { operationId: record.id, target: record.target,
        applied: !rejected, diskDurability: 'confirmed', issue: null }); }
      catch (error) {
        if (!(error instanceof DurableWriteError) || error.path !== this.path || error.phase !== 'after-replace') throw error;
        // This exact replacement succeeded under our lock. Its content is applied,
        // while a power-loss durability ACK is unknown; do not replay or roll back.
        diskDurability = 'unconfirmed';
        issue = `Name operation ${record.id} ${rejected ? 'was refused; its record was replaced' : 'was applied'}, but disk confirmation failed: ${error.message}. Keep the current name and inspect this record before a new edit.`;
        state = { schemaVersion: 1, revision: current.revision + 1, graph,
          nameCommit: { operationId: record.id, target: record.target, applied: !rejected, diskDurability, issue } };
        this.announce(state);
      }
      return { state: projectSpatialState(state), label: document.labels[key] ?? label, record, changed: !rejected && before !== input.value,
        applied: !rejected, diskDurability, issue };
    });
  }
  /** Preserve actually observed old aliases without fabricating their historical author. */
  async retainDisplayLabels(values: { target: AgentMuxNameTarget; value: string }[]): Promise<AgentMuxSpatialState> {
    return this.locked(async () => {
      const current = await this.requiredState(), graph = structuredClone(current.graph), document = displayLabelDocument(graph);
      let changed = false;
      for (const value of values) {
        validateNameIntent({ operationId: 'retain', target: value.target, before: null, requested: value.value,
          context: { actor: { kind: 'unknown', id: null, verified: false }, source: 'retained', entryPoint: 'initial-name-ownership', transport: null, location: {} } });
        const key = nameTargetKey(value.target);
        if (Object.hasOwn(document.labels, key)) continue;
        const tab = value.target.kind === 'tab' ? graph.tabs.find(tab => tab.tabId === value.target.id) : undefined;
        // An existing durable Tab name outranks the client's old handoff.
        // Keep the label and public Tab fact in the same owner commit.
        const retainedValue = tab?.name ?? value.value;
        document.labels[key] = { target: structuredClone(value.target), value: retainedValue, source: 'retained', nameRevision: 1, operationId: 'retained:' + key };
        if (tab) tab.name = retainedValue;
        changed = true;
      }
      if (!changed) return projectSpatialState(current);
      setDisplayLabelDocument(graph, document); return projectSpatialState(await this.writeLocked(current, graph));
    });
  }
  /**
   * Record a created Agent at its exact Launcher Region under the store lock, independent of any
   * client's background layout save. Reads the current revision itself, so a concurrent writer
   * never forces a retry. An already attached matching Region is settled without a new revision.
   */
  async attachLauncherAgent(input: AgentRegionAttachment): Promise<{ state: AgentMuxSpatialState; outcome: 'attached' | 'already-attached' }> {
    const agentRegion = structuredClone(input);
    for (const value of [agentRegion.tabId, agentRegion.regionId, agentRegion.agentSessionId, agentRegion.runId, agentRegion.execution?.hostId, agentRegion.execution?.cwd])
      if (typeof value !== 'string' || !value || value.includes('\0')) invalid('An exact Launcher Region, Agent Session, Run and execution location are required.');
    return this.locked(async () => {
      const current = await this.requiredState(), graph = structuredClone(current.graph);
      const placement = placeAgentRegion(graph, agentRegion);
      if (placement === 'absent')
        throw new AgentMuxError('The exact Launcher Region is not in the spatial document. The Agent and its Run are retained.', 'SPATIAL_RESOURCE_TARGET_CONFLICT');
      if (placement === 'conflict') throw new AgentMuxError(REGION_CHANGED, 'SPATIAL_RESOURCE_TARGET_CONFLICT');
      if (placement === 'settled') return { state: projectSpatialState(current), outcome: 'already-attached' as const };
      const state = projectSpatialState(await this.writeLocked(current, parseAgentMuxSpatialGraph(graph)));
      return { state, outcome: 'attached' as const };
    });
  }
  /** Host-owned metadata and an exact producer-confirmed Agent attachment share one transaction.
   * An in-process owner can assert its exact dependencies under the write lock. */
  async commitOwnedResource(input: { key: string; value: SpatialJson; agentRegion?: AgentRegionAttachment } & (
    { expectedRevision: number; assertCurrent?: never } |
    { expectedRevision?: never; assertCurrent: (graph: Readonly<AgentMuxSpatialGraph>) => void | Promise<void> }
  )): Promise<{
    state: AgentMuxSpatialState; key: string; diskDurability: 'confirmed';
  }> {
    const { key, expectedRevision, assertCurrent } = input;
    if (typeof key !== 'string' || !key.startsWith('owned:') || key.length === 'owned:'.length || key.includes('\0'))
      invalid('An exact owned resource key with a nonempty stable suffix is required.');
    if (assertCurrent === undefined && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
      invalid('An exact nonnegative expected revision is required.');
    const value = structuredClone(input.value), agentRegion = input.agentRegion === undefined ? undefined : structuredClone(input.agentRegion);
    if (agentRegion !== undefined && (!agentRegion || typeof agentRegion.agentSessionId !== 'string' || typeof agentRegion.runId !== 'string' || !agentRegion.execution))
      invalid('An exact Agent Session, Run and execution location are required.');
    return this.locked(async () => {
      const current = await this.requiredState();
      if (expectedRevision !== undefined && current.revision !== expectedRevision)
        throw new AgentMuxError('Spatial state changed. Read the current revision and preserve both edits before retrying.', 'SPATIAL_STATE_CONFLICT');
      if (assertCurrent) await assertCurrent(current.graph);
      const graph = structuredClone(current.graph);
      const placement = agentRegion && placeAgentRegion(graph, agentRegion);
      if (placement === 'absent' || placement === 'conflict') throw new AgentMuxError(REGION_CHANGED, 'SPATIAL_RESOURCE_TARGET_CONFLICT');
      graph.resources[key] = value;
      const validated = parseAgentMuxSpatialGraph(graph);
      // An equal read is not a producer ACK. Reconfirm even an identical value.
      const state = projectSpatialState(await this.writeLocked(current, validated));
      return { state, key, diskDurability: 'confirmed' };
    });
  }
  /** Explicit publication is one original graph transaction; cold resolve is strictly read-only. */
  async ensureSpaceLink(target: SpaceLinkTarget, operationId: string, assertCurrent?: () => void | Promise<void>): Promise<SpaceLinkAddress> {
    return this.locked(async () => {
      const current = await this.requiredState(), graph = structuredClone(current.graph)
      const spaces = graph.spaces.filter(space => space.spaceId === target.spaceId && space.kind === 'mote')
      if (spaces.length !== 1) throw new AgentMuxError('The exact original Mote is unconfirmed. Its identity and workface are kept.', 'SPACE_LINK_TARGET_UNCONFIRMED')
      const document = spaceLinkDocument(graph.resources[SPACE_LINK_RESOURCE])
      const same = (value: SpaceLinkTarget) => value.runtimeId === target.runtimeId && value.spaceId === target.spaceId && value.eventId === target.eventId
      const previous = Object.hasOwn(document.operations, operationId) ? document.operations[operationId] : undefined
      if (previous && !same(document.records[previous]!)) throw new AgentMuxError('This original link operation belongs to another target.', 'SPACE_LINK_OPERATION_CONFLICT')
      let linkId = previous ?? Object.keys(document.records).find(id => same(document.records[id]!))
      if (!linkId) { do { linkId = mintObjectId() } while (Object.hasOwn(document.records,linkId)); document.records[linkId] = structuredClone(target) }
      Object.defineProperty(document.operations, operationId, {value: linkId, enumerable: true, configurable: true, writable: true})
      graph.resources[SPACE_LINK_RESOURCE] = document as unknown as SpatialJson
      await assertCurrent?.()
      // A retry reconfirms these same bindings; an equal cold read is not a write ACK.
      await this.writeLocked(current, parseAgentMuxSpatialGraph(graph))
      return { runtimeId: target.runtimeId, linkId }
    })
  }
  async resolveSpaceLink(address: SpaceLinkAddress): Promise<SpaceLinkTarget | null> {
    const state = await this.requiredState(), document = spaceLinkDocument(state.graph.resources[SPACE_LINK_RESOURCE])
    const target = document.records[address.linkId]
    if (!target) return null
    if (target.runtimeId !== address.runtimeId) throw new AgentMuxError('The public link belongs to another original Runtime.', 'RUNTIME_OWNER_MISMATCH')
    if (!state.graph.spaces.some(space => space.spaceId === target.spaceId && space.kind === 'mote'))
      throw new AgentMuxError('The original Mote target is currently unconfirmed. Its public address is retained.', 'SPACE_LINK_TARGET_UNCONFIRMED')
    return structuredClone(target)
  }
  async commit(input: AgentMuxSpatialCommit): Promise<AgentMuxSpatialState> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      invalid('An exact nonnegative expected revision is required.');
    if (input.removedProjectGroupIds !== undefined && (!Array.isArray(input.removedProjectGroupIds) ||
      input.removedProjectGroupIds.some(id => typeof id !== 'string' || !id || id.includes('\0')) ||
      new Set(input.removedProjectGroupIds).size !== input.removedProjectGroupIds.length))
      // Malformed deletion intent rejects this request, preserving original groups and Runs.
      invalid('Exact project group removal IDs must be a unique array of stable IDs.');
    const graph = parseAgentMuxSpatialGraph(input.graph);
    return this.locked(async () => {
      const current = await this.read();
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new AgentMuxError('Spatial state changed. Read the current revision and preserve both edits before retrying.', 'SPATIAL_STATE_CONFLICT');
      // Bulk/bootstrap callers may echo confirmed owned metadata, but cannot
      // contribute it or erase it by omitting it from a layout snapshot.
      for (const [key, value] of Object.entries(graph.resources)) {
        if (key.startsWith('owned:') && (!current || !Object.hasOwn(current.graph.resources, key) || !isDeepStrictEqual(value, current.graph.resources[key])))
          throw new AgentMuxError('This resource belongs to its original owner. Preserve its binding and submit the layout edit without replacing owned metadata.', 'SPATIAL_RESOURCE_AUTHORITY_CONFLICT');
      }
      if (current) for (const [key, value] of Object.entries(current.graph.resources)) {
        if (key.startsWith('owned:')) graph.resources[key] = value;
      }
      if (current) retainFolderDirectoryIdentity(graph,current.graph);
      if (current) retainAdmittedAgentIdentity(graph, current.graph);
      const groupIds = new Set(graph.projectGroups?.map(group => group.groupId));
      const removedGroupIds = new Set(input.removedProjectGroupIds ?? []);
      if (current?.graph.projectGroups?.some(group => !groupIds.has(group.groupId) && !removedGroupIds.has(group.groupId))) {
          // Reject only this write; an omitted group is not an explicit user dissolution.
          throw new AgentMuxError('An original project group is missing. Explicit dissolution is required; all original work is retained.', 'SPATIAL_ENTITY_REMOVAL_UNCONFIRMED');
      }
      // All writers, including public full-graph callers, share this lock. A layout
      // snapshot cannot become a name writer or erase the durable name history.
      if (current) {
        const resource = AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE, originalCreation = current.graph.resources[resource];
        if (graph.resources[resource] !== undefined && JSON.stringify(graph.resources[resource]) !== JSON.stringify(originalCreation))
          throw new AgentMuxError('Spatial creation associations belong to their original Core owner. Refresh this graph and preserve the layout edit.', 'SPATIAL_CREATION_AUTHORITY_CONFLICT');
        if (originalCreation !== undefined) graph.resources[resource] = originalCreation;
        const proposed = displayLabelDocument(graph), original = displayLabelDocument(current.graph);
        if (JSON.stringify(proposed.labels) !== JSON.stringify(original.labels) ||
            (proposed.records.length > 0 && JSON.stringify(proposed.records) !== JSON.stringify(original.records)))
          throw new AgentMuxError('Names and their records are owned by label mutations. Refresh the graph and keep the layout edit.', 'NAME_AUTHORITY_CONFLICT');
        for (const tab of graph.tabs) {
          const old = current.graph.tabs.find(entry => entry.tabId === tab.tabId);
          const owned = original.labels[nameTargetKey({ kind: 'tab', id: tab.tabId })];
          if ((owned && owned.value !== tab.name) || (old && old.name !== tab.name))
            throw new AgentMuxError('Use the exact Tab label mutation; a layout snapshot cannot rename it or reuse its identity with another name.', 'NAME_AUTHORITY_CONFLICT');
        }
        // Deletion removes a presentation, not its name authority. A standalone
        // old Tab may predate labels; retain its observed value before its graph
        // identity disappears, without inventing an author or rename event.
        let retained = false;
        const surviving = new Set(graph.tabs.map(tab => tab.tabId));
        for (const old of current.graph.tabs) {
          const target = { kind: 'tab', id: old.tabId }, key = nameTargetKey(target);
          if (surviving.has(old.tabId) || Object.hasOwn(original.labels, key)) continue;
          original.labels[key] = { target, value: old.name, source: 'retained', nameRevision: 1, operationId: 'retained:' + key };
          retained = true;
        }
        if (retained || Object.hasOwn(current.graph.resources, AGENTMUX_DISPLAY_LABEL_RESOURCE))
          setDisplayLabelDocument(graph, original);
      }
      else if (Object.hasOwn(graph.resources, AGENTMUX_DISPLAY_LABEL_RESOURCE))
        throw new AgentMuxError('Initial layout registration cannot manufacture name history. Retain observed names through their owner.', 'NAME_AUTHORITY_CONFLICT');
      if (!current && Object.hasOwn(graph.resources, AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE))
        throw new AgentMuxError('Initial layout registration cannot manufacture spatial creation associations.', 'SPATIAL_CREATION_AUTHORITY_CONFLICT');
      if (input.allowEntityRemoval !== true && current) {
        for (const [kind, key] of [['spaces', 'spaceId'], ['zones', 'zoneId'], ['tabs', 'tabId'], ['regions', 'regionId']] as const) {
          const nextIds = new Set(graph[kind].map(entry => (entry as unknown as Record<string, string>)[key]));
          if (current.graph[kind].some(entry => !nextIds.has((entry as unknown as Record<string, string>)[key]))) {
            throw new AgentMuxError('An entity is missing from this update. Original entities are retained; explicit deletion is required.', 'SPATIAL_ENTITY_REMOVAL_UNCONFIRMED');
          }
        }
      }
      const next: AgentMuxSpatialState = { schemaVersion: 1, revision: (current?.revision ?? 0) + 1, graph };
      if (current)
        await durableWriteFile(this.path + '.previous', JSON.stringify(current) + '\n', { requireDirectorySync: true });
      await durableWriteFile(this.path, JSON.stringify(next) + '\n', { requireDirectorySync: true });
      this.announce(next);
      return projectSpatialState(next);
    });
  }
  async bind(binding: AgentMuxSpaceBindingTarget, remove: boolean): Promise<AgentMuxSpatialState> {
    // Optimistic conflict is reported, not silently replayed against a different graph.
    const state = await this.read();
    if (!state)
      throw new AgentMuxError('No durable spatial graph has been registered.', 'SPATIAL_STATE_ABSENT');
    const graph = structuredClone(state.graph);
    if (binding.kind === 'zone-space') {
      if (!graph.zones.some(z => z.zoneId === binding.zoneId) || !graph.spaces.some(s => s.spaceId === binding.spaceId))
        invalid('Binding entities must be known.');
      const exists = graph.bindings.some(b => b.zoneId === binding.zoneId && b.spaceId === binding.spaceId);
      if (remove)
        graph.bindings = graph.bindings.filter(b => !(b.zoneId === binding.zoneId && b.spaceId === binding.spaceId));
      else if (!exists)
        graph.bindings.push({ zoneId: binding.zoneId, spaceId: binding.spaceId });
    }
    else {
      const layout = graph.layouts[binding.displayWorkspaceId];
      if (!layout?.groups.some(g => g.id === binding.groupId) || !graph.tabs.some(t => t.tabId === binding.tabId))
        invalid('The exact Tab and display Group must be known.');
      const next = remove ? removeTab(layout, binding.groupId, binding.tabId) : addTabOccurrence(layout, binding.groupId, binding.tabId);
      if (next)
        graph.layouts[binding.displayWorkspaceId] = next;
    }
    return this.commit({ expectedRevision: state.revision, graph });
  }
}
