import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GRAPHITE_THEME, getThemeCatalog, mountThemeRuntime, parseThemeFile, serializeThemeFile, themeValue, updateThemeSelection, type ThemeDocument } from '@agentmux/client-ui/theme'
import { ConfigOwner } from '../src/main/config-owner'
import { exportThemeFile, writeThemeFile } from '../src/main/theme-file-export'
import { AppearanceSettingsPane } from '../src/renderer/src/components/settings/AppearanceSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig } from './helpers/composer-dom-fixture'
import type { AppConfig, AppearanceConfig } from '../src/shared/contracts'



let root: Root, container: HTMLDivElement, dispose: () => void, directory: string, config: AppConfig
let onSave: (next: AppearanceConfig, expected: AppearanceConfig) => Promise<void>
const personal = (): ThemeDocument => ({ ...structuredClone(GRAPHITE_THEME), id: 'custom.file-proof', name: 'File proof',
  variants: { dark: { ...GRAPHITE_THEME.variants.dark, colors: { ...GRAPHITE_THEME.variants.dark.colors, surface0: '#234534' } }, light: { ...GRAPHITE_THEME.variants.light, colors: { ...GRAPHITE_THEME.variants.light.colors, surface0: '#f4eacb' } } },
  icons: { 'action.close': { kind: 'paths', paths: [{ d: 'M3 3 L21 3 L21 21 L3 21 Z' }] } } })
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query, matches: false, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  directory = await mkdtemp(join(tmpdir(), 'agentmux-theme-files-'))
  const theme = personal()
  config = { ...structuredClone(composerConfig), appearance: { ...composerConfig.appearance, themeId: theme.id, terminalTheme: 'dracula', customThemes: { [theme.id]: themeValue(theme), 'custom.retained': { version: 900, original: 'retained' } } } }
  dispose = mountThemeRuntime(window, config.appearance)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const owner = new ConfigOwner({ read: () => config, save: async value => value, publish: value => { config = value; updateThemeSelection(value.appearance); renderNow() } })
  onSave = async (next, expected) => { await owner.edit({ ...config, appearance: expected }, { ...config, appearance: next }) }
  vi.spyOn(api.ui, 'exportTheme').mockImplementation(document => exportThemeFile(document, { chooseFile: async () => join(directory, 'theme.json'), writeFile: writeThemeFile }))
  await act(async () => renderNow())
})
afterEach(async () => { await act(async () => root.unmount()); dispose(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.removeAttribute('style'); await rm(directory, { recursive: true, force: true }) })
function renderNow() { root.render(<AppearanceSettingsPane appearance={config.appearance} onSave={onSave} />) }
function button(text: string) { const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text); expect(result, text).toBeTruthy(); return result! }
async function click(text: string) { await act(async () => button(text).click()) }
async function upload(text: string) {
  const node = container.querySelector<HTMLInputElement>('input[aria-label="Upload theme file"]')!
  Object.defineProperty(node, 'files', { value: [new File([text], 'theme.json', { type: 'application/json' })], configurable: true })
  await act(async () => node.dispatchEvent(new Event('change', { bubbles: true })))
}
const surface = () => document.documentElement.style.getPropertyValue('--surface-0')
const closePath = () => document.getElementById('agentmux-icon-action.close')?.querySelector('path')?.getAttribute('d')

describe('real Settings theme files and native export use the original schema and owner', () => {
  it('exports embedded assets, removes only the test custom theme, reimports and restores the exact identity, variants and actual icon projection', async () => {
    const original = personal()
    await click('Export selected theme'); let text = ''
    await act(async () => { await vi.mocked(api.ui.exportTheme).mock.results.at(-1)!.value }); text = await readFile(join(directory, 'theme.json'), 'utf8'); expect(container.textContent).toContain('Exported complete theme')
    expect(parseThemeFile(text)).toEqual(original)
    await click('Remove custom theme'); await click('Remove saved theme')
    expect(config.appearance.themeId).toBe('graphite'); expect(config.appearance.customThemes!['custom.file-proof']).toBeUndefined()
    expect(closePath()).not.toBe(original.icons['action.close']!.kind === 'paths' ? original.icons['action.close']!.paths[0]!.d : '')
    await upload(text); expect(config.appearance.themeId).toBe('graphite')
    await click('Preview light'); expect(surface()).toBe('#f4eacb'); expect(closePath()).toBe('M3 3 L21 3 L21 21 L3 21 Z')
    await click('Save and apply theme')
    expect(config.appearance.themeId).toBe(original.id); expect(config.appearance.customThemes![original.id]).toEqual(themeValue(original))
    expect(surface()).toBe('#234534'); expect(closePath()).toBe('M3 3 L21 3 L21 21 L3 21 Z')
    expect(config.appearance.terminalTheme).toBe('dracula'); expect(config.appearance.customThemes!['custom.retained']).toEqual({ version: 900, original: 'retained' })
  })
  it('cancels an import preview without writing or losing other data', async () => {
    const before = structuredClone(config)
    const incoming = personal(); incoming.variants.dark.colors.surface0 = '#445566'; incoming.id = 'custom.cancel-proof'
    await upload(serializeThemeFile(incoming)); await click('Preview dark'); expect(surface()).toBe('#445566')
    await click('Cancel import'); expect(config).toEqual(before); expect(surface()).toBe('#234534')
  })
  it('keeps a submitted import visible until the original Main save settles and never promises cancellation of that write', async () => {
    let release!: () => void
    const original = onSave
    onSave = async (next, expected) => { await new Promise<void>(resolve => { release = resolve }); await original(next, expected) }
    await act(async () => renderNow())
    const incoming = personal(); incoming.id = 'custom.pending-import'
    await upload(serializeThemeFile(incoming)); await click('Save and apply theme')
    expect(button('Cancel import').disabled).toBe(true)
    expect(button('Import theme file').disabled).toBe(true)
    expect(button('Remove custom theme').disabled).toBe(true)
    await click('Cancel import'); expect(container.querySelector('[aria-label="Import review"]')).toBeTruthy()
    await act(async () => release())
    expect(config.appearance.themeId).toBe(incoming.id)
    expect(container.querySelector('[aria-label="Import review"]')).toBeNull()
    expect(container.textContent).toContain('Theme saved and applied')
  })
  it('a late file read cannot revive a cancelled review or replace a newer selected file', async () => {
    let release!: (text: string) => void
    const node = container.querySelector<HTMLInputElement>('input[aria-label="Upload theme file"]')!
    const file = new File(['waiting'], 'older.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => new Promise<string>(resolve => { release = resolve }) })
    Object.defineProperty(node, 'files', { value: [file], configurable: true })
    await act(async () => node.dispatchEvent(new Event('change', { bubbles: true })))
    const newer = personal(); newer.id = 'custom.newer-file'; newer.name = 'Newer file'
    await upload(serializeThemeFile(newer))
    await act(async () => release(serializeThemeFile(personal())))
    expect(container.querySelector('[aria-label="Import review"]')?.textContent).toContain('custom.newer-file')
    await click('Cancel import')
    expect(config.appearance.themeId).toBe('custom.file-proof')
    expect(container.querySelector('[aria-label="Import review"]')).toBeNull()
  })
  it('a file read finishing after opening the editor cannot start a competing import preview', async () => {
    let release!: (text: string) => void
    const node = container.querySelector<HTMLInputElement>('input[aria-label="Upload theme file"]')!
    const file = new File(['waiting'], 'pending.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => new Promise<string>(resolve => { release = resolve }) })
    Object.defineProperty(node, 'files', { value: [file], configurable: true })
    await act(async () => node.dispatchEvent(new Event('change', { bubbles: true })))
    await click('Customize selected theme')
    expect(container.querySelector('[aria-label="Theme editor"]')).toBeTruthy()
    await act(async () => release(serializeThemeFile(personal())))
    expect(container.querySelector('[aria-label="Import review"]')).toBeNull()
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Theme name"]')?.value).toBe('File proof')
    expect(config.appearance.themeId).toBe('custom.file-proof')
  })
  it('an unconfirmed copy save retains one identity and truthful feedback when closing its review', async () => {
    const ids: string[] = []
    onSave = async next => { ids.push(next.themeId!); throw new Error('Transport receipt unavailable') }
    await act(async () => renderNow())
    await upload(serializeThemeFile(GRAPHITE_THEME))
    await click('Save a separate copy'); await click('Save a separate copy')
    expect(ids).toHaveLength(2); expect(ids[0]).toMatch(/^custom\./); expect(ids[1]).toBe(ids[0])
    await click('Cancel import')
    expect(container.textContent).toContain('Check the current theme to confirm the earlier save')
    expect(container.textContent).not.toContain('Import cancelled. Saved themes are unchanged.')
  })
  it('a committed import copy with a lost receipt retries the original owner without duplicating the theme', async () => {
    const original = onSave; const ids: string[] = []
    onSave = async (next, expected) => { ids.push(next.themeId!); await original(next, expected); if (ids.length === 1) throw new Error('Receipt lost after commit') }
    await act(async () => renderNow()); await upload(serializeThemeFile(GRAPHITE_THEME))
    await click('Save a separate copy'); expect(config.appearance.themeId).toBe(ids[0]); expect(container.querySelector('[aria-label="Import review"]')).toBeTruthy()
    await click('Save a separate copy'); expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0])
    expect(Object.keys(config.appearance.customThemes!)).toHaveLength(3)
    expect(config.appearance.customThemes![ids[0]!]).toEqual(themeValue(GRAPHITE_THEME))
    expect(config.appearance.customThemes!['custom.retained']).toEqual({ version: 900, original: 'retained' })
    expect(container.querySelector('[aria-label="Import review"]')).toBeNull()
  })
  it('same-ID differing data requires explicit copy or CAS replacement; a stale replacement preserves the original record', async () => {
    const incoming = personal(); incoming.name = 'Replacement'
    await upload(serializeThemeFile(incoming)); expect(button('Replace and apply theme')).toBeTruthy()
    config.appearance.customThemes![incoming.id] = { ...themeValue(personal()), name: 'Concurrent writer' }
    await click('Replace and apply theme'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('changed')
    expect((config.appearance.customThemes![incoming.id] as { name: string }).name).toBe('Concurrent writer')
    await click('Save a separate copy'); expect(config.appearance.themeId).not.toBe(incoming.id)
    expect(getThemeCatalog(config.appearance.customThemes).items.find(item => item.id === config.appearance.themeId)!.value).toEqual(themeValue(incoming))
    expect((config.appearance.customThemes![incoming.id] as { name: string }).name).toBe('Concurrent writer')
  })
  it('built-in identities cannot be overwritten, and identical imports apply the existing original', async () => {
    await upload(serializeThemeFile(GRAPHITE_THEME)); expect(button('Apply existing theme')).toBeTruthy(); await click('Apply existing theme'); expect(config.appearance.themeId).toBe('graphite')
    const changed = structuredClone(GRAPHITE_THEME); changed.name = 'Different built-in file'
    await upload(serializeThemeFile(changed)); await click('Save and apply theme'); expect(config.appearance.themeId).toMatch(/^custom\./)
    expect(GRAPHITE_THEME.name).toBe('Graphite / Mint'); expect(config.appearance.customThemes?.graphite).toBeUndefined()
  })
  it('invalid versions, active assets, unknown fields and malformed JSON retain the original configuration', async () => {
    const before = structuredClone(config)
    for (const text of ['{', JSON.stringify({ ...personal(), version: 900 }), JSON.stringify({ ...personal(), css: 'body{}' }), JSON.stringify({ ...personal(), icons: { 'action.close': { kind: 'paths', paths: [{ d: 'M3 3 L20 20', onload: 'alert(1)' }] } } })]) {
      await upload(text); expect(container.textContent).toMatch(/not valid JSON|Unsupported or invalid theme/); expect(config).toEqual(before)
    }
  })
  it('native cancellation and a real filesystem write failure are visible and preserve saved theme data', async () => {
    const before = structuredClone(config)
    vi.mocked(api.ui.exportTheme).mockImplementation(document => exportThemeFile(document, { chooseFile: async () => null, writeFile: writeThemeFile }))
    await click('Export selected theme'); expect(container.textContent).toContain('Export cancelled')
    vi.mocked(api.ui.exportTheme).mockImplementation(document => exportThemeFile(document, { chooseFile: async () => join(directory, 'missing', 'theme.json'), writeFile: writeThemeFile }))
    await click('Export selected theme'); await act(async () => { await vi.mocked(api.ui.exportTheme).mock.results.at(-1)!.value.catch(() => {}) }); expect(container.textContent).toContain('Export failed'); expect(config).toEqual(before)
  })
  it('a native temporary name collision leaves the existing destination and unowned temporary file intact', async () => {
    const destination = join(directory, 'theme.json')
    const collision = `${destination}.00000000-0000-0000-0000-000000000001.tmp`
    await writeFile(destination, 'Original destination'); await writeFile(collision, 'Other writer data')
    const before = structuredClone(config)
    await click('Export selected theme'); await act(async () => { await vi.mocked(api.ui.exportTheme).mock.results.at(-1)!.value.catch(() => {}) })
    expect(container.textContent).toContain('Export failed')
    expect(await readFile(destination, 'utf8')).toBe('Original destination')
    await expect(readFile(collision, 'utf8')).resolves.toBe('Other writer data')
    expect(config).toEqual(before)
  })
})
