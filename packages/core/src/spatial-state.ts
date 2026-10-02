import { watch, type FSWatcher } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, open, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { durableWriteFile } from './durable-write.js';
import { AgentMuxError } from './errors.js';
import { defaultAgentMuxStateDirectory } from './runtime-paths.js';
import type { AgentMuxSpaceBindingTarget } from './space-control.js';
import { addTabOccurrence, removeTab } from './spatial-layout.js';
import { parseAgentMuxSpatialGraph, type AgentMuxSpatialState, type AgentMuxSpatialCommit } from './spatial-graph.js';
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
    if (state.revision <= this.announcedRevision)
      return;
    this.announcedRevision = state.revision;
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(state));
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
  private decode(source: string): AgentMuxSpatialState {
    try {
      const d = record(JSON.parse(source));
      if (d.schemaVersion !== 1 || !Number.isSafeInteger(d.revision) || (d.revision as number) < 1)
        invalid('Invalid spatial revision.');
      return { schemaVersion: 1, revision: d.revision as number, graph: parseAgentMuxSpatialGraph(d.graph) };
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
  async commit(input: AgentMuxSpatialCommit): Promise<AgentMuxSpatialState> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      invalid('An exact nonnegative expected revision is required.');
    const graph = parseAgentMuxSpatialGraph(input.graph);
    return this.locked(async () => {
      const current = await this.read();
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new AgentMuxError('Spatial state changed. Read the current revision and preserve both edits before retrying.', 'SPATIAL_STATE_CONFLICT');
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
      return next;
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
