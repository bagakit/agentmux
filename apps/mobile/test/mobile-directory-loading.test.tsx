import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, fixture, mount, mounted, waitForElement } from './conversation-fixture'
import { openPrimary } from './mobile-root-navigation'
const pending = vi.hoisted(() => { let release!: () => void; const permit = new Promise<void>(resolve => { release = resolve }); return { permit, release } })
vi.mock('../src/navigation/MobileSpatialNavigation', async original => { await pending.permit; return original() })
afterEach(async () => { pending.release(); for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks(); localStorage.clear() })
it('names each real directory in its retained loading header instead of the generic directory label', async () => {
  localStorage.clear(); window.history.replaceState(null, ''); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  const f = fixture()
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'appearance', dispose: async () => {} })
  f.client.forwardRpc = vi.fn().mockImplementation(async method => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } }
    if (method === 'app.snapshot') return { agents: [] }
    throw new Error('Unconfigured read-only observation: ' + method)
  })
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '已连接' }} platform={createBrowserPlatform()} />)
  for (const label of ['Focus', 'Space', 'Mote']) {
    await openPrimary(view.element, label)
    const heading = await waitForElement(view.element, '.mobile-deferred-header h1')
    expect(heading.textContent).toBe(label)
    const loading = heading.closest('[aria-busy="true"]')!
    expect(loading.getAttribute('aria-label')).toBe('正在加载 ' + label)
    expect(loading.querySelector('[aria-label="手机设置与连接"]')).not.toBeNull()
  }
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
})
