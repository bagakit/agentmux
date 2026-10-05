import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_THEMES, THEME_FILE_MAX_BYTES, GRAPHITE_THEME, getThemeCatalog, mountThemeRuntime, observeResolvedTheme, previewTheme, readResolvedTheme, serializeThemeFile, parseThemeFile, themeValue, updateObservedTheme, updateThemeSelection, themeValueSchema } from '@agentmux/client-ui/theme'
import { SEMANTIC_ICON_IDS } from '@agentmux/client-ui/icons'
import { AppearanceSettingsPane } from '../src/renderer/src/components/settings/AppearanceSettingsPane'
import { applyConfigEdit } from '../src/shared/config-edit'
import { composerConfig } from './helpers/composer-dom-fixture'

let dispose: () => void, root: Root, container: HTMLDivElement, dark: boolean, listeners: Set<() => void>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  dark = false; listeners = new Set()
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query, get matches() { return dark }, onchange: null,
    addEventListener: (_event, listener) => { listeners.add(listener as () => void) },
    removeEventListener: (_event, listener) => { listeners.delete(listener as () => void) },
    addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  dispose = mountThemeRuntime()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); dispose(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.removeAttribute('style') })
const custom = () => {
  const theme = structuredClone(GRAPHITE_THEME)
  theme.id = 'custom.owner-proof'; theme.name = 'Owner proof'
  theme.variants.dark.colors.surface0 = '#20354a'
  theme.variants.light.colors.surface0 = '#faeed1'
  return theme
}
async function render(appearance: typeof composerConfig.appearance, save: (next: typeof appearance, expected: typeof appearance) => Promise<void>) {
  await act(async () => root.render(<AppearanceSettingsPane appearance={appearance} onSave={save} />))
}

 describe('shared theme owner and real Appearance consumer', () => {
  it('real radio/save changes the root and survives a fresh root mount while preserving other appearance and drafts', async () => {
    const theme = custom()
    let current = { ...composerConfig, appearance: { ...composerConfig.appearance, terminalTheme: 'dracula' as const, customThemes: { [theme.id]: themeValue(theme) } } }
    updateThemeSelection(current.appearance)
    const save = async (appearance: typeof current.appearance, expected: typeof current.appearance) => {
      current = applyConfigEdit(current, { ...current, appearance: expected }, { ...current, appearance }) as typeof current
      updateThemeSelection(current.appearance)
    }
    await render(current.appearance, save)
    const draft = document.createElement('textarea'); draft.value = 'keep this composer draft'; container.append(draft)
    const radio = container.querySelector<HTMLInputElement>('input[value="custom.owner-proof"]')!
    expect(radio).toBeTruthy()
    await act(async () => radio.click())
    const saveButton = container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!
    await act(async () => saveButton.click())
    expect(current.appearance.themeId).toBe(theme.id)
    expect(current.appearance.terminalTheme).toBe('dracula')
    expect(document.documentElement.dataset.theme).toBe(theme.id)
    expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe('#20354a')
    expect(container.querySelector('textarea')).toBe(draft)
    expect(draft.value).toBe('keep this composer draft')
    const saved = JSON.parse(JSON.stringify(current))
    dispose(); dispose = mountThemeRuntime(); updateThemeSelection(saved.appearance)
    expect(readResolvedTheme().id).toBe(theme.id)
    expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe('#20354a')
  })
  it('one OS subscription remains across selections and previews, not one per consumer; disposal releases it', () => {
    const theme = custom()
    updateThemeSelection({ appAppearance: 'system', themeId: theme.id, customThemes: { [theme.id]: themeValue(theme) } })
    const observed: string[] = [], stop = observeResolvedTheme(value => observed.push(value.mode))
    expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe('#faeed1')
    dark = true; listeners.forEach(listener => listener())
    expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe('#20354a')
    previewTheme({ ...theme, variants: { ...theme.variants, dark: { ...theme.variants.dark, colors: { ...theme.variants.dark.colors, surface0: '#224422' } } } })
    expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe('#224422')
    previewTheme(undefined)
    expect(readResolvedTheme().id).toBe(theme.id)
    expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe('#20354a')
    expect(listeners.size).toBe(1); expect(observed).toContain('dark'); stop(); dispose(); expect(listeners.size).toBe(0)
  })
  it('one unsupported saved record is retained and diagnosed while other choices remain usable', () => {
    const theme = custom(), corrupt = { version: 900, original: 'preserve' }
    const raw = { [theme.id]: themeValue(theme), 'custom.corrupt': corrupt }
    const catalog = getThemeCatalog(raw)
    expect(catalog.items.map(item => item.id)).toEqual([...BUILTIN_THEMES.map(item => item.id), theme.id])
    expect(catalog.issues).toEqual([expect.objectContaining({ id: 'custom.corrupt' })])
    expect(raw['custom.corrupt']).toBe(corrupt)
    updateThemeSelection({ themeId: 'custom.corrupt', customThemes: raw })
    expect(readResolvedTheme().issues.length).toBeGreaterThan(0)
    expect(readResolvedTheme().id).toBe('graphite')
  })
  it('runtime resolves only the selected source and skips repeated identical projections', () => {
    const theme = custom(), records = { [theme.id]: themeValue(theme) }
    Object.defineProperty(records, 'custom.unrelated', { enumerable: true, get() { throw new Error('Unselected source must not be read by runtime.') } })
    const updates: string[] = [], stop = observeResolvedTheme(value => updates.push(value.id))
    const selection = { themeId: theme.id, customThemes: records }
    expect(() => updateThemeSelection(selection)).not.toThrow()
    const count = updates.length
    updateThemeSelection(selection)
    expect(updates.length).toBe(count)
    expect(previewTheme({ ...theme, version: 900 } as never).applied).toBe(false)
    expect(readResolvedTheme().id).toBe(theme.id)
    stop()
  })
  it('complete schema roundtrips and rejects active content, missing variants and unsupported versions', () => {
    const theme = custom()
    expect(parseThemeFile(serializeThemeFile(theme))).toEqual(theme)
    expect(themeValueSchema.safeParse({ ...themeValue(theme), css: 'body { display:none }' }).success).toBe(false)
    expect(() => parseThemeFile(JSON.stringify({ ...theme, version: 900 }))).toThrow('Unsupported or invalid theme')
    expect(() => parseThemeFile(JSON.stringify({ ...theme, variants: { dark: theme.variants.dark } }))).toThrow()
    expect(() => parseThemeFile(JSON.stringify({ ...theme, icons: { 'action.close': { kind: 'paths', paths: [{ d: 'M1 1 L20 20', onload: 'alert(1)' }] } } }))).toThrow()
  })
  it('an otherwise valid saved record that cannot roundtrip the canonical file stays retained and unavailable', () => {
    const theme = custom()
    for (let padding = 0; padding <= 2000; padding += 5) {
      theme.icons = Object.fromEntries(SEMANTIC_ICON_IDS.map(id => [id, { kind: 'paths', paths: Array.from({ length: 32 }, () => ({ d: `M0 0 L24 24${' '.repeat(padding)}` })) }]))
      if (new TextEncoder().encode(JSON.stringify(theme, null, 2)+'\n').byteLength > THEME_FILE_MAX_BYTES) break
    }
    const value = themeValue(theme), compact = JSON.stringify(theme)
    expect(themeValueSchema.safeParse(value).success).toBe(true)
    expect(new TextEncoder().encode(compact).byteLength).toBeLessThan(THEME_FILE_MAX_BYTES)
    expect(() => parseThemeFile(compact)).toThrow('2 MiB')
    const records = { [theme.id]: value }
    const catalog = getThemeCatalog(records)
    expect(catalog.items.some(item => item.id === theme.id)).toBe(false)
    expect(catalog.issues).toEqual([expect.objectContaining({ id: theme.id, message: expect.stringContaining('2 MiB') })])
    updateThemeSelection({ themeId: theme.id, customThemes: records })
    expect(readResolvedTheme().id).toBe('graphite'); expect(records[theme.id]).toBe(value)
    expect(readResolvedTheme().issues[0]?.message).toContain('2 MiB')
    expect(updateObservedTheme(theme, 'dark')).toEqual({ applied: false, reason: expect.stringContaining('2 MiB') })
    expect(readResolvedTheme().id).toBe('graphite')
    expect(previewTheme(custom()).applied).toBe(true)
    const lastPreview = readResolvedTheme()
    expect(previewTheme(theme)).toEqual({ applied: false, reason: expect.stringContaining('2 MiB') })
    expect(readResolvedTheme()).toBe(lastPreview)
    previewTheme(undefined)
    expect(readResolvedTheme().id).toBe('graphite')
  })
})
