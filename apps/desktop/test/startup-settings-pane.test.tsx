// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { GeneralSettingsPane } from '../src/renderer/src/components/settings/GeneralSettingsPane'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

function startupControls() {
  const group = [...dom.container.querySelectorAll<HTMLElement>('.settings-group')].find(element => element.querySelector('header > span')?.textContent === 'Startup checks')!
  expect(group).toBeDefined()
  return { group, input: group.querySelector<HTMLInputElement>('input[type="checkbox"]')!, summary: group.querySelector('header > small')! }
}

function saveButton() { return dom.container.querySelector<HTMLButtonElement>('[data-settings-pane="general"] [data-settings-save-bar] button, [data-settings-save-bar] button')! }

it('the actual General module defaults unchecked and saves only startup through the original ConfigOwner while retaining concurrent fields', async () => {
  const f = await configOwnerFixture()
  useAppStore.setState({ config: f.owner.current })
  const release = f.owner.subscribe(saved => useAppStore.setState({ config: saved }))
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected!, next))
  await dom.render(<SettingsPanel initialSection="general" onClose={() => {}} />)
  const controls = startupControls()
  expect(controls.input.checked).toBe(false)
  expect(controls.group.textContent).toContain('continues in the background')
  expect(controls.group.textContent).toContain('Applies on the next startup')
  expect(controls.summary.textContent).toContain('Wait for Agent availability')
  expect(saveButton().disabled).toBe(true)
  expect(f.save).not.toHaveBeenCalled()
  await act(async () => controls.input.click())
  expect(controls.input.checked).toBe(true)
  expect(controls.summary.textContent).toContain('Wait for Agent availability')
  await act(async () => { await f.owner.update(current => ({ ...current, copyPathsAsAbsolute: true, notes: { fontSize: 18 } })) })
  await act(async () => saveButton().click())
  expect(save).toHaveBeenCalledOnce()
  await act(async () => { await save.mock.results[0]!.value })
  expect(f.owner.current.startup).toEqual({ skipAgentAvailabilityCheckWait: true })
  expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
  expect(f.owner.current.notes).toEqual({ fontSize: 18 })
  expect((await f.disk()).startup).toEqual({ skipAgentAvailabilityCheckWait: true })
  expect(startupControls().summary.textContent).toContain('Continue while checking')
  expect(saveButton().disabled).toBe(true)
  release()
})

it('editing another General field keeps the optional startup domain absent', async () => {
  const f = await configOwnerFixture()
  useAppStore.setState({ config: f.owner.current })
  const save = vi.spyOn(api.config, 'save').mockImplementation((next, expected) => f.owner.edit(expected!, next))
  await dom.render(<SettingsPanel initialSection="general" onClose={() => {}} />)
  await dom.click('[data-settings-pane="general"] input[type="checkbox"]')
  await act(async () => saveButton().click())
  expect(save).toHaveBeenCalledOnce()
  await act(async () => { await save.mock.results[0]!.value })
  expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
  expect(f.owner.current.startup).toBeUndefined()
  expect((await f.disk()).startup).toBeUndefined()
})

it('the startup draft retains its expected value through failure, retry and a later pending edit', async () => {
  let reject!: (cause: Error) => void
  const onSave = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
  await dom.render(<GeneralSettingsPane copyPathsAsAbsolute={false} onSave={onSave} />)
  const controls = startupControls()
  await act(async () => controls.input.click())
  await act(async () => saveButton().click())
  const expected = { copyPathsAsAbsolute: false, skipAgentAvailabilityCheckWait: false }
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ ...expected, skipAgentAvailabilityCheckWait: true }, expected)
  await act(async () => reject(new Error('Could not save startup preference')))
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Could not save startup preference')
  expect(controls.input.checked).toBe(true)
  expect(controls.summary.textContent).toContain('Wait for Agent availability')
  let finish!: () => void
  onSave.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await act(async () => saveButton().click())
  expect(onSave.mock.calls[1]).toEqual([{ ...expected, skipAgentAvailabilityCheckWait: true }, expected])
  await act(async () => controls.input.click())
  await dom.render(<GeneralSettingsPane copyPathsAsAbsolute={false} skipAgentAvailabilityCheckWait onSave={onSave} />)
  await act(async () => finish())
  expect(controls.input.checked).toBe(false)
  expect(startupControls().summary.textContent).toContain('Continue while checking')
  expect(saveButton().disabled).toBe(false)
})

it('General search and Overview consume the same startup preference without editing it', async () => {
  const save = vi.spyOn(api.config, 'save')
  await dom.render(<SettingsPanel onClose={() => {}} />)
  const summary = () => dom.container.querySelector('[data-settings-overview] [data-settings-section="general"] .settings-overview__summary')!.textContent
  expect(summary()).toContain('Wait for Agent availability')
  const config = useAppStore.getState().config!
  await act(async () => useAppStore.setState({ config: { ...config, startup: { skipAgentAvailabilityCheckWait: true } } }))
  expect(summary()).toContain('Continue while checking')
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'startup')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect([...dom.container.querySelectorAll('nav[aria-label="Settings sections"] button')].map(element => element.textContent)).toEqual(['General'])
  expect(save).not.toHaveBeenCalled()
  expect(config.startup).toBeUndefined()
})
