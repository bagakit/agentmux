import './mobile-lan-crypto.setup'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { MobileWebUpdateSafetyProvider } from '../src/mobile-web/update-safety'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

vi.mock('../src/navigation/defer-mobile-surface', async original => {
  const actual = await original<typeof import('../src/navigation/defer-mobile-surface')>()
  return { deferMobileSurface(label: string, load: () => Promise<{ default: React.ComponentType<object> }>) {
    return actual.deferMobileSurface(label, label === '来源工作面'
      ? () => Promise.reject(new Error('Original Topic module unavailable')) : load)
  } }
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear()
})

it('withdraws a failed Topic reopening when its own discussion is hidden inside the still-visible Topics surface', async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const f = fixture(), pending = deferred<() => boolean>()
  const verifyConnection = vi.fn(async () => () => true), prepareReload = vi.fn(() => () => {})
  verifyConnection.mockReturnValueOnce(pending.promise)
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  const fetchEntry = vi.fn(async () => ({ ok: true, url: location.href.split('#')[0] }) as Response)
  vi.stubGlobal('fetch', fetchEntry); vi.spyOn(console, 'error').mockImplementation(() => {})
  const category = { categoryId: 'category-original', title: '工作分类', hostId: 'local', spaceId: 'category-space', directoryPath: fixturePath('workspace/category'), revision: 'category-version' }
  const topic = { topicId: 'topic-original', title: '讨论甲', summary: '', hostId: 'local', zoneId: 'zone-original', directoryPath: fixturePath('workspace/topic'), categorySpaceIds: [category.spaceId], chatIds: [], spatialRevision: 1 }
  f.client.forwardRpc = vi.fn(async method => {
    if (method === 'topic.category.ls') return { categories: [category], unavailable: [] }
    if (method === 'topic.ls') return { topics: [topic], unavailable: [] }
    if (method === 'topic.inspect') return { topic, unavailable: [] }
    if (method === 'agent.inspect') return { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } }
    throw new Error('No unrelated operation: ' + method)
  }) as any
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection} prepareReload={prepareReload}>
    <MobileApp client={f.client} connection={{ state: 'connected', message: '已连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  const originalEditor = editor(view.element)
  await paste(view.element, '返回后继续的草稿')
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Topics'))
  await vi.waitFor(() => expect(button(view.element, '工作分类')).toBeDefined(), { timeout: 10000 })
  await click(button(view.element, '工作分类'))
  await vi.waitFor(() => expect(button(view.element, '讨论甲')).toBeDefined(), { timeout: 10000 })
  await click(button(view.element, '讨论甲'))
  await vi.waitFor(() => expect(view.element.querySelector('.mobile-topic-workface .mobile-deferred-surface')).not.toBeNull(), { timeout: 10000 })
  const originalFailure = view.element.querySelector<HTMLElement>('.mobile-topic-workface')!
  await click(button(originalFailure, '保全并重新打开网页'))
  expect(verifyConnection).toHaveBeenCalledOnce()
  await click(button(view.element, '返回分类目录'))
  expect(originalFailure.hidden).toBe(true)
  expect(view.element.querySelector('.mobile-topics')?.closest('[hidden]')).toBeNull()
  await act(async () => pending.resolve(() => true))
  expect(fetchEntry).not.toHaveBeenCalled(); expect(prepareReload).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
  expect(editor(view.element)).toBe(originalEditor); expect(originalEditor.textContent).toBe('返回后继续的草稿')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})
