// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, getThemeCatalog, mountThemeRuntime, parseThemeFile, serializeThemeFile, themeValue, updateThemeSelection, type ThemeDocument } from '@agentmux/client-ui/theme'
import { SemanticIcon, createSemanticIconElement, semanticIconHref } from '@agentmux/client-ui/icons'
import { ThemeEditor } from '../src/renderer/src/components/settings/ThemeEditor'
import type { AppearanceConfig } from '../src/shared/contracts'

let root: Root, host: HTMLDivElement, dispose: () => void, saved: ThemeDocument | undefined
const ids = ['object.settings-cluster', 'object.node', 'object.hosts', 'object.remote-execution', 'object.mobile-access', 'status.node-published', 'status.node-private', 'status.node-publication-unknown'] as const
const symbol = (id: typeof ids[number]) => document.getElementById(semanticIconHref(id).slice(1))!
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  saved = undefined
  const themeDocument = { ...structuredClone(GRAPHITE_THEME), id: 'custom.cluster-icons' }
  const appearance: AppearanceConfig = { appAppearance: 'light', themeId: themeDocument.id, customThemes: { [themeDocument.id]: themeValue(themeDocument) } }
  dispose = mountThemeRuntime(window, appearance)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const item = getThemeCatalog(appearance.customThemes).items.find(item => item.id === themeDocument.id)!
  await act(async () => root.render(<><ThemeEditor item={item} appearance={appearance} active onClose={() => {}}
    onSave={async next => {
      saved = { id: next.themeId!, ...next.customThemes![next.themeId!] as ReturnType<typeof themeValue> }
      updateThemeSelection(next)
    }} /><SemanticIcon name="status.node-published" size={15} animation="stream" /></>))
  host.append(createSemanticIconElement('status.node-published', document, { size: 15, animation: 'stream' }))
})
afterEach(async () => { await act(async () => root.unmount()); dispose(); host.remove(); vi.unstubAllGlobals(); document.documentElement.removeAttribute('style') })
async function click(text: string) {
  const button = [...host.querySelectorAll<HTMLElement>('button, summary')].find(button => button.getAttribute('aria-label') === text || button.textContent?.trim() === text)
  expect(button, text).toBeTruthy(); await act(async () => button!.click())
}
async function fill(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  expect(input, label).toBeTruthy()
  await act(async () => {
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('the actual ThemeEditor discovers all eight meanings and saves one glyph and one path edit through its original theme flow', async () => {
  for (const id of ids) expect(host.querySelector(`[aria-label="Edit ${id}"]`), id).not.toBeNull()
  const originalPrivate = symbol('status.node-private').innerHTML
  await click('Edit object.node'); await click('Choose a drawing')
  await fill('Find icon drawing', 'node-published'); await click('Use node-published')
  await click('Edit status.node-published'); await click('Custom path asset'); await click('Use custom paths')
  await fill('Semantic icon paths', '[{"d":"M4 5H20V19H4Z"}]')
  await act(async () => host.querySelector<HTMLInputElement>('.theme-editor__toolbar input[type="checkbox"]')!.click())
  expect(symbol('status.node-published').querySelector('path')?.getAttribute('d')).toBe('M4 5H20V19H4Z')
  expect(symbol('status.node-published').querySelector('[data-semantic-icon-part]')).toBeNull()
  expect(symbol('object.node').querySelector('[data-semantic-icon-part="stream-caret"]')).not.toBeNull()
  expect(symbol('status.node-private').innerHTML).toBe(originalPrivate)
  expect(host.querySelectorAll('[data-semantic-icon="status.node-published"] use')).toHaveLength(2)
  for (const use of host.querySelectorAll('[data-semantic-icon="status.node-published"] use')) expect(use.getAttribute('href')).toBe(semanticIconHref('status.node-published'))
  await click('Save theme')
  expect(saved).toBeDefined()
  const exported = serializeThemeFile(saved!), parsed = parseThemeFile(exported)
  expect(parsed.icons['object.node']).toEqual({ kind: 'glyph', glyph: 'node-published' })
  expect(parsed.icons['status.node-published']).toEqual({ kind: 'paths', paths: [{ d: 'M4 5H20V19H4Z' }] })
  expect(parsed.icons['status.node-private']).toBeUndefined()
  expect(symbol('status.node-published').querySelector('path')?.getAttribute('d')).toBe('M4 5H20V19H4Z')
  expect(host.textContent).toContain('Theme saved and applied')
})
