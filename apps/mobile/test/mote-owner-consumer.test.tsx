import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, useState } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { desktopSpatialGraph } from '../../desktop/src/renderer/src/lib/desktop-spatial-state'
import { useAppStore } from '../../desktop/src/renderer/src/store'
import { api } from '../../desktop/src/renderer/src/lib/api'
import { initializeSpatialControlFixture } from '../../desktop/test/helpers/spatial-control-owner-fixture'
import { MobileAgentMenuContext, type MobileAgentMenuTarget } from '../src/navigation/MobileAgentRow'
import { MobileAgentActions } from '../src/conversation/MobileAgentActions'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '../../../packages/layout/src/index'
import type { AgentMuxSpaceCatalog, AgentMuxMotePresentation } from '../../../packages/core/src/space-control'
import { parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser'
import { rpcControlResult, parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { parseFileReadResult } from '../../../packages/core/src/public-rpc-files'
import { parseMoteQuickMode, serializeMoteQuickMode } from '../../desktop/src/shared/mote-quick-mode'
import { directoryIdentity } from '../../desktop/src/shared/space-addresses'
import { scratchTopicDirectoryName } from '../../desktop/src/shared/scratch-topics'
import { createWorkbenchTab } from '../../desktop/src/renderer/src/lib/workbench-tabs'
import { executeSpatialControl, selectSpatialCatalog, spatialCatalog } from '../../desktop/src/renderer/src/lib/space-agent-control'
import { readMotePresentation, readAgentPresentation, readSpatialAppearance } from '../../desktop/src/renderer/src/lib/mobile-presentation'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { MobileMoteProfile } from '../src/navigation/MobileMoteProfile'
import { MobileIdentity, type MobileObjectIdentity } from '../src/navigation/MobileIdentity'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
const publicBindingDirectories = new Set<string>()
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
  for (const directory of publicBindingDirectories) await rm(directory, { recursive: true, force: true })
  publicBindingDirectories.clear()
})
function publicCatalog(value: unknown): AgentMuxSpaceCatalog {
  const receipt = parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'original-read', ok: true, operation: 'space.ls', result: { catalog: value } })
  if (receipt.operation !== 'space.ls') throw new Error('The original catalog must be observed')
  return receipt.result.catalog
}
function original(alias = false) {
  const workspace = { id: '__scratch__', hostId: 'host-original', path: fixturePath("original/scratch"), name: '原资料工作区', kind: 'folder' as const }
  const topic = { id: 'launcher:mobile-original', title: '原协调 Mote', directoryPath: fixturePath("original/scratch/mote"), identityDirectoryPath: fixturePath("original/scratch/mote"), physicalDirectoryPath: fixturePath("relocated/mote"), confirmedDirectoryPaths: [fixturePath("relocated/mote")],
    topicPath: fixturePath("relocated/mote/topic.md"), summary: '原摘要', soul: { path: fixturePath("relocated/mote/SOUL.md"), content: '# 原身份', version: 'saved' }, collaborators: [] }
  const main = { hostId: 'host-original', sessionId: 'session-original', displayWorkspaceId: 'second-display', groupId: 'saved-group', tabId: 'main-tab', regionId: 'main-region' }
  const text = serializeMoteQuickMode('', { executorId: 'original-executor', recovery: 'on-open', conversation: main }) + '# 原用户笔记\n不可改写\n'
  const parsed = parseMoteQuickMode(text)
  if (parsed.status !== 'valid') throw new Error('Original parser must accept the nonempty saved tuple')
  const savedTopic = { ...topic, quickMode: { status: 'saved' as const, defaults: parsed.defaults, version: 'original-source-version' } }
  const rendererMain = alias ? 'renderer-original-alias' : 'session-original'
  const tabs = Object.fromEntries([['main', rendererMain], ['neighbor', 'other']].map(([name, sessionId]) => {
    const tab = { ...createWorkbenchTab(`${name}-tab`, { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: `${name}-region`, sessionId: sessionId! }, `${name} discussion`), topicId: topic.id }
    return [tab.id, tab]
  }))
  const sessions = [rendererMain, 'other'].map(id => ({ kind: 'agent', id, providerId: 'codex', executorId: 'original-executor', hostId: workspace.hostId,
    workspacePath: fixturePath("relocated/mote"), label: id === rendererMain ? '继续原协调工作' : '邻居工作', processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: _reshape_fixtureEpoch(0, 0, 1) }, capabilities: { timeline: 'complete-events' },
    control: { kind: 'agent', hostId: workspace.hostId, agentSessionId: id === rendererMain ? 'session-original' : id, run: { runId: id === rendererMain ? 'run-original' : `run-${id}` } } }))
  const state = { config: { version: 9, workspaces: [workspace], hosts: [{ id: workspace.hostId, kind: 'local' }], executors: {}, appearance: {} }, sessions, tabs,
    layouts: { 'first-display': createWorkspaceLayout('first-group', Object.keys(tabs)), 'second-display': createWorkspaceLayout('saved-group', Object.keys(tabs)) },
    spaceZoneBindings: {}, spatialRequests: {}, topicCategories: [], scratchTopicSnapshots: {}, agentNames: {}, timelines: {}, spaceObjectIcons: {} } as any
  const base = spatialCatalog(state, [savedTopic])
  const facts = readMotePresentation(state, base, [savedTopic])
  const catalog = publicCatalog({ ...base, motePresentation: facts, agentPresentation: readAgentPresentation(state) })
  const spaceId = directoryIdentity(workspace.hostId, topic.directoryPath)
  const fact = facts.find(value => value.spaceId === spaceId)!
  const identity: MobileObjectIdentity = { name: topic.title, project: '原项目', mote: { spaceId, name: topic.title, conversationName: sessions[0]!.label, facts: fact } }
  return { state, workspace, topic: savedTopic, text, main, base, catalog, spaceId, fact, identity }
}
function clientFor(value: ReturnType<typeof original>) {
  const f = fixture()
  const read = vi.fn().mockImplementation(async (_resource, path: string) => ({ status: 'read', document: { path, content: path.endsWith('MOTE.md') ? value.text : '# 原合作方式\n先保留原讨论。', revision: 'sha256:' + 'a'.repeat(64) } }))
  const owner = new FileReadOwner({ catalog: async () => value.catalog, workspace: id => id === value.workspace.id ? value.workspace as any : undefined,
    topicForDirectory: async (_workspace, directory) => directory === value.topic.physicalDirectoryPath ? value.topic : null,
    files: { read, listFiles: vi.fn() } })
  const rpc = vi.fn().mockImplementation(async (method: string, params: any) => {
    if (method === 'file.read') return parseFileReadResult(await owner.read(params), params)
    if (method === 'app.snapshot') return { agents: [] }
    if (method === 'agent.inspect') return { routeHostId: 'host-original', session: f.client.agentSession(params.target.agentSessionId), displayName: { override: null, availability: 'observed' } }
    const result = { operation: 'space.ls' as const, catalog: publicCatalog(selectSpatialCatalog(value.catalog, params.target ?? {})) }
    return parseRpcControlResult('space.ls', rpcControlResult('space.ls', result), params)
  })
  f.client.forwardRpc = rpc
  return { ...f, rpc, read }
}

async function publicMissingSnapshot(mismatch?: 'SID' | 'Host' | 'alias' | 'Tab' | 'multiple aliases' | 'multiple Hosts') {
  const value = original(true), previous = useAppStore.getState(), directory = await mkdtemp(join(tmpdir(), 'mobile-public-binding-'))
  publicBindingDirectories.add(directory)
  const store = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  if (mismatch === 'multiple aliases' || mismatch === 'multiple Hosts') {
    value.state.sessions = [value.state.sessions[0], { ...value.state.sessions[0], id: 'neighbor-renderer-alias',
      ...(mismatch === 'multiple Hosts' ? { hostId: 'another-host', control: { ...value.state.sessions[0].control, hostId: 'another-host' } } : {}) }]
    const tab = value.state.tabs['neighbor-tab']
    value.state.tabs = { ...value.state.tabs, [tab.id]: { ...tab, regions: { ...tab.regions,
      'neighbor-region': { ...tab.regions['neighbor-region'], sessionId: 'neighbor-renderer-alias' } } } }
  }
  const graph = desktopSpatialGraph(value.state, [value.topic])
  if (mismatch === 'multiple Hosts') {
    const data = graph.resources['region:neighbor-region'] as { agentPresentation: { sessionId: string } }
    data.agentPresentation.sessionId = 'renderer-original-alias'
    const tab = value.state.tabs['neighbor-tab']
    value.state.tabs = { ...value.state.tabs, [tab.id]: { ...tab, regions: { ...tab.regions,
      'neighbor-region': { ...tab.regions['neighbor-region'], sessionId: 'renderer-original-alias' } } } }
  }
  if (mismatch === 'SID' || mismatch === 'Host') {
    const data = graph.resources['region:main-region'] as { agentPresentation: { agentSessionId: string; hostId: string } }
    if (mismatch === 'SID') data.agentPresentation.agentSessionId = 'another-core-session'
    else data.agentPresentation.hostId = 'another-host'
  }
  await store.commit({ expectedRevision: 0, graph })
  vi.spyOn(api.spatial, 'read').mockImplementation(() => store.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => store.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => store.subscribe(listener))
  useAppStore.setState({ ...value.state, sessions: [], timelines: {}, agentComposerDrafts: { 'renderer-original-alias': 'Original unsent alias draft' } })
  await initializeSpatialControlFixture([value.topic])
  if (mismatch === 'alias' || mismatch === 'Tab') {
    const state = useAppStore.getState(), tab = state.tabs['main-tab']!
    if (mismatch === 'alias') useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: { ...tab, regions: {
      ...tab.regions, 'main-region': { ...tab.regions['main-region']!, sessionId: 'another-renderer-alias' } as any
    } } } })
    else {
      const { [tab.id]: _, ...tabs } = state.tabs, id = 'replacement-tab'
      useAppStore.setState({ tabs: { ...tabs, [id]: { ...tab, id } }, layouts: Object.fromEntries(Object.entries(state.layouts).map(([key]) =>
        [key, createWorkspaceLayout(key === 'first-display' ? 'first-group' : 'saved-group', [id, 'neighbor-tab'])])) })
    }
  }
  const f = fixture(), metadataRead = vi.fn(async (id: string) => f.client.agentSession(id))
  const service = new AgentMuxRpcService({ spatialState: store, execute: request => useAppStore.getState().executeControl(request), coreClients: () => [{
    hostId: 'host-original', client: { runtimeOwnerIdentity: () => ({ availability: 'connected' }),
      agentSession: (id: string) => f.client.agentSession(id), readAgentSession: metadataRead,
      statusAgent: async () => { throw new Error('Run status is not observed by this metadata fixture.') }
    } as any
  }] })
  const calls: Array<{ method: string; params: any }> = []
  f.client.forwardRpc = (async (method: string, params: any) => { calls.push({ method, params }); return await service.call(method as any, params) }) as any
  return { ...value, ...f, service, store, calls, metadataRead, async cleanup() {
    await service.dispose(); useAppStore.setState(previous, true); await rm(directory, { recursive: true, force: true }); publicBindingDirectories.delete(directory)
  } }
}

it('actual Service and Desktop Store preserve the canonical missing-observation binding through Mobile membership and menu inspection', async () => {
  const f = await publicMissingSnapshot(), open = vi.fn()
  try {
    expect(useAppStore.getState().sessions).toEqual([])
    const report = await f.service.call('space.ls', { target: {}, presentation: true })
    expect(report.catalog.regions.find(region => region.regionId === 'main-region')).toMatchObject({
      agentSessionId: 'session-original', runId: 'run-original', execution: { hostId: 'host-original', cwd: fixturePath('relocated/mote') }
    })
    expect(report.catalog.locations).toEqual(expect.arrayContaining([expect.objectContaining({
      tabId: f.main.tabId, regionId: f.main.regionId, displayWorkspaceId: f.main.displayWorkspaceId, groupId: f.main.groupId
    })]))
    function Scene() {
      const [menu, setMenu] = useState<MobileAgentMenuTarget | null>(null)
      return <MobileAgentMenuContext.Provider value={setMenu}>
        <MobileSpatialNavigation home="mote" client={f.client} connected sessions={[]} openSession={open} />
        {menu && <MobileAgentActions client={f.client} agentSessionId={menu.agentSessionId} connected copyText={vi.fn()} />}
      </MobileAgentMenuContext.Provider>
    }
    const view = await mount(<Scene />)
    await click(button(view.element, `选择 Mote · ${f.topic.title}`))
    const row = view.element.querySelector<HTMLElement>('.mobile-mote-agents .mobile-agent-row')!
    expect(row).not.toBeNull()
    await click(row.querySelector('.mobile-agent-row__open')!)
    expect(open).toHaveBeenCalledWith('session-original', expect.anything())
    await click(row.querySelector('.mobile-session-locations summary')!)
    await click([...row.querySelectorAll<HTMLButtonElement>('.mobile-session-locations button')].find(item => item.textContent?.includes('second-display'))!)
    expect(open).toHaveBeenCalledWith('session-original', expect.objectContaining({ context: expect.objectContaining({
      tabId: 'main-tab', regionId: 'main-region', displayWorkspaceId: 'second-display', groupId: 'saved-group'
    }) }))
    await click(row.querySelector('.mobile-agent-row__more')!)
    expect(view.element.querySelector('[aria-label="Agent 消耗"]')).not.toBeNull()
    await act(async () => await vi.waitFor(() => expect(f.metadataRead).toHaveBeenCalledExactlyOnceWith('session-original')))
    expect(f.calls.filter(call => call.method === 'agent.inspect')).toEqual([{ method: 'agent.inspect', params: {
      target: { kind: 'agent-session', agentSessionId: 'session-original' }
    } }])
    expect(f.calls.some(call => call.method === 'agent.open')).toBe(false)
    expect(useAppStore.getState().sessions).toEqual([])
    expect(useAppStore.getState().tabs['main-tab']!.regions['main-region']).toHaveProperty('sessionId', 'renderer-original-alias')
  } finally { await f.cleanup() }
})

it.each(['SID', 'Host', 'alias', 'Tab'] as const)('actual Service keeps an unconfirmed %s descriptor visible without publishing an alias as Core identity', async mismatch => {
  const f = await publicMissingSnapshot(mismatch)
  try {
    const before = useAppStore.getState().tabs, report = await f.service.call('space.ls', { target: {}, presentation: true })
    const region = report.catalog.regions.find(region => region.regionId === 'main-region')!
    expect(region.kind).toBe('agent'); expect(region.agentSessionId).toBeNull()
    expect(report.catalog.tabs.find(tab => tab.tabId === region.tabId)?.issue).toContain('original Agent binding is unconfirmed')
    expect(report.catalog.locations.some(place => place.regionId === 'main-region')).toBe(true)
    expect(useAppStore.getState().tabs).toBe(before)
    expect(f.metadataRead).not.toHaveBeenCalled()
  } finally { await f.cleanup() }
})

it('actual Service Agent view reads and writes the original saved alias while Runtime membership is absent', async () => {
  const f = await publicMissingSnapshot()
  try {
    const before = useAppStore.getState(), read = await f.service.call('agent.view', { agentSessionId: 'session-original' })
    expect(read).toMatchObject({ sessionFacts: 'unconfirmed', outcome: 'read', effectiveMode: 'terminal' })
    const changed = await f.service.call('agent.view', { agentSessionId: 'session-original', mode: 'activity' })
    expect(changed).toMatchObject({ sessionFacts: 'unconfirmed', effectiveMode: 'activity', storedOverride: 'activity', changed: true })
    expect(useAppStore.getState().viewModes['renderer-original-alias']).toBe('activity')
    expect(useAppStore.getState().viewModes['session-original']).toBeUndefined()
    expect(await f.service.call('agent.view', { agentSessionId: 'session-original' })).toMatchObject({ outcome: 'read', effectiveMode: 'activity' })
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().sessions).toEqual([]); expect(f.metadataRead).not.toHaveBeenCalled()
  } finally { await f.cleanup() }
})

it.each(['multiple aliases', 'multiple Hosts'] as const)('actual Service Agent view retains %s as unknown rather than choosing its first saved key', async mismatch => {
  const f = await publicMissingSnapshot(mismatch)
  try {
    const before = useAppStore.getState(), result = await f.service.call('agent.view', { agentSessionId: 'session-original', mode: 'activity' })
    expect(result).toMatchObject({ outcome: 'unknown', changed: false, save: null })
    expect(useAppStore.getState().viewModes).toBe(before.viewModes)
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().sessions).toEqual([])
  } finally { await f.cleanup() }
})

describe('original Mote owner → typed catalog → Mobile consumers', () => {
  it('selects the saved second occurrence among two Sessions without borrowing the first tuple', async () => {
    const value = original(), f = clientFor(value), open = vi.fn()
    expect(value.catalog.locations.filter(place => place.regionId === value.main.regionId)).toHaveLength(2)
    expect(value.fact.conversation).toEqual(value.main)
    expect(value.fact.content).toEqual({ zoneId: value.catalog.zones.find(zone => zone.directoryPath === fixturePath("relocated/mote"))!.zoneId,
      hostId: value.workspace.hostId, workspaceId: value.workspace.id, workspacePath: value.workspace.path })
    const view = await mount(<MobileSpatialNavigation home="mote" client={f.client} connected sessions={f.client.agentSessions()} openSession={open} />)
    await click(button(view.element, `选择 Mote · ${value.topic.title}`))
    expect(open).not.toHaveBeenCalled()
    await click(button(view.element, `继续主对话 · ${value.topic.title}`))
    expect(open).toHaveBeenCalledExactlyOnceWith(value.main.sessionId, expect.objectContaining({ mote: expect.objectContaining({ spaceId: value.spaceId }),
      context: expect.objectContaining({ displayWorkspaceId: 'second-display', groupId: 'saved-group', tabId: 'main-tab', regionId: 'main-region' }) }))
    expect(f.rpc.mock.calls.every(([method]) => method === 'space.ls')).toBe(true)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('keeps original Core SID and full occurrence when the renderer alias differs, including Focus and avatar activities', async () => {
    const value = original(true), f = clientFor(value), open = vi.fn()
    expect(value.catalog.regions.find(region => region.regionId === value.main.regionId)?.agentSessionId).toBe('session-original')
    expect(value.fact.conversation).toEqual(value.main)
    expect(value.catalog.agentPresentation?.map(row => row.agentSessionId)).toContain('session-original')
    const appearance = await readSpatialAppearance(value.state, value.base, undefined, [value.topic], vi.fn())
    expect(appearance.find(fact => fact.spaceId === value.spaceId)?.activities?.map(activity => activity.agentSessionId)).toContain('session-original')
    const view = await mount(<MobileSpatialNavigation home="mote" client={f.client} connected sessions={f.client.agentSessions()} openSession={open} />)
    await click(button(view.element, `选择 Mote · ${value.topic.title}`))
    await click(button(view.element, `继续主对话 · ${value.topic.title}`))
    expect(open).toHaveBeenCalledWith('session-original', expect.objectContaining({ context: expect.objectContaining({ displayWorkspaceId: 'second-display', groupId: 'saved-group' }) }))
    await view.render(<MobileSpatialNavigation home="focus" client={f.client} connected sessions={f.client.agentSessions()} openSession={open} />)
    const main = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-list button')].find(item => item.textContent?.includes('继续原协调工作'))
    expect(main).toBeDefined(); await click(main!)
    expect(open).toHaveBeenLastCalledWith('session-original', expect.objectContaining({ name: '继续原协调工作' }))
    expect(f.submit).not.toHaveBeenCalled()
  })

  it.each([false, true])('closes the real App slice with original Profile/file owner and returns to the same editable draft (renderer alias=%s)', async alias => {
    localStorage.setItem('agentmux-mobile-home', 'mote')
    const value = original(alias), f = clientFor(value), overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '原 Mac' }} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Mote'))
    await click(button(view.element, `选择 Mote · ${value.topic.title}`))
    await click(button(view.element, `继续主对话 · ${value.topic.title}`))
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    const input = editor(view.element); await paste(view.element, '保留未发送原草稿')
    await click(view.element.querySelector<HTMLButtonElement>('.mobile-mote-heading')!)
    expect(overlay.querySelector('.mobile-mote-profile__defaults')?.textContent).toContain('继续原协调工作')
    expect(f.read).not.toHaveBeenCalled()
    await click(button(overlay, '合作方式 · BEHAVIOR.md'))
    expect(overlay.textContent).toContain('先保留原讨论')
    expect(f.rpc).toHaveBeenCalledWith('file.read', { zoneId: value.fact.content!.zoneId, spaceId: value.spaceId, path: 'BEHAVIOR.md',
      expectedResource: { hostId: value.workspace.hostId, workspaceId: value.workspace.id, workspacePath: value.workspace.path } })
    expect(f.read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ hostId: 'host-original', path: fixturePath("original/scratch") }), `${scratchTopicDirectoryName(value.topic.id)}/BEHAVIOR.md`, undefined)
    await click(button(overlay, '返回资料')); await click(button(overlay, '关闭面板'))
    expect(editor(view.element)).toBe(input); expect(input.textContent).toContain('保留未发送原草稿')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })

  it('preserves an invalid saved original reference and leaves healthy exact manual choices available', async () => {
    const value = original(), bad = { ...value.topic, quickMode: { ...value.topic.quickMode, defaults: { ...value.topic.quickMode.defaults,
      conversation: { ...value.main, groupId: 'missing-group' } } } }
    const facts = readMotePresentation(value.state, value.base, [bad])
    expect(facts[0]?.quickMode).toEqual(bad.quickMode); expect(facts[0]?.conversation).toBeNull(); expect(facts[0]?.issue).toContain('kept')
    value.catalog = publicCatalog({ ...value.catalog, motePresentation: facts })
    const f = clientFor(value), open = vi.fn(), profile = vi.fn()
    const view = await mount(<MobileSpatialNavigation home="mote" client={f.client} connected sessions={f.client.agentSessions()} openSession={open} openProfile={profile} />)
    await click(button(view.element, `选择 Mote · ${value.topic.title}`))
    expect(open).not.toHaveBeenCalled(); expect(view.element.textContent).toContain('not confirmed at its original location')
    await click(button(view.element, `查看 Mote 资料 · ${value.topic.title}`)); expect(profile).toHaveBeenCalledOnce()
    const mainRows = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-mote-agents .mobile-agent-row__open')].filter(item => item.textContent?.includes('继续原协调工作'))
    expect(mainRows).toHaveLength(1)
    const places = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-locations button')]
    const originalPlace = places.find(item => item.textContent?.includes('second-display'))!
    expect(originalPlace).toBeDefined(); await click(originalPlace)
    expect(open).toHaveBeenCalledWith('session-original', expect.objectContaining({ context: expect.objectContaining({ displayWorkspaceId: 'second-display', groupId: 'saved-group' }) }))
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('keeps the saved main entry on Mote selection without a confirmed occurrence, preserving the exact Host and SID', async () => {
    const value = original(true), f = clientFor(value), open = vi.fn(), main = vi.fn()
    value.catalog = publicCatalog({ ...value.catalog, motePresentation: [{ ...value.fact, conversation: null }] })
    const view = await mount(<MobileSpatialNavigation home="mote" client={f.client} connected sessions={[]} openSession={open} openMainAgent={main} />)
    await click(button(view.element, `选择 Mote · ${value.topic.title}`))
    expect(view.element.querySelector('.mobile-space-children')).toBeNull()
    expect(button(view.element, `继续主对话 · ${value.topic.title}`)).toBeDefined()
    expect(main).not.toHaveBeenCalled()
    await click(button(view.element, `继续主对话 · ${value.topic.title}`))
    expect(main).toHaveBeenCalledExactlyOnceWith('session-original', expect.objectContaining({ mote: expect.objectContaining({ spaceId: value.spaceId }) }), 'host-original')
    expect(main.mock.calls[0]![1].context).toBeUndefined()
    expect(open).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
  })

  it.each(['missing', 'unconfirmed'] as const)('keeps Profile and Agents with a fixed setup entry while default is %s, hiding file and Launcher Tabs', async status => {
    const value = original(), f = clientFor(value), profile = vi.fn(), main = vi.fn(), create = vi.fn()
    const extra = createWorkbenchTab('file-only-tab', { kind: 'file', regionId: 'file-only-region', workspaceId: value.workspace.id, path: 'SOUL.md' })
    value.state.tabs[extra.id] = { ...extra, topicId: value.topic.id }
    const topic = { ...value.topic, quickMode: status === 'missing' ? { status: 'missing' as const } : { status: 'unconfirmed' as const, message: '原配置暂未确认' } }
    const base = spatialCatalog(value.state, [topic])
    value.catalog = publicCatalog({ ...base, agentPresentation: readAgentPresentation(value.state), motePresentation: readMotePresentation(value.state, base, [topic]) })
    const view = await mount(<MobileSpatialNavigation home="mote" client={f.client} connected sessions={[]} openSession={vi.fn()} openMainAgent={main} openProfile={profile} onCreateAgent={create} />)
    await click(button(view.element, `选择 Mote · ${value.topic.title}`))
    await click(button(view.element, `${status === 'missing' ? '设置主 Agent' : '核对主 Agent'} · ${value.topic.title}`))
    expect(profile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mote: expect.objectContaining({ spaceId: value.spaceId }) }))
    expect(view.element.querySelector('.mobile-mote-selected')?.textContent).toContain('Profile')
    expect(view.element.querySelector('.mobile-mote-selected')?.textContent).toContain('Agents')
    expect(view.element.querySelector('.mobile-mote-selected')?.textContent).not.toContain('SOUL.md')
    expect(view.element.querySelector('.mobile-spatial-tab')).toBeNull()
    expect(view.element.querySelectorAll('.mobile-mote-agents .mobile-agent-row__open')).toHaveLength(2)
    expect([...view.element.querySelectorAll('.mobile-mote-agents .mobile-agent-row__open strong')].map(row => row.textContent)).toEqual(['继续原协调工作', '邻居工作'])
    expect(main).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
    await click(button(view.element, `在 ${value.topic.title} 新建 Agent`))
    expect(create).toHaveBeenCalledExactlyOnceWith({ spaceId: value.spaceId, zoneId: value.fact.content!.zoneId })
    expect(f.rpc.mock.calls.every(([method]) => method === 'space.ls')).toBe(true); expect(f.submit).not.toHaveBeenCalled()
  })

  it('closes the actual App main-entry click through the same retained manual recovery without starting during directory reads', async () => {
    localStorage.setItem('agentmux-mobile-home', 'mote')
    const value = original(), f = clientFor(value)
    const recover = vi.fn(async (input: any) => ({ kind: 'reattachable', agentSessionId: input.agentSessionId, previousRun: input.expectedRun }))
    f.client.ensureAgentContinuity = recover as never
    const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '原 Mac' }} platform={createBrowserPlatform()} />)
    expect(recover).not.toHaveBeenCalled()
    await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Mote'))
    await click(button(view.element, `选择 Mote · ${value.topic.title}`))
    expect(recover).not.toHaveBeenCalled()
    await click(button(view.element, `继续主对话 · ${value.topic.title}`))
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, trigger: 'manual' }))
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(getDeviceWorkface().snapshot().record.agentResumes?.at(-1)).toMatchObject({ phase: 'confirmed', hostId: 'host-original' })
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('uses the public port, filters unrelated facts, and retains the catalog on an owner observation failure', async () => {
    const value = original(), producer = vi.fn((catalog, topics) => readMotePresentation(value.state, catalog, topics))
    const result = await executeSpatialControl({ get: () => value.state, topics: async () => [value.topic], motePresentation: producer } as any,
      { schemaVersion: 5, requestId: 'producer-read', operation: 'space.ls', target: { spaceId: value.spaceId }, presentation: true })
    expect(producer).toHaveBeenCalledOnce()
    if (result.operation !== 'space.ls') throw new Error('Actual public operation required')
    expect(result.catalog.motePresentation).toHaveLength(1); expect(publicCatalog(result.catalog).motePresentation?.[0]?.conversation).toEqual(value.main)
    const other = { ...value.catalog.spaces.find(space => space.spaceId === value.spaceId)!, spaceId: 'unrelated-mote' }
    const filtered = selectSpatialCatalog({ ...value.catalog, spaces: [...value.catalog.spaces, other], motePresentation: [...value.catalog.motePresentation!, { ...value.fact, spaceId: other.spaceId }] }, { spaceId: value.spaceId })
    expect(filtered.motePresentation?.map(fact => fact.spaceId)).toEqual([value.spaceId])
    const failed = await executeSpatialControl({ get: () => value.state, topics: async () => [value.topic], motePresentation: () => { throw new Error('original owner probe unavailable') } } as any,
      { schemaVersion: 5, requestId: 'producer-failure', operation: 'space.ls', target: { spaceId: value.spaceId }, presentation: true })
    if (failed.operation !== 'space.ls') throw new Error('Actual public operation required')
    expect(failed.catalog.regions.length).toBeGreaterThan(0); expect(failed.catalog.motePresentation?.[0]?.issue).toContain('probe unavailable')
    expect(publicCatalog(failed.catalog).motePresentation?.[0]?.quickMode.status).toBe('unconfirmed')
  })

  it('rejects malformed public tuples and keeps missing/unconfirmed statuses distinct', () => {
    const value = original()
    for (const change of [
      { ...value.fact, conversation: { sessionId: 'session-original' } },
      { ...value.fact, content: { ...value.fact.content, hostId: undefined } },
      { ...value.fact, content: { ...value.fact.content, zoneId: 'unrelated-content-zone' } },
      { ...value.fact, conversation: { ...value.main, groupId: 'another-group' } },
      { ...value.fact, spaceId: 'unknown-mote' },
      { ...value.fact, quickMode: { status: 'missing', defaults: {} } }
    ]) expect(() => publicCatalog({ ...value.catalog, motePresentation: [change] })).toThrow()
    for (const quickMode of [{ status: 'missing' }, { status: 'unconfirmed', message: '原配置未知' }]) {
      const next = publicCatalog({ ...value.catalog, motePresentation: [{ ...value.fact, quickMode, conversation: null }] })
      expect(next.motePresentation?.[0]?.quickMode).toEqual(quickMode)
    }
  })
})

describe('bounded readonly Profile and original avatar cost', () => {
  it('keeps a failed metadata query as a folded historical diagnostic after explicit file recovery, without confirming configuration or retrying it', async () => {
    const value = original(), f = clientFor(value), base = f.rpc.getMockImplementation()!
    let metadataAvailable = false, fileAvailable = false
    const oldError = '原 Host 连接中断：上次资料查询失败的完整诊断'
    f.rpc.mockImplementation((method, params) => {
      if (method === 'space.ls' && !metadataAvailable) return Promise.reject(new Error(oldError))
      if (method === 'file.read' && !fileAvailable) return Promise.resolve({ resource: null, result: { status: 'unknown', code: 'UNAVAILABLE', message: '正文暂未读回' } })
      return base(method, params)
    })
    const identity: MobileObjectIdentity = { name: value.identity.name, project: value.identity.project,
      mote: { spaceId: value.spaceId, contentReference: value.fact.content } }
    const renderProfile = (sourcePath: string | null) => <MobileMoteProfile identity={identity} client={f.client} sourcePath={sourcePath} />
    const view = await mount(renderProfile('BEHAVIOR.md'))
    const queries = () => f.rpc.mock.calls.filter(([method]) => method === 'space.ls').length
    const reads = () => f.rpc.mock.calls.filter(([method]) => method === 'file.read').length
    const statuses = () => [...view.element.querySelectorAll('[role="status"]')].map(node => node.textContent).join('\n')
    expect(view.element.textContent).not.toContain('先保留原讨论')
    expect(statuses()).toContain('正文待重新读取')
    expect(statuses()).not.toContain('上次确认内容')
    expect(queries()).toBe(1); expect(reads()).toBe(1)
    metadataAvailable = true; fileAvailable = true
    await click(button(view.element, '刷新原文件'))
    expect(view.element.textContent).toContain('先保留原讨论')
    expect(statuses()).toContain('原配置查询尚未重新核实')
    expect(statuses()).not.toContain('原 Host 连接中断')
    const diagnostic = [...view.element.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === '上次资料查询诊断')!
    expect(diagnostic.open).toBe(false); expect(diagnostic.textContent).toContain(oldError)
    expect(queries()).toBe(1); expect(reads()).toBe(2)
    await view.render(renderProfile('BEHAVIOR.md'))
    expect(queries()).toBe(1); expect(reads()).toBe(2)
    await view.render(renderProfile(null))
    expect(view.element.querySelector('dl')?.textContent).toContain('原配置未确认')
    await click(button(view.element, '刷新原资料'))
    expect(view.element.textContent).not.toContain(oldError)
    expect(view.element.textContent).not.toContain('原配置查询尚未重新核实')
    expect(view.element.querySelector('dl')?.textContent).toContain('original-executor')
    expect(queries()).toBe(2); expect(reads()).toBe(2)
  })

  it('restores a controlled source once, navigates through the callback before reading, and does not register back on unrelated renders', async () => {
    const value = original(), f = clientFor(value), back = vi.fn(), change = vi.fn()
    const renderProfile = (sourcePath: string | null) => <MobileMoteProfile identity={value.identity} client={f.client} sourcePath={sourcePath} onSourceChange={change} onBackChange={back} />
    const view = await mount(renderProfile('BEHAVIOR.md'))
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(view.element.textContent).toContain('先保留原讨论')
    const sourceBack = back.mock.calls.at(-1)![0], registrations = back.mock.calls.length
    await view.render(renderProfile('BEHAVIOR.md'))
    expect(f.read).toHaveBeenCalledTimes(1); expect(back.mock.calls).toHaveLength(registrations)
    await act(async () => sourceBack())
    expect(change).toHaveBeenLastCalledWith(null)
    await view.render(renderProfile(null))
    expect(back).toHaveBeenLastCalledWith(null)
    await click(button(view.element, 'MOTE.md'))
    expect(change).toHaveBeenLastCalledWith('MOTE.md'); expect(f.read).toHaveBeenCalledTimes(1)
    await view.render(renderProfile('MOTE.md'))
    expect(f.read).toHaveBeenCalledTimes(2)
    await click(button(view.element, '刷新原文件'))
    expect(f.read).toHaveBeenCalledTimes(3)
  })

  it('cancels a restored source when the controlled route leaves and retains confirmed cache after an unknown reopen', async () => {
    const value = original(), f = clientFor(value), back = vi.fn(), change = vi.fn(), late = deferred<any>()
    const base = f.rpc.getMockImplementation()!
    const renderProfile = (sourcePath: string | null) => <MobileMoteProfile identity={value.identity} client={f.client} sourcePath={sourcePath} onSourceChange={change} onBackChange={back} />
    const view = await mount(renderProfile('BEHAVIOR.md'))
    f.rpc.mockImplementation((method, params) => method === 'file.read' && params.path === 'MOTE.md' ? late.promise : base(method, params))
    await view.render(renderProfile('MOTE.md')); await view.render(renderProfile(null))
    await act(async () => late.resolve({ resource: null, result: { status: 'read', document: { path: 'late', content: '受控路由离开后的迟到内容', revision: 'old' } } }))
    f.rpc.mockImplementation((method, params) => method === 'file.read' ? Promise.resolve({ resource: null, result: { status: 'unknown', code: 'UNAVAILABLE', message: '原来源暂不可读' } }) : base(method, params))
    await view.render(renderProfile('BEHAVIOR.md'))
    expect(view.element.textContent).toContain('先保留原讨论'); expect(view.element.textContent).toContain('原来源暂不可读')
    expect(view.element.textContent).not.toContain('受控路由离开后的迟到内容')
    const calls = f.rpc.mock.calls.filter(([method]) => method === 'file.read').length
    await view.render(renderProfile('BEHAVIOR.md'))
    expect(f.rpc.mock.calls.filter(([method]) => method === 'file.read')).toHaveLength(calls)
  })

  it('pins the persisted content reference on restore even when newly observed facts name another resource', async () => {
    const value = original(), f = clientFor(value)
    const changed = { ...value.fact, content: { ...value.fact.content!, workspacePath: fixturePath("other/resource") } }
    const identity = { ...value.identity, mote: { ...value.identity.mote!, contentReference: value.fact.content, facts: changed } }
    const base = f.rpc.getMockImplementation()!
    f.rpc.mockImplementation((method, params) => method === 'space.ls' ? Promise.resolve({ catalog: { ...value.catalog, motePresentation: [changed] } }) : base(method, params))
    const view = await mount(<MobileMoteProfile identity={identity} client={f.client} sourcePath="BEHAVIOR.md" />)
    expect(view.element.textContent).toContain('映射已改变')
    expect(view.element.textContent).toContain('先保留原讨论')
    expect(f.rpc).toHaveBeenCalledWith('file.read', { spaceId: value.spaceId, zoneId: value.fact.content!.zoneId, path: 'BEHAVIOR.md',
      expectedResource: { hostId: 'host-original', workspaceId: '__scratch__', workspacePath: fixturePath("original/scratch") } })
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('reports a stable directory back action while preserving search and ignoring hidden navigation renders', async () => {
    const value = original(), f = clientFor(value), back = vi.fn(), open = vi.fn()
    const originalSpace = value.catalog.spaces.find(space => space.spaceId === value.spaceId)!
    const folder = { ...originalSpace, kind: 'folder' as const, name: '原资料目录' }
    const base = f.rpc.getMockImplementation()!
    f.rpc.mockImplementation((method, params) => method === 'space.ls' ? Promise.resolve({ catalog: { ...value.catalog, spaces: [folder] } }) : base(method, params))
    const renderNavigation = (visible = true) => <MobileSpatialNavigation home="space" client={f.client} connected visible={visible} sessions={f.client.agentSessions()} openSession={open} onBackChange={back} />
    const view = await mount(renderNavigation())
    expect(back).toHaveBeenLastCalledWith(null)
    await click([...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-list button')].find(item => item.textContent?.includes(folder.name))!)
    const directoryBack = back.mock.calls.at(-1)![0], registrations = back.mock.calls.length
    const input = view.element.querySelector<HTMLInputElement>('[aria-label="查找"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '原资料'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await view.render(renderNavigation())
    expect(back.mock.calls).toHaveLength(registrations)
    await act(async () => directoryBack())
    expect(back).toHaveBeenLastCalledWith(null); expect(input.value).toBe('原资料')
    expect(view.element.querySelector('.mobile-spatial-tab')).toBeNull()
    await view.render(renderNavigation(false)); const hiddenRegistrations = back.mock.calls.length
    await view.render(renderNavigation(false))
    expect(back.mock.calls).toHaveLength(hiddenRegistrations); expect(open).not.toHaveBeenCalled()
  })

  it('ignores late source/back reads, retains confirmed text on unknown, and refuses a different resource mapping', async () => {
    const value = original(), f = clientFor(value), late = deferred<any>()
    const back = vi.fn(), base = f.rpc.getMockImplementation()!
    f.rpc.mockImplementation((method, params) => method === 'file.read' && params.path === 'MOTE.md' ? late.promise : base(method, params))
    const view = await mount(<MobileMoteProfile identity={value.identity} client={f.client} onBackChange={back} />)
    expect(f.read).not.toHaveBeenCalled()
    await click(button(view.element, 'MOTE.md'))
    const sourceBack = back.mock.calls.at(-1)![0]; expect(sourceBack).toBeTypeOf('function')
    await act(async () => sourceBack())
    await click(button(view.element, '合作方式 · BEHAVIOR.md'))
    expect(view.element.textContent).toContain('先保留原讨论')
    await act(async () => late.resolve({ resource: null, result: { status: 'read', document: { path: 'wrong-late-MOTE.md', content: '迟到旧资料不可覆盖', revision: 'old' } } }))
    expect(view.element.textContent).not.toContain('迟到旧资料不可覆盖')
    f.rpc.mockResolvedValueOnce({ resource: null, result: { status: 'unknown', code: 'UNAVAILABLE', message: 'original file temporarily unavailable' } })
    await click(button(view.element, '刷新原文件'))
    expect(view.element.textContent).toContain('先保留原讨论'); expect(view.element.textContent).toContain('temporarily unavailable')
    await click(button(view.element, '返回资料'))
    const changed: AgentMuxMotePresentation = { ...value.fact, content: { ...value.fact.content!, workspacePath: fixturePath("other/resource") } }
    f.rpc.mockResolvedValueOnce({ catalog: { ...value.catalog, motePresentation: [changed] } })
    await click(button(view.element, '刷新原资料'))
    expect(view.element.textContent).toContain('映射已改变')
    await click(button(view.element, '合作方式 · BEHAVIOR.md'))
    expect(f.rpc).toHaveBeenLastCalledWith('file.read', expect.objectContaining({ expectedResource: { hostId: 'host-original', workspaceId: '__scratch__', workspacePath: fixturePath("original/scratch") } }))
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('reads avatar bytes once per original revision and no bytes for unrelated or hidden activity', async () => {
    const value = original(), f = fixture(), appearance = { spaceId: value.spaceId, image: { dataUrl: null, revision: 'original.png' },
      activities: [{ agentSessionId: 'session-original', runId: 'run-original', expression: 'thinking' }] }
    let revision = appearance.image.revision
    f.client.forwardRpc = vi.fn().mockImplementation(async method => ({ catalog: { ...value.catalog, appearance: [{ ...appearance,
      image: { revision, dataUrl: method === 'space.inspect' ? 'data:image/png;base64,AAAA' : null } }] } }))
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 32, height: 32 }] as unknown as DOMRectList)
    const identity = { ...value.identity, mote: { ...value.identity.mote!, appearance } }
    const view = await mount(<MobileIdentity identity={identity} session={f.client.agentSession('session-original')} client={f.client} connected />)
    expect(view.element.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    const bytes = () => (f.client.forwardRpc as any).mock.calls.filter(([method]: [string]) => method === 'space.inspect').length
    expect(bytes()).toBe(1)
    await act(async () => f.emit({ type: 'agent-timeline', agentSessionId: 'other', revision: 2 } as any))
    expect((f.client.forwardRpc as any).mock.calls).toHaveLength(2)
    await act(async () => f.emit({ type: 'agent-timeline', agentSessionId: 'session-original', revision: 2 } as any))
    expect(bytes()).toBe(1)
    revision = 'new-original.png'
    await act(async () => f.emit({ type: 'agent-timeline', agentSessionId: 'session-original', revision: 3 } as any))
    expect(bytes()).toBe(2)
    revision = 'temporarily-unavailable.png'
    const originalRpc = (f.client.forwardRpc as any).getMockImplementation()
    ;(f.client.forwardRpc as any).mockImplementation(async (method: string, ...args: any[]) => {
      if (method === 'space.inspect') throw new Error('original avatar bytes temporarily unavailable')
      return originalRpc(method, ...args)
    })
    await act(async () => f.emit({ type: 'agent-timeline', agentSessionId: 'session-original', revision: 4 } as any))
    expect(bytes()).toBe(3)
    expect(view.element.querySelector('.mobile-avatar-issue')).not.toBeNull()
    await act(async () => f.emit({ type: 'agent-timeline', agentSessionId: 'session-original', revision: 5 } as any))
    expect(bytes()).toBe(3)
    expect(view.element.querySelector('.mobile-avatar-issue')?.getAttribute('aria-label')).toContain('temporarily unavailable')
    const callsBeforeHide = (f.client.forwardRpc as any).mock.calls.length
    const releasesBeforeHide = f.unsubscribe.mock.calls.length
    await view.render(<MobileIdentity identity={identity} session={f.client.agentSession('session-original')} client={f.client} connected visible={false} />)
    expect(f.unsubscribe.mock.calls.length).toBe(releasesBeforeHide + 1)
    await act(async () => f.emit({ type: 'agent-timeline', agentSessionId: 'session-original', revision: 6 } as any))
    expect((f.client.forwardRpc as any).mock.calls).toHaveLength(callsBeforeHide)
    expect(view.element.querySelector('[data-mote-motion]')?.getAttribute('data-mote-motion')).toBe('off')
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => f.emit({ type: 'agent-timeline', agentSessionId: 'session-original', revision: 6 } as any))
    expect(bytes()).toBe(3)
    expect(f.submit).not.toHaveBeenCalled()
  })
})
