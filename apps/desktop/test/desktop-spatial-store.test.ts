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
});
