// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { BrowserSnapshot } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'

const initial = useAppStore.getState()
let container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>, page: BrowserSnapshot
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  page = await api.browser.create('original-browser-recovery', 'https://outside.invalid/retained-route', 'workspace')
  useAppStore.setState({ ...initial, config: await api.config.get(), toolsOpen: false }, true)
  vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.getElementById('agentmux-window-overlay-host')?.remove()
})
async function retry(capsule: boolean) {
  await act(async () => root.render(<BrowserPane visible tab={{ ...page, error: 'The original document needs attention', kind: 'browser',
    regionId: 'original-region', browserId: page.id, workspaceId: 'workspace',
    ...(capsule ? { capsuleId: '23456789ABCD', capsuleOrigin: 'http://127.0.0.1:49152', capsuleActive: false, profileId: null } : {}) }} />))
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === 'Retry')
  expect(button).toBeDefined(); await act(async () => button!.click())
}
it('retries the exact Capsule Browser through restore-aware reload without recreating its partition or external route', async () => {
  const create = vi.spyOn(api.browser, 'create'), reload = vi.spyOn(api.browser, 'reload').mockResolvedValue(page)
  await retry(true)
  expect(reload).toHaveBeenCalledExactlyOnceWith(page.id); expect(create).not.toHaveBeenCalled()
  expect(container.querySelector('[aria-label="Page questions"]')?.closest('.browser-toolbar')).not.toBeNull()
  expect(container.querySelector<HTMLElement>('.capsule-chrome')!.hidden).toBe(true)
})
it('keeps ordinary Browser recovery on its existing creation path', async () => {
  const create = vi.spyOn(api.browser, 'create').mockResolvedValue(page), reload = vi.spyOn(api.browser, 'reload')
  await retry(false)
  expect(create).toHaveBeenCalledExactlyOnceWith(page.id, page.url, 'workspace', page.profileId || undefined, page.mode)
  expect(reload).not.toHaveBeenCalled()
})
