// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SemanticIcon, createSemanticIconElement, semanticIconHref } from '../src/theme/icons.js'
import { InlineRenameField } from '../src/components/InlineRenameField.js'
import { mountThemeRuntime, previewTheme } from '../src/theme/runtime.js'
import { GRAPHITE_THEME } from '../src/theme/catalog.js'
import { serializeThemeFile } from '../src/theme/schema.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let release: (() => void) | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; release?.(); release = undefined; document.body.replaceChildren(); vi.unstubAllGlobals() })
function mount() {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  release = mountThemeRuntime(window, { appAppearance: 'light' })
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  return host
}
function symbol(name: 'status.loading' | 'action.refresh') { return document.getElementById(semanticIconHref(name).slice(1))! }

it('retains selected assets at both real renderers while only trusted loading/refresh drawings declare rotation', () => {
  const host = mount()
  act(() => root!.render(<SemanticIcon name="status.loading" animation="spin" />))
  const native = createSemanticIconElement('action.refresh', document, { animation: 'spin' })
  host.append(native)
  expect(symbol('status.loading').querySelectorAll('[data-semantic-icon-part="spin-body"]')).toHaveLength(1)
  expect(symbol('action.refresh').querySelectorAll('[data-semantic-icon-part="spin-body"]')).toHaveLength(4)
  const custom = { ...GRAPHITE_THEME, id: 'custom.loading-assets', name: 'Saved original assets', icons: {
    'status.loading': { kind: 'paths' as const, paths: [{ d: 'M3 5h18v14H3Z' }] },
    'action.refresh': { kind: 'glyph' as const, glyph: 'work-writing' as const }
  } }
  const saved = serializeThemeFile(custom)
  expect(previewTheme(custom).applied).toBe(true)
  expect(symbol('status.loading').children).toHaveLength(1)
  expect(symbol('status.loading').firstElementChild?.getAttribute('d')).toBe('M3 5h18v14H3Z')
  expect(symbol('status.loading').querySelector('[data-semantic-icon-part]')).toBeNull()
  expect(symbol('action.refresh').querySelector('[data-semantic-icon-part="spin-body"]')).toBeNull()
  expect(symbol('action.refresh').querySelector('[data-semantic-icon-part="writing-pen"]')).not.toBeNull()
  expect(host.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.loading'))
  expect(native.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.refresh'))
  expect(serializeThemeFile(custom)).toBe(saved)
  expect(previewTheme(GRAPHITE_THEME).applied).toBe(true)
  expect(symbol('status.loading').querySelectorAll('[data-semantic-icon-part="spin-body"]')).toHaveLength(1)
  expect(symbol('action.refresh').querySelectorAll('[data-semantic-icon-part="spin-body"]')).toHaveLength(4)
})

it('the actual inline rename consumer uses its original pending fact and preserves the field after a save error', () => {
  const host = mount(), commit = vi.fn(async () => {}), change = vi.fn(), cancel = vi.fn()
  const props = { value: 'Original name', label: 'Rename', onCommit: commit, onValueChange: change, onCancel: cancel }
  act(() => root!.render(<InlineRenameField {...props} pending />))
  const input = host.querySelector('input')!
  expect(input.readOnly).toBe(true)
  expect(host.querySelector('.inline-rename-field__pending [data-icon-animation="spin"] [data-semantic-icon="status.loading"]')).not.toBeNull()
  act(() => root!.render(<InlineRenameField {...props} error="Save failed; original name retained" />))
  expect(host.querySelector('input')).toBe(input)
  expect(input.value).toBe('Original name'); expect(input.readOnly).toBe(false)
  expect(host.querySelector('[data-icon-animation]')).toBeNull()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Save failed')
  expect(commit).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
})
