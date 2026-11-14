import { createTopicsOwnerFixture } from './topics-owner-fixture'
import { TopicsTestSurface, KnowledgeTestSurface, topicIntents } from './topics-navigation-fixture'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxRpcService, type ExecutionHost } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { mintObjectId } from '@agentmux/core/object-id'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { ScratchTopics } from '../../desktop/src/main/scratch-topics'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files'
import { SCRATCH_WORKSPACE_ID } from '../../host/src/mote-model'
import { MobileTopicSource } from '../src/topics/MobileTopicSource'
import { DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import type { TopicsRpc } from '../src/topics/MobileTopicKnowledge'
import { fixture as conversationFixture } from './conversation-fixture'
import { MobileApp } from '../src/MobileApp'
import type { TopicsNavigationController } from '../src/topics/topics-navigation'
import { createBrowserPlatform } from '../src/platform/browser'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('Content-only Topics proof does not decode avatars.') } } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mounts: { root: Root; element: HTMLDivElement }[] = []
const resources: { dispose(): Promise<void> }[] = []
afterEach(async () => {
  for (const view of mounts.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  for (const value of resources.splice(0)) { await value.dispose() }
  localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const waitFor = async (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 })
async function click(scope: HTMLElement, text: string) {
  const action = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(value => !value.closest('[hidden]') && (value.textContent === text || value.querySelector('strong')?.textContent === text))
  expect(action, `Original visible action: ${text}`).toBeDefined(); await act(async () => action!.click())
}
async function ownerFixture() {
  const fixture = await createTopicsOwnerFixture(); resources.push(fixture); return fixture
}
async function surface(f: Awaited<ReturnType<typeof ownerFixture>>) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounts.push({ root, element })
  const opened = vi.fn(), context = vi.fn(), reference = vi.fn(), workface = vi.fn((topic, visible) => <div data-original-discussion={topic.topicId} data-active={visible}>{topic.title}</div>)
  let navigation!: TopicsNavigationController, wide = true, visible = true, sourceActive = false
  const render = async (next: { wide?: boolean; visible?: boolean; sourceActive?: boolean } = {}) => {
    wide = next.wide ?? wide; visible = next.visible ?? visible
    if (next.sourceActive !== undefined && next.sourceActive !== sourceActive) {
      sourceActive = next.sourceActive
      await act(async () => navigation.send(sourceActive ? { type: 'source-open', source: f.source } : { type: 'source-leave' }))
    }
    await act(async () => root.render(<div className="mobile-topics-host"><TopicsTestSurface rpc={f.rpc} client={f.client} connected visible={visible} wide={wide}
      onController={value => { navigation = value }} onIntent={opened}
      onProjection={route => { context(route.context); reference(route.knowledge) }} renderWorkface={workface} openSource={opened}
      /><div className="mobile-topics-source-slot" hidden={!sourceActive}><MobileTopicSource source={f.source} rpc={f.rpc} presentation={{ presented: visible && sourceActive, observed: visible && sourceActive }} onBack={() => {}} openScope={() => {}} /></div></div>))
  }
  await render()
  await waitFor(() => expect(element.querySelector(`[data-topic-category="${f.category.categoryId}"]`)).not.toBeNull())
  await click(element, 'Original category')
  await waitFor(() => expect(element.querySelector('.mobile-topics-topic')?.textContent).toContain(f.topic.title))
  await click(element, 'Original Topic')
  return { element, render, opened, context, reference, workface }
}

it('keeps the exact original Topic navigation beside its discussion, without width navigation or duplicate hidden reads', async () => {
  const f = await ownerFixture(), v = await surface(f)
  const directory = v.element.querySelector<HTMLElement>('.mobile-topics-directory')!, row = v.element.querySelector('.mobile-topics-topic')!
  const reading = v.element.querySelector('[data-original-discussion]')!
  expect(directory.hidden, 'Responsive Topic navigation must remain visible after exact Topic selection.').toBe(false)
  expect(row.getAttribute('aria-current')).toBe('page')
  expect(topicIntents(v.opened)).toEqual([{ type: 'topic', topicId: f.topic.topicId }])
  const before = v.context.mock.calls.at(-1)![0]
  await v.render({ wide: false }); expect(directory.hidden).toBe(true)
  await v.render({ wide: true }); expect(directory.hidden).toBe(false)
  expect(v.element.querySelector('[data-original-discussion]')).toBe(reading)
  expect(v.element.querySelector('.mobile-topics-topic')).toBe(row)
  expect(v.context.mock.calls.at(-1)![0]).toEqual(before)
  expect(topicIntents(v.opened)).toHaveLength(1)
  const count = f.call.mock.calls.length
  await v.render({ visible: false }); await v.render({ wide: false }); await v.render({ wide: true })
  expect(f.call.mock.calls).toHaveLength(count)
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.read')).toHaveLength(0)
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.ls').every(([, input]) => input.categoryId === f.category.categoryId)).toBe(true)
})

it('retains the same original knowledge editor, caret, draft and Source reader while the original list stays beside it', async () => {
  const f = await ownerFixture(), v = await surface(f)
  await click(v.element, '知识')
  await waitFor(() => expect(v.element.textContent).toContain(f.entry.title))
  await click(v.element, f.entry.title)
  await waitFor(() => expect(v.element.querySelector('.mobile-topic-reading')?.textContent).toContain(f.entry.content))
  const directory = v.element.querySelector<HTMLElement>('.mobile-topics-knowledge-scope:not([hidden]) .mobile-knowledge-directory')!
  expect(directory.hidden, 'Responsive knowledge navigation must remain visible after exact entry selection.').toBe(false)
  await click(v.element, '编辑知识')
  const editor = v.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'Original unsaved later draft.')
    editor.dispatchEvent(new Event('input', { bubbles: true })); editor.focus(); editor.setSelectionRange(5, 12)
  })
  await waitFor(() => expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.knowledgeDrafts?.some(value => value.entryId === f.entry.entryId && value.content === editor.value)).toBe(true))
  const backup = getDeviceWorkface().exportBackup()
  await v.render({ wide: false }); await v.render({ wide: true })
  expect(v.element.querySelector('[aria-label="知识正文"]')).toBe(editor)
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([5, 12])
  await v.render({ sourceActive: true })
  await waitFor(() => expect(v.element.querySelector('.mobile-topics-source-slot article')?.textContent).toContain('Original file owner bytes.'))
  const sourceReader = v.element.querySelector('.mobile-topics-source-slot .mobile-topic-source-reader')!
  expect(sourceReader.matches('.mobile-topics-primary')).toBe(false)
  expect(sourceReader.querySelector('.mobile-topics-workspace')).toBeNull()
  expect(directory.hidden).toBe(false)
  expect(editor.closest('.mobile-knowledge-content')?.hasAttribute('hidden')).toBe(true)
  await v.render({ wide: false }); await v.render({ wide: true })
  expect(v.element.querySelector('.mobile-topics-source-slot .mobile-topic-source-reader')).toBe(sourceReader)
  await v.render({ sourceActive: false })
  expect(v.element.querySelector('[aria-label="知识正文"]')).toBe(editor)
  expect(editor.value).toBe('Original unsaved later draft.')
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([5, 12])
  expect(getDeviceWorkface().exportBackup()).toBe(backup)
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(0)
  expect((await f.owner.call('topic.knowledge.read', { topicId: f.topic.topicId, entryId: f.entry.entryId })).entry?.content).toBe(f.entry.content)
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.read').map(([, input]) => input)).toEqual([{ topicId: f.topic.topicId, entryId: f.entry.entryId }])
})

it('withdraws the actual in-flight knowledge read while its Source owns the reading pane, then rereads only that exact entry', async () => {
  const f = await ownerFixture(), v = await surface(f)
  await click(v.element, '知识')
  await waitFor(() => expect(v.element.textContent).toContain(f.entry.title))
  const original = f.call.getMockImplementation()!
  let release!: () => void, held = false
  f.call.mockImplementation(async (method, input) => {
    const result = await original(method, input)
    if (method === 'topic.knowledge.read' && !held) {
      held = true
      return new Promise(resolve => { release = () => resolve(result) })
    }
    return result
  })
  await click(v.element, f.entry.title)
  await waitFor(() => expect(release).toBeTypeOf('function'))
  await v.render({ sourceActive: true })
  await act(async () => release())
  expect(v.element.querySelector('.mobile-topic-reading h2'), 'A hidden knowledge reader must not commit its delayed body while Source is active.').toBeNull()
  const count = f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.read').length
  await v.render({ visible: false }); await v.render({ wide: false }); await v.render({ wide: true })
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.read')).toHaveLength(count)
  await v.render({ visible: true, sourceActive: false })
  await waitFor(() => expect(v.element.querySelector('.mobile-topic-reading h2')?.textContent).toBe(f.entry.title))
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.read').map(([, input]) => input)).toEqual([
    { topicId: f.topic.topicId, entryId: f.entry.entryId }, { topicId: f.topic.topicId, entryId: f.entry.entryId },
  ])
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(0)
})

it('actual App leaves original Source A only for explicit knowledge B or discussion navigation, keeping original draft and no business dispatch', async () => {
  const f = await ownerFixture(), sdk = conversationFixture()
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024)
  window.dispatchEvent(new Event('resize'))
  sdk.client.runtimeOwnerIdentity = f.client.runtimeOwnerIdentity!
  sdk.client.forwardRpc = (async (method, input) => method === 'goal.ls' ? { goals: [], unavailable: [] } : f.rpc(method, input)) as TopicsRpc
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: f.scope.origin, panel: 'conversation' }, {
    primary: 'topics', showSession: false, showGoalWork: false, identity: null, profile: null,
    topics: { context: { categoryId: null, topicId: null, mode: 'discussion' }, sources: [] },
  })
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounts.push({ root, element })
  await act(async () => root.render(<MobileApp restoreWorkface client={sdk.client} connection={{ state: 'connected', message: 'Original private Host' }} platform={createBrowserPlatform()} />))
  await waitFor(() => expect(element.querySelector('.mobile-navigation')).not.toBeNull())
  await click(element.querySelector('.mobile-navigation')!, 'Topics')
  await waitFor(() => expect(element.querySelector('.mobile-topics-tree')?.textContent).toContain(f.category.title))
  const topics = element.querySelector<HTMLElement>('.mobile-topics-primary')!
  await click(topics, f.category.title)
  await waitFor(() => expect(topics.querySelector('.mobile-topics-topic')?.textContent).toContain(f.topic.title))
  await click(topics, f.topic.title); await click(topics, '知识')
  await waitFor(() => expect(topics.textContent).toContain(f.entry.title))
  await click(topics, f.entry.title)
  await waitFor(() => expect(topics.querySelector('.mobile-topic-reading h2')?.textContent).toBe(f.entry.title))
  await click(topics, '编辑知识')
  const editor = topics.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'Source A original unsaved knowledge draft.')
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await waitFor(() => expect(getDeviceWorkface().snapshot().record.knowledgeDrafts?.some(value => value.entryId === f.entry.entryId && value.content === editor.value)).toBe(true))
  const draft = structuredClone(getDeviceWorkface().snapshot().record.knowledgeDrafts)
  await click(topics, '返回阅读')
  const openOriginalSource = async () => {
    await act(async () => topics.querySelector<HTMLButtonElement>('.mobile-topic-reading:not([hidden]) .mobile-topic-source')!.click())
    await waitFor(() => expect(element.querySelector('.mobile-source-host:not([hidden])')?.textContent).toContain('Original file owner bytes.'))
  }
  await openOriginalSource()
  expect(topics.querySelector<HTMLElement>('.mobile-knowledge-directory:not([hidden])')).not.toBeNull()
  await click(topics, '刷新')
  expect(element.querySelector('.mobile-source-host')?.hasAttribute('hidden')).toBe(false)
  await click(topics, f.first.title)
  expect(element.querySelector('.mobile-source-host')?.hasAttribute('hidden'), 'Explicit knowledge navigation must leave the original Source instead of keeping stale Source A.').toBe(true)
  await waitFor(() => {
    const reading = topics.querySelector('.mobile-topic-reading:not([hidden])')!
    expect(reading.closest('[hidden]')).toBeNull()
    expect(reading.querySelector('h2')?.textContent).toBe(f.first.title)
    expect(reading.textContent).toContain(f.first.content)
  })
  expect(getDeviceWorkface().snapshot().record.presentation?.topics?.sources).toEqual([])
  expect(getDeviceWorkface().snapshot().record.presentation?.topics?.knowledge?.entryId).toBe(f.first.entryId)
  expect(topics.querySelector('[aria-label="知识正文"]')).toBe(editor)
  expect(editor.value).toBe('Source A original unsaved knowledge draft.')
  await click(topics, f.entry.title)
  await waitFor(() => expect(topics.querySelector('.mobile-topic-reading h2')?.textContent).toBe(f.entry.title))
  await openOriginalSource(); await click(topics, '讨论')
  await waitFor(() => {
    expect(element.querySelector('.mobile-source-host')?.hasAttribute('hidden')).toBe(true)
    const workface = topics.querySelector('.mobile-topic-workface:not([hidden])')!
    expect(workface.closest('[hidden]')).toBeNull()
    expect(workface.querySelector('.mobile-zone-workface')?.getAttribute('aria-label')).toBe(`${f.topic.title} 的讨论与内容`)
  })
  expect(getDeviceWorkface().snapshot().record.presentation?.topics?.context).toMatchObject({ topicId: f.topic.topicId, mode: 'discussion' })
  expect(getDeviceWorkface().snapshot().record.knowledgeDrafts).toEqual(draft)
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(0)
  expect(sdk.submit).not.toHaveBeenCalled(); expect(sdk.respond).not.toHaveBeenCalled(); expect(sdk.signalAgent).not.toHaveBeenCalled()
})
