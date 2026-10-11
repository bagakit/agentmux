const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { EventEmitter } from 'node:events'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("private/tmp") } }))
import type { WebContents } from 'electron'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { useAppStore } from '../src/renderer/src/store.js'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs.js'
import { RendererUpdates } from '../src/main/renderer-updates.js'
import { inspectDesktopClient, readLoadedPackageIdentity } from '../src/main/client-observation.js'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { desktopWorkbenchObservationSchema, parseDesktopClientObservation } from '../src/shared/client-observation.js'
import { api } from '../src/renderer/src/lib/api.js'
import { customTab, moteTopics, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface.js'
import { topicSpatialAddress } from '../src/shared/space-addresses.js'

const initial = useAppStore.getState()
const roots: string[] = []
const request = { schemaVersion: 5, requestId: 'private-inspection', operation: 'inspect.client' } as const
const packageIdentity = { schema: 'agentmux.package-identity.v1', sourceCommit: 'private-original', sourceTree: 'private-tree',
  appVersion: '1', platform: 'darwin', arch: 'arm64' } as const
const renderer = { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'private-shell', ctxmux: 'private-native' } } as const
const runtime = { hostId: 'local', identity: { hostId: 'local', buildIdentity: 'private-serving',
  protocolVersion: 18, processId: null, instanceId: 'private-instance', ownership: 'unverified' as const } }
const comparison = { snapshot: { hostId: 'local', repoPath: _hygiene_fixturePath("private-repo"), mode: 'merge-base' as const,
  baseBranch: 'base', targetBranch: 'target', baseOid: 'a'.repeat(40), targetOid: 'b'.repeat(40), comparisonBaseOid: 'a'.repeat(40) },
  file: { path: 'original.txt', origPath: null } }
afterEach(async () => {
  useAppStore.setState(initial, true); vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
function workbench() {
  let tab = createWorkbenchTab('private-tab', { kind: 'agent', regionId: 'missing-agent', workspaceId: 'workspace', sessionId: 'missing', phase: 'attached' })
  tab = addWorkbenchRegion(tab, 'missing-agent', 'right', { kind: 'terminal', regionId: 'launching-terminal', workspaceId: 'workspace', sessionId: 'pending', phase: 'launching' })
  tab = addWorkbenchRegion(tab, 'launching-terminal', 'down', { kind: 'browser', regionId: 'original-browser', workspaceId: 'workspace', browserId: 'browser-id',
    id: 'browser-id', mode: 'normal', navigationId: '', profileId: 'default', url: 'about:blank', title: 'Original page', loading: false,
    error: 'Native page has not reopened', canGoBack: false, canGoForward: false,
    viewport: 'responsive', driving: false, appLinkPrompt: null })
  tab = addWorkbenchRegion(tab, 'original-browser', 'right', { kind: 'file', regionId: 'original-file', workspaceId: 'workspace', path: _hygiene_fixturePath("private-file") })
  tab = addWorkbenchRegion(tab, 'original-file', 'down', { kind: 'git-diff', regionId: 'original-diff', workspaceId: 'workspace', comparison })
  tab = addWorkbenchRegion(tab, 'original-diff', 'right', { kind: 'launcher', regionId: 'original-launcher', workspaceId: 'workspace' })
  useAppStore.setState({ loading: true, startupProgress: { step: 'browsers', current: 0, total: 1 }, sessions: [],
    tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('private-group', [tab.id]) },
    activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    documents: { secret: { text: 'FILE BODY MUST NOT LEAVE', path: _hygiene_fixturePath("private-file") } } as never,
    agentComposerDrafts: { missing: 'DRAFT MUST NOT LEAVE' } })
  return tab
}

it('projects every original Region through actual Store and IPC bridge, including missing/launching/error owners, without writes or body', async () => {
  const tab = workbench()
  const before = useAppStore.getState()
  const changed = vi.fn(); const dispose = useAppStore.subscribe(changed)
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => true,
    sendRequest: input => {
      if (input.operation !== 'inspect.client') throw new Error('Unexpected observation operation')
      void useAppStore.getState().executeControl(input).then(result => bridge.accept({ requestId: input.requestId, ok: true, result }))
    },
    sendCancellation: () => { throw new Error('Unexpected cancellation') } })
  try {
    const result = await inspectDesktopClient(request, { pid: 123, package: packageIdentity, renderer: () => renderer,
      generation: () => 1, runtimes: () => [runtime], execute: input => bridge.execute(input) })
    expect(result.operation).toBe('inspect.client')
    if (result.operation !== 'inspect.client') throw new Error('wrong operation')
    const observed = parseDesktopClientObservation(result.observation)
    expect(observed.main.runtimes).toEqual([runtime])
    expect(observed.workbench.loading).toBe(true)
    expect(observed.workbench.tabs[0]?.layout).toEqual(tab.layout)
    expect(observed.workbench.layouts).toEqual(before.layouts)
    expect(observed.workbench.tabs[0]?.regions.map(region => [region.kind, region.regionId])).toEqual([
      ['agent', 'missing-agent'], ['terminal', 'launching-terminal'], ['browser', 'original-browser'],
      ['file', 'original-file'], ['git-diff', 'original-diff'], ['launcher', 'original-launcher']
    ])
    expect(observed.workbench.tabs[0]?.regions[0]).toMatchObject({ control: null, processState: null })
    expect(observed.workbench.tabs[0]?.regions[1]).toMatchObject({ phase: 'launching', control: null })
    expect(observed.workbench.tabs[0]?.regions[2]).toMatchObject({ browserId: 'browser-id', error: 'Native page has not reopened' })
    expect(observed.workbench.tabs[0]?.regions[3]).toEqual({ kind: 'file', regionId: 'original-file', workspaceId: 'workspace', path: _hygiene_fixturePath("private-file") })
    expect(observed.workbench.tabs[0]?.regions[4]).toEqual({ kind: 'git-diff', regionId: 'original-diff', workspaceId: 'workspace', comparison })
    expect(observed.workbench.tabs[0]?.regions[5]).toEqual({ kind: 'launcher', regionId: 'original-launcher', workspaceId: 'workspace' })
    expect(JSON.stringify(observed)).not.toContain('MUST NOT LEAVE')
    expect(changed).toHaveBeenCalledTimes(0)
    expect(useAppStore.getState()).toBe(before)
  } finally { bridge.dispose(); dispose() }
})

it('reads Recall through the original Store IPC and Main observation without changing the workface', async () => {
  const tab = workbench()
  useAppStore.setState({ mainSurface: 'recall' })
  const before = useAppStore.getState()
  const changed = vi.fn(); const dispose = useAppStore.subscribe(changed)
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => true,
    sendRequest: input => {
      if (input.operation !== 'inspect.client') throw new Error('Unexpected observation operation')
      void useAppStore.getState().executeControl(input).then(result => bridge.accept({ requestId: input.requestId, ok: true, result }))
    },
    sendCancellation: () => { throw new Error('Unexpected cancellation') } })
  try {
    const result = await inspectDesktopClient(request, { pid: 123, package: packageIdentity, renderer: () => renderer,
      generation: () => 1, runtimes: () => [runtime], execute: input => bridge.execute(input) })
    if (result.operation !== 'inspect.client') throw new Error('wrong operation')
    const observed = parseDesktopClientObservation(result.observation)
    expect(observed.workbench.desktop.selection).toMatchObject({ surface: 'recall', mainSurface: 'recall' })
    expect(observed.workbench.mainSurface).toBe('recall')
    expect(observed.workbench.tabs[0]?.id).toBe(tab.id)
    expect(observed.workbench.layouts).toEqual(before.layouts)
    expect(observed.workbench.focus).toEqual({ executionSessionId: null, pmoSessionId: null })
    expect(JSON.stringify(observed)).not.toContain('MUST NOT LEAVE')
    expect(changed).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toBe(before)
    expect(() => parseDesktopClientObservation({ ...observed, workbench: { ...observed.workbench,
      desktop: { ...observed.workbench.desktop, selection: { ...observed.workbench.desktop.selection, surface: 'foreign-surface' } } } })).toThrow()
  } finally { bridge.dispose(); dispose() }
})

function scratchWorkbench() {
  seedMoteWorkface()
  useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: scratchWorkspace.id,
    workbenchSpaceSelection: null, spaceZoneBindings: {}, topicCategories: [],
    layouts: { [scratchWorkspace.id]: createWorkspaceLayout('original-group', [customTab.id]) } })
}
function inspectWorkbench() {
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => true,
    sendRequest: input => {
      if (input.operation !== 'inspect.client') throw new Error('Unexpected observation operation')
      void useAppStore.getState().executeControl(input).then(result => bridge.accept({ requestId: input.requestId, ok: true, result }))
    },
    sendCancellation: () => { throw new Error('Unexpected cancellation') } })
  const result = inspectDesktopClient(request, { pid: 123, package: packageIdentity, renderer: () => renderer,
    generation: () => 1, runtimes: () => [runtime], execute: input => bridge.execute(input) })
  return { result, dispose: () => bridge.dispose() }
}

it.each([false, true])('observes the loaded workface through Main/IPC without waiting for unrelated Scratch I/O, retained read=%s', async reading => {
  scratchWorkbench()
  const current = useAppStore.getState()
  const snapshot = current.scratchTopicSnapshots[scratchWorkspace.id]!
  useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: { ...snapshot, reading,
    error: reading ? 'Directory refresh is unavailable' : null } } })
  let release!: (topics: typeof moteTopics) => void
  const pending = new Promise<typeof moteTopics>(resolve => { release = resolve })
  const list = vi.spyOn(api.scratch, 'listTopics').mockReturnValue(pending)
  const read = vi.spyOn(api.scratch, 'readTopic')
  const before = useAppStore.getState(), changed = vi.fn(), dispose = useAppStore.subscribe(changed)
  const inspection = inspectWorkbench()
  try {
    expect(list).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    const result = await inspection.result
    if (result.operation !== 'inspect.client') throw new Error('wrong operation')
    const observed = parseDesktopClientObservation(result.observation)
    const topic = moteTopics.find(topic => topic.id === customTab.topicId)!
    expect(observed.workbench.desktop.selection.space).toMatchObject({ ...topicSpatialAddress(before.config, topic),
      workspaceId: scratchWorkspace.id, tabId: customTab.id, regionId: customTab.layout.activeRegionId })
    expect(observed.workbench.focus).toEqual({ executionSessionId: before.agentFocus.execution.sessionId, pmoSessionId: before.agentFocus.pmo.sessionId })
    expect(observed.workbench.layouts).toEqual(before.layouts)
    expect(observed.workbench.tabs.find(tab => tab.id === customTab.id)?.regions[0]).toMatchObject({
      regionId: customTab.layout.activeRegionId, sessionId: 'custom-agent', processState: 'running',
      control: before.sessions.find(session => session.id === 'custom-agent')!.control })
    expect(changed).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toBe(before)
    expect(list).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  } finally { release(moteTopics); await inspection.result.catch(() => {}); inspection.dispose(); dispose() }
})

it.each(['host', 'path'] as const)('does not borrow a Scratch snapshot from a different %s while retaining its original workface', async field => {
  scratchWorkbench()
  const current = useAppStore.getState()
  const changedWorkspace = { ...scratchWorkspace, ...(field === 'host' ? { hostId: 'other-host' } : { path: _hygiene_fixturePath('other-topics') }) }
  useAppStore.setState({ config: { ...current.config!, workspaces: current.config!.workspaces.map(workspace =>
    workspace.id === scratchWorkspace.id ? changedWorkspace : workspace) } })
  const list = vi.spyOn(api.scratch, 'listTopics')
  const before = useAppStore.getState(), inspection = inspectWorkbench()
  try {
    const result = await inspection.result
    if (result.operation !== 'inspect.client') throw new Error('wrong operation')
    const observed = parseDesktopClientObservation(result.observation)
    expect(observed.workbench.desktop.selection.space).toMatchObject({ spaceId: null, zoneId: null,
      workspaceId: scratchWorkspace.id, tabId: customTab.id, regionId: customTab.layout.activeRegionId })
    expect(observed.workbench.tabs.map(tab => tab.id)).toEqual(Object.keys(before.tabs))
    expect(observed.workbench.tabs.find(tab => tab.id === customTab.id)?.regions[0]).toMatchObject({ processState: 'running' })
    expect(useAppStore.getState()).toBe(before)
    expect(list).not.toHaveBeenCalled()
  } finally { inspection.dispose() }
})

it.each(['missing', 'unknown', 'empty'] as const)('retains original Regions and unknown presentation without %s Scratch facts', async facts => {
  scratchWorkbench()
  const current = useAppStore.getState()
  const snapshot = current.scratchTopicSnapshots[scratchWorkspace.id]!
  useAppStore.setState({ scratchTopicSnapshots: facts === 'missing' ? {} : { [scratchWorkspace.id]: {
    ...snapshot, topics: facts === 'unknown' ? null : [], reading: facts === 'unknown', error: 'Discovery is unconfirmed' } } })
  const list = vi.spyOn(api.scratch, 'listTopics')
  const before = useAppStore.getState(), inspection = inspectWorkbench()
  try {
    const result = await inspection.result
    if (result.operation !== 'inspect.client') throw new Error('wrong operation')
    const observed = parseDesktopClientObservation(result.observation)
    expect(observed.workbench.desktop.selection.space).toMatchObject({ spaceId: null, zoneId: null,
      tabId: customTab.id, regionId: customTab.layout.activeRegionId })
    expect(observed.workbench.desktop.presentation).toMatchObject({ provenance: 'unknown', state: 'unknown' })
    expect(observed.workbench.tabs.map(tab => tab.id)).toEqual(Object.keys(before.tabs))
    expect(observed.workbench.focus.pmoSessionId).toBe(before.agentFocus.pmo.sessionId)
    expect(useAppStore.getState()).toBe(before)
    expect(list).not.toHaveBeenCalled()
  } finally { inspection.dispose() }
})

it('retains the package metadata captured at startup after the canonical metadata changes', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-loaded-identity-")); roots.push(root)
  const path = join(root, 'package-identity.json')
  await writeFile(path, JSON.stringify(packageIdentity))
  const loaded = await readLoadedPackageIdentity(path)
  await writeFile(path, JSON.stringify({ ...packageIdentity, sourceCommit: 'private-new-on-disk' }))
  workbench()
  const result = await inspectDesktopClient(request, { pid: 123, package: loaded, renderer: () => renderer,
    generation: () => 1, runtimes: () => [runtime], execute: input => useAppStore.getState().executeControl(input) })
  if (result.operation !== 'inspect.client') throw new Error('wrong operation')
  expect(parseDesktopClientObservation(result.observation).main.package?.sourceCommit).toBe('private-original')
  expect(JSON.parse(await readFile(path, 'utf8')).sourceCommit).toBe('private-new-on-disk')
})

it('does not pair a pre-navigation Store response with a new Renderer owner', async () => {
  workbench()
  const controller = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  const contents = Object.assign(new EventEmitter(), { id: 10, isDestroyed: () => false }) as unknown as WebContents
  const detach = controller.attach(contents)
  const held = await useAppStore.getState().executeControl(request)
  let complete!: (value: typeof held) => void
  const result = inspectDesktopClient(request, { pid: 123, package: packageIdentity, renderer: () => renderer,
    generation: () => controller.rendererGeneration(contents), runtimes: () => [],
    execute: () => new Promise(resolve => { complete = resolve }) })
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  complete(held)
  await expect(result).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  detach(); await controller.dispose()
})

it('reports unavailable during an actual loader transaction, then preserves its successful loaded identity', async () => {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-loaded-renderer-")); roots.push(root)
  const bundled = join(root, 'bundled'); await mkdir(bundled)
  await writeFile(join(bundled, 'release.json'), JSON.stringify({ schema: 1, id: renderer.id, identity: renderer.identity, files: {} }))
  let finish!: () => void
  const loading = new Promise<void>(resolve => { finish = resolve })
  let current!: RendererUpdates
  let initialized!: Promise<void>
  const entered = new Promise<void>(resolve => {
    const owner = new RendererUpdates({ directory: join(root, 'updates'), bundled, prepare: async () => {},
      load: async () => { resolve(); await loading }, report: error => { throw error } })
    current = owner; initialized = owner.initialize()
  })
  await entered
  expect(current.loadedRenderer()).toBeNull()
  await expect(inspectDesktopClient(request, { pid: 123, package: packageIdentity, renderer: () => current.loadedRenderer(),
    generation: () => 1, runtimes: () => [], execute: async () => { throw new Error('must not request Store while loading') } }))
    .rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  finish(); await initialized
  const loaded = current.loadedRenderer()
  expect(loaded).toEqual(renderer)
  await writeFile(join(bundled, 'release.json'), JSON.stringify({ schema: 1, id: 'b'.repeat(64), identity: renderer.identity, files: {} }))
  expect(current.loadedRenderer()).toBe(loaded)
  current.dispose()
})

it('rejects additional body fields rather than accepting a truncated or expanded workbench schema', async () => {
  workbench()
  const result = await useAppStore.getState().executeControl(request)
  if (result.operation !== 'inspect.client') throw new Error('wrong operation')
  expect(desktopWorkbenchObservationSchema.parse(result.observation).tabs).toHaveLength(1)
  expect(() => desktopWorkbenchObservationSchema.parse({ ...result.observation, draft: 'unexpected-body' })).toThrow()
})

it('binds the activated GUI serving identity and exact Run state to the existing confirmation, including a natural exit', async () => {
  const { assertUiRuntimeObservation } = await import(pathToFileURL(process.env.AGENTMUX_UPGRADE_OWNER_PATH ?? resolve(import.meta.dirname, '../scripts/package-runtime-upgrade.mjs')).href)
  workbench()
  const result = await inspectDesktopClient(request, { pid: 123, package: packageIdentity, renderer: () => renderer,
    generation: () => 1, runtimes: () => [runtime], execute: input => useAppStore.getState().executeControl(input) })
  if (result.operation !== 'inspect.client') throw new Error('wrong operation')
  const observed = parseDesktopClientObservation(result.observation)
  const region = observed.workbench.tabs[0]!.regions[0]!
  if (region.kind !== 'agent') throw new Error('Expected original Agent Region')
  region.control = { kind: 'agent', hostId: 'local', agentSessionId: 'missing', run: { runId: 'confirmed-run' } }
  region.processState = 'running'
  const original = structuredClone(observed)
  const confirmation = { runtime: { daemonInstanceId: 'private-instance', buildId: 'private-serving', protocolGeneration: 18 },
    originalRuns: [{ id: 'confirmed-run', state: { type: 'running' } }, { id: 'unprojected-sibling', state: { type: 'running' } }] }
  expect(original.workbench.tabs[0]!.regions).toHaveLength(6)
  expect(confirmation.originalRuns.map(run => run.id)).toEqual(['confirmed-run', 'unprojected-sibling'])
  expect(() => assertUiRuntimeObservation(observed, confirmation, original)).not.toThrow()
  expect(() => assertUiRuntimeObservation({ ...observed, main: { ...observed.main, runtimes: [] } }, confirmation, original)).toThrow('serving Runtime')
  expect(() => assertUiRuntimeObservation(observed, { ...confirmation,
    runtime: { ...confirmation.runtime, daemonInstanceId: 'different-instance' } }, original)).toThrow('serving Runtime')
  region.processState = 'interrupted'
  expect(() => assertUiRuntimeObservation(observed, confirmation, original)).toThrow('original Run state')
  region.processState = 'exited'
  expect(() => assertUiRuntimeObservation(observed, { ...confirmation,
    originalRuns: [{ id: 'confirmed-run', state: { type: 'exited' } }, confirmation.originalRuns[1]] }, original)).not.toThrow()
  region.processState = 'running'
  region.control.run.runId = 'unprojected-sibling'
  expect(() => assertUiRuntimeObservation(observed, confirmation, original)).toThrow('original Run state')
  region.control.run.runId = 'confirmed-run'
  const originalRegionId = region.regionId; region.regionId = 'different-region'
  expect(() => assertUiRuntimeObservation(observed, confirmation, original)).toThrow('original Run state')
  region.regionId = originalRegionId
  const originalTabId = observed.workbench.tabs[0]!.id; observed.workbench.tabs[0]!.id = 'different-tab'
  expect(() => assertUiRuntimeObservation(observed, confirmation, original)).toThrow('original Run state')
  observed.workbench.tabs[0]!.id = originalTabId
  region.control = null
  expect(() => assertUiRuntimeObservation(observed, confirmation, original)).toThrow('original Run state')
  expect(() => assertUiRuntimeObservation(observed, confirmation, null)).not.toThrow()
  expect(() => assertUiRuntimeObservation({ ...observed, main: { ...observed.main, runtimes: [] } }, confirmation, null)).toThrow('serving Runtime')
  expect(() => assertUiRuntimeObservation(observed, confirmation, undefined)).toThrow()
})
