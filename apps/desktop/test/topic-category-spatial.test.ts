import { describe, expect, it, afterEach, beforeAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { TopicCategory } from '@agentmux/core/control'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial, desktopBindingsFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { TopicSpatialOwner } from '../src/main/topic-spatial-owner'
import { SCRATCH_WORKSPACE_ID, scratchTopicStorageRoots } from '../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { categoriesFromSpatial, isKnowledgeTopicInBindings, topicContentZoneId, UNCLASSIFIED_TOPIC_CATEGORY_ID } from '../src/shared/topic-categories'
import type { AppConfig, ScratchTopicSnapshot, WorkspaceRecord } from '../src/shared/contracts'
const { build } = createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('esbuild')
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
let worker: string
beforeAll(async () => {
  worker = resolve('.local/topic-knowledge/spatial-restart-worker.mjs')
  await build({ stdin: { contents: `import {AgentMuxSpatialStateStore} from './packages/core/src/spatial-state.ts'; console.log(JSON.stringify(await new AgentMuxSpatialStateStore(process.argv[2]).read()));`, resolveDir: process.cwd() },
    outfile: worker, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
})
function restartRead(path: string): Promise<any> {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [worker, path], { env: { ...process.env, NODE_PATH: resolve('packages/core/node_modules') } })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', no); child.on('exit', code => { if (code !== 0) no(new Error(errors)); else { try { yes(JSON.parse(output)) } catch (error) { no(error) } } })
  })
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'topic-category-spatial-')); roots.push(root)
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(root, 'scratch'), name: 'Topics', kind: 'folder' }
  await mkdir(workspace.path)
  const topicPath = join(scratchTopicStorageRoots(workspace.path).topics, 'view:original')
  await mkdir(topicPath, { recursive: true }); await writeFile(join(topicPath, 'topic.md'), '# 原始主题\nA retained source.\n')
  const topic: ScratchTopicSnapshot = { id: 'view:original', title: '原始主题', summary: 'Original summary', topicPath: 'topic.md', directoryPath: 'topics/view:original', physicalDirectoryPath: topicPath, identityDirectoryPath: topicPath, collaborators: [] }
  const motePath = join(scratchTopicStorageRoots(workspace.path).motes, 'view:mote')
  await mkdir(motePath, { recursive: true }); await writeFile(join(motePath, 'SOUL.md'), 'Original personality')
  const mote: ScratchTopicSnapshot = { ...topic, id: 'view:mote', title: 'Mote', directoryPath: 'motes/view:mote', physicalDirectoryPath: motePath, identityDirectoryPath: motePath, soul: { path: 'SOUL.md', content: 'Original personality', version: 'fixture' } }
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [workspace], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const chat = { ...createWorkbenchTab('original-chat', { regionId: 'original-thread', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'healthy-session' }), topicId: topic.id,
    space: { spaceId: directoryIdentity(workspace.hostId, topicPath), zoneId: topicContentZoneId(workspace, topic) } }
  const global = createWorkbenchTab('global-browser', { regionId: 'global-region', kind: 'browser', workspaceId: workspace.id, browserId: 'healthy-browser', url: 'about:blank' })
  const workbench = { config, sessions: [], tabs: { [chat.id]: chat, [global.id]: global }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [chat.id, global.id]) }, spaceZoneBindings: {}, spatialRequests: {} }
  const graph = desktopSpatialGraph(workbench, [topic, mote])
  graph.regions[0]!.runId = 'healthy-run'; graph.regions[0]!.execution = { hostId: 'local', cwd: topicPath }
  graph.resources['tab:original-chat'] = { ...graph.resources['tab:original-chat'] as object, draft: 'Unsent draft', pin: true }
  // A deliberate cross-object relation remains valid. Shared Scratch by itself creates no membership.
  graph.bindings.push({ zoneId: topicContentZoneId(workspace, topic), spaceId: directoryIdentity('local', motePath) })
  const state = new AgentMuxSpatialStateStore(join(root, 'spatial.json')); await state.commit({ expectedRevision: 0, graph })
  const categories: TopicCategory[] = []
  const categoryPath = join(scratchTopicStorageRoots(workspace.path).topics, 'category--' + UNCLASSIFIED_TOPIC_CATEGORY_ID)
  const category: TopicCategory = { categoryId: UNCLASSIFIED_TOPIC_CATEGORY_ID, title: '未分类', hostId: 'local', directoryPath: categoryPath,
    spaceId: directoryIdentity('local', categoryPath), revision: 'sha256:' + createHash('sha256').update('# 未分类\n').digest('hex') }
  let topics = [topic, mote]
  const owner = new TopicSpatialOwner({ state, workspace: () => workspace, topics: async () => topics, categories: async () => categories,
    ensureDefaultCategory: async () => { await mkdir(categoryPath, { recursive: true }); await writeFile(join(categoryPath, 'category.md'), '# 未分类\n'); if (!categories.length) categories.push(category); return category } })
  return { root, workspace, topic, mote, config, graph, state, categories, category, owner, workbench, setTopics: (next: ScratchTopicSnapshot[]) => { topics = next } }
}
describe('Topic Category uses original Core identities through local migration', () => {
  it('retains the canonical original Zone when a real failed Host discovery lacks absolute identity paths', async () => {
    const f = await fixture(); await f.owner.migrateApply(1);
    const current = (await f.state.read())!, { identityDirectoryPath: _identity, physicalDirectoryPath: _physical, ...metadata } = f.topic;
    const failed = { ...metadata, directoryPath: 'view:original', readError: 'Original source temporarily unreadable' };
    const restored = desktopWorkbenchFromSpatial(current.graph);
    const captured = desktopSpatialGraph({ ...f.workbench, ...restored, tabs: restored.tabs as any, topicCategories: categoriesFromSpatial(current.graph),
      spaceZoneBindings: desktopBindingsFromSpatial(current.graph) }, [failed, f.mote], current.graph);
    expect((await f.owner.inspect(failed)).zoneId).toBe(topicContentZoneId(f.workspace, f.topic));
    expect(captured.zones.map(zone => zone.zoneId).sort()).toEqual(current.graph.zones.map(zone => zone.zoneId).sort());
    expect(captured.spaces.map(space => space.spaceId).sort()).toEqual(current.graph.spaces.map(space => space.spaceId).sort());
    expect(captured.tabs).toEqual(current.graph.tabs);
    expect(captured.bindings.map(binding => JSON.stringify(binding)).sort()).toEqual(current.graph.bindings.map(binding => JSON.stringify(binding)).sort());
  })
  it('keeps an already converted Category membership when its Host directory is temporarily absent', async () => {
    const f = await fixture();
    await f.owner.migrateApply(1);
    const original = (await f.state.read())!;
    f.categories.splice(0);
    expect((await f.owner.inspect(f.topic)).categorySpaceIds).toEqual([f.category.spaceId]);
    const preview = await f.owner.migratePreview();
    expect(preview.topics).toEqual([]);
    expect(preview.required).toBe(false);
    expect(preview.unavailable).toContainEqual(expect.objectContaining({ code: 'TOPIC_CATEGORY_UNAVAILABLE', source: f.category.spaceId }));
    await expect(f.owner.migrateApply(original.revision)).rejects.toMatchObject({ code: 'TOPIC_MIGRATION_UNCONFIRMED' });
    expect(await f.state.read()).toEqual(original);
  })
  it('keeps a Mote with an empty original SOUL file outside every knowledge conversion', async () => {
    const f = await fixture(), emptyMote = { ...f.mote, soul: { path: 'SOUL.md', content: '', version: 'fixture' } };
    f.setTopics([f.topic, emptyMote]);
    expect((await f.owner.migratePreview()).topics.map(topic => topic.topicId)).toEqual([f.topic.id]);
    const initial = desktopSpatialGraph(f.workbench, [f.topic, emptyMote]);
    expect(initial.spaces.find(space => space.topicId === f.mote.id)?.kind).toBe('mote');
    await f.owner.migrateApply(1);
    expect((await f.state.read())!.graph.spaces.find(space => space.topicId === f.mote.id)?.kind).toBe('mote');
    const { soul: _soul, identityDirectoryPath: _identity, physicalDirectoryPath: _physical, ...metadata } = f.mote;
    const failed = { ...metadata, directoryPath: f.mote.id, readError: 'Original metadata temporarily unreadable' };
    await expect(f.owner.inspect(failed)).rejects.toMatchObject({ code: 'TOPIC_TARGET_IS_MOTE' });
    expect(isKnowledgeTopicInBindings(failed, desktopBindingsFromSpatial((await f.state.read())!.graph))).toBe(false);
  })
  it('hydrates older descriptors from the exact Core Tab Zone without choosing a foreign display binding', async () => {
    const f = await fixture(), old = structuredClone(f.graph);
    const metadata = old.resources['tab:original-chat'] as Record<string, any>;
    delete metadata.space;
    const originalSpace = directoryIdentity('local', f.topic.identityDirectoryPath!);
    const restored = desktopWorkbenchFromSpatial(old);
    expect(restored.tabs['original-chat']!.space).toEqual({ spaceId: originalSpace, zoneId: topicContentZoneId(f.workspace, f.topic) });
    expect(restored.tabs['original-chat']!.regions['original-thread']).toMatchObject({ sessionId: 'healthy-session' });
    delete old.resources['zone:' + topicContentZoneId(f.workspace, f.topic)];
    expect(desktopWorkbenchFromSpatial(old).tabs['original-chat']!.space).toBeUndefined();
    expect(old.bindings.filter(binding => binding.zoneId === topicContentZoneId(f.workspace, f.topic))).toHaveLength(2);
  })
  it('previews without writing and keeps exact Topic source, all workfaces and Mote isolation after restart', async () => {
    const f = await fixture(), original = (await f.state.read())!, bytes = await readFile(join(f.topic.physicalDirectoryPath!, 'topic.md'))
    const preview = await f.owner.migratePreview()
    expect(preview).toMatchObject({ spatialRevision: 1, required: true, unavailable: [], topics: [{ topicId: f.topic.id, zoneId: topicContentZoneId(f.workspace, f.topic), categorySpaceId: f.category.spaceId }] })
    await expect(stat(f.category.directoryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.state.read()).toEqual(original)
    const receipt = await f.owner.migrateApply(preview.spatialRevision), migrated = (await f.state.read())!
    expect(receipt).toMatchObject({ migratedTopicIds: [f.topic.id], diskDurability: 'confirmed', spatialRevision: 2 })
    expect(JSON.parse(await readFile(receipt.backupPath!, 'utf8'))).toEqual(original)
    expect((await stat(receipt.backupPath!)).mode & 0o777).toBe(0o600)
    expect(migrated.graph.tabs).toEqual(original.graph.tabs)
    expect(migrated.graph.regions).toEqual(original.graph.regions)
    expect(migrated.graph.zones).toEqual(original.graph.zones)
    expect(migrated.graph.layouts).toEqual(original.graph.layouts)
    expect(migrated.graph.tabLayouts).toEqual(original.graph.tabLayouts)
    expect(migrated.graph.resources['tab:original-chat']).toEqual(original.graph.resources['tab:original-chat'])
    expect(migrated.graph.bindings).toContainEqual({ zoneId: topicContentZoneId(f.workspace, f.topic), spaceId: f.category.spaceId })
    expect(migrated.graph.bindings).toContainEqual({ zoneId: topicContentZoneId(f.workspace, f.topic), spaceId: directoryIdentity('local', f.mote.physicalDirectoryPath!) })
    expect(migrated.graph.spaces.some(space => space.kind === 'topic')).toBe(false)
    expect(migrated.graph.spaces.find(space => space.topicId === f.mote.id)?.kind).toBe('mote')
    expect(await readFile(join(f.topic.physicalDirectoryPath!, 'topic.md'))).toEqual(bytes)
    const restarted = await restartRead(f.state.path)
    expect(restarted).toEqual(migrated)
    expect(desktopWorkbenchFromSpatial(restarted.graph).tabs['original-chat']!.regions['original-thread']).toMatchObject({ sessionId: 'healthy-session' })
    const repeated = await f.owner.migrateApply(migrated.revision)
    expect(repeated).toMatchObject({ spatialRevision: migrated.revision, backupPath: null, migratedTopicIds: [] })
  })
  it('keeps concurrent work and corrupt durable bytes instead of committing a stale or absent graph', async () => {
    const f = await fixture(), preview = await f.owner.migratePreview(), original = (await f.state.read())!
    await f.state.mutateDisplayLabel({ target: { kind: 'tab', id: original.graph.tabs[0]!.tabId },
      value: 'User changed this while previewing', expectedNameRevision: 0, source: 'manual', operationId: 'concurrent-topic-preview-label' },
    { actor: { kind: 'user', id: 'fixture-user', verified: true }, source: 'explicit-edit', entryPoint: 'space.rename', transport: 'local', location: {} })
    await expect(f.owner.migrateApply(preview.spatialRevision)).rejects.toMatchObject({ code: 'SPATIAL_STATE_CONFLICT' })
    expect((await f.state.read())!.graph.tabs[0]!.name).toBe('User changed this while previewing')
    await writeFile(f.state.path, 'original corrupt bytes')
    await expect(f.owner.migratePreview()).rejects.toMatchObject({ code: 'SPATIAL_STATE_READ_UNCONFIRMED' })
    expect(await readFile(f.state.path, 'utf8')).toBe('original corrupt bytes')
  })
  it('does not resurrect Topic-as-Space on Renderer ACK, cold observation gaps, or later unrelated saves', async () => {
    const f = await fixture(); await f.owner.migrateApply(1)
    const migrated = (await f.state.read())!, bindings = desktopBindingsFromSpatial(migrated.graph), categories = categoriesFromSpatial(migrated.graph)
    const sourceId = directoryIdentity('local', f.topic.identityDirectoryPath!), zoneId = topicContentZoneId(f.workspace, f.topic)
    for (const topics of [[f.topic, f.mote], []]) {
      const captured = desktopSpatialGraph({ ...f.workbench, spaceZoneBindings: bindings, topicCategories: categories }, topics, migrated.graph)
      expect(captured.spaces.some(space => space.spaceId === sourceId)).toBe(false)
      expect(captured.bindings.some(binding => binding.spaceId === sourceId)).toBe(false)
      expect(captured.zones.find(zone => zone.zoneId === zoneId)?.directoryPath).toBe(f.topic.physicalDirectoryPath)
      expect(captured.resources['zone:' + zoneId]).toMatchObject({ topicId: f.topic.id, spaceId: sourceId })
      expect(captured.regions).toEqual(migrated.graph.regions)
    }
  })
  it('reports unreadable Topic content while preserving the original graph and healthy execution', async () => {
    const f = await fixture(), original = await f.state.read()
    f.setTopics([{ ...f.topic, readError: 'Metadata unavailable' }, f.mote])
    const preview = await f.owner.migratePreview()
    expect(preview.unavailable).toHaveLength(1)
    await expect(f.owner.migrateApply(preview.spatialRevision)).rejects.toMatchObject({ code: 'TOPIC_MIGRATION_UNCONFIRMED' })
    expect(await f.state.read()).toEqual(original)
  })
  it('transfers only the exact Topic classification while retaining legal Mote references and sibling Zones', async () => {
    const f = await fixture(); await f.owner.migrateApply(1)
    const directoryPath = join(scratchTopicStorageRoots(f.workspace.path).topics, 'category--11111111-1111-4111-8111-111111111111')
    const destination = { ...f.category, categoryId: '11111111-1111-4111-8111-111111111111', directoryPath, title: '工作', spaceId: directoryIdentity('local', directoryPath) }
    f.categories.push(destination); await f.owner.ensureCategory(destination)
    const before = (await f.state.read())!, siblingBindings = before.graph.bindings.filter(binding => binding.zoneId !== topicContentZoneId(f.workspace, f.topic))
    const moved = await f.owner.moveTopic(f.topic.id, destination.categoryId, before.revision), after = (await f.state.read())!
    expect(moved.previousCategorySpaceIds).toEqual([f.category.spaceId])
    expect(moved.categorySpaceIds).toEqual([destination.spaceId])
    expect(after.graph.bindings).toContainEqual({ zoneId: topicContentZoneId(f.workspace, f.topic), spaceId: directoryIdentity('local', f.mote.physicalDirectoryPath!) })
    expect(after.graph.bindings.filter(binding => binding.zoneId !== topicContentZoneId(f.workspace, f.topic))).toEqual(siblingBindings)
    expect(after.graph.tabs).toEqual(before.graph.tabs)
    expect(after.graph.regions).toEqual(before.graph.regions)
    expect(after.graph.layouts).toEqual(before.graph.layouts)
  })
})
