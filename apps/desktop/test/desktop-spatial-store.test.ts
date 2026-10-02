import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state';
import { createWorkspaceLayout } from '@agentmux/layout';
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs';
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state';
import { api } from '../src/renderer/src/lib/api';
import { useAppStore } from '../src/renderer/src/store';
import type { AppConfig } from '../src/shared/contracts';
const config: AppConfig = { version: 9, hosts: [{ id: 'host', kind: 'local', label: 'Local' }], executors: {}, workspaces: [{ id: 'resource', name: 'Project', hostId: 'host', path: _hygiene_fixturePath("project"), kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } };
const original = useAppStore.getState(), directories: string[] = [], disposers: (() => void)[] = [];
function workbench(name: string) { const tab = createWorkbenchTab('file', { regionId: 'file-region', kind: 'file', workspaceId: 'resource', path: 'research.md' }, name); return { config, sessions: [], tabs: { file: tab }, layouts: { resource: createWorkspaceLayout('group', ['file']) }, spaceZoneBindings: {}, spatialRequests: {} }; }
afterEach(async () => { for (const dispose of disposers.splice(0))
  dispose(); vi.restoreAllMocks(); useAppStore.setState(original, true); for (const path of directories.splice(0))
  await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'amux-spatial-client-'));
  directories.push(dir);
  const store = new AgentMuxSpatialStateStore(join(dir, 'state.json'));
  vi.spyOn(api.spatial, 'read').mockImplementation(() => store.read());
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => store.commit(input));
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => store.subscribe(listener));
  vi.spyOn(api.config, 'get').mockResolvedValue(config);
  const snapshot = await api.sessions.snapshot();
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...snapshot, sessions: [], recoveryCandidates: [] });
  return store;
}
describe('actual Desktop Store spatial cutover', () => {
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
