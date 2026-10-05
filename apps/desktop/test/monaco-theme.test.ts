// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, updateThemeSelection, previewTheme, themeValue } from '@agentmux/client-ui/theme'
import { MONACO_THEME_ID, mountMonacoTheme } from '../src/renderer/src/lib/monaco-theme.js'

let close: (() => void) | undefined
let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); close?.(); vi.unstubAllGlobals() })
it('updates the same native theme from Root preview and local system changes with one media subscription', () => {
  const media = Object.assign(new EventTarget(), { matches: true })
  const add = vi.spyOn(media, 'addEventListener')
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  window.matchMedia = vi.fn(() => media as MediaQueryList)
  close = mountThemeRuntime(window, { appAppearance: 'system' })
  const native = { defineTheme: vi.fn(), setTheme: vi.fn() }
  dispose = mountMonacoTheme(native)
  expect(window.document.querySelectorAll('[data-monaco-semantic-surfaces]')).toHaveLength(1)
  expect(window.document.querySelector('[data-monaco-semantic-surfaces]')?.textContent).toContain('var(--radius-sm)')
  expect(add.mock.calls.filter(([event]) => event === 'change')).toHaveLength(1)
  const document = structuredClone(GRAPHITE_THEME)
  document.id = 'custom.editor'; document.variants.light.colors.surface0 = '#fffaf0'
  document.variants.light.colors.text = '#243a51'; document.variants.light.colors.danger = '#a52f2f'
  updateThemeSelection({ themeId: document.id, customThemes: { [document.id]: themeValue(document) }, appAppearance: 'system' })
  media.matches = false; media.dispatchEvent(new Event('change'))
  expect(native.defineTheme).toHaveBeenLastCalledWith(MONACO_THEME_ID, expect.objectContaining({ base: 'vs', colors: expect.objectContaining({
    'editor.background': '#fffaf0', 'editor.foreground': '#243a51', 'editorError.foreground': '#a52f2f',
    'diffEditor.removedTextBackground': '#a52f2f25'
  }) }))
  const before = native.defineTheme.mock.calls.length
  const edited = structuredClone(document); edited.variants.light.colors.surface0 = '#f5e8ce'
  previewTheme(edited)
  expect(native.defineTheme.mock.calls.at(-1)?.[1].colors?.['editor.background']).toBe('#f5e8ce')
  previewTheme(undefined)
  expect(native.defineTheme.mock.calls.at(-1)?.[1].colors?.['editor.background']).toBe('#fffaf0')
  expect(native.defineTheme.mock.calls).toHaveLength(before + 2)
  expect(new Set(native.defineTheme.mock.calls.map(([id]) => id))).toEqual(new Set([MONACO_THEME_ID]))
  dispose(); dispose = undefined
  expect(window.document.querySelector('[data-monaco-semantic-surfaces]')).toBeNull()
  updateThemeSelection({ appAppearance: 'dark' })
  expect(native.defineTheme.mock.calls).toHaveLength(before + 2)
})
