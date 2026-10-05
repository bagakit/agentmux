import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AgentMuxControlServer } from '../../../packages/core/dist/control-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { createWorkspaceLayout } from '@agentmux/layout'
import { formatAmuxObjectLink, parseAmuxObjectLink, parseAgentMuxControlRequest, type TopicCategory } from '@agentmux/core'
import type { AppConfig, ScratchTopicSnapshot } from '../src/shared/contracts'
import { directoryIdentity, originalTopicAddress } from '../src/shared/space-addresses'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { DesktopFocusFailure, resolveDesktopSpaceSelection } from '../src/renderer/src/lib/desktop-focus-navigation'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SpatialLinkIngress } from '../src/main/spatial-link-ingress'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'

const initial = useAppStore.getState()
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: _hygiene_fixturePath("private/topics"), kind: 'folder' as const }
const category = (name: string): TopicCategory => ({ categoryId: name, title: name, hostId: 'local', revision: 'original',
  directoryPath: _hygiene_fixturePath("private/categories/") + name, spaceId: directoryIdentity('local', _hygiene_fixturePath("private/categories/") + name) })
const work = category('Work'), ideas = category('Ideas')
const topic = (id: string): ScratchTopicSnapshot => ({ id: 'view:' + id, title: id, summary: '', collaborators: [],
  directoryPath: _hygiene_fixturePath("private/topics/") + id, identityDirectoryPath: _hygiene_fixturePath("private/topics/") + id, topicPath: _hygiene_fixturePath("private/topics/") + id + '/topic.md' })
const topics = [topic('one'), topic('two')]
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
  workspaces: [workspace, { id: 'project', hostId: 'local', name: 'Project', path: _hygiene_fixturePath("private/project"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
function arrange(count = 2) {
  const members = topics.slice(0, count), tabs = members.map(value => ({ ...createWorkbenchTab('chat:' + value.id,
    { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'region:' + value.id, sessionId: 'healthy:' + value.id }),
    topicId: value.id, space: { spaceId: work.spaceId, zoneId: originalTopicAddress(workspace, value, {})!.zoneId } }))
  const bindings = Object.fromEntries(members.map(value => {
    const address = originalTopicAddress(workspace, value, {})!
    return [address.zoneId, { spaceId: address.spaceId, workspaceId: workspace.id, topicId: value.id, contentKind: 'topic' as const, relations: { [work.spaceId]: true } }]
  }))
  useAppStore.setState({ config, loading: false, activeWorkspaceId: workspace.id, mainSurface: 'workbench',
    topicCategories: [work, ideas], spaceZoneBindings: bindings, sessions: [], tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])),
    layouts: { [workspace.id]: createWorkspaceLayout('group', tabs.map(tab => tab.id)) }, workbenchSpaceSelection: null,
    agentComposerDrafts: { original: 'Unsent original draft' } })
  return { state: useAppStore.getState(), catalog: spatialCatalog(useAppStore.getState(), members), members }
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); window.localStorage.clear(); useAppStore.setState(initial, true)
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
})
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.localStorage.clear() })

describe('original Space focus resolver and control owner', () => {
  it.each([0, 1, 2])('opens the confirmed Category parent with %i members without choosing any child', count => {
    const { state, catalog } = arrange(count)
    expect(resolveDesktopSpaceSelection(state, catalog, { spaceId: work.spaceId })).toEqual({ spaceId: work.spaceId,
      zoneId: null, workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null })
    expect(resolveDesktopSpaceSelection(state, catalog, { spaceId: ideas.spaceId }).zoneId).toBeNull()
  })
  it('rejects a wrong resource Host/path or display Workspace for this operation, preserving the original state', () => {
    const { state, catalog } = arrange(), before = useAppStore.getState()
    for (const wrong of [{ ...catalog, spaces: catalog.spaces.map(space => space.spaceId === work.spaceId ? { ...space, hostId: 'other' } : space) },
      { ...catalog, spaces: catalog.spaces.map(space => space.spaceId === work.spaceId ? { ...space, directoryPath: _hygiene_fixturePath("other") } : space) }]) {
      expect(() => resolveDesktopSpaceSelection(state, wrong, { spaceId: work.spaceId })).toThrow(DesktopFocusFailure)
    }
    expect(() => resolveDesktopSpaceSelection(state, catalog, { spaceId: work.spaceId, displayWorkspaceId: 'project' })).toThrow('original Category context')
    expect(useAppStore.getState()).toBe(before)
  })
  it('keeps an explicit member, ordinary Folder and Mote on their existing resolver paths', () => {
    const { state, catalog } = arrange(1), member = catalog.tabs[0]!
    expect(resolveDesktopSpaceSelection(state, catalog, { spaceId: work.spaceId, tabId: member.tabId }).tabId).toBe(member.tabId)
    const folder = directoryIdentity('local', _hygiene_fixturePath("private/project"))
    expect(resolveDesktopSpaceSelection(state, catalog, { spaceId: folder })).toMatchObject({ spaceId: folder, workspaceId: 'project' })
    const mote = { ...topic('mote'), soul: { path: _hygiene_fixturePath("private/topics/mote/SOUL.md"), content: '# Original Mote', version: 'original' } }
    const original = originalTopicAddress(workspace, mote, {})!
    const moteCatalog = spatialCatalog(state, [mote, ...topics])
    expect(resolveDesktopSpaceSelection(state, moteCatalog, { spaceId: original.spaceId })).toMatchObject({ spaceId: original.spaceId, zoneId: original.zoneId, topicId: mote.id })
  })
  it('resolves a copied original Zone after a Category transfer and rejects real multiple parents without guessing', () => {
    const { state } = arrange(1), target = originalTopicAddress(workspace, topics[0]!, {})!
    const raw = formatAmuxObjectLink({ kind: 'zone', zoneId: target.zoneId })
    const parsed = parseAmuxObjectLink(raw); expect(parsed.kind).toBe('zone')
    const moved = { ...state, spaceZoneBindings: { ...state.spaceZoneBindings, [target.zoneId]: { ...state.spaceZoneBindings[target.zoneId]!, relations: { [work.spaceId]: false, [ideas.spaceId]: true } } } }
    expect(resolveDesktopSpaceSelection(moved, spatialCatalog(moved, [topics[0]!]), { zoneId: target.zoneId })).toMatchObject({ spaceId: ideas.spaceId, zoneId: target.zoneId, topicId: topics[0]!.id })
    const shared = { ...moved, spaceZoneBindings: { ...moved.spaceZoneBindings, [target.zoneId]: { ...moved.spaceZoneBindings[target.zoneId]!, relations: { [work.spaceId]: true, [ideas.spaceId]: true } } } }
    try { resolveDesktopSpaceSelection(shared, spatialCatalog(shared, [topics[0]!]), { zoneId: target.zoneId }); throw new Error('Expected exact location rejection') }
    catch (error) {
      expect(error).toBeInstanceOf(DesktopFocusFailure)
      const issue = (error as DesktopFocusFailure).issue
      expect(issue.code).toBe('SPACE_LOCATION_REQUIRED'); expect(issue.candidates?.map(candidate => candidate.spaceId).sort()).toEqual([work.spaceId, ideas.spaceId].sort())
    }
  })
  it('executes the original typed Category focus without replacing any durable Chat, Region, layout, Session or draft', async () => {
    const { state } = arrange()
    const result = await state.executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'category', operation: 'focus', target: { kind: 'space', spaceId: work.spaceId }, inputPolicy: 'preserve' }))
    expect(result.operation).toBe('focus')
    if (result.operation !== 'focus') throw new Error('Expected focus')
    expect(result.navigation.selection.space).toMatchObject({ spaceId: work.spaceId, zoneId: null, tabId: null, groupId: null, regionId: null })
    const after = useAppStore.getState()
    expect(after.tabs).toBe(state.tabs); expect(after.layouts).toBe(state.layouts); expect(after.sessions).toBe(state.sessions); expect(after.agentComposerDrafts).toBe(state.agentComposerDrafts)
  })
  it('does not let late original Topic discovery overwrite a newer deliberate navigation', async () => {
    const { state } = arrange()
    let resolve!: (value: ScratchTopicSnapshot[]) => void
    vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = state.executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'late', operation: 'focus', target: { kind: 'space', spaceId: work.spaceId }, inputPolicy: 'preserve' }))
    const later = { spaceId: ideas.spaceId, zoneId: null, workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null }
    useAppStore.setState({ workbenchSpaceSelection: later })
    resolve(topics)
    const result = await pending
    if (result.operation !== 'focus') throw new Error('Expected focus')
    expect(result.navigation.state).toBe('rejected'); expect(result.issues.map(issue => issue.code)).toContain('NAVIGATION_CHANGED')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(later); expect(useAppStore.getState().tabs).toBe(state.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
  })
  it('consumes Category parent and relocated Zone through actual compiled CLI, original Unix RPC service and real Store focus', async () => {
    vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve(import.meta.dirname, '../../../packages/core/bin/amux'))
    const { state } = arrange(), root = await mkdtemp(_hygiene_fixturePath("tmp/amx-spatial-link-")), seen: string[] = [], executions: unknown[] = [], results: unknown[] = []
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: async request => {
      seen.push(request.operation); executions.push(request)
      return await useAppStore.getState().executeControl(request)
    } })
    await server.start()
    const run = async (args: string[]) => {
      const output = await runCompiledObjectCli(args, objectCliEnvironment(root))
      expect(output.code, output.stderr).toBe(1) // Real unmounted client has partial DOM/input facts.
      const body = JSON.parse(output.stdout || output.stderr); expect(body.ok).toBe(true)
      expect(body.operation).toBe('space.focus'); results.push({ args, ...output, body }); return body.result
    }
    try {
      const parent = await run(['space', 'focus', '--space', work.spaceId])
      expect(parent.navigation.state).toBe('applied')
      expect(parent.navigation.selection.space).toEqual({ spaceId: work.spaceId, zoneId: null, workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null })
      const zoneId = originalTopicAddress(workspace, topics[0]!, {})!.zoneId
      useAppStore.setState(current => ({ spaceZoneBindings: { ...current.spaceZoneBindings,
        [zoneId]: { ...current.spaceZoneBindings[zoneId]!, relations: { [work.spaceId]: false, [ideas.spaceId]: true } } } }))
      const moved = await run(['space', 'focus', '--zone', zoneId])
      expect(moved.navigation.selection.space).toMatchObject({ spaceId: ideas.spaceId, zoneId, topicId: topics[0]!.id })
      const beforeAmbiguous = useAppStore.getState().workbenchSpaceSelection
      useAppStore.setState(current => ({ spaceZoneBindings: { ...current.spaceZoneBindings,
        [zoneId]: { ...current.spaceZoneBindings[zoneId]!, relations: { [work.spaceId]: true, [ideas.spaceId]: true } } } }))
      const shared = await run(['space', 'focus', '--zone', zoneId])
      expect(shared.navigation.state).toBe('rejected')
      expect(shared.issues.find((issue: { code: string }) => issue.code === 'SPACE_LOCATION_REQUIRED')?.candidates.map((candidate: { spaceId: string }) => candidate.spaceId).sort()).toEqual([work.spaceId, ideas.spaceId].sort())
      expect(useAppStore.getState().workbenchSpaceSelection).toBe(beforeAmbiguous)
      expect(seen).toEqual(['focus', 'focus', 'focus'])
      const after = useAppStore.getState()
      expect(after.tabs).toEqual(state.tabs); expect(after.layouts).toEqual(state.layouts); expect(after.sessions).toBe(state.sessions); expect(after.agentComposerDrafts).toBe(state.agentComposerDrafts)
      if (process.env.AGENTMUX_SPATIAL_LINK_RECEIPT) await writeFile(process.env.AGENTMUX_SPATIAL_LINK_RECEIPT, JSON.stringify({
        passed: true, scope: 'compiled CLI -> real Unix public service -> original Renderer Store/resolver; DOM is intentionally unmounted, partial exit 1 is preserved',
        root, requests: executions, results, workfaceIdsUnchanged: true, packagingOrUserAppTouched: false
      }, null, 2), { mode: 0o600 })
    } finally { await server.stop(); await rm(root, { recursive: true }) }
  }, 30_000)
  it('keeps a newer navigation even when the user leaves and returns to the starting workface before discovery replies', async () => {
    const { state } = arrange()
    let resolve!: (value: ScratchTopicSnapshot[]) => void
    vi.mocked(api.scratch.listTopics).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const subscribe = vi.spyOn(useAppStore, 'subscribe')
    const pending = state.executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'returning-user', operation: 'focus', target: { kind: 'space', spaceId: work.spaceId }, inputPolicy: 'preserve' }))
    useAppStore.setState({ mainSurface: 'agents' }); useAppStore.setState({ mainSurface: state.mainSurface })
    resolve(topics)
    const result = await pending
    if (result.operation !== 'focus') throw new Error('Expected focus')
    expect(result.navigation.state).toBe('rejected'); expect(result.issues.map(issue => issue.code)).toContain('NAVIGATION_CHANGED')
    expect(useAppStore.getState().mainSurface).toBe(state.mainSurface); expect(useAppStore.getState().workbenchSpaceSelection).toBeNull()
    expect(useAppStore.getState().tabs).toBe(state.tabs); expect(subscribe).toHaveBeenCalledTimes(1)
  })
})


it.each([false, true])('opens an Agent URI via the original service/Store and guards against a replaced occupant (replace=%s)', async replace => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve(import.meta.dirname, '../../../packages/core/bin/amux'))
  const { state, catalog } = arrange(1)
  const originalRegion = catalog.regions.find(region => region.agentSessionId === 'healthy:view:one')!
  expect(originalRegion).toBeDefined()
  const beforeSelection = useAppStore.getState().workbenchSpaceSelection
  const beforeTabs = useAppStore.getState().tabs
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-agent-link-"))
  const requests: unknown[] = []
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: async request => {
    requests.push(request)
    return await useAppStore.getState().executeControl(request)
  } })
  await server.start()
  try {
    const link = formatAmuxObjectLink({ kind: 'agent', agentSessionId: 'healthy:view:one' })
    expect(link).toBe('amux://agent/healthy%3Aview%3Aone')
    const parsed = parseAmuxObjectLink(link)
    expect(parsed.kind).toBe('agent')
    if (parsed.kind !== 'agent') throw new Error('Expected semantic Agent URI')
    const discovery = await runCompiledObjectCli(['space', 'ls'], objectCliEnvironment(root))
    expect(discovery.code, discovery.stderr).toBe(0)
    const discovered = JSON.parse(discovery.stdout).result.catalog
    const location = discovered.locations.find((candidate: { regionId: string }) => candidate.regionId === originalRegion.regionId)
    expect(location).toBeDefined()
    if (replace) {
      const originalTab = useAppStore.getState().tabs[originalRegion.tabId]!
      useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [originalTab.id]: { ...originalTab,
        regions: { ...originalTab.regions, [originalRegion.regionId]: { ...originalTab.regions[originalRegion.regionId]!, sessionId: 'replacement-session' } } } } })
    }
    const output = await runCompiledObjectCli(['space', 'focus', '--region', location.regionId,
      '--display-workspace', location.displayWorkspaceId, '--group', location.groupId,
      '--expect-session', parsed.agentSessionId], objectCliEnvironment(root))
    // The Store is intentionally unmounted; actual DOM/input remain unconfirmed.
    expect(output.code, output.stderr).toBe(1)
    const body = JSON.parse(output.stdout || output.stderr)
    expect(body.ok).toBe(true)
    expect(body.result.navigation.expectedAgentSessionId).toBe(parsed.agentSessionId)
    if (replace) {
      expect(body.result.navigation.state).toBe('rejected')
      expect(body.result.issues.map((issue: { code: string }) => issue.code)).toContain('AGENT_LOCATION_CHANGED')
      expect(useAppStore.getState().workbenchSpaceSelection).toBe(beforeSelection)
      expect(useAppStore.getState().tabs[originalRegion.tabId]!.regions[originalRegion.regionId]).toMatchObject({ sessionId: 'replacement-session' })
    } else {
      expect(body.result.navigation.state).toBe('applied')
      expect(body.result.navigation.selection.space).toMatchObject({ regionId: originalRegion.regionId, tabId: originalRegion.tabId })
      expect(useAppStore.getState().tabs).toEqual(beforeTabs)
    }
    expect(requests).toEqual([expect.objectContaining({ operation: 'space.ls' }), expect.objectContaining({ operation: 'focus', expectedAgentSessionId: parsed.agentSessionId })])
    expect(useAppStore.getState().sessions).toBe(state.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
  } finally { await server.stop(); await rm(root, { recursive: true }) }
}, 30_000)

it('routes an Agent link through the real Main ingress and Store without invoking lifecycle actions', async () => {
  const { state } = arrange(1)
  const ingress = new SpatialLinkIngress(), seen: string[] = [], reports: string[] = []
  let settled!: () => void
  const completed = new Promise<void>(resolve => { settled = resolve })
  ingress.receive('amux://agent/healthy%3Aview%3Aone')
  ingress.ready(async (request, signal) => {
    seen.push(request.operation)
    const result = await useAppStore.getState().executeControl(request, signal)
    if (request.operation === 'focus') settled()
    return result
  }, message => reports.push(message))
  await completed
  await new Promise(resolve => setImmediate(resolve))
  expect(seen).toEqual(['space.ls', 'focus'])
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: 'chat:view:one', regionId: 'region:view:one' })
  expect(useAppStore.getState().tabs).toEqual(state.tabs)
  expect(useAppStore.getState().sessions).toBe(state.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toContain('presentation: unknown')
})


it('reports the original Agent link unconfirmed if its occupant changes during the final persistence await', async () => {
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue({ catalog: [], warnings: [] })
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  const dispose = await useAppStore.getState().initialize()
  expect(useAppStore.getState().loading).toBe(false)
  dispose()
  const { state, catalog } = arrange(1)
  const region = catalog.regions.find(item => item.agentSessionId === 'healthy:view:one')!
  const reachedFlush = new Promise<void>(resolve => {
    vi.mocked(api.ui.requestStorageFlush).mockImplementationOnce(async () => {
      const tab = useAppStore.getState().tabs[region.tabId]!
      useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [tab.id]: { ...tab,
        regions: { ...tab.regions, [region.regionId]: { ...tab.regions[region.regionId]!, sessionId: 'later-session' } } } } })
      resolve()
    })
  })
  const result = await state.executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'flush-race', operation: 'focus',
    target: { kind: 'space', regionId: region.regionId }, inputPolicy: 'preserve', expectedAgentSessionId: 'healthy:view:one' }))
  await reachedFlush
  expect(result.operation).toBe('focus')
  if (result.operation !== 'focus') throw new Error('Expected focus')
  expect(result.navigation.state).toBe('unconfirmed')
  expect(result.navigation.expectedAgentSessionId).toBe('healthy:view:one')
  expect(result.issues.map(issue => issue.code)).toContain('AGENT_LOCATION_CHANGED')
  expect(useAppStore.getState().tabs[region.tabId]!.regions[region.regionId]).toMatchObject({ sessionId: 'later-session' })
  expect(useAppStore.getState().sessions).toBe(state.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
})
