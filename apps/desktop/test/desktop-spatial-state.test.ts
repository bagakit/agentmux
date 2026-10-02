import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it, afterEach, beforeAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { build } = createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('esbuild');
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state';
import { createWorkspaceLayout, addTabOccurrence, moveTabToNewGroup } from '@agentmux/layout';
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs';
import { projectPersistedWorkbench, restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence';
import { desktopSpatialGraph, desktopWorkbenchFromSpatial, desktopBindingsFromSpatial, DesktopSpatialPersistence, reconcileSpatialGraphs } from '../src/renderer/src/lib/desktop-spatial-state';
import type { AppConfig } from '../src/shared/contracts';
const config: AppConfig = { version: 9, hosts: [{ id: 'host', kind: 'local', label: 'Local' }], executors: {}, workspaces: [{ id: 'resource', name: 'Project', hostId: 'host', path: _hygiene_fixturePath("project"), kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } };
function workbench() {
  const tab = createWorkbenchTab('tab', { regionId: 'agent', kind: 'agent', phase: 'attached', workspaceId: 'resource', sessionId: 'original-session' });
  const mixed = addWorkbenchRegion(tab, 'agent', 'right', { regionId: 'file', kind: 'file', workspaceId: 'resource', path: 'research.md' });
  return { config, sessions: [], tabs: { tab: mixed }, layouts: { resource: createWorkspaceLayout('group', ['tab']) }, spaceZoneBindings: {}, spatialRequests: {} };
}
let worker: string;
beforeAll(async () => {
  worker = resolve('.tmp/durable-spatial-index/desktop-restore-worker.mjs');
  await build({ stdin: { contents: `import {AgentMuxSpatialStateStore} from './packages/core/src/spatial-state.ts'; import {DesktopSpatialPersistence,desktopWorkbenchFromSpatial} from './apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts'; import {restorePersistedWorkbench} from './apps/desktop/src/renderer/src/lib/workbench-persistence.ts'; const owner=new AgentMuxSpatialStateStore(process.argv[2]);const client=new DesktopSpatialPersistence({read:()=>owner.read(),commit:i=>owner.commit(i),onChange:f=>owner.subscribe(f)},e=>{throw e});const state=await client.read(); if(process.argv[3]==='edit'){state.graph.tabs[0].name='CLI process edit';console.log(JSON.stringify(await owner.commit({expectedRevision:state.revision,graph:state.graph})));}else{const config=JSON.parse(process.argv[3]);const restored=restorePersistedWorkbench({config,sessions:[],persisted:desktopWorkbenchFromSpatial(state.graph),createTabGroupId:()=> 'unused',preserveEntityIds:new Set(state.graph.tabs.map(t=>t.tabId))});console.log(JSON.stringify(restored));}`, resolveDir: process.cwd() }, outfile: worker, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { '@agentmux/core/agent-session-id': resolve('packages/core/src/agent-session-id.ts'), '@agentmux/core/spatial-graph': resolve('packages/core/src/spatial-graph.ts'), '@agentmux/core/space-control': resolve('packages/core/src/space-control.ts'), '@agentmux/core/public-rpc': resolve('packages/core/src/public-rpc.ts'), '@agentmux/core/errors': resolve('packages/core/src/errors.ts'), '@agentmux/layout': resolve('packages/core/src/spatial-layout.ts'), '@agentmux/client-ui/ime-keyboard-event': resolve('packages/client-ui/src/lib/ime-keyboard-event.ts') }, logLevel: 'silent' });
});
function processWorker(args: string[]): Promise<any> { return new Promise((yes, no) => { const child = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; child.stdout.on('data', value => out += value); child.stderr.on('data', value => err += value); child.once('error', no); child.once('close', code => { try {
  if (code !== 0)
    throw new Error(err);
  yes(JSON.parse(out));
}
catch (error) {
  no(error);
} }); }); }
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0))
  await rm(dir, { recursive: true, force: true }); });
async function owner() { const dir = await mkdtemp(join(tmpdir(), 'amux-desktop-spatial-')); directories.push(dir); return new AgentMuxSpatialStateStore(join(dir, 'state.json')); }
describe('Desktop consumes the Core spatial owner', () => {
  it('round-trips the original entity metadata and topology without duplicate workbench snapshots', () => {
    const original = workbench(), graph = desktopSpatialGraph(original, []);
    expect(Object.keys(projectPersistedWorkbench(original).tabs)).toEqual(['tab']);
    expect(graph.tabs[0]!.regionIds).toEqual(['agent', 'file']);
    expect(desktopWorkbenchFromSpatial(graph)).toEqual(projectPersistedWorkbench(original));
    expect(graph.resources['tab:tab']).not.toHaveProperty('layout');
    expect(graph.resources['region:agent']).not.toHaveProperty('sessionId');
    expect(graph.regions.find(r => r.regionId === 'agent')!.agentSessionId).toBe('original-session');
  });
  it('retains missing observations and permits only explicit entity removal', () => {
    const original = workbench(), graph = desktopSpatialGraph(original, []);
    const missing = { ...original, tabs: {}, layouts: {} };
    expect(desktopSpatialGraph(missing, [], graph).tabs).toEqual(graph.tabs);
    expect(desktopSpatialGraph(missing, [], graph).regions).toEqual(graph.regions);
    const closed = desktopSpatialGraph(missing, [], graph, new Set(['tab']));
    expect(closed.tabs).toEqual([]);
    expect(closed.regions).toEqual([]);
    expect(closed.resources).not.toHaveProperty('tab:tab');
    expect(closed.resources).not.toHaveProperty('region:agent');
  });
  it('keeps disjoint remote edits and refuses overlapping changes', () => {
    const base = desktopSpatialGraph(workbench(), []), local = structuredClone(base), remote = structuredClone(base);
    local.tabs[0]!.name = 'Local title';
    remote.resources['separate-resource'] = { draft: 'remote' };
    expect(reconcileSpatialGraphs(base, local, remote)).toMatchObject({ tabs: [{ name: 'Local title' }], resources: { 'separate-resource': { draft: 'remote' } } });
    remote.tabs[0]!.name = 'Another title';
    expect(() => reconcileSpatialGraphs(base, local, remote)).toThrow(/retained/);
  });
  it('imports only an absent Core document, receives CLI-owner updates and persists local changes', async () => {
    const store = await owner(), warnings: unknown[] = [], client = new DesktopSpatialPersistence({ read: () => store.read(), commit: i => store.commit(i), onChange: f => store.subscribe(f) }, e => warnings.push(e));
    expect(await client.read()).toBeNull();
    const graph = desktopSpatialGraph(workbench(), []);
    await client.bootstrap(graph);
    const applied: unknown[] = [], dispose = client.connect(state => applied.push(state));
    const native = structuredClone(graph);
    native.tabs[0]!.name = 'From CLI';
    await store.commit({ expectedRevision: 1, graph: native });
    expect(applied).toHaveLength(1);
    expect(client.current!.graph.tabs[0]!.name).toBe('From CLI');
    const edited = structuredClone(client.current!.graph);
    edited.tabLayouts.tab!.activeRegionId = 'file';
    client.stage(edited);
    await client.flush();
    expect((await store.read())!.graph.tabLayouts.tab!.activeRegionId).toBe('file');
    await client.bootstrap(graph);
    expect((await store.read())!.graph.tabs[0]!.name).toBe('From CLI');
    expect(warnings).toEqual([]);
    dispose();
  });
  it('preserves local pending work and the durable original on a failed write', async () => {
    const store = await owner(), graph = desktopSpatialGraph(workbench(), []);
    await store.commit({ expectedRevision: 0, graph });
    const client = new DesktopSpatialPersistence({ read: () => store.read(), commit: async () => { throw new Error('Disk unavailable'); }, onChange: f => store.subscribe(f) }, () => { });
    await client.read();
    const local = structuredClone(graph);
    local.tabs[0]!.name = 'Unsaved change';
    client.stage(local);
    await expect(client.flush()).rejects.toThrow('Disk unavailable');
    expect((await store.read())!.graph).toEqual(graph);
    await expect(client.flush()).rejects.toThrow('Disk unavailable');
  });
  it('keeps unbound launchers and original resources after client discovery disappears', () => {
    const launcher = createWorkbenchTab('temporary', { regionId: 'new', kind: 'launcher', workspaceId: 'resource' });
    const state = { ...workbench(), tabs: { temporary: launcher }, layouts: { resource: createWorkspaceLayout('g', ['temporary']) } };
    const graph = desktopSpatialGraph(state, []);
    expect(graph.tabs.map(t => t.tabId)).toEqual(['temporary']);
    expect(graph.resources['region:new']).toEqual({});
    const restored = restorePersistedWorkbench({ config: { ...config, workspaces: [] }, sessions: [], persisted: desktopWorkbenchFromSpatial(graph), createTabGroupId: () => 'new-g', preserveEntityIds: new Set(['temporary']) });
    expect(restored.tabs.temporary!.regions.new!.kind).toBe('launcher');
    expect(restored.layouts.resource).toEqual(state.layouts.resource);
  });
  it('preserves every typed binding and foreign or repeated Group occurrence', () => {
    const state = workbench(), initial = desktopSpatialGraph(state, []), zone = initial.zones[0]!, space = initial.spaces[0]!;
    state.spaceZoneBindings = { [zone.zoneId]: { spaceId: space.spaceId, workspaceId: 'resource', relations: { [space.spaceId]: false, [JSON.stringify(["host", _hygiene_fixturePath("topic-a")])]: true, [JSON.stringify(["host", _hygiene_fixturePath("topic-b")])]: true } } } as typeof state.spaceZoneBindings;
    (state.tabs as Record<string, typeof state.tabs.tab>).placeholder = createWorkbenchTab('placeholder', { regionId: 'placeholder-region', kind: 'file', workspaceId: 'resource', path: 'other.md' });
    state.layouts.resource = addTabOccurrence(moveTabToNewGroup(createWorkspaceLayout('group', ['tab', 'placeholder']), 'tab', 'group', 'group', 'right', 'second'), 'group', 'tab')!;
    const graph = desktopSpatialGraph({ ...state, layouts: { ...state.layouts, foreign: createWorkspaceLayout('other', ['tab']) } }, []);
    expect(graph.bindings).toHaveLength(2);
    const bindings = desktopBindingsFromSpatial(graph);
    expect(bindings[zone.zoneId]!.relations![space.spaceId]).toBe(false);
    expect(bindings[zone.zoneId]!.relations![JSON.stringify(["host", _hygiene_fixturePath("topic-a")])]).toBe(true);
    expect(bindings[zone.zoneId]!.relations![JSON.stringify(["host", _hygiene_fixturePath("topic-b")])]).toBe(true);
    const roundTrip = desktopSpatialGraph({ ...state, spaceZoneBindings: bindings, layouts: graph.layouts }, [], graph);
    expect(roundTrip.bindings).toEqual(graph.bindings);
    expect(roundTrip.layouts.foreign!.groups[0]!.tabOrder).toEqual(['tab']);
    expect(roundTrip.layouts.resource!.groups.filter(g => g.tabOrder.includes('tab'))).toHaveLength(2);
  });
  it('reports missing host descriptors without silently manufacturing or deleting an entity', () => {
    const graph = desktopSpatialGraph(workbench(), []), missing: string[] = [];
    delete graph.resources['region:file'];
    expect(desktopWorkbenchFromSpatial(graph, id => missing.push(id)).tabs).toEqual({});
    expect(missing).toEqual(['tab']);
    expect(graph.tabs[0]!.regionIds).toEqual(['agent', 'file']);
  });
  it('preserves the later local edit and disjoint remote data during an in-flight write', async () => {
    const store = await owner(), graph = desktopSpatialGraph(workbench(), []);
    await store.commit({ expectedRevision: 0, graph });
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(yes => { release = yes; }), started = new Promise<void>(yes => { entered = yes; });
    let first = true;
    const client = new DesktopSpatialPersistence({ read: () => store.read(), commit: async (input) => { if (first) {
        first = false;
        entered();
        await waiting;
      } return store.commit(input); }, onChange: f => store.subscribe(f) }, () => { });
    await client.read();
    const remote = structuredClone(graph);
    remote.resources.separate = { text: 'from remote' };
    await store.commit({ expectedRevision: 1, graph: remote });
    const a = structuredClone(graph);
    a.tabs[0]!.name = 'First';
    client.stage(a);
    const saving = client.flush();
    await started;
    const b = structuredClone(a);
    b.tabs[0]!.name = 'Latest';
    client.stage(b);
    release();
    await saving;
    expect((await store.read())!.graph.tabs[0]!.name).toBe('Latest');
    expect((await store.read())!.graph.resources.separate).toEqual({ text: 'from remote' });
  });
  it('observes a different filesystem owner without an App or shared in-memory listeners', async () => {
    const store = await owner(), graph = desktopSpatialGraph(workbench(), []);
    await store.commit({ expectedRevision: 0, graph });
    const client = new DesktopSpatialPersistence({ read: () => store.read(), commit: i => store.commit(i), onChange: f => store.subscribe(f) }, () => { });
    await client.read();
    const applied: string[] = [], dispose = client.connect(state => applied.push(state.graph.tabs[0]!.name!));
    try {
      await processWorker([store.path, 'edit']);
      await vi.waitFor(() => expect(applied).toContain('CLI process edit'));
    }
    finally {
      dispose();
    }
  });
  it('restores the original resource and split tree in two actual fresh client processes', async () => {
    const store = await owner(), graph = desktopSpatialGraph(workbench(), []);
    await store.commit({ expectedRevision: 0, graph });
    for (let restart = 0; restart < 2; restart++) {
      const restored = await processWorker([store.path, JSON.stringify(config)]);
      expect(Object.keys(restored.tabs)).toEqual(['tab']);
      expect(restored.tabs.tab.layout).toEqual(graph.tabLayouts.tab);
      expect(restored.tabs.tab.regions.agent.sessionId).toBe('original-session');
      expect(restored.tabs.tab.regions.file.path).toBe('research.md');
      expect(restored.layouts).toEqual(graph.layouts);
    }
  });
});
