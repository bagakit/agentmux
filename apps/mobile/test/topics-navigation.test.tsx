import './mobile-lan-crypto.setup'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { mobileKnowledgeDraftKey } from '../src/recovery/knowledge-drafts'
import { getDeviceWorkface, DeviceWorkfaceStore } from '../src/recovery/device-workface'
import type { MobileTopicsRoute } from '../src/recovery/presentation-route'
import { createTopicsNavigation, projectTopicsRoute, knowledgePosition, type TopicsNavigationController, type TopicsNavigationObservation } from '../src/topics/topics-navigation'
import { TopicsTestSurface } from './topics-navigation-fixture'
import { createTopicsOwnerFixture } from './topics-owner-fixture'
import { fixture as conversationFixture } from './conversation-fixture'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('This content consumer does not decode avatars.') } } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mounts: { root: Root; element: HTMLDivElement }[] = [], resources: { dispose(): Promise<void> }[] = []
afterEach(async () => {
  for (const view of mounts.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  await vi.dynamicImportSettled()
  for (const resource of resources.splice(0)) await resource.dispose()
  localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '')
})
const wait = async (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 })
async function fixture() { const value = await createTopicsOwnerFixture(); resources.push(value); return value }
async function click(scope: HTMLElement, text: string) {
  let button: HTMLButtonElement | undefined
  await wait(() => {
    button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(value => !value.closest('[hidden]') && (value.textContent === text || value.querySelector('strong')?.textContent === text))
    expect(button, text).toBeDefined()
  })
  await act(async () => button!.click())
}
async function readEntry(scope: HTMLElement, title: string) {
  await click(scope, title)
  await wait(() => expect([...scope.querySelectorAll<HTMLElement>('.mobile-topic-reading h2')].find(value => !value.closest('[hidden]'))?.textContent).toBe(title))
}
async function fill(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function secondTopic(f: Awaited<ReturnType<typeof fixture>>) {
  const topic = (await f.owner.call('topic.create', { topicId: mintObjectId(), categoryId: f.category.categoryId, title: 'Second exact Topic' })).topic
  const entry = (await f.owner.call('topic.knowledge.write', { topicId: topic.topicId, entryId: mintObjectId(), title: 'Beta exact knowledge', content: 'Second Topic original body.', form: 'derived', certainty: 'fact', sources: [], expectedRevision: null })).entry
  return { topic, entry }
}
async function surface(f: Awaited<ReturnType<typeof fixture>>, route?: MobileTopicsRoute) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounts.push({ root, element })
  let navigation!: TopicsNavigationController
  const observations: TopicsNavigationObservation[] = []
  const render = async (client: AgentMuxHostedClient = f.client) => act(async () => root.render(<TopicsTestSurface client={client} connected wide rpc={f.rpc}
    initialRoute={route ?? { context: { categoryId: f.category.categoryId, topicId: f.topic.topicId, mode: 'knowledge' }, sources: [] }}
    onController={value => { navigation = value }} onObservation={value => observations.push(value)} renderWorkface={(topic, visible) => <div hidden={!visible} data-original-topic={topic.topicId}>{topic.title}</div>}
    openSource={source => { if (source.kind !== 'url') navigation.send({ type: 'source-open', source }) }} />))
  await render()
  await wait(() => expect(element.querySelector('.mobile-topics-primary header h1')).not.toBeNull())
  return { element, root, render, observations, get navigation() { return navigation } }
}
async function chooseTopic(view: Awaited<ReturnType<typeof surface>>, title: string) {
  await act(async () => view.element.querySelector<HTMLButtonElement>('[aria-label="返回分类目录"]')!.click())
  await click(view.element, title); await click(view.element, '知识')
}

it('retains canonical positions for every visited scope and All Topics while keeping separate original editor and reading targets', async () => {
  const f = await fixture(), second = await secondTopic(f), view = await surface(f)
  await readEntry(view.element, f.entry.title); await click(view.element, '编辑知识')
  const firstEditor = view.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  await fill(firstEditor, 'Original A retained unsaved text.')
  await click(view.element, '返回阅读'); await readEntry(view.element, f.first.title)
  await click(view.element, '继续编辑草稿')
  expect(view.element.querySelector('[aria-label="知识正文"]')).toBe(firstEditor)
  await click(view.element, '返回阅读')
  expect(view.element.querySelector('.mobile-topic-reading:not([hidden]) h2')?.textContent).toBe(f.first.title)
  await chooseTopic(view, second.topic.title)
  await wait(() => expect(view.element.textContent).toContain(second.entry.title))
  await readEntry(view.element, second.entry.title); await click(view.element, '编辑知识')
  const secondEditor = [...view.element.querySelectorAll<HTMLTextAreaElement>('[aria-label="知识正文"]')].find(value => !value.closest('[hidden]'))!
  await fill(secondEditor, 'Original B retained unsaved text.')
  await chooseTopic(view, f.topic.title)
  expect(view.element.querySelector('[aria-label="知识正文"]')).toBe(firstEditor)
  expect(firstEditor.value).toBe('Original A retained unsaved text.')
  expect(knowledgePosition(view.navigation.state, second.topic.topicId).view).toBe('edit')
  await click(view.element, '继续编辑草稿')
  expect(firstEditor.closest('[hidden]'), 'Revisiting A must restore the same canonical editor position.').toBeNull()
  expect(secondEditor.value).toBe('Original B retained unsaved text.')
  await act(async () => view.element.querySelector<HTMLButtonElement>('[aria-label="返回分类目录"]')!.click())
  await act(async () => view.element.querySelector<HTMLButtonElement>('[aria-label="返回所有分类"]')!.click())
  await click(view.element, '知识')
  const search = [...view.element.querySelectorAll<HTMLInputElement>('[aria-label="搜索知识"]')].find(value => !value.closest('[hidden]'))!
  await fill(search, 'Beta exact knowledge'); await click(view.element, '搜索')
  await wait(() => expect(view.element.querySelector('.mobile-topics-knowledge-scope:not([hidden])')?.textContent).toContain(second.entry.title))
  await readEntry(view.element, second.entry.title)
  await wait(() => expect(view.element.querySelector('.mobile-topics-knowledge-scope:not([hidden]) .mobile-topic-reading h2')?.textContent).toBe(second.entry.title))
  expect(view.navigation.state.context.topicId).toBeNull()
  expect(knowledgePosition(view.navigation.state, null).reading).toEqual({ topicId: second.topic.topicId, entryId: second.entry.entryId })
  expect(knowledgePosition(view.navigation.state, second.topic.topicId).editor?.entryId).toBe(second.entry.entryId)
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(0)
})

it('late original metadata cannot navigate the current scope or replace its editor, including old client and record observations', async () => {
  const f = await fixture(), second = await secondTopic(f), view = await surface(f)
  await readEntry(view.element, f.entry.title); await click(view.element, '编辑知识')
  await wait(() => expect(view.observations.some(value => value.type === 'draft-key')).toBe(true))
  const original = view.observations.find(value => value.type === 'draft-key')!, originalObserve = view.navigation.observe
  await chooseTopic(view, second.topic.title); await readEntry(view.element, second.entry.title); await click(view.element, '编辑知识')
  const before = view.navigation.route, editor = [...view.element.querySelectorAll<HTMLTextAreaElement>('[aria-label="知识正文"]')].find(value => !value.closest('[hidden]'))!
  await fill(editor, 'Current B original text.')
  await act(async () => originalObserve(original))
  expect(view.navigation.route.context.topicId, 'Metadata from A must not navigate away from current B.').toBe(second.topic.topicId)
  expect(view.element.querySelector('header h1')?.textContent).toBe(second.topic.title)
  expect(editor.closest('[hidden]')).toBeNull(); expect(editor.value).toBe('Current B original text.')
  expect(view.navigation.route.context).toEqual(before.context)
  const rebound = { ...f.client } as AgentMuxHostedClient
  await view.render(rebound)
  const oldState = view.navigation.state
  await act(async () => originalObserve({ ...original, draftKey: 'stale-client-metadata' } as TopicsNavigationObservation))
  expect(view.navigation.state).toBe(oldState)
  const recordObserve = view.navigation.observe
  await getDeviceWorkface().replaceBackup(getDeviceWorkface().parseBackup(getDeviceWorkface().exportBackup()))
  await act(async () => recordObserve({ ...original, draftKey: 'stale-record-metadata' } as TopicsNavigationObservation))
  expect(view.navigation.state).toBe(oldState)
  expect(editor.value).toBe('Current B original text.')
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(0)
})

it('actual App keeps a Topic source return frame through its own knowledge layers, then returns the original scope and draft', async () => {
  const f = await fixture(), second = await secondTopic(f), sdk = conversationFixture()
  const entry = (await f.owner.call('topic.knowledge.write', { topicId: f.topic.topicId, entryId: f.entry.entryId, title: f.entry.title,
    content: f.entry.content, form: f.entry.form, certainty: f.entry.certainty, sources: [{ kind: 'topic', topicId: second.topic.topicId }], expectedRevision: f.entry.revision })).entry
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  sdk.client.runtimeOwnerIdentity = f.client.runtimeOwnerIdentity!
  sdk.client.forwardRpc = (async (method, input) => method === 'goal.ls' ? { goals: [], unavailable: [] } : f.rpc(method, input)) as typeof f.rpc
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: f.scope.origin, panel: 'conversation' }, {
    primary: 'topics', showSession: false, showGoalWork: false, identity: null, profile: null,
    topics: { context: { categoryId: f.category.categoryId, topicId: f.topic.topicId, mode: 'knowledge' }, sources: [], knowledge: { topicId: f.topic.topicId, entryId: entry.entryId, view: 'read' } },
  })
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounts.push({ root, element })
  await act(async () => root.render(<MobileApp restoreWorkface client={sdk.client} connection={{ state: 'connected', message: 'Original Host' }} platform={createBrowserPlatform()} />))
  await wait(() => expect(element.querySelector('.mobile-topic-reading h2')?.textContent).toBe(entry.title))
  await click(element, '编辑知识')
  const original = element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  await fill(original, 'Original App Topic source return draft.')
  await click(element, '返回阅读'); await act(async () => element.querySelector<HTMLButtonElement>('.mobile-topic-reading:not([hidden]) .mobile-topic-source')!.click())
  await wait(() => expect(element.querySelector('.mobile-topics-primary header h1')?.textContent).toBe(second.topic.title))
  await click(element.querySelector('.mobile-topics-primary')!, '知识')
  await wait(() => expect(element.textContent).toContain(second.entry.title))
  await readEntry(element, second.entry.title); await click(element, '编辑知识')
  const sourceEditor = [...element.querySelectorAll<HTMLTextAreaElement>('[aria-label="知识正文"]')].find(value => !value.closest('[hidden]'))!
  expect(sourceEditor).toBeDefined()
  await wait(() => expect(getDeviceWorkface().snapshot().record.presentation?.topics?.sources).toHaveLength(1))
  const categoryReads = f.call.mock.calls.filter(([method]) => method === 'topic.ls').length
  const nativeBack = async () => act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 0)) })
  await nativeBack(); await wait(() => expect(sourceEditor.closest('[hidden]')).not.toBeNull())
  await nativeBack(); await wait(() => expect(getDeviceWorkface().snapshot().record.presentation?.topics?.knowledge?.view).toBe('list'))
  await nativeBack(); await wait(() => expect(getDeviceWorkface().snapshot().record.presentation?.topics?.context.mode).toBe('discussion'))
  expect(getDeviceWorkface().snapshot().record.presentation?.topics?.sources).toHaveLength(1)
  await nativeBack(); await wait(() => expect(getDeviceWorkface().snapshot().record.presentation?.topics?.sources).toHaveLength(0))
  expect(getDeviceWorkface().snapshot().record.presentation?.topics?.context).toEqual({ categoryId: f.category.categoryId, topicId: f.topic.topicId, mode: 'knowledge' })
  expect(element.querySelector('[aria-label="知识正文"]')).toBe(original); expect(original.value).toBe('Original App Topic source return draft.')
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.ls')).toHaveLength(categoryReads)
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(0)
  expect(sdk.submit).not.toHaveBeenCalled(); expect(sdk.respond).not.toHaveBeenCalled(); expect(sdk.signalAgent).not.toHaveBeenCalled()
})

it('restores the unchanged backup shape and exact unknown write while a new draft cancellation returns to its original list', async () => {
  const f = await fixture(), view = await surface(f)
  await click(view.element, '新建知识')
  const empty = view.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  await click(view.element, '返回阅读')
  expect(empty.closest('[hidden]')).not.toBeNull(); expect(view.navigation.route.knowledge?.view).toBe('list')
  await click(view.element, '继续编辑草稿'); expect(view.element.querySelector('[aria-label="知识正文"]')).toBe(empty)
  await click(view.element, '返回阅读'); await readEntry(view.element, f.entry.title); await act(async () => view.element.querySelector<HTMLButtonElement>('.mobile-topic-reading:not([hidden]) .mobile-topics-actions button:last-child')!.click())
  const editor = view.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  await fill(editor, 'Unknown original frozen write.')
  const normal = f.call.getMockImplementation()!
  f.call.mockImplementation(async (method, input) => { const result = await normal(method, input); if (method === 'topic.knowledge.write') throw new Error('Original committed reply unavailable'); return result })
  await click(view.element, '保存知识'); await wait(() => expect(view.element.textContent).toContain('保存未确认'))
  const requests = f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.write')
  expect(requests).toHaveLength(1)
  const frozen = requests[0]![1]
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: f.scope.origin, panel: 'conversation' }, {
    primary: 'topics', showSession: false, showGoalWork: false, identity: null, profile: null, topics: view.navigation.route,
  })
  const backup = getDeviceWorkface().exportBackup(), parsed = getDeviceWorkface().parseBackup(backup)
  expect(parsed.presentation?.topics).toEqual(view.navigation.route)
  expect(Object.keys(parsed.presentation!.topics!).sort()).toEqual(['context', 'knowledge', 'sources'])
  await act(async () => view.root.unmount()); view.element.remove(); mounts.splice(mounts.findIndex(value => value.root === view.root), 1)
  await getDeviceWorkface().replaceBackup(parsed)
  const restored = await surface(f, new DeviceWorkfaceStore(() => localStorage).snapshot().record.presentation!.topics)
  await wait(() => expect(restored.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')?.value).toBe('Unknown original frozen write.'))
  expect(restored.element.textContent).toContain('Original committed reply unavailable')
  const draft = getDeviceWorkface().snapshot().record.knowledgeDrafts!.find(value => value.entryId === f.entry.entryId)!
  expect(draft.attempts[0]?.input).toEqual(frozen)
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(1)
  expect((await f.owner.call('topic.knowledge.read', { topicId: f.topic.topicId, entryId: f.entry.entryId })).entry?.content).toBe('Unknown original frozen write.')
})

it('keeps already confirmed B readable when the original A save reply arrives after navigation, without another B read', async () => {
  const f = await fixture(), view = await surface(f)
  await readEntry(view.element, f.entry.title); await click(view.element, '编辑知识')
  const editor = view.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  await fill(editor, 'Original A explicitly saved text.')
  const normal = f.call.getMockImplementation()!
  let release!: () => void, saving = false, bReads = 0
  f.call.mockImplementation(async (method, input) => {
    if (method === 'topic.knowledge.read' && input.entryId === f.first.entryId && ++bReads > 1) throw new Error('A late reply must not require rereading confirmed B.')
    const result = await normal(method, input)
    if (method === 'topic.knowledge.write') { saving = true; return new Promise(resolve => { release = () => resolve(result) }) }
    return result
  })
  await click(view.element, '保存知识'); await wait(() => expect(saving).toBe(true))
  await readEntry(view.element, f.first.title)
  const reading = view.element.querySelector<HTMLElement>('.mobile-topic-reading:not([hidden])')!
  expect(reading.textContent).toContain(f.first.content)
  await act(async () => release())
  await wait(() => expect(getDeviceWorkface().snapshot().record.knowledgeDrafts!.find(value => value.entryId === f.entry.entryId)?.attempts).toHaveLength(0))
  expect(reading.querySelector('h2')?.textContent, 'Late A receipt must preserve already confirmed B body.').toBe(f.first.title)
  expect(reading.textContent).toContain(f.first.content)
  expect(bReads).toBe(1)
  expect(view.navigation.route.knowledge?.entryId).toBe(f.first.entryId)
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(1)
  expect((await f.owner.call('topic.knowledge.read', { topicId: f.topic.topicId, entryId: f.entry.entryId })).entry?.content).toBe('Original A explicitly saved text.')
})

it('restores an existing All Topics source origin without treating its null scope as a missing Topic', async () => {
  const f = await fixture(), second = await secondTopic(f)
  const first = await surface(f, { context: { categoryId: f.category.categoryId, topicId: null, mode: 'knowledge' }, sources: [], knowledge: { topicId: f.topic.topicId, entryId: f.entry.entryId, view: 'read' } })
  await wait(() => expect(first.element.querySelector('.mobile-topic-reading h2')?.textContent).toBe(f.entry.title))
  await click(first.element, '编辑知识')
  await fill(first.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!, 'All Topics original persisted draft.')
  await wait(() => expect(first.navigation.route.knowledge?.draftKey).toBeTypeOf('string'))
  const knowledge = first.navigation.route.knowledge!
  const route: MobileTopicsRoute = { context: { categoryId: f.category.categoryId, topicId: second.topic.topicId, mode: 'discussion' }, knowledge,
    sources: [{ source: { kind: 'topic', topicId: second.topic.topicId }, origin: { categoryId: f.category.categoryId, topicId: null, mode: 'knowledge' }, originKnowledge: knowledge }] }
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: f.scope.origin, panel: 'conversation' }, {
    primary: 'topics', showSession: false, showGoalWork: false, identity: null, profile: null, topics: route,
  })
  const parsed = getDeviceWorkface().parseBackup(getDeviceWorkface().exportBackup())
  await act(async () => first.root.unmount()); first.element.remove(); mounts.splice(mounts.findIndex(value => value.root === first.root), 1)
  const restored = await surface(f, parsed.presentation!.topics)
  expect(restored.navigation.state.knowledgeScope, 'A retained null All Topics origin must remain the canonical scope.').toBeNull()
  expect(restored.navigation.state.positions.has(f.topic.topicId)).toBe(false)
  const editor = restored.element.querySelector<HTMLTextAreaElement>('[aria-label="知识正文"]')!
  await act(async () => restored.element.querySelector<HTMLButtonElement>('[aria-label="返回知识"]')!.click())
  expect(restored.navigation.route.context.topicId).toBeNull()
  expect(restored.element.querySelector('[aria-label="知识正文"]')).toBe(editor)
  expect(editor.value).toBe('All Topics original persisted draft.')
  expect(editor.closest('[hidden]')).toBeNull()
  expect(restored.navigation.route.knowledge).toEqual(knowledge)
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(0)
})

it('retains the exact accepted current draft reference when a source origin has an earlier editing scope', async () => {
  const f = await fixture()
  const origin = { topicId: f.topic.topicId, entryId: f.entry.entryId, view: 'edit' as const,
    draftKey: mobileKnowledgeDraftKey(f.topic.topicId, f.entry.entryId, { ...f.scope, runtimeId: 'original-prior-runtime' }) }
  const knowledge = { ...origin, draftKey: mobileKnowledgeDraftKey(f.topic.topicId, f.entry.entryId, f.scope) }
  const route: MobileTopicsRoute = { context: { categoryId: f.category.categoryId, topicId: f.topic.topicId, mode: 'knowledge' }, knowledge,
    sources: [{ source: f.source, origin: { categoryId: f.category.categoryId, topicId: f.topic.topicId, mode: 'knowledge' }, originKnowledge: origin }] }
  const parsed = getDeviceWorkface().parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: { ...getDeviceWorkface().snapshot().record,
    presentation: { primary: 'topics', showSession: false, showGoalWork: false, identity: null, profile: null, topics: route } } }))
  expect(projectTopicsRoute(createTopicsNavigation(parsed.presentation!.topics))).toEqual(route)
  expect(f.call.mock.calls.filter(([method]) => method === 'topic.knowledge.write')).toHaveLength(0)
})
