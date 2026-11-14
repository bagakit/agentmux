import './mobile-lan-crypto.setup'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { getDeviceWorkface } from '../src/recovery/device-workface'
import type { MobileTopicSourceProps } from '../src/topics/MobileTopicSource'
import type { MobileTopicSourceContentReference } from '../src/topics/source-reference'
import { createTopicsOwnerFixture } from './topics-owner-fixture'
import { fixture as conversationFixture } from './conversation-fixture'

const observed = vi.hoisted(() => ({ reports: [] as { report: NonNullable<MobileTopicSourceProps['onReferenceChange']>; content: MobileTopicSourceContentReference }[] }))
vi.mock('../src/topics/MobileTopicSource', async original => {
  const module = await original<typeof import('../src/topics/MobileTopicSource')>(), { createElement } = await import('react')
  return { ...module, MobileTopicSource: (props: MobileTopicSourceProps) => createElement(module.MobileTopicSource, { ...props,
    onReferenceChange: content => { if (props.onReferenceChange) observed.reports.push({ report: props.onReferenceChange, content }); props.onReferenceChange?.(content) } }) }
})
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('This original file reader does not decode avatars.') } } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, element: HTMLDivElement | undefined, resource: Awaited<ReturnType<typeof createTopicsOwnerFixture>> | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  element?.remove(); await vi.dynamicImportSettled(); await resource?.dispose()
  localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); observed.reports.length = 0
})
const wait = async (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 })
async function click(text: string) {
  const button = [...element!.querySelectorAll<HTMLButtonElement>('button')].find(value => !value.closest('[hidden]') && (value.textContent === text || value.getAttribute('aria-label') === text))
  expect(button, text).toBeDefined(); await act(async () => button!.click())
}

it('actual App rejects a delayed original Source trail after that exact file is reopened in a new frame', async () => {
  const f = resource = await createTopicsOwnerFixture(), sdk = conversationFixture()
  const source = { ...f.source, path: dirname(f.source.path) }
  await f.owner.call('topic.knowledge.write', { topicId: f.topic.topicId, entryId: f.entry.entryId, title: f.entry.title, content: f.entry.content, form: f.entry.form, certainty: f.entry.certainty, sources: [source], expectedRevision: f.entry.revision })
  await writeFile(join(dirname(f.source.path), 'second-source.md'), '# Original second child\n\nOriginal exact child body.')
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024)
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768)
  window.dispatchEvent(new Event('resize'))
  sdk.client.runtimeOwnerIdentity = f.client.runtimeOwnerIdentity!
  sdk.client.forwardRpc = (async (method, input) => method === 'goal.ls' ? { goals: [], unavailable: [] } : f.rpc(method, input)) as typeof f.rpc
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: f.scope.origin, panel: 'conversation' }, {
    primary: 'topics', showSession: false, showGoalWork: false, identity: null, profile: null,
    topics: { context: { categoryId: f.category.categoryId, topicId: f.topic.topicId, mode: 'knowledge' }, sources: [], knowledge: { topicId: f.topic.topicId, entryId: f.entry.entryId, view: 'read' } },
  })
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  await act(async () => root!.render(<MobileApp restoreWorkface client={sdk.client} connection={{ state: 'connected', message: 'Original Host' }} platform={createBrowserPlatform()} />))
  await wait(() => expect(element!.querySelector('.mobile-topic-reading h2')?.textContent).toBe(f.entry.title))
  const openSource = async () => {
    await act(async () => element!.querySelector<HTMLButtonElement>('.mobile-topic-reading:not([hidden]) .mobile-topic-source')!.click())
    await wait(() => expect(element!.querySelector('.mobile-topic-source-reader')?.textContent).toContain('second-source.md'))
  }
  await openSource()
  await click('second-source.md')
  await wait(() => expect(element!.querySelector('.mobile-topic-source-reader article h1')?.textContent).toBe('Original second child'))
  const delayed = observed.reports.findLast(value => value.content.kind === 'file' && value.content.trail.length === 2)!
  expect(delayed).toBeDefined()
  await click('返回上层来源'); await click('返回知识')
  await wait(() => expect(getDeviceWorkface().snapshot().record.presentation?.topics?.sources).toHaveLength(0))
  await openSource()
  await wait(() => {
    const content = getDeviceWorkface().snapshot().record.presentation?.topics?.sources[0]?.content
    expect(content?.kind === 'file' ? content.trail : null).toHaveLength(1)
  })
  const original = structuredClone(getDeviceWorkface().snapshot().record.presentation!.topics!.sources[0]!.content)
  const reader = element.querySelector('.mobile-topic-source-reader')!
  const reads = f.call.mock.calls.filter(([method]) => method === 'file.read').length
  await act(async () => delayed.report(delayed.content))
  const unchanged = await getDeviceWorkface().preparePageReload(); expect(unchanged()).toBe(true)
  expect(getDeviceWorkface().snapshot().record.presentation!.topics!.sources[0]!.content,
    'Old Source metadata must not replace the new frame original trail.').toEqual(original)
  expect(element.querySelector('.mobile-topic-source-reader')).toBe(reader)
  expect(reader.querySelector('article h1')).toBeNull()
  expect(reader.textContent).toContain('original-source.md'); expect(reader.textContent).toContain('second-source.md')
  expect(f.call.mock.calls.filter(([method]) => method === 'file.read')).toHaveLength(reads)
  expect(sdk.submit).not.toHaveBeenCalled(); expect(sdk.respond).not.toHaveBeenCalled(); expect(sdk.signalAgent).not.toHaveBeenCalled()
})

it('actual App opens a Markdown workspace-relative source link through the original zone Files owner and keeps cached Back', async () => {
  const f = resource = await createTopicsOwnerFixture(), sdk = conversationFixture()
  await writeFile(f.source.path, '# Original parent file\n\n[Second child](second-source.md)')
  await writeFile(join(dirname(f.source.path), 'second-source.md'), '# Original linked child\n\nOriginal exact linked bytes.')
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024)
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768)
  window.dispatchEvent(new Event('resize'))
  sdk.client.runtimeOwnerIdentity = f.client.runtimeOwnerIdentity!
  sdk.client.forwardRpc = (async (method, input) => method === 'goal.ls' ? { goals: [], unavailable: [] } : f.rpc(method, input)) as typeof f.rpc
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: f.scope.origin, panel: 'conversation' }, {
    primary: 'topics', showSession: false, showGoalWork: false, identity: null, profile: null,
    topics: { context: { categoryId: f.category.categoryId, topicId: f.topic.topicId, mode: 'knowledge' }, sources: [], knowledge: { topicId: f.topic.topicId, entryId: f.entry.entryId, view: 'read' } },
  })
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  await act(async () => root!.render(<MobileApp restoreWorkface client={sdk.client} connection={{ state: 'connected', message: 'Original Host' }} platform={createBrowserPlatform()} />))
  await wait(() => expect(element!.querySelector('.mobile-topic-reading h2')?.textContent).toBe(f.entry.title))
  await act(async () => element!.querySelector<HTMLButtonElement>('.mobile-topic-reading:not([hidden]) .mobile-topic-source')!.click())
  await wait(() => expect(element!.querySelector('.mobile-topic-source-reader article h1')?.textContent).toBe('Original parent file'))
  const reader = element.querySelector('.mobile-topic-source-reader')!
  const parentRead = f.call.mock.calls.filter(([method]) => method === 'file.read').at(-1)![1]
  const header = reader.querySelector<HTMLElement>('.mobile-source-header')!
  expect(header.querySelector('[aria-label="手机设置与连接"]')).not.toBeNull()
  expect(header.querySelector('[aria-label="返回知识"]')).not.toBeNull()
  expect(header.querySelector('[aria-label="重试读取"]')).not.toBeNull()
  expect(reader.querySelectorAll('.mobile-source-location')).toHaveLength(1)
  expect(reader.querySelector('.mobile-source-location')?.textContent).toContain('来源引用')
  expect(reader.querySelector('.mobile-source-location')?.textContent).toContain('当前文件位置')
  const link = reader.querySelector<HTMLButtonElement>('.md-link--file')!
  expect(link).not.toBeNull()
  await act(async () => link.click())
  const reads = f.call.mock.calls.filter(([method]) => method === 'file.read')
  expect(reads.at(-1)![1], 'Workspace-relative link must call the original zone Files owner with its exact relative target.').toEqual({ ...parentRead, path: 'second-source.md' })
  await wait(() => expect(reader.querySelector('article h1')?.textContent).toBe('Original linked child'))
  expect(reader.textContent).toContain('Original exact linked bytes.')
  const count = f.call.mock.calls.length
  await click('返回上层来源')
  expect(reader.querySelector('article h1')?.textContent).toBe('Original parent file')
  expect(element.querySelector('.mobile-topic-source-reader')).toBe(reader)
  expect(f.call.mock.calls).toHaveLength(count)
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(sdk.submit).not.toHaveBeenCalled(); expect(sdk.respond).not.toHaveBeenCalled(); expect(sdk.signalAgent).not.toHaveBeenCalled()
})
