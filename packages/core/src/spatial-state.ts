import { watch, type FSWatcher } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, open, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { durableWriteFile, DurableWriteError } from './durable-write.js';
import { AgentMuxError } from './errors.js';
import { defaultAgentMuxStateDirectory } from './runtime-paths.js';
import type { AgentMuxSpaceBindingTarget } from './space-control.js';
import { addTabOccurrence, removeTab } from './spatial-layout.js';
import { parseAgentMuxSpatialGraph, type AgentMuxSpatialState, type AgentMuxSpatialCommit } from './spatial-graph.js';
import { AGENTMUX_DISPLAY_LABEL_RESOURCE, displayLabelDocument, setDisplayLabelDocument, projectSpatialState, nameTargetKey, validateNameIntent,
  type AgentMuxNameTarget, type AgentMuxNameContext, type AgentMuxNameChangeIntent, type AgentMuxNameChangeRecord,
  type AgentMuxNameChangeAdmission, type AgentMuxNameChangeSettlement, type AgentMuxDisplayLabelMutation, type AgentMuxDisplayLabelResult } from './display-label.js';
export * from './spatial-graph.js';
function invalid(message: string): never { throw new AgentMuxError(message, 'SPATIAL_STATE_INVALID'); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value))
  invalid('A spatial object is required.'); return value as Record<string, unknown>; }
export function defaultAgentMuxSpatialStatePath(): string {
  const selected = process.env.AGENTMUX_SPATIAL_STATE_STORE;
  if (selected && !isAbsolute(selected))
    invalid('AGENTMUX_SPATIAL_STATE_STORE must be absolute.');
  return selected || join(defaultAgentMuxStateDirectory(), 'spatial-state.json');
}
const requireNative = createRequire(import.meta.url);
/** A single filesystem owner. Lock inode is never removed, including after process death. */
export class AgentMuxSpatialStateStore {
  private readonly listeners = new Set<(state: AgentMuxSpatialState) => void>();
  private watcher: FSWatcher | null = null;
  private watching = 0;
  private announcedRevision = 0;
  private announcedNameCommit: string | null = null;
  subscribe(listener: (state: AgentMuxSpatialState) => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      const generation = ++this.watching;
      void mkdir(dirname(this.path), { recursive: true, mode: 0o700 }).then(() => {
        if (generation !== this.watching || this.listeners.size === 0)
          return;
        this.watcher = watch(dirname(this.path), (_event, name) => {
          if (name !== null && String(name) !== basename(this.path))
            return;
          void this.read().then(state => { if (state && generation === this.watching)
            this.announce(state); }).catch(error => this.observationWarning(error));
        });
        this.watcher.on('error', error => this.observationWarning(error));
        // Close the read/subscribe race, including a commit from another process.
        return this.read().then(state => { if (state && generation === this.watching)
          this.announce(state); });
      }).catch(error => this.observationWarning(error));
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.watching++;
        this.watcher?.close();
        this.watcher = null;
      }
    };
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
        this.observationWarning(error);
      }
    }
  }
  constructor(readonly path = defaultAgentMuxSpatialStatePath()) {
    if (!isAbsolute(path))
      invalid('Spatial state path must be absolute.');
  }
  async read(): Promise<AgentMuxSpatialState | null> {
    let source: string;
    try {
      source = await readFile(this.path, 'utf8');
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return null;
      throw error;
    }
    return this.decode(source);
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
      const graph = parseAgentMuxSpatialGraph(d.graph);
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
  private async writeLocked(current: AgentMuxSpatialState, graph: AgentMuxSpatialState['graph'],
    nameCommit?: AgentMuxSpatialState['nameCommit']): Promise<AgentMuxSpatialState> {
    const next: AgentMuxSpatialState = { schemaVersion: 1, revision: current.revision + 1, graph };
    await durableWriteFile(this.path + '.previous', JSON.stringify(current) + '\n', { requireDirectorySync: true });
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
  async confirmNameCommit(operationId: string): Promise<AgentMuxSpatialState> {
    return this.locked(async () => {
      const current = await this.requiredState();
      const document = displayLabelDocument(current.graph), record = document.records.find(record => record.id === operationId);
      if (!record)
        throw new AgentMuxError('The original name operation is unobserved. Keep the current name and inspect its owner.', 'NAME_INTENT_ABSENT');
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
  /** Label and history are one durable write under the same cross-process lock. */
  async mutateDisplayLabel(input: AgentMuxDisplayLabelMutation, context: AgentMuxNameContext): Promise<AgentMuxDisplayLabelResult> {
    if (!Number.isSafeInteger(input.expectedNameRevision) || input.expectedNameRevision < 0 ||
        !['manual', 'launch', 'derived'].includes(input.source)) invalid('An exact name revision and writer source are required.');
    validateNameIntent({ operationId: input.operationId, target: input.target, before: null, requested: input.value, context });
    return this.locked(async () => {
      const current = await this.requiredState(), graph = structuredClone(current.graph), document = displayLabelDocument(graph);
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
      try { state = await this.writeLocked(current, graph, { operationId: record.id, target: record.target,
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
        document.labels[key] = { ...structuredClone(value), source: 'retained', nameRevision: 1, operationId: 'retained:' + key };
        changed = true;
      }
      if (!changed) return projectSpatialState(current);
      setDisplayLabelDocument(graph, document); return projectSpatialState(await this.writeLocked(current, graph));
    });
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
      const groupIds = new Set(graph.projectGroups?.map(group => group.groupId));
      const removedGroupIds = new Set(input.removedProjectGroupIds ?? []);
      if (current?.graph.projectGroups?.some(group => !groupIds.has(group.groupId) && !removedGroupIds.has(group.groupId))) {
          // Reject only this write; an omitted group is not an explicit user dissolution.
          throw new AgentMuxError('An original project group is missing. Explicit dissolution is required; all original work is retained.', 'SPATIAL_ENTITY_REMOVAL_UNCONFIRMED');
      }
      // All writers, including public full-graph callers, share this lock. A layout
      // snapshot cannot become a name writer or erase the durable name history.
      if (current) {
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
