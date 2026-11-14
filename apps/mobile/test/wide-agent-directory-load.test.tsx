import './mobile-lan-crypto.setup'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, editor, fixture, mount, mounted, paste } from './conversation-fixture'
const transport = vi.hoisted(() => { let reject!: (error: Error) => void; const promise = new Promise<never>((_accept, fail) => { reject = fail }); return { promise, reject } })
// Control only the lazy module transport; the App and original load/reload owner remain real.
vi.mock('../src/navigation/defer-mobile-surface', async original => {
  const actual = await original<typeof import('../src/navigation/defer-mobile-surface')>()
  return { deferMobileSurface(label: string, load: Parameters<typeof actual.deferMobileSurface>[1], options: Parameters<typeof actual.deferMobileSurface>[2]) {
    return actual.deferMobileSurface(label, label === '目录' ? () => transport.promise : load, options)
  } }
})
it('wide directory module loading and failure stay reachable in the actual fixed sidebar, preserving the original editor', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const owner = getDeviceWorkface(), f = fixture()
  localStorage.clear(); await owner.replaceBackup(emptyDeviceWorkface()); await owner.updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '原 Host' }} platform={createBrowserPlatform()} />)
  try {
    const aside = view.element.querySelector<HTMLElement>('.mobile-focus-pane')!, original = editor(view.element)
    expect(aside.hasAttribute('hidden')).toBe(false); expect(aside.querySelector('[aria-busy=true]')).not.toBeNull()
    await paste(view.element, '目录失败也保原草稿')
    await act(async () => { transport.reject(new Error('original-directory-module-unavailable')) })
    expect(aside.textContent).toContain('目录暂时无法打开'); expect(aside.textContent).toContain('original-directory-module-unavailable')
    expect(button(aside, '保全并重新打开网页').disabled).toBe(false)
    expect(editor(view.element)).toBe(original); expect(original.textContent).toBe('目录失败也保原草稿')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
  } finally {
    for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
    vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear()
  }
})
