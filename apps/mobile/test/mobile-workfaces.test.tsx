import './mobile-lan-crypto.setup'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { AgentMuxRpcService } from '@agentmux/core'
import { createHostGoals } from '../../host/src/goals'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { getDeviceWorkface } from '../src/recovery/device-workface'
import type { MobilePresentationRoute } from '../src/recovery/presentation-route'
import { createTopicsOwnerFixture } from './topics-owner-fixture'
import { fixture as conversationFixture } from './conversation-fixture'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('This original content fixture does not decode avatars.') } } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const resources: { dispose(): Promise<void> }[] = [], mounts: { root: Root; element: HTMLDivElement }[] = []
afterEach(async () => {
  for (const item of mounts.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  await vi.dynamicImportSettled()
  for (const item of resources.splice(0)) await item.dispose()
  localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '')
})
const wait = async (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 })
const visible = (element: HTMLElement, selector: string) => [...element.querySelectorAll<HTMLElement>(selector)].find(value => !value.closest('[hidden]')) ?? null
async function click(element: HTMLElement, label: string) {
  expect(label).toBeTypeOf('string'); expect(label.length).toBeGreaterThan(0)
  let found: HTMLButtonElement | undefined
  await wait(() => {
    found = [...element.querySelectorAll<HTMLButtonElement>('button')].find(value => !value.closest('[hidden]') &&
      (value.getAttribute('aria-label') === label || value.textContent?.trim() === label || value.querySelector('strong')?.textContent === label))
    expect(found, label).toBeDefined()
  })
  await act(async () => found!.click())
}
async function mountedApp(showSession: boolean) {
  const f = await createTopicsOwnerFixture(), sdk = conversationFixture()
  const nativeCalls = vi.fn(async () => { throw new Error('This read-only workface fixture does not authorize native Agent control.') })
  const projects = async () => []
  const goals = createHostGoals({ configurationPath: join(dirname(f.source.path), 'goals.json'), projects,
    runtime: () => { throw new Error('Native Goal execution is not supplied by this original read fixture.') }, coreCall: nativeCalls })
  resources.push({ dispose: async () => { await goals.dispose(); await f.dispose() } })
  const { demand: goal } = await goals.demands.create({ title: 'Original exact Goal', description: 'Original Goal owner detail.' })
  const goalService = new AgentMuxRpcService({ coreClients: () => [], execute: async request => {
    const result = await goals.execute(request, undefined)
    if (!result) throw new Error('No unrelated control fixture: ' + request.operation)
    return result
  } })
  const listed = await goalService.call('goal.ls', { limit: 1000 }, { principal: { kind: 'device', id: 'private-workface-device' } })
  expect(listed.goals.map(value => value.id)).toContain(goal.id)
  const rpc = vi.fn(async (method: string, input: any) => method.startsWith('goal.')
    ? goalService.call(method as any, input, { principal: { kind: 'device', id: 'private-workface-device' } })
    : method === 'app.snapshot' ? { ...await f.rpc(method, input), projects: await projects() } : f.rpc(method as any, input))
  sdk.client.runtimeOwnerIdentity = f.client.runtimeOwnerIdentity!
  sdk.client.forwardRpc = rpc as typeof f.rpc
  const route: MobilePresentationRoute = { primary: 'topics', showSession, showGoalWork: false, identity: null, profile: null,
    topics: { context: { categoryId: f.category.categoryId, topicId: f.topic.topicId, mode: 'knowledge' },
      knowledge: { topicId: f.topic.topicId, entryId: f.entry.entryId, view: 'read' },
      sources: [{ source: f.source, origin: { categoryId: f.category.categoryId, topicId: f.topic.topicId, mode: 'knowledge' } }] } }
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: f.scope.origin, panel: 'conversation' }, route)
  const recordId = getDeviceWorkface().recordIdentity()
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390)
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844)
  window.dispatchEvent(new Event('resize'))
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounts.push({ root, element })
  await act(async () => root.render(<MobileApp restoreWorkface client={sdk.client} connection={{ state: 'connected', message: 'Original Host' }} platform={createBrowserPlatform()} />))
  return { f, sdk, goals, goal, rpc, nativeCalls, route, recordId, element }
}
const sourceReads = (view: Awaited<ReturnType<typeof mountedApp>>) => view.f.call.mock.calls.filter(([method]) => method === 'file.read')
async function savedFrontier() { const current = await getDeviceWorkface().preparePageReload(); expect(current()).toBe(true); return getDeviceWorkface().snapshot().record }

it('actual Root Goals header and Back consume the current primary without popping a retained Topics Source', async () => {
  const view = await mountedApp(false)
  await wait(() => expect(view.element.querySelector('.mobile-topic-source-reader article h1')?.textContent).toBe('Exact original source'))
  const reader = view.element.querySelector('.mobile-topic-source-reader')!, stack = structuredClone((await savedFrontier()).presentation!.topics!.sources)
  expect(stack).toHaveLength(1)
  const reads = sourceReads(view).length
  await click(view.element.querySelector('.mobile-navigation')!, 'Goals')
  await click(view.element, view.goal.title)
  await wait(() => expect(visible(view.element, 'article[aria-label="目标详情"]')?.textContent).toContain(view.goal.description))
  expect(visible(view.element, '.mobile-goals header h1')?.textContent).toBe(view.goal.title)
  expect(visible(view.element, '.mobile-topic-source-reader')).toBeNull()
  expect(view.rpc).toHaveBeenCalledWith('goal.inspect', { goalId: view.goal.id })
  await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 0)) })
  const saved = await savedFrontier()
  expect(saved.presentation!.topics!.sources, 'Current Goals Back must not pop the retained Topics Source.').toEqual(stack)
  await wait(() => expect(getDeviceWorkface().snapshot().record.presentation?.goals?.goalId ?? null).toBeNull())
  expect(getDeviceWorkface().recordIdentity()).toBe(view.recordId)
  expect(view.element.querySelector('.mobile-topic-source-reader')).toBe(reader)
  expect(sourceReads(view)).toHaveLength(reads)
  expect(view.sdk.submit).not.toHaveBeenCalled(); expect(view.sdk.respond).not.toHaveBeenCalled(); expect(view.sdk.signalAgent).not.toHaveBeenCalled(); expect(view.nativeCalls).not.toHaveBeenCalled()
})

it('actual Root Agent overlay does not activate its retained Topics Source reader and preserves the original record', async () => {
  const view = await mountedApp(true)
  await wait(() => expect(visible(view.element, '[contenteditable="true"]')).not.toBeNull())
  await vi.dynamicImportSettled()
  expect(sourceReads(view), 'An Agent overlay must not activate the retained Source directory.').toHaveLength(0)
  await act(async () => view.element.querySelector<HTMLButtonElement>('[data-mobile-back]')!.click())
  await wait(() => expect(view.element.querySelector('.mobile-topic-source-reader article h1')?.textContent).toBe('Exact original source'))
  const reader = view.element.querySelector('.mobile-topic-source-reader')!, stack = structuredClone((await savedFrontier()).presentation!.topics!.sources)
  const reads = sourceReads(view).length
  await click(view.element.querySelector('.mobile-source-header')!, '手机设置与连接')
  await click(document.body, '提醒与诊断')
  await click(document.body, '返回这段对话')
  await wait(() => expect(visible(view.element, '[contenteditable="true"]')).not.toBeNull())
  expect(view.element.querySelector('.mobile-topic-source-reader')).toBe(reader)
  expect(visible(view.element, '.mobile-topic-source-reader')).toBeNull()
  expect(sourceReads(view), 'Returning to the original Agent must not reread its retained Source.').toHaveLength(reads)
  const saved = await savedFrontier()
  expect(saved.presentation!.topics!.sources).toEqual(stack)
  expect(saved.presentation!.showSession).toBe(true); expect(saved.selectedSessionId).toBe('session-original')
  expect(getDeviceWorkface().recordIdentity()).toBe(view.recordId)
  expect(view.sdk.submit).not.toHaveBeenCalled(); expect(view.sdk.respond).not.toHaveBeenCalled(); expect(view.sdk.signalAgent).not.toHaveBeenCalled(); expect(view.nativeCalls).not.toHaveBeenCalled()
})
