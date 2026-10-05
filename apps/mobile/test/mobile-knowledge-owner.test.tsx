import './mobile-lan-crypto.setup'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxRpcService, type ExecutionHost } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { TopicKnowledge, TopicKnowledgeWrite } from '@agentmux/core/control'
import { ScratchTopics } from '../../desktop/src/main/scratch-topics'
import { TopicKnowledgeOwner } from '../../desktop/src/main/topic-knowledge'
import { TopicSpatialOwner } from '../../desktop/src/main/topic-spatial-owner'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files'
import { SCRATCH_WORKSPACE_ID } from '../../desktop/src/shared/scratch-topics'
import { MobileTopicKnowledge, MobileTopicKnowledgeEditor } from '../src/topics/MobileTopicKnowledge'
import { getDeviceWorkface, emptyDeviceWorkface, DEVICE_WORKFACE_KEY, DeviceWorkfaceStore } from '../src/recovery/device-workface'
import { freezeMobileKnowledgeInput, mobileKnowledgeDraftKey } from '../src/recovery/knowledge-drafts'
import type { MobileKnowledgeReference } from '../src/recovery/presentation-route'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('Avatar decoding is not consumed by this content-only owner proof.') } } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const scope = { origin: 'http://192.168.2.45:8443', runtimeId: 'original-knowledge-runtime', deviceHostId: 'original-device-host' }
const topicId = 'view:mobile-knowledge-owner', firstId = '11111111-1111-4111-8111-111111111111', entryId = '22222222-2222-4222-8222-222222222222'
let directory: string, topicDirectory: string, files: WorkspaceFiles, owner: TopicKnowledgeOwner, service: AgentMuxRpcService, entry: TopicKnowledge
let fault = false
const mounts: { root: Root; element: HTMLDivElement }[] = []
beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-mobile-knowledge-')))
  const path = join(directory, 'scratch'); await mkdir(path)
  const workspace = { id: SCRATCH_WORKSPACE_ID, name: 'Private Topics', hostId: 'local', path, kind: 'folder' as const }
  const scratch = new ScratchTopics(), state = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost), { localWriteFault: () => { if (fault) { fault = false; return 'receipt' } return undefined } })
  owner = new TopicKnowledgeOwner(scratch, files, () => workspace)
  owner.setSpatialPort(new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => owner.listTopicSnapshots(),
    categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
  service = new AgentMuxRpcService({ topics: owner, coreClients: () => [] })
  topicDirectory = (await owner.call('topic.create', { topicId, title: '原真实 Knowledge Topic' })).topic.directoryPath
  await owner.call('topic.knowledge.write', { topicId, entryId: firstId, title: '首条无关知识', content: '不能按第一条代替原对象',
    form: 'derived', certainty: 'fact', sources: [], expectedRevision: null })
}, 30000)
beforeEach(async () => {
  fault = false; localStorage.clear()
  await getDeviceWorkface().replaceBackup({ ...emptyDeviceWorkface(), hostUrl: scope.origin, host: { origin: scope.origin, hostId: scope.deviceHostId } })
  const current = await owner.call('topic.knowledge.read', { topicId, entryId })
  entry = (await owner.call('topic.knowledge.write', { topicId, entryId, title: '准确第二知识', content: '原基线完整正文',
    form: 'reference', certainty: 'fact', sources: [{ kind: 'topic', topicId, chatId: 'original-chat', threadId: 'original-thread' }],
    expectedRevision: current.entry?.revision ?? null })).entry
})
afterEach(async () => {
  for (const view of mounts.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  vi.restoreAllMocks()
})
afterAll(async () => { await files?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }) })
async function waitFor(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 }) }
async function mount(options: { draftKey?: string; restored?: boolean; scopeSurface?: MobileKnowledgeReference; offline?: boolean } = {}) {
  const forwardRpc = vi.fn((method: any, input: any) => service.call(method, input, { principal: { kind: 'device', id: 'controlled-original-device' } }))
  let identity = { runtimeId: scope.runtimeId, ownerInstanceId: 'original-process', availability: 'connected' }
  const client = { forwardRpc, runtimeOwnerIdentity: () => identity } as unknown as AgentMuxHostedClient
  const onSaved = vi.fn(), onReferenceChange = vi.fn(), onDraftKeyChange = vi.fn()
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounts.push({ root, element })
  const target = options.restored ? { topicId, entryId, ...(options.draftKey ? { draftKey: options.draftKey } : {}) } : { topicId, entryId, entry, scope }
  const render = async (connected = !options.offline, visible = true, reference = options.scopeSurface) => {
    await act(async () => root.render(options.scopeSurface ? <MobileTopicKnowledge rpc={forwardRpc as any} client={connected ? client : null} connected={connected}
      topicId={topicId} title="原真实Topic" visible={visible} {...(reference ? { initialReference: reference } : {})} onReferenceChange={onReferenceChange} openSource={vi.fn()} />
      : <MobileTopicKnowledgeEditor rpc={forwardRpc as any} client={connected ? client : null} connected={connected} target={target} onSaved={onSaved} onClose={vi.fn()} onDraftKeyChange={onDraftKeyChange} />))
  }
  await render()
  const click = async (text: string) => {
    const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text && !value.closest('[hidden]'))
    expect(button, text).toBeDefined(); await act(async () => button!.click())
  }
  const edit = async (text: string) => {
    const input = element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
    expect(input).not.toBeNull()
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const save = async () => { await act(async () => element.querySelector('section[aria-label="知识编辑"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
  return { element, root, render, click, edit, save, forwardRpc, onSaved, onReferenceChange, onDraftKeyChange,
    rebind(kind: 'runtime' | 'instance' | 'both') { identity = { ...identity, runtimeId: kind === 'instance' ? scope.runtimeId : 'different-runtime', ownerInstanceId: kind === 'runtime' ? 'original-process' : 'different-process' } } }
}
async function unmount(view: Awaited<ReturnType<typeof mount>>) {
  await act(async () => view.root.unmount()); view.element.remove(); mounts.splice(mounts.findIndex(value => value.root === view.root), 1)
}
function text(view: Awaited<ReturnType<typeof mount>>) { return view.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!.value }
const writes = (view: Awaited<ReturnType<typeof mount>>) => view.forwardRpc.mock.calls.filter(([method]) => method === 'topic.knowledge.write')
const stored = () => getDeviceWorkface().snapshot().record.knowledgeDrafts!.find(value => value.topicId === topicId && value.entryId === entryId)!
async function gate(view: Awaited<ReturnType<typeof mount>>) {
  const normal = view.forwardRpc.getMockImplementation()!
  let release!: () => void
  view.forwardRpc.mockImplementationOnce(async (method, input) => { const result = await normal(method, input); return await new Promise(resolve => { release = () => resolve(result) }) })
  await view.save(); await waitFor(() => expect(release).toBeTypeOf('function'))
  return async () => { await act(async () => release()) }
}

it('explicit New retains the empty original ID and null revision across unmount; only a later filled Save creates that exact Host entry', async () => {
  const first = await mount({ scopeSurface: { topicId, entryId: null, view: 'list' } })
  await first.click('新建知识')
  let reference!: MobileKnowledgeReference
  await waitFor(() => {
    reference = first.onReferenceChange.mock.calls.map(([value]) => value).find(value => value.view === 'edit' && value.draftKey)!
    expect(reference?.draftKey).toBeTypeOf('string')
    const committed = new DeviceWorkfaceStore(() => localStorage).snapshot().record.knowledgeDrafts?.find(value => value.entryId === reference.entryId)
    expect(committed).toMatchObject({ topicId, entryId: reference.entryId, scope, title: '', content: '', expectedRevision: null, attempts: [], blockedAttemptId: null })
  })
  expect(reference.entryId).not.toBe(entryId); expect(reference.entryId).not.toBe(firstId)
  expect(reference.draftKey).toBe(mobileKnowledgeDraftKey(topicId, reference.entryId!, scope))
  expect(writes(first)).toHaveLength(0)
  expect((await owner.call('topic.knowledge.read', { topicId, entryId: reference.entryId! })).entry).toBeNull()
  await unmount(first)

  const restored = await mount({ scopeSurface: reference })
  expect(text(restored)).toBe('')
  expect(restored.element.querySelector<HTMLInputElement>('[aria-label="知识标题"]')!.value).toBe('')
  expect(writes(restored)).toHaveLength(0)
  await act(async () => {
    const title = restored.element.querySelector<HTMLInputElement>('[aria-label="知识标题"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, '后来明确填写的知识')
    title.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await restored.edit('空意图重开之后明确填写的完整正文'); await restored.save()
  await waitFor(() => expect(restored.element.querySelector('.mobile-topic-reading')?.textContent).toContain('空意图重开之后明确填写的完整正文'))
  expect(writes(restored)).toHaveLength(1)
  expect(writes(restored)[0]![1]).toMatchObject({ topicId, entryId: reference.entryId, title: '后来明确填写的知识',
    content: '空意图重开之后明确填写的完整正文', expectedRevision: null })
  expect(writes(restored)[0]![1]).not.toHaveProperty('attemptId')
  expect(JSON.parse(await readFile(join(topicDirectory, 'knowledge', reference.entryId + '.json'), 'utf8')).content).toBe('空意图重开之后明确填写的完整正文')
  const committed = new DeviceWorkfaceStore(() => localStorage).snapshot().record.knowledgeDrafts!.find(value => value.entryId === reference.entryId)!
  expect(committed).toMatchObject({ entryId: reference.entryId, content: '空意图重开之后明确填写的完整正文', attempts: [], blockedAttemptId: null })
  expect(committed.expectedRevision).not.toBeNull()
  expect((await owner.call('topic.knowledge.read', { topicId, entryId })).entry?.content).toBe('原基线完整正文')
})

it('real Topic/WorkspaceFiles → public codec → mounted editor freezes the second entry input and keeps later text after its actual committed response', async () => {
  const view = await mount(), originalRevision = entry.revision
  const editScope = async (value: string) => act(async () => {
    const field = view.element.querySelector<HTMLInputElement>('[aria-label="知识适用范围"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await editScope('原知识的明确适用范围')
  await view.edit('明确这次保存的完整正文')
  const release = await gate(view), input = writes(view)[0]![1] as TopicKnowledgeWrite
  expect(input).toEqual({ topicId, entryId, title: entry.title, content: '明确这次保存的完整正文', form: entry.form, certainty: entry.certainty,
    sources: entry.sources, scope: '原知识的明确适用范围', expectedRevision: originalRevision })
  expect(Object.isFrozen(input)).toBe(true); expect(Object.isFrozen(input.sources[0])).toBe(true); expect(input).not.toHaveProperty('operationId')
  expect(JSON.parse(await readFile(join(topicDirectory, 'knowledge', entryId + '.json'), 'utf8')).content).toBe(input.content)
  expect(stored().attempts[0]?.input).toEqual(input)
  await view.edit('原请求之后继续写的后来正文'); await editScope('后来未发送的适用范围'); await release()
  await waitFor(() => expect(view.onSaved).toHaveBeenCalledWith(expect.objectContaining({ entryId, content: input.content }), true))
  expect(text(view)).toBe('原请求之后继续写的后来正文')
  expect(view.element.querySelector<HTMLInputElement>('[aria-label="知识适用范围"]')!.value).toBe('后来未发送的适用范围')
  expect(stored().scope).toEqual(scope)
  expect((await owner.call('topic.knowledge.read', { topicId, entryId })).entry?.scope).toBe('原知识的明确适用范围')
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.knowledgeDrafts?.[0]).toMatchObject({ content: '原请求之后继续写的后来正文', attempts: [], blockedAttemptId: null })
  expect((await owner.call('topic.knowledge.read', { topicId, entryId: firstId })).entry?.content).toBe('不能按第一条代替原对象')
})

it('original post-write receipt unknown and later draft survive cold mounted restore; inspect does not ACK, explicit adoption retains the old input', async () => {
  const first = await mount(); await first.edit('已实际写入但回执未知的原文'); fault = true
  await first.save(); await waitFor(() => expect(first.element.textContent).toContain('保存未确认'))
  const input = writes(first)[0]![1], originalRevision = input.expectedRevision
  expect(JSON.parse(await readFile(join(topicDirectory, 'knowledge', entryId + '.json'), 'utf8')).content).toBe(input.content)
  await first.edit('后来未发送的完整草稿'); await waitFor(() => expect(stored().content).toBe('后来未发送的完整草稿'))
  const key = mobileKnowledgeDraftKey(topicId, entryId, scope); await unmount(first)
  const restored = await mount({ restored: true, draftKey: key })
  expect(text(restored)).toBe('后来未发送的完整草稿'); expect(stored().attempts[0]?.input).toEqual(input)
  await restored.click('检查原保存结果'); await waitFor(() => expect(restored.element.textContent).toContain('已读回原条目当前版本'))
  expect(writes(restored)).toHaveLength(0); expect(stored().blockedAttemptId).not.toBeNull(); expect(stored().expectedRevision).toBe(originalRevision)
  await restored.click('以检查结果为基准继续编辑'); await waitFor(() => expect(stored().blockedAttemptId).toBeNull())
  expect(stored().attempts[0]?.input).toEqual(input); expect(text(restored)).toBe('后来未发送的完整草稿')
  await restored.save(); await waitFor(() => expect(restored.onSaved).toHaveBeenCalled())
  expect(writes(restored)).toHaveLength(1); expect(writes(restored)[0]![1].expectedRevision).not.toBe(originalRevision)
  expect(stored().attempts.map(value => value.input)).toEqual([input])
  expect((await owner.call('topic.knowledge.read', { topicId, entryId })).entry?.content).toBe('后来未发送的完整草稿')
}, 20000)

it.each(['runtime', 'instance', 'both'] as const)('same client %s rebind cannot settle the original exact attempt or publish its late response', async kind => {
  const view = await mount(); await view.edit('原A请求正文'); const release = await gate(view)
  const before = localStorage.getItem(DEVICE_WORKFACE_KEY), input = writes(view)[0]![1]
  view.rebind(kind); await release()
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before); expect(view.onSaved).not.toHaveBeenCalled()
  expect(stored().attempts[0]?.input).toEqual(input); expect(stored().blockedAttemptId).not.toBeNull()
  expect(view.element.textContent).toContain('保存未确认'); expect(writes(view)).toHaveLength(1)
})

it.each([false, true])('late original receipt cannot change replacement B with the same Topic/entry (unmounted=%s)', async leave => {
  const view = await mount(); await view.edit('A明确请求正文'); const release = await gate(view)
  const previous = getDeviceWorkface().snapshot().record
  await getDeviceWorkface().replaceBackup({ ...previous, knowledgeDrafts: previous.knowledgeDrafts!.map(value => ({ ...value, content: 'B保留正文' })) })
  const before = localStorage.getItem(DEVICE_WORKFACE_KEY)
  if (leave) await unmount(view)
  await release()
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before); expect(stored().content).toBe('B保留正文'); expect(view.onSaved).not.toHaveBeenCalled()
})

it('same-key conflict has explicit device recovery preserving both original unknown inputs without a blind writer call', async () => {
  const view = await mount(); await view.edit('本页原请求正文'); fault = true; await view.save()
  await waitFor(() => expect(view.element.textContent).toContain('保存未确认'))
  const old = stored(), peerInput = freezeMobileKnowledgeInput({ ...old.attempts[0]!.input, content: '另一页原请求正文' })
  const peer = new DeviceWorkfaceStore(() => localStorage)
  await peer.editKnowledgeDraft(old, { ...old, content: '另一页完整正文', attempts: [{ attemptId: 'peer-attempt', ownerInstanceId: 'original-process', input: peerInput, phase: 'unknown', issue: '另一页未知' }], blockedAttemptId: 'peer-attempt' }, peer.recordIdentity())
  await view.edit('本页冲突后完整正文'); await waitFor(() => expect(view.element.textContent).toContain('另一页面已保存同一知识草稿'))
  expect(writes(view)).toHaveLength(1)
  await view.click('明确保留本页正文与双方原请求'); await waitFor(() => expect(stored().attempts).toHaveLength(2))
  expect(stored().content).toBe('本页冲突后完整正文'); expect(stored().attempts.map(value => value.input)).toEqual(expect.arrayContaining([old.attempts[0]!.input, peerInput]))
  expect(writes(view)).toHaveLength(1)
})

it('settlement quota failure preserves original unknown input in actual device export and leaves the later body usable', async () => {
  const view = await mount(); await view.edit('Host明确提交正文'); const release = await gate(view)
  await view.edit('后来正文仍可编辑')
  const write = localStorage.setItem.bind(localStorage)
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, bytes) => {
    if (key === DEVICE_WORKFACE_KEY && JSON.parse(bytes).knowledgeDrafts?.some((value: any) => value.attempts.length === 0)) throw new Error('settlement quota')
    write(key, bytes)
  })
  await release(); await waitFor(() => expect(view.element.textContent).toContain('设备回执保全尚未完成'))
  const exported = getDeviceWorkface().parseBackup(getDeviceWorkface().exportBackup())
  expect(exported.knowledgeDrafts?.[0]?.attempts[0]?.input).toEqual(writes(view)[0]![1])
  expect(exported.knowledgeDrafts?.[0]?.attempts[0]?.phase).toBe('unknown'); expect(text(view)).toBe('后来正文仍可编辑')
  expect(view.onSaved).not.toHaveBeenCalled(); expect(writes(view)).toHaveLength(1)
})

it('adoption waits for actual commit and an I/O failure keeps original blocked unknown revision and later body', async () => {
  const view = await mount(), originalRevision = entry.revision
  await view.edit('原未知保存正文'); fault = true; await view.save(); await waitFor(() => expect(view.element.textContent).toContain('保存未确认'))
  await view.edit('待采用时后来正文'); await view.click('检查原保存结果'); await waitFor(() => expect(view.element.textContent).toContain('已读回原条目当前版本'))
  const write = localStorage.setItem.bind(localStorage)
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, bytes) => {
    if (key === DEVICE_WORKFACE_KEY && JSON.parse(bytes).knowledgeDrafts?.some((value: any) => value.attempts.length && value.blockedAttemptId === null)) throw new Error('adoption quota')
    write(key, bytes)
  })
  await view.click('以检查结果为基准继续编辑'); await waitFor(() => expect(view.element.textContent).toContain('采用版本尚未持久确认'))
  expect(stored().expectedRevision).toBe(originalRevision); expect(stored().blockedAttemptId).not.toBeNull()
  expect(text(view)).toBe('待采用时后来正文'); expect(view.element.textContent).not.toContain('已采用刚读回的 revision')
  expect(writes(view)).toHaveLength(1)
})

it('offline restore uses the explicit full draft key even beside another runtime; late read only checks and never overwrites it', async () => {
  const first = await mount(); await first.edit('原Runtime的后来草稿'); fault = true; await first.save()
  await waitFor(() => expect(first.element.textContent).toContain('保存未确认'))
  const original = stored(), other = { ...original, scope: { ...scope, runtimeId: 'another-runtime' }, content: '不能误选的另一Runtime正文' }
  await getDeviceWorkface().editKnowledgeDraft(null, other, getDeviceWorkface().recordIdentity()); await unmount(first)
  const key = mobileKnowledgeDraftKey(topicId, entryId, scope)
  const reference: MobileKnowledgeReference = { topicId, entryId, view: 'edit', draftKey: key }
  const view = await mount({ scopeSurface: reference, offline: true })
  expect(text(view)).toBe(original.content); expect(view.forwardRpc).not.toHaveBeenCalled()
  await view.edit('离线继续的完整后稿')
  await view.render(true, true, reference); await waitFor(() => expect(view.forwardRpc.mock.calls.some(([method]) => method === 'topic.knowledge.read')).toBe(true))
  expect(text(view)).toBe('离线继续的完整后稿')
  expect(view.onReferenceChange.mock.calls.every(([value]) => value.draftKey === key)).toBe(true)
  expect(writes(view)).toHaveLength(0); expect(stored().attempts[0]?.input).toEqual(original.attempts[0]?.input)
  const count = view.forwardRpc.mock.calls.length; await view.render(true, false, reference)
  expect(view.forwardRpc.mock.calls).toHaveLength(count)
})
