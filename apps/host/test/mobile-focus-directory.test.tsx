import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state.js'
import { createWorkbenchViewLayout, createWorkspaceLayout } from '../../../packages/core/src/spatial-layout.js'
import type { AgentMuxSpatialGraph } from '../../../packages/core/src/spatial-graph.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { createHostSpatialPresentation } from '../src/spatial-presentation.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { directoryIdentity, homeZoneId, SCRATCH_WORKSPACE_ID } from '../src/mote-model.js'
import { MobileSpatialNavigation } from '../../mobile/src/navigation/MobileSpatialNavigation.js'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
type Owner = Awaited<ReturnType<typeof rpcOwnerFixture>>
const graph = (): AgentMuxSpatialGraph => ({ spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} })
const facts = (value: unknown) => { if (process.env.MOBILE_FOCUS_DIRECTORY_FACTS) appendFileSync(process.env.MOBILE_FOCUS_DIRECTORY_FACTS, JSON.stringify(value) + '\n') }
const region = (g: AgentMuxSpatialGraph, sid: string, zoneId: string, workspaceId: string, cwd: string, suffix = sid) => {
  const tabId = 'tab-' + suffix, regionId = 'region-' + suffix
  g.tabs.push({ tabId, zoneId, workspaceId, name: null, regionIds: [regionId] })
  g.regions.push({ tabId, regionId, kind: 'agent', agentSessionId: sid, runId: 'run-' + sid, execution: { hostId: 'local', cwd } })
  g.tabLayouts[tabId] = createWorkbenchViewLayout(regionId)
  g.layouts[workspaceId] = createWorkspaceLayout('group-' + workspaceId, g.tabs.filter(tab => tab.workspaceId === workspaceId).map(tab => tab.tabId))
}
async function endpoint(f: Owner, g: AgentMuxSpatialGraph, workspaces: any[]) {
  const configurationPath = join(f.root, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify({ workspaces, focus: { recentActivityHours: 48 },
    executors: { codex: { providerId: 'codex', label: 'Original Codex' } }, appearance: {} }))
  const spatial = new AgentMuxSpatialStateStore(join(f.root, 'original-spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: g })
  const disk = await readFile(spatial.path, 'utf8'), path = join(f.root, 'focus.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: f.coreClients, spatialState: spatial,
    spatialPresentation: createHostSpatialPresentation({ configurationPath, clients: f.coreClients }) })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => rpc.dispose())
  const continuity = vi.spyOn(f.client, 'ensureAgentContinuity'), input = vi.spyOn(f.client, 'submitAgentPrompt')
  const noControl = () => {
    expect(continuity).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled()
    expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
    expect(f.inner.kernel.openInput).not.toHaveBeenCalled()
  }
  return { rpc, path, spatial, disk, noControl }
}
async function mobile(rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>>) {
  const element = document.createElement('div'); document.body.append(element)
  const root: Root = createRoot(element); cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  const opened = vi.fn(), forwardRpc = vi.fn((method: any, params: any) => rpc.call(method, params))
  const client = { forwardRpc, onEvent: () => () => {} } as any
  await act(async () => root.render(<MobileSpatialNavigation client={client} sessions={[]} connected home="focus" openSession={opened} />))
  await vi.waitFor(async () => { await act(async () => new Promise(resolve => setTimeout(resolve, 10))); expect(element.querySelectorAll('.mobile-focus-project').length).toBeGreaterThan(0) })
  return { element, opened, forwardRpc, headings: () => [...element.querySelectorAll('.mobile-focus-project h2 strong')].map(node => node.textContent) }
}
async function task(f: Owner, sid: string, at: number, workspacePath: string, state: 'done' | 'working' | 'blocked' = 'done') {
  const stored = await f.store.readMetadata(sid)
  expect(stored).not.toBeNull()
  await f.store.compareAndSwap(stored!, { ...stored!, workspacePath, updatedAt: Date.now(),
    semanticStatus: { state, source: 'native-hook', observedAt: Date.now(), stateEnteredAt: at } })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { id: 'task-' + sid,
    agentSessionId: sid, kind: 'user_message', status: 'complete', source: 'user', createdAt: at, updatedAt: at,
    title: 'Original task', content: 'Task for ' + sid, authorHuman: true } })
}

it('public RPC, compiled CLI and the mounted phone put current work ahead of old retained directory order without promoting heartbeat or bytes', async () => {
  const ids = ['old', 'heartbeat', 'recent', 'working', 'attention'], f = await rpcOwnerFixture(ids); cleanup.push(f.close)
  const now = Date.now(), day = 86400000, times = { old: now - 6 * day, heartbeat: now - 7 * day, recent: now - 3600000, working: now - 1000, attention: now - 2000 }
  const g = graph(), workspaces = ids.map(id => ({ id, hostId: 'local', name: 'Project ' + id, path: join(f.root, id), kind: 'folder' }))
  for (const workspace of workspaces) {
    const id = workspace.id as keyof typeof times, spaceId = directoryIdentity('local', workspace.path), zoneId = 'zone-' + id
    g.spaces.push({ spaceId, kind: 'folder', name: workspace.name, hostId: 'local', directoryPath: workspace.path, projectId: spaceId })
    g.zones.push({ zoneId, workspaceId: id, kind: 'directory', hostId: 'local', directoryPath: workspace.path, branch: null })
    g.bindings.push({ zoneId, spaceId }); region(g, id, zoneId, id, workspace.path)
    await task(f, id, times[id], workspace.path, id === 'working' ? 'working' : id === 'attention' ? 'blocked' : 'done')
  }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'heartbeat', item: { id: 'byte-observation', agentSessionId: 'heartbeat',
    kind: 'lifecycle', status: 'complete', source: 'run-process', createdAt: now, updatedAt: now, title: 'Observed output bytes' } })
  const status = f.inner.kernel.status as any
  status.mockImplementation(async (id: string) => ({ ...f.run(id), workspacePath: join(f.root, id.slice(4)) }))
  const h = await endpoint(f, g, workspaces), read = await h.rpc.call('space.ls', { target: {}, presentation: true })
  const expected = ['attention', 'working', 'recent', 'old', 'heartbeat']
  expect(read.catalog.agentPresentation?.map(row => row.agentSessionId)).toEqual(expected)
  expect(read.catalog.agentPresentation?.map(row => row.lastActivityAt)).toEqual(expected.map(id => times[id as keyof typeof times]))
  expect(read.catalog.regions).toEqual(g.regions)
  const inspected = await h.rpc.call('space.inspect', { target: { regionId: 'region-heartbeat' }, presentation: true })
  expect(inspected.catalog.agentPresentation).toMatchObject([{ agentSessionId: 'heartbeat', lastActivityAt: times.heartbeat }])
  expect(inspected.catalog.regions).toEqual([g.regions[1]])
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + h.path, 'space', 'ls', '--presentation'], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.catalog.agentPresentation.map((row: any) => [row.agentSessionId, row.lastActivityAt])).toEqual(expected.map(id => [id, times[id as keyof typeof times]]))
  const cliInspect = await runCompiledObjectCli(['--endpoint', 'unix:' + h.path, 'space', 'inspect', '--region', 'region-heartbeat', '--presentation'], objectCliEnvironment(f.root))
  expect(cliInspect.code, cliInspect.stderr).toBe(0)
  expect(JSON.parse(cliInspect.stdout).result.catalog.agentPresentation).toMatchObject([{ agentSessionId: 'heartbeat', lastActivityAt: times.heartbeat }])
  const view = await mobile(h.rpc)
  expect(view.headings()).toEqual(expected.map(id => 'Project ' + id))
  const original = await f.store.readMetadata('heartbeat')
  await f.store.compareAndSwap(original!, { ...original!, updatedAt: Date.now() + 100 })
  status.mockImplementation(async (id: string) => ({ ...f.run(id), workspacePath: join(f.root, id.slice(4)), latestOutputBytes: 900000 }))
  const after = await h.rpc.call('space.ls', { target: {}, presentation: true })
  expect(after.catalog.agentPresentation?.map(row => [row.agentSessionId, row.lastActivityAt])).toEqual(expected.map(id => [id, times[id as keyof typeof times]]))
  expect(await readFile(h.spatial.path, 'utf8')).toBe(h.disk); h.noControl()
  facts({ case: 'work-order', expected, publicCliExitCode: cli.code, sameSpatialBytes: true, preservedRegions: g.regions.length })
})

it('two ordinary Topics in one category retain exact independent names through missing Session metadata and share one display read per Topic', async () => {
  const f = await rpcOwnerFixture(['topic-a', 'topic-a-peer']); cleanup.push(f.close)
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Scratch resource', path: join(f.root, 'scratch'), kind: 'folder' }
  await mkdir(workspace.path)
  const topics = new ScratchTopics(), a = await topics.ensure(workspace, 'view:focus-first', 'First original Topic'), b = await topics.ensure(workspace, 'view:focus-second', 'Second original Topic')
  const g = graph(), category = directoryIdentity('local', join(f.root, 'category'))
  g.spaces.push({ spaceId: category, kind: 'container', name: 'Shared category', hostId: 'local', directoryPath: join(f.root, 'category'), projectId: null })
  for (const [topic, ids] of [[a, ['topic-a', 'topic-a-peer']], [b, ['missing-topic-b']]] as const) {
    const spaceId = directoryIdentity('local', topic.identityDirectoryPath!), zoneId = homeZoneId(spaceId)
    g.zones.push({ zoneId, workspaceId: workspace.id, kind: 'home', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null })
    g.bindings.push({ zoneId, spaceId: category }); g.resources['zone:' + zoneId] = { spaceId, workspaceId: workspace.id, topicId: topic.id, contentKind: 'topic' }
    for (const id of ids) region(g, id, zoneId, workspace.id, topic.physicalDirectoryPath!)
  }
  const moteId = directoryIdentity('local', join(f.root, 'mote')), moteZone = homeZoneId(moteId)
  g.spaces.push({ spaceId: moteId, kind: 'mote', name: 'Original named Mote', hostId: 'local', directoryPath: join(f.root, 'mote'), projectId: null, topicId: 'view:missing-mote' })
  g.zones.push({ zoneId: moteZone, workspaceId: workspace.id, kind: 'home', hostId: 'local', directoryPath: join(f.root, 'mote'), branch: null })
  g.bindings.push({ zoneId: moteZone, spaceId: moteId }); g.resources['zone:' + moteZone] = { spaceId: moteId, workspaceId: workspace.id, topicId: 'view:missing-mote', contentKind: 'mote' }
  region(g, 'missing-mote', moteZone, workspace.id, join(f.root, 'mote'))
  const readCopy = vi.spyOn(ScratchTopics.prototype, 'readDisplayCopy'), list = vi.spyOn(ScratchTopics.prototype, 'list')
  const h = await endpoint(f, g, [workspace]), read = await h.rpc.call('space.ls', { target: {}, presentation: true })
  const rows = new Map(read.catalog.agentPresentation!.map(row => [row.agentSessionId, row]))
  expect(rows.size).toBe(4)
  expect(rows.get('topic-a')?.projectGroup).toMatchObject({ key: directoryIdentity('local', a.identityDirectoryPath!), name: 'First original Topic', spaceId: null })
  expect(rows.get('topic-a-peer')?.projectGroup).toEqual(rows.get('topic-a')?.projectGroup)
  expect(rows.get('missing-topic-b')).toMatchObject({ presenceUnknown: true, projectGroup: { key: directoryIdentity('local', b.identityDirectoryPath!), name: 'Second original Topic', spaceId: null } })
  expect(rows.get('missing-mote')).toMatchObject({ presenceUnknown: true, projectGroup: { key: moteId, name: 'Original named Mote', spaceId: moteId } })
  expect(readCopy.mock.calls.map(call => call[1]).sort()).toEqual([a.id, b.id].sort()); expect(list).not.toHaveBeenCalled()
  expect(read.catalog.regions).toEqual(g.regions)
  const view = await mobile(h.rpc)
  expect(view.headings()).toContain('First original Topic'); expect(view.headings()).toContain('Second original Topic'); expect(view.headings()).toContain('Original named Mote')
  expect(view.headings()).not.toContain('Shared category'); expect(view.headings()).not.toContain('Scratch resource')
  const second = [...view.element.querySelectorAll<HTMLElement>('.mobile-focus-project')].find(section => section.dataset.projectKey === directoryIdentity('local', b.identityDirectoryPath!))
  const missing = second?.querySelector<HTMLButtonElement>('.mobile-agent-row__open')
  expect(missing).toBeDefined(); await act(async () => missing!.click())
  expect(view.opened).toHaveBeenCalledWith('missing-topic-b', expect.objectContaining({ project: 'Second original Topic' }))
  expect(await readFile(h.spatial.path, 'utf8')).toBe(h.disk); h.noControl()
  facts({ case: 'original-object-groups', distinctTopicReads: 2, independentTopics: 2, missingMotePreserved: true, sameSpatialBytes: true })
})

it('conflicting original content owners and a wrong read identity stay explicit without selecting the first owner or changing the workface', async () => {
  const f = await rpcOwnerFixture([]); cleanup.push(f.close)
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Scratch resource', path: join(f.root, 'scratch'), kind: 'folder' }
  await mkdir(workspace.path)
  const topics = new ScratchTopics(), a = await topics.ensure(workspace, 'view:ambiguous-first', 'First owner'), b = await topics.ensure(workspace, 'view:ambiguous-second', 'Second owner')
  const g = graph(), category = directoryIdentity('local', join(f.root, 'category'))
  g.spaces.push({ spaceId: category, kind: 'container', name: 'Shared category', hostId: 'local', directoryPath: join(f.root, 'category'), projectId: null })
  for (const [topic, suffix] of [[a, 'first'], [b, 'second']] as const) {
    const spaceId = directoryIdentity('local', topic.identityDirectoryPath!), zoneId = homeZoneId(spaceId)
    g.zones.push({ zoneId, workspaceId: workspace.id, kind: 'home', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null })
    g.bindings.push({ zoneId, spaceId: category }); g.resources['zone:' + zoneId] = { spaceId, workspaceId: workspace.id, topicId: topic.id, contentKind: 'topic' }
    region(g, 'ambiguous-session', zoneId, workspace.id, topic.physicalDirectoryPath!, suffix)
  }
  const wrongId = directoryIdentity('local', join(f.root, 'wrong-original')), wrongZone = homeZoneId(wrongId)
  g.zones.push({ zoneId: wrongZone, workspaceId: workspace.id, kind: 'home', hostId: 'local', directoryPath: a.physicalDirectoryPath!, branch: null })
  g.bindings.push({ zoneId: wrongZone, spaceId: category }); g.resources['zone:' + wrongZone] = { spaceId: wrongId, workspaceId: workspace.id, topicId: a.id, contentKind: 'topic' }
  region(g, 'wrong-identity-session', wrongZone, workspace.id, a.physicalDirectoryPath!)
  const h = await endpoint(f, g, [workspace]), read = await h.rpc.call('space.ls', { target: {}, presentation: true })
  const rows = read.catalog.agentPresentation!
  expect(rows).toHaveLength(2)
  expect(rows.find(row => row.agentSessionId === 'ambiguous-session')).toMatchObject({ project: '对象归属未确认', presenceUnknown: true })
  expect(rows.find(row => row.agentSessionId === 'ambiguous-session')?.projectGroup).toBeUndefined()
  const wrong = rows.find(row => row.agentSessionId === 'wrong-identity-session')!
  expect(wrong.projectGroup).toMatchObject({ key: wrongId, name: '名称未确认的 Topic' })
  expect(wrong.detail).toContain('unconfirmed'); expect(wrong.projectGroup?.name).not.toBe('First owner')
  expect(read.catalog.regions).toEqual(g.regions)
  expect(await readFile(h.spatial.path, 'utf8')).toBe(h.disk); h.noControl()
  facts({ case: 'owner-conflict', ambiguousPreserved: true, wrongIdentityNotAdopted: true, sameSpatialBytes: true, preservedRegions: g.regions.length })
})
