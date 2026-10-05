// @vitest-environment happy-dom
import '../../mobile/test/mobile-lan-crypto.setup'
import { createWorkspaceLayout } from '@agentmux/layout'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { agentMuxCommandHelp } from '../../../packages/core/src/agentmux-cli-help'
import { parseAgentMuxCliInvocation, AGENTMUX_CLI_COMMANDS } from '../../../packages/core/src/agentmux-cli-commands'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec'
import * as preferenceCodec from '@agentmux/core/mote-preferences'
import { parseMoteDefaultConversation, parseMotePreferencesSaveResult, moteQuickBaseline } from '@agentmux/core/mote-preferences'
import { parseMoteQuickMode, serializeMoteQuickMode } from '../src/shared/mote-quick-mode'
import { ScratchTopics } from '../src/main/scratch-topics'
import { FileReadOwner } from '../src/main/file-read-owner'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { createMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { moteTopics, scratchWorkspace, customMoteId } from './fixtures/mote-workface'
import { scratchTopicDirectoryName, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { MobileMoteProfile } from '../../mobile/src/navigation/MobileMoteProfile'
import { getDeviceWorkface, emptyDeviceWorkface, DEVICE_WORKFACE_KEY } from '../../mobile/src/recovery/device-workface'
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
async function original() {
  const workspace = { ...scratchWorkspace, path: root }, topics = moteTopics.map(topic => ({ ...topic,
    directoryPath: join(root, scratchTopicDirectoryName(topic.id)), topicPath: join(root, scratchTopicDirectoryName(topic.id), 'topic.md'),
    ...(topic.soul ? { soul: { ...topic.soul, path: join(root, scratchTopicDirectoryName(topic.id), 'SOUL.md') } } : {}) }))
  for (const topic of topics) { await mkdir(topic.directoryPath); await writeFile(join(topic.directoryPath, 'MOTE.md'), originalBody) }
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
  const service = new AgentMuxRpcService({ execute: request => useAppStore.getState().executeControl(request), coreClients: () => [] })
  const call = (method: any, params: any) => service.call(method, params, { principal: { kind: 'device', id: 'private-quick-device' } })
  const f = fixture(); f.sessions.clear()
  let runtime = { runtimeId: 'original-quick-runtime', ownerInstanceId: 'original-quick-process', availability: 'connected' }
  f.client.runtimeOwnerIdentity = () => runtime as ReturnType<AgentMuxHostedClient['runtimeOwnerIdentity']>
  const rpc = vi.fn(async (method: any, params: any) => method === 'space.ls' ? { catalog: catalog() } : call(method, params))
  f.client.forwardRpc = rpc as NonNullable<AgentMuxHostedClient['forwardRpc']>
  const content = { ...target.expectedResource, zoneId }, identity = { name: topic.title, project: '原项目', mote: { spaceId, contentReference: content } }
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); await getDeviceWorkface().confirmHost({ origin: location.origin, hostId: 'local' })
  await getDeviceWorkface().updateConversation({ version: 1, drafts: [['original-chat', '未发原对话稿']], attempts: [], responses: [] })
  const copy = vi.fn(async () => true)
  const view = async () => { const v = await mount(<MobileMoteProfile identity={identity} client={f.client} copyText={copy} />); await click(button(v.element, '编辑快捷配置')); await waitFor(() => expect(v.element.textContent).toContain('已核对当前配置')); return v }
  return { workspace, topic, target, call, rpc, writes, creates, nativeWrite, f, view, copy, catalog,
    path: join(topic.directoryPath, 'MOTE.md'), read: () => call('space.mote.preferences.read', { kind: 'quick', target }) as Promise<any>,
    setRuntime: (value: typeof runtime) => { runtime = value } }
}
describe('original Quick public owner vertical slice', () => {
  it('shares the exact public six-tuple limits with the existing YAML owner, preserving opaque bytes', () => {
    const c = { hostId: ' host ', sessionId: 'original', displayWorkspaceId: 'display', groupId: 'pane', tabId: '/' + '文'.repeat(4000), regionId: 'C:\\opaque' }
    expect(() => parseMoteDefaultConversation(c)).not.toThrow()
    expect(parseMoteDefaultConversation(c)).toEqual(c)
    expect(parseMoteQuickMode(serializeMoteQuickMode(originalBody, { conversation: c }))).toEqual({ status: 'valid', defaults: { conversation: c } })
    for (const invalid of [{ ...c, hostId: '文'.repeat(171) }, { ...c, tabId: '文'.repeat(5462) }, { ...c, regionId: 'self' }, { ...c, sessionId: 'bad\nrun' }]) expect(() => parseMoteDefaultConversation(invalid)).toThrow()
  })
  it('discovers CLI/read/save on the same service, reads content without a display, and refuses wrong resources without writing', async () => {
    const f = await original(), state = useAppStore.getState()
    useAppStore.setState({ tabs: Object.fromEntries(Object.entries(state.tabs).filter(([, tab]) => tab.topicId !== customMoteId)) })
    const input = join(root, 'read.json'); await writeFile(input, JSON.stringify({ kind: 'quick', target: f.target }))
    const parsed = await parseAgentMuxCliInvocation(['space', 'mote', 'preferences', 'read', '--input', input])
    expect(parsed.command.method).toBe('space.mote.preferences.read')
    expect(agentMuxCommandHelp('space.mote.preferences')).toContain('space mote preferences read')
    expect(agentMuxCommandHelp('space.mote.preferences.save')).toContain('original operationId')
    expect(AGENTMUX_CLI_COMMANDS.filter(c => c.method.startsWith('space.mote.preferences.')).map(c => c.method)).toEqual(['space.mote.preferences.read', 'space.mote.preferences.save'])
    const read: any = await f.call(parsed.command.method, parsed.params)
    expect(read).toMatchObject({ status: 'ready', defaults: {}, source: { result: { status: 'read', document: { content: originalBody } } } })
    expect(read.choices.destinations.length).toBeGreaterThan(0); expect(read.choices.destinations.every((d: any) => d.reference.kind === 'empty')).toBe(true)
    expect((await f.call('space.mote.preferences.read', { kind: 'quick', target: { ...f.target, expectedResource: { ...f.target.expectedResource, hostId: 'foreign' } } }) as any).status).toBe('unconfirmed')
    expect(f.writes).not.toHaveBeenCalled(); expect(f.creates).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
    expect(() => rpcControlRequest('space.mote.preferences.save', { kind: 'quick', target: f.target, baseline: moteQuickBaseline(read), values: {}, destination: read.choices.destinations[0].reference })).toThrow('operationId')
  })
  it('saves from mounted Profile through Source public service, original helper/Editor and real native Files, preserving notes and later form', async () => {
    const f = await original(), before = useAppStore.getState(), v = await f.view()
    const draftBefore = before.agentComposerDrafts, navigation = before.activeWorkspaceId
    await choose(v.element, '新对话使用的 Agent', 'fixture')
    const pending = deferred<void>(), native = f.nativeWrite
    f.writes.mockImplementationOnce(async (...args) => { await pending.promise; return native(...args) })
    await submit(v.element); await waitFor(() => expect(f.writes).toHaveBeenCalledTimes(1))
    await choose(v.element, '接回时机', 'on-open'); pending.resolve()
    await waitFor(() => expect(v.element.textContent).toContain('原 Quick 配置已保存'))
    const content = await readFile(f.path, 'utf8')
    expect(parseMoteQuickMode(content)).toEqual({ status: 'valid', defaults: { executorId: 'fixture' } })
    for (const part of ['# original format', 'private: keep-me', '# 原 Mote 笔记', '后来正文不可丢。']) expect(content).toContain(part)
    expect((v.element.querySelector('[aria-label="接回时机"]') as HTMLSelectElement).value).toBe('on-open')
    const draft = getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]!
    expect(draft.values).toEqual({ executorId: 'fixture', recovery: 'on-open' }); expect(draft.attempts[0]?.input.values).toEqual({ executorId: 'fixture' })
    expect(getDeviceWorkface().snapshot().record.conversation.drafts).toEqual([['original-chat', '未发原对话稿']])
    expect(draft.attempts[0]?.phase).toBe('saved'); expect(draft.blockedAttemptId).toBeNull()
    expect(useAppStore.getState().agentComposerDrafts).toBe(draftBefore); expect(useAppStore.getState().activeWorkspaceId).toBe(navigation)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(f.f.submit).not.toHaveBeenCalled()
    await submit(v.element); await waitFor(() => expect(f.writes).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.attempts[1]?.phase).toBe('saved'))
    expect(parseMoteQuickMode(await readFile(f.path, 'utf8'))).toEqual({ status: 'valid', defaults: { executorId: 'fixture', recovery: 'on-open' } })
  })
  it('refreshes the mounted Profile through the actual ScratchTopics file reader and public Mote carrier after the native Quick writer', async () => {
    const f = await original(), topics = new ScratchTopics()
    await topics.ensureMote(f.workspace, f.topic.id)
    vi.mocked(api.scratch.listTopics).mockImplementation(() => topics.list(f.workspace))
    vi.mocked(api.scratch.readTopic).mockImplementation((_workspace, id) => topics.read(f.workspace, id))
    f.rpc.mockImplementation((method, params) => f.call(method, params))
    const before: any = await f.call('space.ls', { target: { spaceId: f.target.spaceId }, presentation: true })
    expect(before.catalog.motePresentation[0].quickMode.defaults).toEqual({})
    const v = await f.view(); await choose(v.element, '新对话使用的 Agent', 'fixture'); await submit(v.element)
    await waitFor(() => expect(v.element.textContent).toContain('原 Quick 配置已保存'))
    const after: any = await f.call('space.ls', { target: { spaceId: f.target.spaceId }, presentation: true })
    expect(after.catalog.motePresentation[0]).toMatchObject({ spaceId: f.target.spaceId, quickMode: { status: 'saved', defaults: { executorId: 'fixture' } } })
    expect(after.catalog.motePresentation[0].quickMode.version).not.toBe(before.catalog.motePresentation[0].quickMode.version)
    expect(after.catalog.motePresentation[0].quickMode.version).toHaveLength(16)
    expect((await f.read()).source.result.document.revision).not.toBe(after.catalog.motePresentation[0].quickMode.version)
    await click(button(v.element, '返回 Profile')); await waitFor(() => expect(v.element.querySelector('.mobile-mote-profile__defaults')?.textContent).toContain('fixture'))
    expect(f.writes).toHaveBeenCalledTimes(1); expect(app.launch).not.toHaveBeenCalled()
  })
  it('retains original unknown/full request and later choices across remount; current reads never acknowledge it', async () => {
    const f = await original(), v = await f.view(), nativeCall = f.rpc.getMockImplementation()!
    f.rpc.mockImplementation(async (method, params) => { const result = await nativeCall(method, params); if (method === 'space.mote.preferences.save') throw new Error('Original receipt lost after writer'); return result })
    await choose(v.element, '新对话使用的 Agent', 'fixture'); await submit(v.element)
    await waitFor(() => expect(v.element.textContent).toContain('原保存未确认'))
    await choose(v.element, '接回时机', 'on-open'); await waitFor(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.values.recovery).toBe('on-open'))
    const before = getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]!, writes = f.writes.mock.calls.length
    expect(before.attempts[0]?.input.values).toEqual({ executorId: 'fixture' }); expect(before.attempts[0]?.phase).toBe('unknown')
    const mountedView = mounted.find(item => item.element === v.element)!
    await act(async () => mountedView.root.unmount()); v.element.remove(); mounted.splice(mounted.indexOf(mountedView), 1)
    const reopened = await f.view(); await submit(reopened.element); await click(button(reopened.element, '核对当前配置'))
    await waitFor(() => expect(reopened.element.textContent).toContain('读取不确认旧保存'))
    const after = getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]!
    expect(after.blockedAttemptId).toBe(before.blockedAttemptId); expect(after.attempts[0]).toEqual(before.attempts[0]); expect(after.values).toEqual(before.values)
    expect(f.writes).toHaveBeenCalledTimes(writes); await click(button(reopened.element, '复制配置与请求')); expect(f.copy).toHaveBeenCalledWith(expect.stringContaining(before.attempts[0]!.input.operationId), expect.any(Function))
    expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toContain(before.attempts[0]!.input.operationId)
  })
  it('never guesses the first of multiple original display destinations', async () => {
    const f = await original(), state = useAppStore.getState(), tab = Object.values(state.tabs).find(t => t.topicId === customMoteId)!
    useAppStore.setState({ layouts: { ...state.layouts, project: createWorkspaceLayout('project-group', [tab.id]) } })
    const v = await f.view(); await choose(v.element, '新对话使用的 Agent', 'fixture')
    const select = v.element.querySelector<HTMLSelectElement>('[aria-label="保存位置"]')!
    expect(select.options.length).toBe(3); expect(select.value).toBe('')
    await submit(v.element); expect(f.writes).not.toHaveBeenCalled(); expect(f.rpc.mock.calls.filter(([m]) => m === 'space.mote.preferences.save')).toHaveLength(0)
    await choose(v.element, '保存位置', select.options[2]!.value); await submit(v.element)
    await waitFor(() => expect(f.writes).toHaveBeenCalledTimes(1)); await waitFor(() => expect(v.element.textContent).toContain('原 Quick 配置已保存'))
    expect(useAppStore.getState().layouts.project?.groups[0]?.tabOrder.length).toBeGreaterThan(1)
  })
  it('freezes the original explicit Save before its device ACK while later typed choices remain editable', async () => {
    const f = await original(), v = await f.view(), owner = getDeviceWorkface(), gate = deferred<void>(), originalEdit = owner.editMoteQuickDraft.bind(owner)
    let waiting = false
    vi.spyOn(owner, 'editMoteQuickDraft').mockImplementation(async (...args) => {
      if (!waiting && args[1].attempts.some(a => a.phase === 'sending')) { waiting = true; await gate.promise }
      return originalEdit(...args)
    })
    await choose(v.element, '新对话使用的 Agent', 'fixture'); await submit(v.element)
    await waitFor(() => expect(waiting).toBe(true)); await choose(v.element, '接回时机', 'on-open')
    expect(f.writes).not.toHaveBeenCalled(); gate.resolve()
    await waitFor(() => expect(v.element.textContent).toContain('原 Quick 配置已保存'))
    expect(parseMoteQuickMode(await readFile(f.path, 'utf8'))).toEqual({ status: 'valid', defaults: { executorId: 'fixture' } })
    const draft = getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]!
    expect(draft.values.recovery).toBe('on-open'); expect(draft.attempts[0]?.input.values).toEqual({ executorId: 'fixture' })
  })
  it('never forwards a pending device-ACK Save after its original Profile editor unmounts', async () => {
    const f = await original(), v = await f.view(), owner = getDeviceWorkface(), gate = deferred<void>(), originalEdit = owner.editMoteQuickDraft.bind(owner)
    let waiting = false
    vi.spyOn(owner, 'editMoteQuickDraft').mockImplementation(async (...args) => {
      if (!waiting && args[1].attempts.some(a => a.phase === 'sending')) { waiting = true; await gate.promise }
      return originalEdit(...args)
    })
    await choose(v.element, '新对话使用的 Agent', 'fixture'); await submit(v.element)
    await waitFor(() => expect(waiting).toBe(true)); await click(button(v.element, '返回 Profile')); gate.resolve()
    await waitFor(() => expect(owner.snapshot().record.moteQuickDrafts?.[0]?.attempts).toEqual([]))
    expect(f.rpc.mock.calls.filter(([m]) => m === 'space.mote.preferences.save')).toHaveLength(0)
    expect(f.writes).not.toHaveBeenCalled()
    expect(owner.snapshot().record.moteQuickDrafts?.[0]?.values).toEqual({ executorId: 'fixture' })
  })
  it('does not unlock a second Save while explicit adoption awaits a failed original device commit ACK', async () => {
    const f = await original(), v = await f.view(), nativeCall = f.rpc.getMockImplementation()!
    f.rpc.mockImplementation(async (method, params) => { const result = await nativeCall(method, params); if (method === 'space.mote.preferences.save') throw new Error('Original lost receipt'); return result })
    await choose(v.element, '新对话使用的 Agent', 'fixture'); await submit(v.element); await waitFor(() => expect(v.element.textContent).toContain('原保存未确认'))
    await choose(v.element, '接回时机', 'on-open'); await click(button(v.element, '核对当前配置'))
    const owner = getDeviceWorkface(), gate = deferred<void>(), originalEdit = owner.editMoteQuickDraft.bind(owner)
    let waiting = false
    vi.spyOn(owner, 'editMoteQuickDraft').mockImplementation(async (...args) => {
      if (!waiting && args[1].blockedAttemptId === null && args[1].attempts.length === 1) {
        waiting = true; await gate.promise; vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('Original adoption storage failure') })
      }
      return originalEdit(...args)
    })
    const originalDraft = structuredClone(owner.snapshot().record.moteQuickDrafts![0]!)
    await click(button(v.element, '采用当前修订，保留我的选择')); await waitFor(() => expect(waiting).toBe(true))
    await submit(v.element); gate.resolve()
    await waitFor(() => expect(v.element.textContent).not.toContain('正在采用当前修订'))
    await waitFor(() => expect(v.element.textContent).not.toContain('正在保存原配置'))
    await waitFor(() => expect(owner.snapshot().record.moteQuickDrafts![0]!.blockedAttemptId).toBe(originalDraft.blockedAttemptId))
    expect(owner.snapshot().record.moteQuickDrafts![0]!.attempts).toEqual(originalDraft.attempts)
    expect(owner.snapshot().record.moteQuickDrafts![0]!.values.recovery).toBe('on-open')
    expect(f.writes).toHaveBeenCalledTimes(1); expect(f.rpc.mock.calls.filter(([m]) => m === 'space.mote.preferences.save')).toHaveLength(1)
  })
  it('keeps the original full request and later choices when its completed writer receipt arrives after Profile navigation unmounts it', async () => {
    const f = await original(), v = await f.view(), gate = deferred<void>(), nativeCall = f.rpc.getMockImplementation()!
    let answered = false
    f.rpc.mockImplementation(async (method, params) => { const result = await nativeCall(method, params); if (method === 'space.mote.preferences.save') { answered = true; await gate.promise }; return result })
    await choose(v.element, '新对话使用的 Agent', 'fixture'); await submit(v.element); await waitFor(() => expect(answered).toBe(true))
    await choose(v.element, '接回时机', 'on-open'); await waitFor(() => expect(getDeviceWorkface().snapshot().record.moteQuickDrafts?.[0]?.values.recovery).toBe('on-open'))
    await click(button(v.element, '返回 Profile'))
    const originalRecord = structuredClone(getDeviceWorkface().snapshot().record)
    gate.resolve(); await f.rpc.mock.results.find((_, i) => f.rpc.mock.calls[i]![0] === 'space.mote.preferences.save')!.value
    await act(async () => {})
    expect(getDeviceWorkface().snapshot().record).toEqual(originalRecord)
    await click(button(v.element, '编辑快捷配置')); await waitFor(() => expect(v.element.textContent).toContain('原保存未确认'))
    expect((v.element.querySelector('[aria-label="接回时机"]') as HTMLSelectElement).value).toBe('on-open')
    expect(f.writes).toHaveBeenCalledTimes(1); expect(parseMoteQuickMode(await readFile(f.path, 'utf8'))).toEqual({ status: 'valid', defaults: { executorId: 'fixture' } })
  })
  it('never attributes an original Host save to a replacement device record while its settle ACK is pending', async () => {
    const f = await original(), v = await f.view(), owner = getDeviceWorkface(), gate = deferred<void>(), originalEdit = owner.editMoteQuickDraft.bind(owner)
    let waiting = false
    vi.spyOn(owner, 'editMoteQuickDraft').mockImplementation(async (...args) => {
      if (!waiting && args[1].attempts.some(a => a.phase === 'saved')) { waiting = true; await gate.promise }
      return originalEdit(...args)
    })
    await choose(v.element, '新对话使用的 Agent', 'fixture'); await submit(v.element)
    await waitFor(() => expect(waiting).toBe(true)); await choose(v.element, '接回时机', 'on-open')
    const reads = f.rpc.mock.calls.filter(([method]) => method === 'space.ls').length
    await owner.replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1, drafts: [['new-record-draft', '新工作面原稿']], attempts: [], responses: [] } })
    const replacement = structuredClone(owner.snapshot().record); gate.resolve()
    await waitFor(() => expect(v.element.textContent).not.toContain('正在保存原配置'))
    expect(owner.snapshot().record).toEqual(replacement); expect(f.writes).toHaveBeenCalledTimes(1)
    expect(v.element.textContent).not.toContain('原 Quick 配置已保存')
    expect(f.rpc.mock.calls.filter(([method]) => method === 'space.ls')).toHaveLength(reads)
    await click(button(v.element, '复制配置与请求'))
    const copy = JSON.parse(f.copy.mock.calls.at(-1)![0] as string)
    expect(copy.values).toEqual({ executorId: 'fixture', recovery: 'on-open' })
    expect(copy.attempts[0]).toMatchObject({ input: { values: { executorId: 'fixture' }, target: f.target }, phase: 'unknown', result: { status: 'saved' } })
    expect(parseMoteQuickMode(await readFile(f.path, 'utf8'))).toEqual({ status: 'valid', defaults: { executorId: 'fixture' } })
  })
  it('preserves a different original Mote draft and conversation through the same narrow device transaction', async () => {
    const f = await original(), read = await f.read(), owner = getDeviceWorkface(), recordId = owner.recordIdentity()
    const otherScope = { origin: location.origin, runtimeId: 'different-original-runtime', deviceHostId: 'local', target: f.target }
    const other = { scope: otherScope, values: { recovery: 'startup' as const }, baseline: moteQuickBaseline(read), attempts: [], blockedAttemptId: null }
    await owner.editMoteQuickDraft(null, other, recordId)
    const v = await f.view(); await choose(v.element, '新对话使用的 Agent', 'fixture'); await submit(v.element)
    await waitFor(() => expect(v.element.textContent).toContain('原 Quick 配置已保存'))
    expect(owner.snapshot().record.moteQuickDrafts?.find(d => d.scope.runtimeId === otherScope.runtimeId)).toEqual(other)
    expect(owner.snapshot().record.conversation.drafts).toEqual([['original-chat', '未发原对话稿']])
  })
  it('continues one explicit healthy File Save after a known device-record budget refusal, preserving full memory input and the original durable record', async () => {
    const f = await original(); await writeFile(f.path, originalBody + '原文'.repeat(8000))
    const owner = getDeviceWorkface(); await owner.updateConversation({ version: 1, drafts: Array.from({ length: 31 }, (_, index) => ['large-original-draft-' + index, 'x'.repeat(65536)]), attempts: [], responses: [] })
    const v = await f.view(); await choose(v.element, '新对话使用的 Agent', 'fixture')
    await waitFor(() => expect(owner.snapshot().record.moteQuickDrafts?.[0]?.values.executorId).toBe('fixture'))
    const before = localStorage.getItem(DEVICE_WORKFACE_KEY)
    await submit(v.element); await waitFor(() => expect(v.element.textContent).toContain('原 Host 已确认保存'))
    expect(f.writes).toHaveBeenCalledTimes(1); expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before)
    expect(v.element.textContent).toContain('尚未进入设备备份')
    await click(button(v.element, '复制配置与请求'))
    const copied = JSON.parse(f.copy.mock.calls.at(-1)![0] as string)
    expect(copied.attempts[0].input.baseline.document.content).toBe(originalBody + '原文'.repeat(8000))
    expect(copied.attempts[0].input.values).toEqual({ executorId: 'fixture' }); expect(copied.attempts[0].phase).toBe('unknown'); expect(copied.attempts[0].result.status).toBe('saved')
    expect(parseMoteQuickMode(await readFile(f.path, 'utf8'))).toEqual({ status: 'valid', defaults: { executorId: 'fixture' } })
  })
  it('creates a deleted MOTE.md with empty defaults through real writers, without fabricating an unchanged document', async () => {
    const f = await original(); await rm(f.path)
    const read = await f.read(); expect(read.source.result.status).toBe('deleted')
    const input = { kind: 'quick', target: f.target, baseline: moteQuickBaseline(read)!, values: {},
      destination: read.choices.destinations[0].reference, operationId: 'explicit-empty-create' }
    const inputPath = join(root, 'save.json'); await writeFile(inputPath, JSON.stringify(input))
    const cli = await parseAgentMuxCliInvocation(['space', 'mote', 'preferences', 'save', '--input', inputPath])
    const result: any = await f.call(cli.command.method, cli.params)
    expect(result.status).toBe('saved'); expect(result.source.document).not.toBeNull()
    expect(f.creates).toHaveBeenCalledTimes(1); expect(f.writes).toHaveBeenCalledTimes(1)
    expect(parseMoteQuickMode(await readFile(f.path, 'utf8'))).toEqual({ status: 'valid', defaults: {} })
  })
  it('never turns a completed real writer into refused-before-write when receipt assembly/codec rejects it', async () => {
    const f = await original(), read = await f.read()
    vi.spyOn(preferenceCodec, 'parseMotePreferencesSaveResult').mockImplementationOnce(() => { throw new Error('reject original receipt assembly') })
      .mockImplementationOnce(() => { throw new Error('reject revalidation of completed writer') })
    const outcome = await f.call('space.mote.preferences.save', { kind: 'quick', target: f.target, baseline: moteQuickBaseline(read)!, values: { executorId: 'fixture' },
      destination: read.choices.destinations[0].reference, operationId: 'original-post-writer-codec-failure' })
      .then(result => ({ resolved: true, result }), error => ({ resolved: false, error: String(error) }))
    expect(outcome).toMatchObject({ resolved: true, result: { status: 'unconfirmed', source: null } })
    expect(f.writes).toHaveBeenCalledTimes(1)
    expect(parseMoteQuickMode(await readFile(f.path, 'utf8'))).toEqual({ status: 'valid', defaults: { executorId: 'fixture' } })
  })
  it('refuses stale revision/exact occurrence and decodes only the admitted operation receipt; unchanged is a no-write step', async () => {
    const f = await original(), read = await f.read(), base = { kind: 'quick', target: f.target, baseline: moteQuickBaseline(read)!,
      destination: read.choices.destinations[0].reference, values: { executorId: 'fixture' }, operationId: 'original-quick-op' }
    await writeFile(f.path, originalBody + '\nexternal later text')
    expect(await f.call('space.mote.preferences.save', base)).toMatchObject({ status: 'refused-before-write', operationId: base.operationId, source: null })
    expect(await f.call('space.mote.preferences.save', { ...base, baseline: moteQuickBaseline(await f.read()), destination: { ...base.destination, regionId: 'foreign' } })).toMatchObject({ status: 'refused-before-write' })
    expect(f.writes).not.toHaveBeenCalled()
    const fresh = await f.read(), params = { ...base, baseline: moteQuickBaseline(fresh)!, values: fresh.defaults }
    const result: any = await f.call('space.mote.preferences.save', params)
    expect(result.status).toBe('unchanged'); expect(f.writes).not.toHaveBeenCalled()
    expect(() => parseMotePreferencesSaveResult({ ...result, operationId: 'another-operation' }, params)).toThrow('another original request')
  })
})
