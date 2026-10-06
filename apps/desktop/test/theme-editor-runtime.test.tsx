import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, getThemeCatalog, mountThemeRuntime, previewTheme, themeValue, updateThemeSelection } from '@agentmux/client-ui/theme'
import { AppearanceSettingsPane } from '../src/renderer/src/components/settings/AppearanceSettingsPane'
import { ConfigOwner } from '../src/main/config-owner'
import { composerConfig } from './helpers/composer-dom-fixture'
import type { AppConfig, AppearanceConfig } from '../src/shared/contracts'

let root: Root, container: HTMLDivElement, dispose: () => void, config: AppConfig
let save: (next: AppearanceConfig, expected: AppearanceConfig) => Promise<void>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query, matches: false, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  config = structuredClone(composerConfig)
  dispose = mountThemeRuntime(window, config.appearance)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const owner = new ConfigOwner({ read: () => config, save: async value => value, publish: value => { config = value; updateThemeSelection(value.appearance) } })
  save = async (next, expected) => { await owner.edit({ ...config, appearance: expected }, { ...config, appearance: next }) }
})
afterEach(async () => { await act(async () => root.unmount()); dispose(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.removeAttribute('style') })
async function render(active = true) { await act(async () => root.render(<AppearanceSettingsPane active={active} appearance={config.appearance} onSave={save} />)) }
function button(text: string) { const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text); expect(result, text).toBeTruthy(); return result! }
async function click(text: string) { await act(async () => button(text).click()) }
async function fill(label: string, value: string) {
  const node = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  expect(node, label).toBeTruthy()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function preview() { await act(async () => container.querySelector<HTMLInputElement>('.theme-editor__toolbar input[type="checkbox"]')!.click()) }
const surface = () => document.documentElement.style.getPropertyValue('--surface-0')

describe('real theme editor with the production Main configuration boundary', () => {
  it('previews the edited brightness, cancels to the latest owner and keeps its draft across inactive panes', async () => {
    await render(); await click('Customize selected theme'); await fill('Surface 0 hexadecimal color', '#314159'); await preview()
    expect(surface()).toBe('#314159')
    await render(false); expect(surface()).toBe(GRAPHITE_THEME.variants.dark.colors.surface0)
    await render(true); expect(surface()).toBe('#314159')
    await click('Light'); await fill('Surface 0 hexadecimal color', '#faf0d0'); expect(document.documentElement.dataset.appearance).toBe('light'); expect(surface()).toBe('#faf0d0')
    config = { ...config, appearance: { ...config.appearance, appAppearance: 'light' } }; updateThemeSelection(config.appearance)
    await click('Discard draft and close'); expect(surface()).toBe(GRAPHITE_THEME.variants.light.colors.surface0)
    expect(config.appearance.customThemes).toBeUndefined()
  })
  it('saves an immutable built-in as a complete custom copy through ConfigOwner and preserves terminal settings', async () => {
    const builtin = structuredClone(GRAPHITE_THEME)
    config.appearance.terminalTheme = 'dracula'; await render(); await click('Customize selected theme')
    await fill('Theme name', 'Personal theme'); await fill('Surface 0 hexadecimal color', '#315432'); await click('Save custom copy')
    expect(config.appearance.themeId).toMatch(/^custom\./)
    const item = getThemeCatalog(config.appearance.customThemes).items.find(item => item.id === config.appearance.themeId)!
    expect(item.value.name).toBe('Personal theme'); expect(item.value.variants.dark.colors.surface0).toBe('#315432')
    expect(item.value.variants.light).toEqual(builtin.variants.light); expect(config.appearance.terminalTheme).toBe('dracula'); expect(GRAPHITE_THEME).toEqual(builtin)
    expect(surface()).toBe('#315432')
  })
  it('incomplete input stays editable, reports its exact field and preserves the last valid preview', async () => {
    await render(); await click('Customize selected theme'); await fill('Surface 0 hexadecimal color', '#315432'); await preview(); await fill('Surface 0 hexadecimal color', '#3')
    expect(surface()).toBe('#315432'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('surface0')
    expect(button('Save custom copy').disabled).toBe(true)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Surface 0 hexadecimal color"]')!.value).toBe('#3')
    await click('Restore saved version'); expect(surface()).toBe(GRAPHITE_THEME.variants.dark.colors.surface0); expect(button('Save custom copy').disabled).toBe(true)
  })
  it('preserves a newer draft entered while the submitted save is pending', async () => {
    let release!: () => void; const original = save; save = async (next, expected) => { await new Promise<void>(resolve => { release = resolve }); await original(next, expected) }
    await render(); await click('Customize selected theme'); await fill('Theme name', 'Submitted'); await fill('Surface 0 hexadecimal color', '#223344'); await preview(); await click('Save custom copy')
    await fill('Theme name', 'Newer draft'); await fill('Surface 0 hexadecimal color', '#334455')
    await act(async () => release())
    expect(getThemeCatalog(config.appearance.customThemes).items.find(item => item.id === config.appearance.themeId)!.value.name).toBe('Submitted')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Theme name"]')!.value).toBe('Newer draft'); expect(surface()).toBe('#334455'); expect(button('Save theme').disabled).toBe(false)
  })
  it('a closed editor save cannot clear the next editor preview when its Main receipt arrives late', async () => {
    let release!: () => void; const original = save; save = async (next, expected) => { await new Promise<void>(resolve => { release = resolve }); await original(next, expected) }
    await render(); await click('Customize selected theme'); await fill('Theme name', 'Older save'); await fill('Surface 0 hexadecimal color', '#223344'); await click('Save custom copy'); await click('Discard draft and close')
    await click('Customize selected theme'); await fill('Surface 0 hexadecimal color', '#665544'); await preview()
    await act(async () => release()); expect(surface()).toBe('#665544'); expect(container.querySelector<HTMLInputElement>('.theme-editor__toolbar input[type="checkbox"]')!.checked).toBe(true)
  })
  it('semantic glyph and path edits reach actual shared sprite consumers; invalid geometry remains a draft', async () => {
    await render(); await click('Customize selected theme')
    const drawing = container.querySelector<HTMLSelectElement>('select[aria-label="Semantic icon drawing"]')!
    await act(async () => { drawing.value = 'paths'; drawing.dispatchEvent(new Event('change', { bubbles: true })) })
    const asset = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Semantic icon paths"]')!
    const text = '[{"d":"M3 3 L21 3 L21 21 L3 21 Z","fill":"currentColor"}]'
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(asset, text); asset.dispatchEvent(new Event('input', { bubbles: true })) })
    await preview()
    expect(document.getElementById('agentmux-icon-action.close')?.querySelector('path')?.getAttribute('d')).toBe('M3 3 L21 3 L21 21 L3 21 Z')
    expect(document.getElementById('agentmux-icon-action.close')?.querySelector('path')?.getAttribute('fill')).toBe('currentColor')
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(asset, '[{"d":"M1 1 LInfinity 20"}]'); asset.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(button('Save custom copy').disabled).toBe(true); expect(container.textContent).toContain('last valid drawing')
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(asset, text); asset.dispatchEvent(new Event('input', { bubbles: true })) })
    await click('Save custom copy')
    expect(getThemeCatalog(config.appearance.customThemes).items.find(item => item.id === config.appearance.themeId)!.value.icons['action.close']).toEqual({ kind: 'paths', paths: [{ d: 'M3 3 L21 3 L21 21 L3 21 Z', fill: 'currentColor' }] })
  })
  it('same-ID concurrent updates fail as a whole record and keep the visible draft and original data', async () => {
    const document = { ...structuredClone(GRAPHITE_THEME), id: 'custom.concurrent' }
    config.appearance = { ...config.appearance, themeId: document.id, customThemes: { [document.id]: themeValue(document) } }; updateThemeSelection(config.appearance)
    await render(); await click('Customize selected theme'); await fill('Theme name', 'My draft')
    config = { ...config, appearance: { ...config.appearance, customThemes: { [document.id]: { ...themeValue(document), name: 'Other writer' } } } }
    await click('Save theme'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('changed')
    expect((config.appearance.customThemes![document.id] as { name: string }).name).toBe('Other writer'); expect(container.querySelector<HTMLInputElement>('input[aria-label="Theme name"]')!.value).toBe('My draft')
  })
  it('an unconfirmed built-in copy uses the same identity on retry and retains its editable draft', async () => {
    const ids: string[] = []
    save = async next => { ids.push(next.themeId!); throw new Error('Transport receipt unavailable') }
    await render(); await click('Customize selected theme'); await fill('Theme name', 'Retained draft')
    await click('Save custom copy'); await click('Save custom copy')
    expect(ids).toHaveLength(2); expect(ids[0]).toMatch(/^custom\./); expect(ids[1]).toBe(ids[0])
    expect(container.textContent).toContain(`Save for ${ids[0]} was not confirmed`)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Theme name"]')!.value).toBe('Retained draft')
    expect(config.appearance.customThemes).toBeUndefined()
  })
  it('a committed built-in copy with a lost receipt retries through ConfigOwner without creating another identity', async () => {
    const original = save; const ids: string[] = []
    save = async (next, expected) => { ids.push(next.themeId!); await original(next, expected); if (ids.length === 1) throw new Error('Receipt lost after commit') }
    await render(); await click('Customize selected theme'); await fill('Theme name', 'Saved despite lost receipt')
    await click('Save custom copy')
    expect(config.appearance.themeId).toBe(ids[0]); expect(container.textContent).toContain('was not confirmed')
    await click('Save custom copy')
    expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]); expect(Object.keys(config.appearance.customThemes!)).toEqual([ids[0]])
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Theme name"]')!.value).toBe('Saved despite lost receipt')
    expect(container.textContent).toContain('Custom copy saved and applied')
  })
})
