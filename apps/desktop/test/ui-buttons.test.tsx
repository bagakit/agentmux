// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { act, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Button } from '@agentmux/client-ui/components/Button'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { appearanceSettingsModule } from '../src/renderer/src/components/settings/modules/appearance'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'

let root: Root, container: HTMLDivElement
const initial = useAppStore.getState()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const render = async (content: ReactNode) => { await act(async () => root.render(content)) }

it('keeps native default and submit actions distinct, forwards the ref and respects explicit disabled', async () => {
  const ordinary = createRef<HTMLButtonElement>(), submit = vi.fn(), action = vi.fn()
  await render(<form onSubmit={event => { event.preventDefault(); submit() }}>
    <Button ref={ordinary} id="ordinary" className="own-surface" aria-busy onClick={action}>Inspect</Button>
    <Button id="submit" variant="primary" type="submit">Save</Button>
    <Button id="disabled" variant="danger" disabled onClick={action}>Delete</Button>
  </form>)
  const button = container.querySelector<HTMLButtonElement>('#ordinary')!
  expect(button.type).toBe('button'); expect(ordinary.current).toBe(button)
  expect(button.getAttribute('aria-busy')).toBe('true'); expect(button.disabled).toBe(false)
  button.focus(); expect(document.activeElement).toBe(button)
  expect(button.className).toBe('small-button own-surface')
  await act(async () => button.click())
  expect(action).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled()
  const disabled = container.querySelector<HTMLButtonElement>('#disabled')!
  expect(disabled.className).toBe('danger-button'); expect(disabled.disabled).toBe(true)
  await act(async () => disabled.click())
  expect(action).toHaveBeenCalledTimes(1)
  const save = container.querySelector<HTMLButtonElement>('#submit')!
  expect(save.className).toBe('primary-button'); expect(save.type).toBe('submit')
  await act(async () => save.click())
  expect(submit).toHaveBeenCalledTimes(1)
})

it('keeps a named busy icon action usable and retains explicit native title and ARIA', async () => {
  const ref = createRef<HTMLButtonElement>(), action = vi.fn()
  await render(<><IconButton ref={ref} id="icon" aria-label="Inspect original target" aria-busy aria-describedby="detail" onClick={action}><span aria-hidden="true">i</span></IconButton>
    <span id="detail">Original operation retained</span>
    <IconButton id="danger-icon" intent="danger" aria-label="Delete original target" title="Inspect the exact target before deletion" disabled onClick={action}>×</IconButton></>)
  const icon = container.querySelector<HTMLButtonElement>('#icon')!
  expect(icon.type).toBe('button'); expect(icon.getAttribute('aria-label')).toBe('Inspect original target')
  expect(icon.title).toBe('Inspect original target'); expect(icon.getAttribute('aria-describedby')).toBe('detail')
  expect(icon.getAttribute('aria-busy')).toBe('true'); expect(icon.disabled).toBe(false); expect(ref.current).toBe(icon)
  icon.focus(); expect(document.activeElement).toBe(icon)
  await act(async () => icon.click()); expect(action).toHaveBeenCalledTimes(1)
  const danger = container.querySelector<HTMLButtonElement>('#danger-icon')!
  expect(danger.title).toBe('Inspect the exact target before deletion')
  expect(danger.className).toBe('icon-button icon-button--danger'); expect(danger.disabled).toBe(true)
  await act(async () => danger.click()); expect(action).toHaveBeenCalledTimes(1)
})

function ActualAppearance() {
  const config = useAppStore(state => state.config)
  return config ? <appearanceSettingsModule.Pane config={config} active /> : null
}
const saveButton = () => container.querySelector<HTMLButtonElement>('.settings-appearance > [data-settings-save-bar] button')!
const light = () => container.querySelector<HTMLInputElement>('input[aria-label="Light"]')!

it('saves the real Settings draft through its original module and durable owner, retaining failure and explicit retry', async () => {
  const f = await configOwnerFixture({ appearance: { appAppearance: 'dark', terminalTheme: 'graphite', terminalFontSize: 18 } })
  const originalDrafts = { retained: 'Keep the unsent Agent input' }
  useAppStore.setState({ config: f.owner.current, agentComposerDrafts: originalDrafts })
  const publish = f.publish.getMockImplementation()!
  f.publish.mockImplementation(config => { publish(config); useAppStore.getState().setConfig(config) })
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected, next))
  await render(<ActualAppearance />)
  const button = saveButton(); expect(button).not.toBeNull(); expect(button.className).toBe('primary-button')
  expect(button.disabled).toBe(true)
  await act(async () => light().click())
  expect(button.disabled).toBe(false); expect(light().checked).toBe(true)
  const release = deferred<void>()
  f.save.mockImplementationOnce(async () => { await release.promise; throw new Error('The original settings disk is unavailable') })
  try {
    await act(async () => button.click())
    expect(button.getAttribute('aria-busy')).toBe('true'); expect(button.disabled).toBe(true)
    await act(async () => button.click()); expect(save).toHaveBeenCalledTimes(1)
  } finally { await act(async () => release.resolve()) }
  await act(async () => { await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe('The original settings disk is unavailable')) })
  expect(saveButton()).toBe(button); expect(light().checked).toBe(true); expect(button.disabled).toBe(false)
  expect((await f.disk()).appearance.appAppearance).toBe('dark')
  expect(useAppStore.getState().agentComposerDrafts).toBe(originalDrafts)
  await act(async () => button.click())
  expect(save).toHaveBeenCalledTimes(2)
  await act(async () => { await save.mock.results[1]!.value })
  expect(container.querySelector('.settings-save-feedback')?.textContent?.trim()).toBe('Changes saved')
  expect(save).toHaveBeenCalledTimes(2); expect(saveButton()).toBe(button); expect(button.disabled).toBe(true)
  expect((await f.disk()).appearance.appAppearance).toBe('light')
  expect(save.mock.calls.map(([next, expected]) => [next.appearance.appAppearance, expected.appearance.appAppearance])).toEqual([['light', 'dark'], ['light', 'dark']])
  expect(useAppStore.getState().agentComposerDrafts).toBe(originalDrafts)
})

it('loads the four canonical button styles from one shared owner in both stylesheet entries', () => {
  const shared = readFileSync('packages/client-ui/src/styles/buttons.css', 'utf8')
  const base = readFileSync('apps/desktop/src/renderer/src/styles/base.css', 'utf8')
  const canonical = ['small-button', 'primary-button', 'danger-button', 'icon-button']
  expect(canonical.length).toBeGreaterThan(0)
  for (const name of canonical) {
    expect(shared).toContain('.' + name)
    expect(base).not.toMatch(new RegExp('^\\.' + name + '(?:[ ,:{.]|--)','m'))
  }
  expect(readFileSync('packages/client-ui/src/styles/index.css', 'utf8')).toContain("@import './buttons.css'")
  expect(readFileSync('apps/desktop/src/renderer/src/styles/index.css', 'utf8')).toContain("@import '@agentmux/client-ui/styles/buttons.css'")
})
