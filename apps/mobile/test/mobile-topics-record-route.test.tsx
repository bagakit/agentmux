import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintObjectId } from '@agentmux/core/object-id'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { mobileKnowledgeDraftKey } from '../src/recovery/knowledge-drafts'
import { button, click, deferred, fixture, mount, mounted } from './conversation-fixture'

const connected = { state: 'connected' as const, message: 'Original connected test client' }
const hostId = 'original-topic-host', workspaceId = 'original-topic-workspace', zoneId = 'original-file-zone'
const ids = { category: mintObjectId(), otherCategory: mintObjectId(), topic: mintObjectId(), otherTopic: mintObjectId(), entry: mintObjectId(), otherEntry: mintObjectId() }
const revision = 'sha256:' + 'a'.repeat(64)
const navigation = { selectedSessionId: null, hostUrl: location.origin, panel: 'conversation' as const }
function originalClient() {
  const f = fixture()
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-topic-runtime', ownerInstanceId: 'original-topic-process', availability: 'connected' })
  const category = { categoryId: ids.category, hostId, spaceId: 'category-space', directoryPath: fixturePath("scratch/second"), title: 'Second Category', revision: null }
  const topic = { topicId: ids.topic, hostId, zoneId: 'topic-zone', directoryPath: fixturePath("scratch/second/topic"), title: 'Second Topic', summary: '',
    categorySpaceIds: ['category-space'], chatIds: [], spatialRevision: 1 }
  const entry = { topicId: ids.topic, entryId: ids.entry, title: 'Second Knowledge', content: 'Original second knowledge', form: 'derived' as const,
    certainty: 'proposal' as const, sources: [{ kind: 'file' as const, hostId, path: fixturePath("workspace") }], revision, updatedAt: 1 }
  const catalog = { spaces: [], zones: [{ zoneId, workspaceId, hostId, directoryPath: fixturePath("workspace"), kind: 'folder', branch: null }],
    tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [], motePresentation: [] }
  const file = (path: string) => ({ resource: { hostId, workspaceId, workspacePath: fixturePath("workspace"), zoneId, zonePath: fixturePath("workspace"), path },
    result: path === '.' ? { status: 'directory' } : { status: 'read', document: { path, content: '# ' + path, revision } } })
  const rpc = vi.fn().mockImplementation(async (method: string, params: any) => {
    if (method === 'goal.ls') return { goals: [], unavailable: [] }
    if (method === 'topic.category.ls') return { categories: [{ ...category, categoryId: ids.otherCategory, title: 'First Category' }, category], unavailable: [] }
    if (method === 'topic.ls') return { topics: [topic], unavailable: [] }
    if (method === 'topic.inspect') return { topic, unavailable: [] }
    if (method === 'topic.knowledge.ls') return { entries: [{ ...entry, entryId: ids.otherEntry, title: 'First Knowledge' }, entry], documents: [], unavailable: [] }
    if (method === 'topic.knowledge.read') return { entry: { ...entry, entryId: params.entryId } }
    if (method === 'topic.knowledge.write') throw new Error('Controlled mounted test response unavailable')
    if (method === 'app.snapshot') return { workspaces: [{ workspaceId, hostId, path: fixturePath("workspace"), name: 'Original Folder' }], unavailable: [] }
    if (method === 'file.read') return file(params.path)
    if (method === 'file.list') return { resource: file(params.path).resource, result: { status: 'listed', files: ['first.md', 'second.md'], complete: true, omitted: 'none', partialReason: null } }
    return { catalog }
  })
  f.client.forwardRpc = rpc
  return { ...f, rpc, entry, file }
}
async function typeBody(element: HTMLElement, text: string) {
  const input = element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function unmount(view: Awaited<ReturnType<typeof mount>>) {
  const at = mounted.findIndex(item => item.element === view.element)
  await act(async () => mounted[at]!.root.unmount()); mounted.splice(at, 1); view.element.remove()
}
async function enterKnowledge(f: ReturnType<typeof originalClient>) {
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Topics'))
  const topics = view.element.querySelector<HTMLElement>('section[aria-label="Topics"]')!
  await vi.waitFor(() => expect(topics.textContent).toContain('Second Category'))
  await click(button(topics, 'Second Category')); await click(button(topics, 'Second Topic'))
  await click(button(topics.querySelector<HTMLElement>('[aria-label="Topic 内容"]')!, '知识'))
  const knowledge = topics.querySelector<HTMLElement>('[aria-label="Second Topic知识"]')!
  await vi.waitFor(() => expect(knowledge.textContent).toContain('Second Knowledge'))
  await click(button(knowledge, 'Second Knowledge提案'))
  await vi.waitFor(() => expect(knowledge.querySelector('h2')?.textContent).toBe('Second Knowledge'))
  return { view, knowledge }
}
beforeEach(async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  await getDeviceWorkface().confirmHost({ origin: location.origin, hostId })
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); window.history.replaceState(null, '')
})

describe('actual App Topics route consumes original device fields', () => {
  it('writes accurate Knowledge and File child references through UI, then reopens without replacing the record or unknown input', async () => {
    const f = originalClient(), owner = getDeviceWorkface(), { view, knowledge } = await enterKnowledge(f)
    await click(button(knowledge, '编辑知识')); await typeBody(knowledge, 'Original frozen save body')
    await click(button(knowledge, '保存知识'))
    await vi.waitFor(() => expect(knowledge.textContent).toContain('保存未确认'))
    await typeBody(knowledge, 'Later body remains unsent')
    const scope = { origin: location.origin, runtimeId: 'original-topic-runtime', deviceHostId: hostId }
    const key = mobileKnowledgeDraftKey(ids.topic, ids.entry, scope)
    await vi.waitFor(() => expect(owner.snapshot().record.knowledgeDrafts?.[0]?.content).toBe('Later body remains unsent'))
    await click(button(knowledge, '返回阅读'))
    await click(knowledge.querySelector('.mobile-topic-source')!)
    await vi.waitFor(() => expect(view.element.querySelector('.mobile-topic-source-reader')?.textContent).toContain('second.md'))
    await click(button(view.element.querySelector<HTMLElement>('.mobile-topic-source-reader')!, 'second.md'))
    await vi.waitFor(() => {
      const reference = owner.snapshot().record.presentation?.topics?.sources[0]?.content
      expect(reference?.kind === 'file' && reference.trail.at(-1)?.target.path).toBe('second.md')
    })
    const saved = owner.snapshot().record, frame = saved.presentation!.topics!.sources[0]!
    expect(frame.originKnowledge).toMatchObject({ topicId: ids.topic, entryId: ids.entry, view: 'read', draftKey: key })
    expect(frame.content?.kind === 'file' && frame.content.trail.at(-1)?.target.path).toBe('second.md')
    const request = saved.knowledgeDrafts![0]!.attempts[0]!.input
    expect(request.content).toBe('Original frozen save body')
    const recordId = owner.recordIdentity(), writes = f.rpc.mock.calls.filter(([method]) => method === 'topic.knowledge.write').length
    await unmount(view)
    // Original stored record and draft are the only input to the new actual App.
    const restored = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await vi.waitFor(() => expect(restored.element.querySelector('.mobile-topic-source-reader h1')?.textContent).toBe('second.md'))
    const reader = restored.element.querySelector<HTMLElement>('.mobile-topic-source-reader')!
    await click(button(reader, '返回上层来源')); await click(button(reader, '返回知识'))
    const restoredKnowledge = restored.element.querySelector<HTMLElement>('[aria-label="Second Topic知识"]')!
    await vi.waitFor(() => expect(restoredKnowledge.querySelector('h2')?.textContent).toBe('Second Knowledge'))
    await click(button(restoredKnowledge, '继续编辑草稿'))
    expect(restoredKnowledge.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')?.value).toBe('Later body remains unsent')
    expect(owner.recordIdentity()).toBe(recordId)
    expect(owner.snapshot().record.knowledgeDrafts![0]!.attempts[0]!.input).toEqual(request)
    expect(f.rpc.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(writes)
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })

  it('does not write a late old Source reference or navigation into an explicitly replaced record', async () => {
    const f = originalClient(), owner = getDeviceWorkface(), { view, knowledge } = await enterKnowledge(f)
    const pending = deferred<any>(), original = f.rpc.getMockImplementation()!
    f.rpc.mockImplementation(async (method: string, params: any) => method === 'file.read' ? pending.promise : original(method, params))
    await click(knowledge.querySelector('.mobile-topic-source')!)
    await vi.waitFor(() => expect(f.rpc.mock.calls.some(([method]) => method === 'file.read')).toBe(true))
    await owner.replaceBackup({ ...emptyDeviceWorkface(), ...navigation, host: { origin: location.origin, hostId },
      conversation: { version: 1, drafts: [['new-record-only', 'New record body']], attempts: [], responses: [] } })
    const adopted = structuredClone(owner.snapshot().record)
    await act(async () => pending.resolve(f.file('.')))
    expect(owner.snapshot().record).toEqual(adopted)
    expect(owner.snapshot().record.presentation).toBeUndefined()
    expect(owner.snapshot().record.knowledgeDrafts).toBeUndefined()
    await vi.waitFor(() => expect(view.element.textContent).toContain('暂时无法保存导航位置'))
  })
})
