import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
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
import { FileReadOwner } from '../../desktop/src/main/file-read-owner'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { MobileMoteProfile } from '../src/navigation/MobileMoteProfile'
import { MobileIdentity, type MobileObjectIdentity } from '../src/navigation/MobileIdentity'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

beforeEach(() => { localStorage.clear(); getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
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
    status: { state: 'working', source: 'native-hook', observedAt: 1 }, capabilities: { timeline: 'complete-events' },
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
    if (method === 'agent.inspect') return { session: f.client.agentSession(params.target.agentSessionId), displayName: { override: null, availability: 'observed' } }
    const result = { operation: 'space.ls' as const, catalog: publicCatalog(selectSpatialCatalog(value.catalog, params.target ?? {})) }
    return parseRpcControlResult('space.ls', rpcControlResult('space.ls', result), params)
  })
  f.client.forwardRpc = rpc
  return { ...f, rpc, read }
}

describe('original Mote owner → typed catalog → Mobile consumers', () => {
  it('selects the saved second occurrence among two Sessions without borrowing the first tuple', async () => {
    const value = original(), f = clientFor(value), open = vi.fn()
    expect(value.catalog.locations.filter(place => place.regionId === value.main.regionId)).toHaveLength(2)
    expect(value.fact.conversation).toEqual(value.main)
    expect(value.fact.content).toEqual({ zoneId: value.catalog.zones.find(zone => zone.directoryPath === fixturePath("relocated/mote"))!.zoneId,
      hostId: value.workspace.hostId, workspaceId: value.workspace.id, workspacePath: value.workspace.path })
    const view = await mount(<MobileSpatialNavigation home="mote" client={f.client} connected sessions={f.client.agentSessions()} openSession={open} />)
    await click([...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-list button')].find(item => item.textContent?.includes(value.topic.title))!)
    expect(open).toHaveBeenCalledExactlyOnceWith(value.main.sessionId, expect.objectContaining({ mote: expect.objectContaining({ spaceId: value.spaceId }),
      context: expect.objectContaining({ displayWorkspaceId: 'second-display', groupId: 'saved-group', tabId: 'main-tab', regionId: 'main-region' }) }))
    expect(f.rpc.mock.calls.every(([method]) => method === 'space.ls')).toBe(true)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('keeps original Core SID and full occurrence when the renderer alias differs, including Focus and avatar activities', async () => {
    const value = original(true), f = clientFor(value), open = vi.fn()
    expect(value.catalog.regions.find(region => region.regionId === value.main.regionId)?.agentSessionId).toBe('renderer-original-alias')
    expect(value.fact.conversation).toEqual(value.main)
    expect(value.catalog.agentPresentation?.map(row => row.agentSessionId)).toContain('session-original')
    const appearance = await readSpatialAppearance(value.state, value.base, undefined, [value.topic], vi.fn())
    expect(appearance.find(fact => fact.spaceId === value.spaceId)?.activities?.map(activity => activity.agentSessionId)).toContain('session-original')
    const view = await mount(<MobileSpatialNavigation home="mote" client={f.client} connected sessions={f.client.agentSessions()} openSession={open} />)
    await click([...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-list button')].find(item => item.textContent?.includes(value.topic.title))!)
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
    await click([...view.element.querySelectorAll<HTMLButtonElement>('.mobile-spatial-panel > .mobile-session-list button')].find(item => item.textContent?.includes(value.topic.title))!)
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
    await click(button(overlay, '返回 Profile')); await click(button(overlay, '关闭面板'))
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
    await click([...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-list button')].find(item => item.textContent?.includes(value.topic.title))!)
    expect(open).not.toHaveBeenCalled(); expect(view.element.textContent).toContain('not confirmed at its original location')
    await click(button(view.element, '查看 Mote 资料')); expect(profile).toHaveBeenCalledOnce()
    const mainRows = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-spatial-tab .mobile-session-list > li > button')].filter(item => item.textContent?.includes('继续原协调工作'))
    expect(mainRows).toHaveLength(2)
    await click(mainRows[1]!)
    expect(open).toHaveBeenCalledWith('session-original', expect.objectContaining({ context: expect.objectContaining({ displayWorkspaceId: 'second-display', groupId: 'saved-group' }) }))
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
    await click(button(view.element, '返回 Profile'))
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
    expect(view.element.textContent).toContain('!')
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
