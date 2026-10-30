// @vitest-environment happy-dom
import '../../mobile/test/device-locks'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import type { MoteQuickDefaults } from '@agentmux/core/mote-preferences'
import { parseMoteQuickMode, serializeMoteQuickMode } from '../src/shared/mote-quick-mode'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { HostMoteQuickPreferences } from '../../host/src/mote-quick-preferences'
import { createHostMoteMainReader } from '../../host/src/mote-dialogue'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { createMoteApp, moteClick, type MoteAppFixture } from './fixtures/mote-app'
import { moteTopics, scratchWorkspace, customMoteId } from './fixtures/mote-workface'
import { scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { MoteQuickModeDialog } from '../src/renderer/src/components/MoteQuickMode'
import { MobileMoteProfile } from '../../mobile/src/navigation/MobileMoteProfile'
import { getDeviceWorkface, emptyDeviceWorkface } from '../../mobile/src/recovery/device-workface'
import { button, click, fixture, mount, mounted, deferred } from '../../mobile/test/conversation-fixture'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'

let app: MoteAppFixture, files: WorkspaceFiles, root: string
const originalBody = '---\nversion: 1 # original format\nprivate: keep-me\ndefaults: {}\n---\n# 原 Mote 笔记\n后来正文不可丢。\n'
async function waitFor(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 }) }
async function choose(element: HTMLElement, name: string, value: string) {
  const input = element.querySelector<HTMLSelectElement>(`[aria-label="${name}"]`); expect(input).not.toBeNull()
  await act(async () => { input!.value = value; input!.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function submit(element: HTMLElement) { await act(async () => element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
beforeEach(async () => { app = createMoteApp(); root = await realpath(await mkdtemp(join(tmpdir(), 'amx-mote-quick-'))); files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  await files.dispose(); await rm(root, { recursive: true, force: true }); await app.dispose(); vi.restoreAllMocks()
})
async function original(defaults: MoteQuickDefaults = {}) {
  const workspace = { ...scratchWorkspace, path: root }, topics = moteTopics.map(topic => ({ ...topic,
    directoryPath: join(root, scratchTopicDirectoryName(topic.id)), topicPath: join(root, scratchTopicDirectoryName(topic.id), 'topic.md'),
    ...(topic.soul ? { soul: { ...topic.soul, path: join(root, scratchTopicDirectoryName(topic.id), 'SOUL.md') } } : {}) }))
  for (const topic of topics) { await mkdir(topic.directoryPath); await writeFile(join(topic.directoryPath, 'MOTE.md'), serializeMoteQuickMode(originalBody, defaults)) }
  const state = useAppStore.getState()
  useAppStore.setState({ config: { ...state.config!, workspaces: [workspace, ...state.config!.workspaces.filter(w => w.id !== workspace.id)] },
    documents: {}, documentIssues: {}, dirtyDocuments: {}, savingDocuments: {}, retainedDocumentDrafts: {},
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics, reading: false, error: null } } })
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_w, id) => topics.find(t => t.id === id) ?? null)
  const topic = topics.find(t => t.id === customMoteId)!, spaceId = directoryIdentity(workspace.hostId, topic.directoryPath), zoneId = homeZoneId(spaceId)
  const target = { spaceId, zoneId, expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } }
  const catalog = () => spatialCatalog(useAppStore.getState(), topics)
  const owner = new FileReadOwner({ files, catalog: async () => catalog(), workspace: id => id === workspace.id ? workspace : undefined })
  vi.spyOn(api.files, 'readPublic').mockImplementation(params => owner.read(params))
  vi.spyOn(api.files, 'read').mockImplementation((_w, path) => files.read(workspace, path))
  vi.spyOn(api.files, 'write').mockImplementation((_w, input) => files.write(workspace, input))
  vi.spyOn(api.files, 'create').mockImplementation((_w, input) => files.create(workspace, input))
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
  const nativeWrite = files.write.bind(files)
  const writes = vi.spyOn(files, 'write'), creates = vi.spyOn(files, 'create')
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial-state.json'))
  const { locations: _locations, ...catalogGraph } = catalog()
  await spatial.commit({ expectedRevision: 0, graph: { ...catalogGraph, layouts: useAppStore.getState().layouts,
    tabLayouts: Object.fromEntries(Object.values(useAppStore.getState().tabs).map(tab => [tab.id, tab.layout])), resources: {} } })
  const configurationPath = join(root, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify(useAppStore.getState().config))
  const main = createHostMoteMainReader({ configurationPath, spatial, files: owner })
  const quick = new HostMoteQuickPreferences({ files: owner, main, catalog: async () => catalog(), executors: async () => [{ id: 'fixture', name: 'Fixture', providerId: 'fixture' }] })
  const service = new AgentMuxRpcService({ execute: request => useAppStore.getState().executeControl(request), coreClients: () => [], spatialState: spatial, moteQuickPreferences: quick })
  const call = (method: any, params: any) => service.call(method, params, { principal: { kind: 'device', id: 'private-quick-device' } })
  const publicRead = vi.spyOn(api.motePreferences, 'read').mockImplementation(input => call('space.mote.preferences.read', input) as any)
  const publicSave = vi.spyOn(api.motePreferences, 'save').mockImplementation(input => call('space.mote.preferences.save', input) as any)
  const f = fixture(); f.sessions.clear()
  let runtime = { runtimeId: 'original-quick-runtime', ownerInstanceId: 'original-quick-process', availability: 'connected' }
  f.client.runtimeOwnerIdentity = () => runtime as ReturnType<AgentMuxHostedClient['runtimeOwnerIdentity']>
  const rpc = vi.fn(async (method: any, params: any) => { const result: any = method === 'space.ls' ? { catalog: catalog() } : await call(method, params); return result })
  f.client.forwardRpc = rpc as NonNullable<AgentMuxHostedClient['forwardRpc']>
  const content = { ...target.expectedResource, zoneId }, identity = { name: topic.title, project: '原项目', mote: { spaceId, contentReference: content } }
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); await getDeviceWorkface().confirmHost({ origin: location.origin, hostId: 'local' })
  await getDeviceWorkface().updateConversation({ version: 1, drafts: [['original-chat', '未发原对话稿']], attempts: [], responses: [] })
  const copy = vi.fn(async () => true)
  const preflight: any = await call('space.mote.preferences.read', { kind: 'quick', target }); expect(preflight.status, preflight.issue).toBe('ready')
  const view = async () => { const v = await mount(<MobileMoteProfile identity={identity} client={f.client} copyText={copy} />); await click(button(v.element, '编辑快捷配置')); await waitFor(() => expect(v.element.textContent).toContain('已核对当前配置')); return v }
  return { workspace, topic, target, call, rpc, writes, creates, nativeWrite, f, view, copy, catalog, publicRead, publicSave,
    scope: { workspace, topic, rootPath: topic.directoryPath.slice(workspace.path.length + 1) },
    path: join(topic.directoryPath, 'MOTE.md'), read: () => call('space.mote.preferences.read', { kind: 'quick', target }) as Promise<any>,
    setRuntime: (value: typeof runtime) => { runtime = value } }
}
async function number(root: ParentNode, name: string, value: string) {
  const input = root.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!; expect(input).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const mobileDuration = '对话空闲时长（分钟）', desktopDuration = 'Conversation inactivity (minutes)'
async function desktop(f: Awaited<ReturnType<typeof original>>) {
  const tab = Object.values(useAppStore.getState().tabs).find(tab => tab.topicId === f.topic.id)!
  useAppStore.getState().activateTab(f.workspace.id, 'mote-group', tab.id)
  const close = vi.fn(), component = () => <MoteQuickModeDialog scope={f.scope} onOpenPath={async () => {}} onClose={close} returnFocus={() => null} />
  const v = await mount(component())
  await waitFor(() => expect(document.querySelector<HTMLButtonElement>('[aria-label="Automatic rollover policy"]')).toBeTruthy())
  await waitFor(() => expect(button(document.body, 'Save').disabled).toBe(false))
  return { ...v, close, component }
}
async function desktopPolicy(value: 'idle' | 'keep-current') {
  await moteClick(document.querySelector<HTMLButtonElement>('[aria-label="Automatic rollover policy"]')!)
  const option = document.querySelector<HTMLElement>(`[role="menuitemradio"][data-value="${value}"]`)
  expect(option).toBeTruthy(); await moteClick(option!)
}
function noAgentOperation() {
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
}

it('Mobile Profile saves the exact policy through real public CAS/files and reopens it without changing other original data', async () => {
  const f = await original({ executorId: 'fixture', presence: { enabled: false, intervalMs: 420000 } }), v = await f.view()
  expect(v.element.textContent).toContain('原配置未设置流转策略')
  await choose(v.element, '自动流转策略', 'idle')
  expect(v.element.querySelector<HTMLInputElement>(`[aria-label="${mobileDuration}"]`)!.value).toBe('')
  await submit(v.element); expect(f.writes).not.toHaveBeenCalled()
  expect(v.element.textContent).toContain('大于 0')
  await number(v.element, mobileDuration, '1.5'); await submit(v.element)
  await waitFor(() => expect(v.element.textContent).toContain('原 Quick 配置已保存'))
  const packet = f.rpc.mock.calls.find(([m]) => m === 'space.mote.preferences.save')![1]
  expect(packet.values).toEqual({ executorId: 'fixture', presence: { enabled: false, intervalMs: 420000 }, conversationRollover: { kind: 'idle', idleMs: 90000 } })
  expect(packet).not.toHaveProperty('conversationRolloverEditor')
  const read = await f.read(); expect(read.defaults.conversationRollover).toEqual({ kind: 'idle', idleMs: 90000 })
  const content = await readFile(f.path, 'utf8')
  for (const part of ['# original format', 'private: keep-me', '# 原 Mote 笔记', '后来正文不可丢。']) expect(content).toContain(part)
  await v.render(null); const reopened = await f.view()
  expect(reopened.element.querySelector<HTMLInputElement>(`[aria-label="${mobileDuration}"]`)!.value).toBe('1.5')
  expect(getDeviceWorkface().snapshot().record.conversation.drafts).toEqual([['original-chat', '未发原对话稿']])
  noAgentOperation(); expect(f.f.submit).not.toHaveBeenCalled()
})

it('Mobile keeps an absent policy absent when saving unrelated settings and explicitly saves keep-current for an existing idle policy', async () => {
  const f = await original(), v = await f.view()
  await choose(v.element, '新对话使用的 Agent', 'fixture'); await submit(v.element)
  await waitFor(() => expect(v.element.textContent).toContain('原 Quick 配置已保存'))
  expect((await f.read()).defaults).toMatchObject({ executorId: 'fixture' }); expect((await f.read()).defaults).not.toHaveProperty('conversationRollover')
  await choose(v.element, '自动流转策略', 'idle'); await number(v.element, mobileDuration, '7'); await submit(v.element)
  await waitFor(() => expect(f.writes).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.attempts[1]?.phase).toBe('saved'))
  await choose(v.element, '自动流转策略', 'keep-current'); await submit(v.element)
  await waitFor(() => expect(f.writes).toHaveBeenCalledTimes(3))
  expect((await f.read()).defaults).toMatchObject({ executorId: 'fixture', conversationRollover: { kind: 'keep-current' } })
  noAgentOperation()
})

it('Mobile preserves incomplete policy input across its original durable draft and never submits the preceding valid duration', async () => {
  const f = await original({ conversationRollover: { kind: 'idle', idleMs: 600000 } }), v = await f.view()
  await number(v.element, mobileDuration, '0'); await submit(v.element)
  expect(f.writes).not.toHaveBeenCalled()
  await waitFor(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.conversationRolloverEditor).toEqual({ kind: 'idle', minutes: '0' }))
  await v.render(null); const reopened = await f.view()
  expect(reopened.element.querySelector<HTMLInputElement>(`[aria-label="${mobileDuration}"]`)!.value).toBe('0')
  await click(button(reopened.element, '核对当前配置')); await submit(reopened.element)
  expect(f.rpc.mock.calls.filter(([m]) => m === 'space.mote.preferences.save')).toHaveLength(0)
  expect((await f.read()).defaults.conversationRollover).toEqual({ kind: 'idle', idleMs: 600000 })
})

it('Mobile keeps policy draft and exact frozen request through real CAS conflict, explicit adoption and an unknown reply without replay', async () => {
  const f = await original(), v = await f.view()
  await choose(v.element, '自动流转策略', 'idle'); await number(v.element, mobileDuration, '8')
  await writeFile(f.path, (await readFile(f.path, 'utf8')) + '\nOther original editor wrote this.\n')
  await submit(v.element); await waitFor(() => expect(v.element.textContent).toContain('原 owner 确认尚未写入'))
  expect(f.writes).not.toHaveBeenCalled(); expect(v.element.querySelector<HTMLInputElement>(`[aria-label="${mobileDuration}"]`)!.value).toBe('8')
  await click(button(v.element, '核对当前配置')); await click(button(v.element, '采用当前修订，保留我的选择'))
  await waitFor(() => expect(v.element.textContent).toContain('已明确采用当前修订'))
  const call = f.rpc.getMockImplementation()!
  f.rpc.mockImplementation(async (method, input) => { const result = await call(method, input); if (method === 'space.mote.preferences.save') throw Error('Original reply lost after actual file commit'); return result })
  await submit(v.element); await waitFor(() => expect(v.element.textContent).toContain('原保存未确认'))
  const originalRequest = structuredClone(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.attempts[1]!)
  expect(originalRequest.input.values.conversationRollover).toEqual({ kind: 'idle', idleMs: 480000 })
  await number(v.element, mobileDuration, '9'); await waitFor(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.conversationRolloverEditor?.minutes).toBe('9'))
  await v.render(null); const reopened = await f.view(); await submit(reopened.element)
  expect(f.rpc.mock.calls.filter(([m]) => m === 'space.mote.preferences.save')).toHaveLength(2)
  expect(getDeviceWorkface().snapshot().record.moteQuickDrafts![0]!.attempts[1]).toEqual(originalRequest)
  expect(reopened.element.querySelector<HTMLInputElement>(`[aria-label="${mobileDuration}"]`)!.value).toBe('9')
  expect(await readFile(f.path, 'utf8')).toContain('Other original editor wrote this.')
  noAgentOperation()
})

it('Desktop original Quick dialog saves exact idle milliseconds through its public file owner without lifecycle work', async () => {
  const f = await original({ executorId: 'fixture', presence: { enabled: true, intervalMs: 900000 } }), v = await desktop(f)
  await desktopPolicy('idle')
  expect(document.querySelector<HTMLInputElement>(`[aria-label="${desktopDuration}"]`)!.value).toBe('')
  await moteClick(button(document.body, 'Save')); expect(f.publicSave).not.toHaveBeenCalled()
  await number(document.body, desktopDuration, '2.5'); await moteClick(button(document.body, 'Save'))
  await waitFor(() => expect(v.close, document.body.textContent ?? '').toHaveBeenCalledTimes(1))
  expect(f.publicSave.mock.calls[0]![0].values).toEqual({ executorId: 'fixture', presence: { enabled: true, intervalMs: 900000 }, conversationRollover: { kind: 'idle', idleMs: 150000 } })
  expect((await f.read()).defaults.conversationRollover).toEqual({ kind: 'idle', idleMs: 150000 })
  expect(await readFile(f.path, 'utf8')).toContain('private: keep-me')
  noAgentOperation()
})

it('Desktop retains invalid raw idle draft on close/reopen and isolates another Mote while preserving saved source', async () => {
  const f = await original({ conversationRollover: { kind: 'idle', idleMs: 600000 } }), v = await desktop(f)
  await number(document.body, desktopDuration, '0'); await moteClick(button(document.body, 'Save'))
  expect(f.publicSave).not.toHaveBeenCalled(); await v.render(null); await v.render(v.component())
  await waitFor(() => expect(document.querySelector<HTMLInputElement>(`[aria-label="${desktopDuration}"]`)?.value).toBe('0'))
  await moteClick(button(document.body, 'Save')); expect(f.publicSave).not.toHaveBeenCalled()
  await v.render(null)
  const other = { ...f.scope, topic: moteTopics[0]!, rootPath: moteTopics[0]!.directoryPath.slice(scratchWorkspace.path.length + 1) }
  await v.render(<MoteQuickModeDialog scope={other} onOpenPath={async () => {}} onClose={() => {}} returnFocus={() => null} />)
  expect(document.querySelector<HTMLInputElement>(`[aria-label="${desktopDuration}"]`)).toBeNull()
  expect((await f.read()).defaults.conversationRollover).toEqual({ kind: 'idle', idleMs: 600000 })
})

it('Desktop saves unrelated edits without installing a policy and displays an unconfirmed source honestly', async () => {
  const f = await original(), v = await desktop(f)
  expect(document.body.textContent).toContain('No rollover policy is configured')
  await moteClick(document.querySelector<HTMLInputElement>('[aria-label="Enable automatic Mote maintenance"]')!)
  await moteClick(button(document.body, 'Save')); await waitFor(() => expect(v.close, document.body.textContent ?? '').toHaveBeenCalled())
  expect((await f.read()).defaults).toMatchObject({ presence: { enabled: false, intervalMs: 1800000 } }); expect((await f.read()).defaults).not.toHaveProperty('conversationRollover')
  await v.render(null)
  f.publicRead.mockRejectedValue(new Error('Original configuration source unavailable'))
  await v.render(v.component()); await waitFor(() => expect(document.body.textContent).toContain('The saved rollover policy is unconfirmed'))
  expect(button(document.body, 'Save').disabled).toBe(true); noAgentOperation()
})


it('Desktop keeps a later invalid idle draft when the original valid save completes, including after close/reopen', async () => {
  const f = await original(), v = await desktop(f), gate = deferred<void>()
  await desktopPolicy('idle'); await number(document.body, desktopDuration, '6')
  f.writes.mockImplementationOnce(async (...args) => { await gate.promise; return f.nativeWrite(...args) })
  await moteClick(button(document.body, 'Save')); await waitFor(() => expect(f.writes).toHaveBeenCalledTimes(1))
  await number(document.body, desktopDuration, '0'); await act(async () => gate.resolve())
  await waitFor(() => expect(button(document.body, 'Save').disabled).toBe(false))
  expect(v.close).not.toHaveBeenCalled()
  expect((await f.read()).defaults.conversationRollover).toEqual({ kind: 'idle', idleMs: 360000 })
  await v.render(null); await v.render(v.component())
  await waitFor(() => expect(document.querySelector<HTMLInputElement>(`[aria-label="${desktopDuration}"]`)?.value).toBe('0'))
  await moteClick(button(document.body, 'Save')); expect(f.publicSave).toHaveBeenCalledTimes(1)
  noAgentOperation()
})

it('Mobile scopes incomplete rollover input to the original Mote across another actual Profile', async () => {
  const f = await original(), v = await f.view()
  await choose(v.element, '自动流转策略', 'idle'); await number(v.element, mobileDuration, '0')
  await waitFor(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.conversationRolloverEditor?.minutes).toBe('0'))
  await v.render(null)
  const otherPath = join(f.workspace.path, scratchTopicDirectoryName(moteTopics[0]!.id)), spaceId = directoryIdentity('local', otherPath)
  const identity = { name: 'Other original Mote', project: '原项目', mote: { spaceId, contentReference: { ...f.target.expectedResource, zoneId: homeZoneId(spaceId) } } }
  const other = await mount(<MobileMoteProfile identity={identity} client={f.f.client} copyText={f.copy} />)
  await click(button(other.element, '编辑快捷配置')); await waitFor(() => expect(other.element.textContent).toContain('已核对当前配置'))
  expect(other.element.querySelector<HTMLInputElement>(`[aria-label="${mobileDuration}"]`)).toBeNull()
  expect(other.element.querySelector<HTMLSelectElement>('[aria-label="自动流转策略"]')!.value).toBe('keep-current')
  await other.render(null); const reopened = await f.view()
  expect(reopened.element.querySelector<HTMLInputElement>(`[aria-label="${mobileDuration}"]`)!.value).toBe('0')
  expect(f.writes).not.toHaveBeenCalled(); noAgentOperation()
})
