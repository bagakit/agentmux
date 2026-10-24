import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, fixture, mount, mounted } from './conversation-fixture'

beforeEach(async () => {
  localStorage.clear()
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)) }
    disconnect() {} unobserve() {}
  })
})
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it.each(['image', 'error'] as const)('keeps the original Space %s and avoids a repeated inspect when an equivalent directory object is returned', async outcome => {
  const f = fixture(), spaceId = 'original-space', pending = deferred<unknown>(), image = 'data:image/png;base64,c3BhY2U='
  const catalog = { spaces: [{ spaceId, kind: 'folder', name: '原项目', hostId: 'host-original', directoryPath: fixturePath('project'), projectId: null }],
    zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [],
    appearance: [{ spaceId, image: { revision: 'original-image' } }] }
  let directories = 0, inspections = 0
  f.client.forwardRpc = vi.fn(async (method: string, params: any) => {
    if (method === 'space.ls') { directories++; return { catalog: structuredClone(catalog) } }
    if (method === 'space.inspect' && params?.target?.spaceId === spaceId) {
      if (++inspections > 1) return pending.promise
      if (outcome === 'error') throw Error('原空间外观读取失败')
      return { catalog: { ...catalog, appearance: [{ spaceId, image: { revision: 'original-image', dataUrl: image } }] } }
    }
    if (method === 'goal.ls') return { goals: [], unavailable: [] }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'topic.ls') return { topics: [], unavailable: [] }
    if (method === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog: structuredClone(catalog) }
  }) as any
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' },
    { primary: 'space', showSession: false, showGoalWork: false, identity: null, profile: null })
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '原 Host' }} platform={createBrowserPlatform()} native />)
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Space'))
  const icon = () => view.element.querySelector<HTMLImageElement>('.mobile-space-row .mobile-space-icon img')
  const notice = () => [...document.querySelectorAll<HTMLElement>('.mobile-avatar-notice')].find(node => !node.closest('[hidden]'))
  if (outcome === 'image') await vi.waitFor(() => expect(icon()?.getAttribute('src')).toBe(image))
  else await vi.waitFor(() => expect(notice()?.textContent).toContain('原空间外观读取失败'))
  expect(inspections).toBe(1)
  const originalDirectories = directories
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await vi.waitFor(() => expect(directories).toBeGreaterThan(originalDirectories))
  if (outcome === 'image') expect.soft(icon()?.getAttribute('src'), '已确认图片在等价目录重建后保留').toBe(image)
  else expect.soft(notice()?.textContent ?? '', '原失败在等价目录重建后保留').toContain('原空间外观读取失败')
  expect.soft(inspections, '等价外观不应触发额外 inspect').toBe(1)
  expect(f.submit).not.toHaveBeenCalled()
})
