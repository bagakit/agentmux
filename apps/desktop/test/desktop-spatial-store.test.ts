import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state';
import { createWorkspaceLayout } from '@agentmux/layout';
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs';
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state';
import { api } from '../src/renderer/src/lib/api';
import { useAppStore } from '../src/renderer/src/store';
import type { AppConfig, SessionSnapshot, RuntimeSnapshot, AgentTimelineSnapshot } from '../src/shared/contracts';
import { agent } from './helpers/workface-control-fixture';
const config: AppConfig = { version: 9, hosts: [{ id: 'host', kind: 'local', label: 'Local' }], executors: {}, workspaces: [{ id: 'resource', name: 'Project', hostId: 'host', path: _hygiene_fixturePath("project"), kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } };
const original = useAppStore.getState(), directories: string[] = [], disposers: (() => void)[] = [];
function workbench(name: string) { const tab = createWorkbenchTab('file', { regionId: 'file-region', kind: 'file', workspaceId: 'resource', path: 'research.md' }, name); return { config, sessions: [], tabs: { file: tab }, layouts: { resource: createWorkspaceLayout('group', ['file']) }, spaceZoneBindings: {}, spatialRequests: {} }; }
afterEach(async () => { for (const dispose of disposers.splice(0))
  dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(original, true); for (const path of directories.splice(0))
  await rm(path, { recursive: true, force: true }); });
async function fixture(sessions: SessionSnapshot[] = [], recoveryCandidates: RuntimeSnapshot['recoveryCandidates'] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'amux-spatial-client-'));
  directories.push(dir);
  const store = new AgentMuxSpatialStateStore(join(dir, 'state.json'));
  vi.spyOn(api.spatial, 'read').mockImplementation(() => store.read());
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => store.commit(input));
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => store.subscribe(listener));
  vi.spyOn(api.config, 'get').mockResolvedValue(config);
  const snapshot = await api.sessions.snapshot();
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...snapshot, sessions, recoveryCandidates });
  return store;
}
function aliasSession() {
  const session = agent('original-pane-alias');
  return { ...session, hostId: 'host', workspacePath: config.workspaces[0]!.path,
    control: { ...session.control, hostId: 'host', agentSessionId: 'original-core-session' } };
}
async function seedAlias(store: AgentMuxSpatialStateStore, session = aliasSession(), aliases = [session.id]) {
  const tabs = Object.fromEntries(aliases.map((alias, index) => {
    const tab = createWorkbenchTab('agent-tab-' + index, { regionId: 'agent-region-' + index, kind: 'agent', phase: 'attached', workspaceId: 'resource', sessionId: alias });
    return [tab.id, tab];
  }));
  const work = { ...workbench('unused'), sessions: aliases.map(id => ({ ...session, id })), tabs, layouts: { resource: createWorkspaceLayout('agent-group', Object.keys(tabs)) } };
  await store.commit({ expectedRevision: 0, graph: desktopSpatialGraph(work, []) });
  useAppStore.setState({ ...work, sessions: [], restoredWorkbench: { tabs: work.tabs, layouts: work.layouts }, agentComposerDrafts: { [session.id]: 'Original unsent alias draft' } });
  disposers.push(await useAppStore.getState().initialize());
  return work;
}
describe('actual Desktop Store spatial cutover', () => {
  it('applies real Core save ACKs without replacing the original alias Region, Session, focus or draft', async () => {
    const session = aliasSession();
    const store = await fixture([session]);
    const tab = addWorkbenchRegion(createWorkbenchTab('agent-tab', { regionId: 'agent-region', kind: 'agent', phase: 'attached', workspaceId: 'resource', sessionId: session.id }), 'agent-region', 'right', { regionId: 'file-region', kind: 'file', workspaceId: 'resource', path: 'research.md' });
    const work = { ...workbench('unused'), sessions: [session], tabs: { [tab.id]: tab }, layouts: { resource: createWorkspaceLayout('agent-group', [tab.id]) } };
    await store.commit({ expectedRevision: 0, graph: desktopSpatialGraph(work, []) });
    useAppStore.setState({ ...work, restoredWorkbench: { tabs: work.tabs, layouts: work.layouts } });
    disposers.push(await useAppStore.getState().initialize());
    const before = useAppStore.getState(), region = before.tabs[tab.id]!.regions['agent-region'], sessions = before.sessions;
    const focus = { execution: { sessionId: session.id, history: [{ sessionId: session.id, focusedAt: 1 }] }, pmo: { sessionId: null } };
    const drafts = { [session.id]: 'Original unsent alias draft' };
    useAppStore.setState({ agentComposerDrafts: drafts, agentFocus: focus });
    const controls = ['launchAgent', 'recover', 'resume', 'stop'].map(name => vi.spyOn(api.sessions, name as 'stop'));
    // The source-mutation harness can arm the reader defect only after cold restore,
    // so its failure must pass through this real Store ACK application.
    vi.stubGlobal('__ALIAS_SPATIAL_ACK_MUTANT_ARMED__', true);
    useAppStore.getState().updateRegionSplitRatio('resource', tab.id, '', 0.63);
    await vi.waitFor(async () => expect((await store.read())!.graph.tabLayouts[tab.id]!.root).toHaveProperty('ratio', 0.63));
    await useAppStore.getState().retryWorkbenchSave();
    const after = useAppStore.getState(), durable = (await store.read())!.graph;
    expect(after.tabs[tab.id]!.regions['agent-region']).toBe(region);
    expect(region).toHaveProperty('sessionId', session.id);
    expect(after.sessions).toBe(sessions);
    expect(after.agentFocus).toBe(focus); expect(after.agentComposerDrafts).toBe(drafts);
    expect(durable.regions.find(value => value.regionId === 'agent-region')).toMatchObject({ agentSessionId: session.control.agentSessionId, runId: session.control.run.runId });
    expect(durable.resources['region:agent-region']).toMatchObject({ agentPresentation: { sessionId: session.id, hostId: session.control.hostId, agentSessionId: session.control.agentSessionId } });
    expect(after.tabs[tab.id]!.layout.root).toHaveProperty('ratio', 0.63);
    expect(after.tabs[tab.id]!.layout.activeRegionId).toBe(work.tabs[tab.id]!.layout.activeRegionId);
    for (const control of controls) expect(control).not.toHaveBeenCalled();
  });
  it('admits a real canonical startup observation into its unique original alias without changing Core control', async () => {
    const source = aliasSession(), canonical = { ...source, id: source.control.agentSessionId };
    const store = await fixture([canonical]); await seedAlias(store);
    await vi.waitFor(() => expect(useAppStore.getState().sessions.find(session => session.id === source.id)?.control).toEqual(source.control));
    expect(useAppStore.getState().sessions.some(session => session.id === canonical.id)).toBe(false);
    expect(useAppStore.getState().tabs['agent-tab-0']!.regions['agent-region-0']).toHaveProperty('sessionId', source.id);
    expect(useAppStore.getState().agentComposerDrafts[source.id]).toBe('Original unsent alias draft');
    await vi.waitFor(() => expect(useAppStore.getState().error).toBeNull());
  });
  it.each(['canonical', 'Host'] as const)('rejects a saved alias observation with another %s control and retains its original surface', async mismatch => {
    const source = aliasSession(), wrong = mismatch === 'canonical'
      ? { ...source, control: { ...source.control, agentSessionId: 'another-core-session' } }
      : { ...source, hostId: 'other-host', control: { ...source.control, hostId: 'other-host' } };
    const store = await fixture([wrong]); await seedAlias(store);
    await vi.waitFor(() => expect(vi.mocked(api.sessions.snapshot).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(useAppStore.getState().sessions.some(session => session.id === source.id)).toBe(false);
    expect(useAppStore.getState().tabs['agent-tab-0']!.regions['agent-region-0']).toHaveProperty('sessionId', source.id);
    expect(useAppStore.getState().error).toContain('saved Session reference');
  });
  it('retains the original alias when ordinary startup receives the real canonical reattachment shape', async () => {
    const source = aliasSession(), canonical = { ...source, id: source.control.agentSessionId };
    const store = await fixture([canonical]);
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'reattachable', session: canonical });
    await seedAlias(store);
    await vi.waitFor(() => expect(recover).toHaveBeenCalled());
    await vi.waitFor(() => expect(useAppStore.getState().sessions.find(session => session.id === source.id)?.control).toEqual(source.control));
    expect(recover.mock.calls[0]![0]).toEqual(source.control);
    expect(useAppStore.getState().sessions.some(session => session.id === canonical.id)).toBe(false);
    expect(useAppStore.getState().tabs['agent-tab-0']!.regions['agent-region-0']).toHaveProperty('sessionId', source.id);
    expect(useAppStore.getState().agentComposerDrafts[source.id]).toBe('Original unsent alias draft');
  });
  it('keeps multiple distinct saved aliases unknown instead of selecting the first canonical occurrence', async () => {
    const source = aliasSession(), canonical = { ...source, id: source.control.agentSessionId };
    const store = await fixture([canonical]); await seedAlias(store, source, [source.id, 'second-original-alias']);
    await vi.waitFor(() => expect(useAppStore.getState().sessions.some(session => session.id === canonical.id)).toBe(true));
    expect(useAppStore.getState().sessions.some(session => session.id === source.id || session.id === 'second-original-alias')).toBe(false);
    expect(useAppStore.getState().tabs['agent-tab-0']!.regions['agent-region-0']).toHaveProperty('sessionId', source.id);
    expect(useAppStore.getState().tabs['agent-tab-1']!.regions['agent-region-1']).toHaveProperty('sessionId', 'second-original-alias');
  });
  it.each(['canonical', 'alias'] as const)('keeps original history and both healthy Hosts when a %s startup cut has one ambiguous Timeline slot', async key => {
    const source = aliasSession(), canonical = { ...source, id: source.control.agentSessionId };
    const other = { ...canonical, hostId: 'other-host', control: { ...canonical.control, hostId: 'other-host', run: { runId: 'other-host-run' } } };
    const retained: AgentTimelineSnapshot = { agentSessionId: source.control.agentSessionId, revision: 1, items: [{
      id: 'original-history', agentSessionId: source.control.agentSessionId, kind: 'lifecycle', status: 'complete', source: 'user',
      title: 'Original Host history', createdAt: 1, updatedAt: 1
    }] };
    const incoming: AgentTimelineSnapshot = { agentSessionId: source.control.agentSessionId, revision: 2, items: [{
      ...retained.items[0]!, id: 'other-host-history', title: 'History from another Host'
    }] };
    const primary = key === 'canonical' ? canonical : source;
    const store = await fixture([primary, other]), snapshot = await api.sessions.snapshot();
    vi.spyOn(api.config, 'get').mockResolvedValue({ ...config, hosts: [...config.hosts, { id: 'other-host', kind: 'ssh', label: 'Other Host', hostname: 'private.example' }] });
    vi.mocked(api.sessions.snapshot).mockResolvedValue({ ...snapshot, timelines: { [primary.id]: incoming } });
    useAppStore.setState({ timelines: { [source.id]: retained } });
    const replaced: unknown[] = [], off = useAppStore.subscribe(state => {
      if (state.timelines[source.id] !== retained) replaced.push(state.timelines[source.id]);
    });
    disposers.push(off); await seedAlias(store);
    await vi.waitFor(() => expect(useAppStore.getState().sessions.find(session => session.id === source.id)?.control).toEqual(source.control));
    expect(useAppStore.getState().sessions.find(session => session.id === other.id)).toMatchObject({ control: other.control, processState: 'running' });
    expect(useAppStore.getState().timelines[source.id]).toBe(retained); expect(replaced).toEqual([]);
    expect(useAppStore.getState().timelines[canonical.id]).toBeUndefined();
    expect(useAppStore.getState().sessions.find(session => session.id === source.id)).toMatchObject({
      processState: 'running', timelineObservation: { code: 'TIMELINE_HOST_UNCONFIRMED', run: source.control.run }
    });
    expect(useAppStore.getState().tabs['agent-tab-0']!.regions['agent-region-0']).toHaveProperty('sessionId', source.id);
  });
  it('projects a canonical recovery candidate into the original alias while keeping its semantic Core recovery target', async () => {
    const source = aliasSession(), candidate = { ...source, agentSessionId: source.control.agentSessionId, run: source.control.run };
    const store = await fixture([], [candidate]);
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'unavailable', reason: 'native-handle-unavailable', agentSessionId: candidate.agentSessionId, previousRun: candidate.run, evidence: { kind: 'run-ended', state: 'exited', observedAt: 1 } });
    await seedAlias(store);
    await vi.waitFor(() => expect(recover).toHaveBeenCalled());
    expect(recover.mock.calls[0]![0]).toEqual(source.control);
    expect(useAppStore.getState().sessions.find(session => session.id === source.id)?.control).toEqual(source.control);
    expect(useAppStore.getState().tabs['agent-tab-0']!.regions['agent-region-0']).toHaveProperty('sessionId', source.id);
  });
  it('maps exact canonical retirement metadata to its alias notice without removing the original surface', async () => {
    const source = aliasSession(), store = await fixture();
    vi.spyOn(api.sessions, 'historySources').mockImplementation(async options => options?.observation
      ? { sources: [{ agentSessionId: source.control.agentSessionId, hostId: source.control.hostId, state: 'retired' as const }], warnings: [] }
      : [{ agentSessionId: source.control.agentSessionId, hostId: source.control.hostId, state: 'retired' as const }]);
    await seedAlias(store);
    await vi.waitFor(() => expect(useAppStore.getState().error).toBeNull());
    expect(useAppStore.getState().tabs['agent-tab-0']!.regions['agent-region-0']).toHaveProperty('sessionId', source.id);
  });
  it('keeps the exact canonical saved Session when another Host supplies the same SID in the cold snapshot', async () => {
    const alias = aliasSession(), source = { ...alias, id: alias.control.agentSessionId };
    const other = { ...source, hostId: 'other-host', control: { ...source.control, hostId: 'other-host', run: { runId: 'other-host-run' } } };
    const store = await fixture([source, other]);
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'reattachable', session: source });
    await seedAlias(store, source);
    await vi.waitFor(() => expect(useAppStore.getState().sessions.find(session => session.id === source.id)?.control).toEqual(source.control));
    expect(useAppStore.getState().sessions.some(session => session.hostId === other.hostId)).toBe(false);
    expect(useAppStore.getState().tabs['agent-tab-0']!.regions['agent-region-0']).toHaveProperty('sessionId', source.id);
    await vi.waitFor(() => expect(recover).toHaveBeenCalled());
    for (const [control] of recover.mock.calls) expect(control).toEqual(source.control);
  });
  it('keeps the exact canonical saved recovery candidate when another Host supplies the same SID', async () => {
    const alias = aliasSession(), source = { ...alias, id: alias.control.agentSessionId };
    const candidate = { ...source, agentSessionId: source.control.agentSessionId, run: source.control.run };
    const other = { ...candidate, hostId: 'other-host', run: { runId: 'other-host-run' } };
    const store = await fixture([], [candidate, other]);
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'unavailable', reason: 'native-handle-unavailable', agentSessionId: candidate.agentSessionId, previousRun: candidate.run, evidence: { kind: 'run-ended', state: 'exited', observedAt: 1 } });
    await seedAlias(store, source);
    await vi.waitFor(() => expect(recover).toHaveBeenCalled());
    for (const [control] of recover.mock.calls) expect(control).toEqual(source.control);
    expect(useAppStore.getState().sessions.find(session => session.id === source.id)?.control).toEqual(source.control);
    expect(useAppStore.getState().tabs['agent-tab-0']!.regions['agent-region-0']).toHaveProperty('sessionId', source.id);
  });
  it('restores Core facts instead of stale UI layout, omits the old UI owner and retains live file content across CLI edits', async () => {
    const store = await fixture(), graph = desktopSpatialGraph(workbench('Canonical'), []);
    await store.commit({ expectedRevision: 0, graph });
    useAppStore.setState({ ...workbench('Stale UI'), restoredWorkbench: { tabs: workbench('Stale UI').tabs, layouts: workbench('Stale UI').layouts } });
    disposers.push(await useAppStore.getState().initialize());
    expect(useAppStore.getState().tabs.file?.name).toBe('Canonical');
    const partialize = useAppStore.persist.getOptions().partialize!;
    const persisted = partialize(useAppStore.getState());
    expect(persisted).not.toHaveProperty('restoredWorkbench');
    expect(persisted).not.toHaveProperty('spaceZoneBindings');
    const surface = useAppStore.getState().tabs.file!.regions['file-region'], draft = { content: 'unsaved thought', dirty: true };
    useAppStore.setState({ documents: { ...useAppStore.getState().documents, ['resource\0research.md']: draft as never } });
    const changed = structuredClone(graph);
    changed.tabs[0]!.name = 'CLI title';
    await store.commit({ expectedRevision: 1, graph: changed });
    await vi.waitFor(() => expect(useAppStore.getState().tabs.file?.name).toBe('CLI title'));
    expect(useAppStore.getState().tabs.file!.regions['file-region']).toBe(surface);
    expect(useAppStore.getState().documents['resource\0research.md']).toBe(draft);
  });
  it('imports the original workbench only when Core has no document and writes later structural changes through the same owner', async () => {
    const store = await fixture(), work = workbench('Original');
    useAppStore.setState({ ...work, restoredWorkbench: { tabs: work.tabs, layouts: work.layouts } });
    disposers.push(await useAppStore.getState().initialize());
    expect((await store.read())!.graph.tabs[0]!.name).toBe('Original');
    useAppStore.getState().renameTab('file', 'Saved edit');
    await vi.waitFor(async () => expect((await store.read())!.graph.tabs[0]!.name).toBe('Saved edit'));
    expect((await store.read())!.graph.tabLayouts.file!.root).toEqual(work.tabs.file.layout.root);
  });
  it('retries a failed cold read through the actual Store, preserves edits and consumes remote facts without replacing live content', async () => {
    const store = await fixture(), graph = desktopSpatialGraph(workbench('Core title'), []);
    await store.commit({expectedRevision: 0, graph});
    const read = vi.spyOn(api.spatial, 'read').mockRejectedValue(new Error('Storage offline'));
    const work = workbench('Stale UI');
    useAppStore.setState({...work, restoredWorkbench: {tabs: work.tabs, layouts: work.layouts}});
    disposers.push(await useAppStore.getState().initialize());
    expect(useAppStore.getState().workbenchSaveWarning).toContain('has not been read');
    const live = useAppStore.getState().tabs.file!.regions['file-region'];
    const draft = {content: 'thought retained during read failure', dirty: true};
    useAppStore.setState({documents: {'resource\0research.md': draft as never}});
    // New entities are a disjoint local edit; the unchanged stale title must not overwrite Core.
    const note = createWorkbenchTab('local-note', {regionId: 'local-note-region', kind: 'file', workspaceId: 'resource', path: 'new-note.md'});
    useAppStore.setState(state => ({tabs: {...state.tabs, [note.id]: note}}));
    await useAppStore.getState().retryWorkbenchSave();
    expect(useAppStore.getState().workbenchSaveWarning).not.toBeNull();
    expect((await store.read())!.revision).toBe(1);
    read.mockImplementation(() => store.read());
    await useAppStore.getState().retryWorkbenchSave();
    const saved = (await store.read())!;
    expect(saved.graph.tabs.find(tab => tab.tabId === 'file')!.name).toBe('Core title');
    expect(saved.graph.tabs.map(tab => tab.tabId)).toContain('local-note');
    expect(useAppStore.getState().tabs.file!.regions['file-region']).toBe(live);
    expect(useAppStore.getState().documents['resource\0research.md']).toBe(draft);
    expect(useAppStore.getState().workbenchSaveWarning).toBeNull();
    expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState())).not.toHaveProperty('restoredWorkbench');
    const remote = structuredClone(saved.graph);
    remote.tabs.find(tab => tab.tabId === 'file')!.name = 'Later CLI title';
    await store.commit({expectedRevision: saved.revision, graph: remote});
    await vi.waitFor(() => expect(useAppStore.getState().tabs.file!.name).toBe('Later CLI title'));
  });
  it('keeps conflicting local work and the durable graph when a cold-read retry cannot rebase', async () => {
    const store = await fixture(), graph = desktopSpatialGraph(workbench('Core title'), []);
    await store.commit({expectedRevision: 0, graph});
    const read = vi.spyOn(api.spatial, 'read').mockRejectedValue(new Error('Storage offline'));
    const work = workbench('Stale UI');
    useAppStore.setState({...work, restoredWorkbench: {tabs: work.tabs, layouts: work.layouts}});
    disposers.push(await useAppStore.getState().initialize());
    useAppStore.getState().renameTab('file', 'Unsaved local title');
    read.mockImplementation(() => store.read());
    await useAppStore.getState().retryWorkbenchSave();
    expect(useAppStore.getState().workbenchSaveWarning).toContain('edited elsewhere');
    expect(useAppStore.getState().tabs.file!.name).toBe('Unsaved local title');
    expect((await store.read())!.graph).toEqual(graph);
    // The user can resolve the edit in place and retry; no reload or Run operation is needed.
    useAppStore.getState().renameTab('file', 'Core title');
    await useAppStore.getState().retryWorkbenchSave();
    expect(useAppStore.getState().workbenchSaveWarning).toBeNull();
  });
  it('retries a failed first document write and saves the edits made while storage was unavailable', async () => {
    const store = await fixture(), work = workbench('Original');
    const commit = vi.spyOn(api.spatial, 'commit').mockRejectedValue(new Error('Disk write unavailable'));
    useAppStore.setState({...work, restoredWorkbench: {tabs: work.tabs, layouts: work.layouts}});
    disposers.push(await useAppStore.getState().initialize());
    expect(useAppStore.getState().workbenchSaveWarning).not.toBeNull();
    useAppStore.getState().renameTab('file', 'Edited while offline');
    await useAppStore.getState().retryWorkbenchSave();
    expect(await store.read()).toBeNull();
    commit.mockImplementation(input => store.commit(input));
    await useAppStore.getState().retryWorkbenchSave();
    expect((await store.read())!.graph.tabs[0]!.name).toBe('Edited while offline');
    expect(useAppStore.getState().workbenchSaveWarning).toBeNull();
  });

});
