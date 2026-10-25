// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { DEFAULT_BROWSER_START_PAGE } from '../src/shared/browser-start-page'

const original = useAppStore.getState()
let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); useAppStore.setState(original) })
const field = (label: string) => {
  const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
  expect(input).not.toBeNull(); return input!
}
const input = async (label: string, text: string) => act(async () => {
  const target = field(label)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, text)
  target.dispatchEvent(new Event('input', { bubbles: true }))
})
const click = async (selector: string) => act(async () => {
  const target = host.querySelector<HTMLButtonElement>(selector); expect(target).not.toBeNull(); target!.click()
})
const saved = async (f: Awaited<ReturnType<typeof renderSettings>>) => {
  await act(async () => { await f.uiSave.mock.results.at(-1)!.value })
  expect(host.querySelector('[data-settings-save-bar]')?.textContent).toContain('Changes saved')
}
async function renderSettings() {
  const f = await configOwnerFixture()
  useAppStore.setState({ config: f.owner.current, loading: false })
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (value, expected) => {
    await f.owner.edit(expected!, value); useAppStore.setState({ config: f.owner.current }); return f.owner.current
  })
  await act(async () => root.render(<SettingsPanel initialSection="survey" onClose={() => {}} />))
  return { ...f, uiSave: save }
}

it('the actual Survey Settings module saves count and interactive background through the existing configuration owner', async () => {
  const f = await renderSettings()
  expect(field('Cards on first view').value).toBe('12')
  expect(field('Interactive start page background').checked).toBe(true)
  expect(host.querySelector('[data-settings-field="start-history-limit"]')).not.toBeNull()
  expect(host.querySelector('[data-settings-field="start-interactive-background"]')).not.toBeNull()
  await input('Cards on first view', '18')
  await click('[aria-label="Interactive start page background"]')
  expect(host.querySelector('.settings-survey__history')?.textContent).toContain('18 on first view')
  expect(host.querySelector('.settings-survey__caption')?.textContent).toContain('Interactive background off')
  expect(f.uiSave).not.toHaveBeenCalled()
  await click('[data-settings-save-bar] button')
  await saved(f)
  expect(f.uiSave).toHaveBeenCalledOnce()
  expect(f.uiSave.mock.calls[0]![1]!.browser.startPage).toEqual(DEFAULT_BROWSER_START_PAGE)
  expect((await f.disk()).browser.startPage).toEqual({ historyLimit: 18, interactiveBackground: false })
  expect(f.owner.current.browser.startPage).toEqual({ historyLimit: 18, interactiveBackground: false })
})

it('keeps an empty or invalid numeric draft and does not save until it is corrected', async () => {
  const f = await renderSettings(), before = await f.bytes()
  await input('Cards on first view', '')
  expect(field('Cards on first view').value).toBe('')
  await click('[data-settings-save-bar] button')
  expect(host.textContent).toContain('Use a whole number from 1 to 50')
  expect(field('Cards on first view').value).toBe('')
  expect(f.uiSave).not.toHaveBeenCalled(); expect(await f.bytes()).toBe(before)
  await input('Cards on first view', '51')
  await click('[data-settings-save-bar] button')
  expect(field('Cards on first view').value).toBe('51'); expect(f.uiSave).not.toHaveBeenCalled()
  await input('Cards on first view', '50')
  await click('[data-settings-save-bar] button')
  await saved(f)
  expect((await f.disk()).browser.startPage?.historyLimit).toBe(50)
})

it('retains all changed personalization after a save failure and preserves a later unrelated config edit', async () => {
  const f = await renderSettings()
  f.uiSave.mockRejectedValueOnce(new Error('Configuration disk unavailable'))
  await input('Start page title', 'Reading room')
  await input('Cards on first view', '6')
  await click('[aria-label="Interactive start page background"]')
  await click('[data-settings-save-bar] button')
  expect(host.textContent).toContain('Configuration disk unavailable')
  expect(field('Start page title').value).toBe('Reading room')
  expect(field('Cards on first view').value).toBe('6')
  expect(field('Interactive start page background').checked).toBe(false)
  await act(async () => {
    await f.owner.update(config => ({ ...config, browser: { ...config.browser, agentAutomation: true } }))
    useAppStore.setState({ config: f.owner.current })
  })
  await click('[data-settings-save-bar] button')
  await saved(f)
  expect((await f.disk()).browser.startPage).toEqual({ title: 'Reading room', historyLimit: 6, interactiveBackground: false })
  expect(f.owner.current.browser.agentAutomation).toBe(true)
})
