import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { mobileKnowledgeDraftKey } from '../src/recovery/knowledge-drafts'
import { click, fixture, mount, mounted } from './conversation-fixture'

const native = vi.hoisted(() => ({ back: null as (() => void) | null }))
vi.mock('../src/platform/native/device', async original => ({ ...await original<Record<string, unknown>>(),
  bindNativeDevice: vi.fn((value: { onBack(): void }) => { native.back = value.onBack; return { dispose: async () => { native.back = null } } }) }))
const context = { categoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', topicId: 'view:original-topic', mode: 'knowledge' as const }
const category = { categoryId: context.categoryId, title: '原分类', hostId: 'host-original', spaceId: 'original-category-space', directoryPath: fixturePath("workspace/category"), revision: 'original-category-revision' }
const topic = { topicId: context.topicId, title: '原 Topic', summary: '原说明', hostId: 'host-original', zoneId: 'original-zone', directoryPath: fixturePath("workspace"), categorySpaceIds: [category.spaceId], chatIds: [], spatialRevision: 1 }
const source = { kind: 'file' as const, hostId: 'host-original', path: fixturePath("workspace/docs"), projectId: 'original-project' }
const workspace = { workspaceId: 'original-workspace', hostId: source.hostId, path: fixturePath("workspace"), name: '原项目', projectId: source.projectId, kind: 'folder', repoPath: null, branch: null }
const zone = { zoneId: topic.zoneId, workspaceId: workspace.workspaceId, hostId: source.hostId, directoryPath: workspace.path, kind: 'directory', branch: null }
const resource = { hostId: workspace.hostId, workspaceId: workspace.workspaceId, workspacePath: workspace.path }
const entry = { topicId: topic.topicId, entryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '原知识', content: '# 原知识正文', form: 'reference', certainty: 'fact', revision: 'sha256:' + 'a'.repeat(64), updatedAt: 1, sources: [source] }
const draftScope = { origin: location.origin, runtimeId: 'original-topic-runtime', deviceHostId: source.hostId }
const knowledgeReference = { topicId: topic.topicId, entryId: entry.entryId, view: 'read' as const,
  draftKey: mobileKnowledgeDraftKey(topic.topicId, entry.entryId, draftScope) }
const pin = (path: string) => ({ target: { zoneId: zone.zoneId, path, expectedResource: resource },
  resource: { ...resource, zoneId: zone.zoneId, zonePath: workspace.path, path } })
const presentation = { primary: 'topics' as const, showSession: false, showGoalWork: false, identity: null, profile: null, topics: { context, sources: [] } }
const visibleButton = (element: HTMLElement, label: string) => {
  const found = [...element.querySelectorAll<HTMLButtonElement>('button')].find(value => !value.closest('[hidden]') && value.textContent?.trim() === label)
  expect(found, label).toBeDefined(); return found!
}
beforeEach(async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup({ ...emptyDeviceWorkface(), presentation,
    hostUrl: location.origin, host: { origin: location.origin, hostId: source.hostId } })
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

it('exports and reopens complete original Topic/source frames without persisting catalog, bodies or adopting malformed references', async () => {
  let raw: string | null = null
  const disk = { getItem: () => raw, setItem: (_: string, value: string) => { raw = value } }
  const owner = new DeviceWorkfaceStore(() => disk)
  const route = { ...presentation, topics: { context: { ...context, topicId: 'source-topic', mode: 'discussion' as const }, sources: [
    { source: { kind: 'topic' as const, topicId: 'source-topic', chatId: 'original-chat', threadId: 'original-thread' }, origin: context },
    { source: { kind: 'note' as const, noteId: 'original-note', blockId: 'original-block' }, origin: { ...context, topicId: 'source-topic' } }
  ] } }
  await owner.updatePresentation(emptyDeviceWorkface(), route)
  expect(new DeviceWorkfaceStore(() => disk).snapshot().record.presentation).toEqual(route)
  expect(owner.parseBackup(owner.exportBackup()).presentation).toEqual(route)
  const before = raw
  for (const invalidSource of [{ kind: 'note', noteId: undefined }, { kind: 'file', hostId: 'host-original', path: fixturePath("workspace/docs"), body: 'copied-body' },
    { kind: 'topic', topicId: 'source-topic', runId: 'invented-run' }]) {
    expect(() => owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: {
      ...emptyDeviceWorkface(), presentation: { ...route, topics: { context, sources: [{ source: invalidSource, origin: context }] } }
    } }))).toThrow()
  }
  expect(raw).toBe(before)
  expect(owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: emptyDeviceWorkface() })).presentation).toBeUndefined()
})

it.each(['browser', 'native'])('%s Back leaves the exact cached source child before restoring the original Topic knowledge and retained editor', async mode => {
  const f = fixture()
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: draftScope.runtimeId, ownerInstanceId: 'original-topic-instance', availability: 'connected' })
  f.client.forwardRpc = vi.fn().mockImplementation(async (method: string, params: any) => {
    if (method === 'topic.category.ls') return { categories: [category], unavailable: [] }
    if (method === 'topic.ls') return { topics: [topic], unavailable: [] }
    if (method === 'topic.inspect') return { topic, unavailable: [] }
    if (method === 'topic.knowledge.ls') return { entries: [entry], unavailable: [] }
    if (method === 'topic.knowledge.read') return { entry, unavailable: [] }
    if (method === 'app.snapshot') return { workspaces: [workspace], projects: [], agents: [], executors: [], unavailable: [] }
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [zone], tabs: [], regions: [], locations: [], bindings: [] } }
    if (method === 'file.read') return { resource: { ...resource, zoneId: zone.zoneId, zonePath: workspace.path, path: params.path }, result: params.path === 'docs'
      ? { status: 'directory' } : { status: 'read', document: { path: params.path, content: '# 准确原来源正文', revision: 'sha256:' + 'b'.repeat(64) } } }
    if (method === 'file.list') return { resource: { ...resource, zoneId: zone.zoneId, zonePath: workspace.path, path: params.path }, result: { status: 'listed', files: ['original.md'], complete: true, omitted: 'none', partialReason: null } }
    throw new Error('Unexpected public operation: ' + method)
  })
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} native={mode === 'native'} />)
  await click(visibleButton(view.element, '原知识事实')); await click(visibleButton(view.element, '编辑知识'))
  const draft = view.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, '原 Topic 未保存草稿')
    draft.dispatchEvent(new Event('input', { bubbles: true })); draft.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click(visibleButton(view.element, '返回阅读')); await click(visibleButton(view.element, source.path))
  await act(async () => { await vi.waitFor(() => expect(view.element.querySelector('.mobile-topic-source-reader')?.textContent).toContain('original.md')) })
  expect(getDeviceWorkface().snapshot().record.presentation!.topics!.sources).toEqual([{ source, origin: context,
    originKnowledge: knowledgeReference, content: { kind: 'file', trail: [pin('docs')] } }])
  await click(visibleButton(view.element, 'original.md'))
  await act(async () => { await vi.waitFor(() => expect(view.element.querySelector('.mobile-topic-source-reader article h1')?.textContent).toBe('准确原来源正文')) })
  expect(f.client.forwardRpc).toHaveBeenCalledWith('file.read', { zoneId: zone.zoneId, path: 'docs/original.md', expectedResource: resource })
  const reads = vi.mocked(f.client.forwardRpc!).mock.calls.length
  const back = async () => {
    if (mode === 'native') await act(async () => native.back!())
    else await act(async () => { history.back(); await new Promise(resolve => setTimeout(resolve, 30)) })
  }
  await back()
  expect(view.element.querySelector('.mobile-topic-source-reader article h1')).toBeNull()
  expect(vi.mocked(f.client.forwardRpc!).mock.calls).toHaveLength(reads)
  expect(getDeviceWorkface().snapshot().record.presentation!.topics!.sources).toHaveLength(1)
  await back()
  expect(view.element.querySelector('.mobile-topic-source-reader')).toBeNull()
  expect(getDeviceWorkface().snapshot().record.presentation!.topics).toEqual({ context, sources: [], knowledge: knowledgeReference })
  expect(view.element.querySelector('[aria-label="知识正文"]')).toBe(draft)
  await click(visibleButton(view.element, '继续编辑草稿'))
  expect(draft.value).toBe('原 Topic 未保存草稿'); expect(draft.closest('[hidden]')).toBeNull()
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.some(([method]) => method === 'topic.knowledge.write')).toBe(false)
})
