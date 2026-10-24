// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { FocusSettingsPane } from '../src/renderer/src/components/settings/FocusSettingsPane'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { resolveFocusPreferences } from '../src/shared/focus-preferences'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { applyConfigEdit } from '../src/shared/config-edit'
import { focusSettingsModule } from '../src/renderer/src/components/settings/modules/focus'
import { DEFAULT_FOCUS_MAP_PREFERENCES } from '../src/shared/focus-map-preferences'

const dom = composerDOM()
async function select(label: string, value: string) {
  const node = dom.container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  expect(node).not.toBeNull()
  await act(async () => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function number(label: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  expect(node).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('treats equivalent authored Map defaults as unchanged and actually previews compact status information', async () => {
  await dom.render(<FocusSettingsPane preferences={{ map: structuredClone(DEFAULT_FOCUS_MAP_PREFERENCES) }} onSave={async () => {}} />)
  await dom.click('[data-settings-field="map"] > header button')
  expect((dom.container.querySelector('[data-settings-save-bar] button') as HTMLButtonElement).disabled).toBe(true)
  await select('LOD levels', '4')
  const slider = dom.container.querySelector<HTMLInputElement>('[aria-label="Map preview zoom"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '64'); slider.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(dom.container.querySelector('.focus-map-preview__identity .collaboration-agent__status')?.textContent).toContain('Completed')
  expect(dom.container.querySelector('.focus-map-preview__detail')).toBeNull()
})

it('edits complete Map drafts with production preview geometry, keeps invalid input and restores only Map defaults', async () => {
  const save = vi.fn(async () => {}), history = vi.spyOn(api.sessions, 'historySources')
  await dom.render(<FocusSettingsPane preferences={{ recentActivityHours: 12 }} onSave={save} />)
  expect(dom.container.querySelectorAll('.focus-map-settings__boundaries svg path')).toHaveLength(2)
  expect(dom.container.querySelectorAll('.focus-map-settings__boundaries svg path')[0]!.getAttribute('d')).toContain(' Q ')
  expect(dom.container.querySelectorAll('.focus-map-settings__boundaries svg path')[1]!.getAttribute('d')).not.toContain(' Q ')
  await select('LOD levels', '4')
  expect(dom.container.querySelectorAll('.focus-map-settings__levels details')).toHaveLength(4)
  expect(dom.container.querySelector('[aria-label="Level 1 start zoom"]')).toBeNull()
  expect(dom.container.querySelector('.focus-map-preview__canvas')?.getAttribute('data-levels')).toBe('4')
  await select('Level 4 information', 'identity')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Level 4')
  expect((dom.container.querySelector('[data-settings-save-bar] button') as HTMLButtonElement).disabled).toBe(true)
  expect(dom.container.querySelector('.focus-map-preview [role="status"]')?.textContent).toContain('last valid')
  expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="Level 4 information"]')!.value).toBe('identity')
  await select('Level 4 information', 'summary')
  await number('Level 4 start zoom', '40')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('Level 4')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Level 4 start zoom"]')!.value).toBe('40')
  expect(save).not.toHaveBeenCalled()
  await dom.click('[data-settings-field="map"] > header button')
  expect(dom.container.querySelector('[role="alert"]')).toBeNull()
  expect(dom.container.querySelectorAll('.focus-map-settings__levels details')).toHaveLength(3)
  expect(dom.container.querySelector<HTMLInputElement>('input[name="focus-recent-activity"][value="12"]')!.checked).toBe(true)
  expect(history).not.toHaveBeenCalled()
})

it('saves authored Map objects through the original Focus save owner without resetting concurrent Focus fields', async () => {
  let config = { ...composerConfig }
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => { config = applyConfigEdit({ ...config, focus: { recentActivityHours: 24, previewTrigger: 'keyboard' } }, expected!, next); return config })
  const Pane = focusSettingsModule.Pane
  await dom.render(<Pane config={config} active onClose={() => {}} onNavigate={() => {}} />)
  const polygon = dom.container.querySelectorAll<HTMLInputElement>('input[name="focus-map-boundary"]')[1]!
  await act(async () => polygon.click())
  await select('LOD levels', '2')
  await dom.click('[data-settings-save-bar] button')
  expect(save).toHaveBeenCalledTimes(1)
  expect(config.focus?.map?.boundary).toBe('polygon')
  expect(config.focus?.map?.levels).toHaveLength(2)
  expect(config.focus?.previewTrigger).toBe('keyboard')
  expect(dom.container.querySelector('[data-settings-save-bar]')?.textContent).toContain('Changes saved')
  // Fresh equivalent objects from a durable reload must not become new edits.
  await dom.render(<Pane config={structuredClone(config)} active onClose={() => {}} onNavigate={() => {}} />)
  expect((dom.container.querySelector('[data-settings-save-bar] button') as HTMLButtonElement).disabled).toBe(true)
})

it('opens the original Focus Map field without search and preserves the visited editor draft on return', async () => {
  const close = vi.fn(), request = { section: 'focus', field: 'map' } as const
  await dom.render(<SettingsPanel initialSection="focus" navigationRequest={request} onClose={close} />)
  const target = dom.container.querySelector<HTMLElement>('[data-settings-pane="focus"] [data-settings-field="map"]')!
  expect(target).not.toBeNull(); expect(document.activeElement).toBe(target)
  expect(dom.container.querySelector('.focus-settings-preview__canvas')?.getAttribute('data-scene')).toBe('map')
  expect((dom.container.querySelector('[data-settings-save-bar] button') as HTMLButtonElement).disabled).toBe(true)
  await select('LOD levels', '4')
  await dom.render(<SettingsPanel initialSection="focus" navigationRequest={{ ...request }} onClose={close} />)
  expect(dom.container.querySelector('[data-settings-field="map"]')).toBe(target)
  expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="LOD levels"]')!.value).toBe('4')
  expect(document.activeElement).toBe(target)
  expect(resolveFocusPreferences(undefined).map.levels).toHaveLength(3)
})
