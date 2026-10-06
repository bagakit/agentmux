// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME } from '../src/theme/catalog.js'
import { iconAssetSchema, themeDocumentSchema } from '../src/theme/schema.js'
import { ICON_GLYPHS, SEMANTIC_ICON_CATALOG, SEMANTIC_ICON_IDS } from '../src/theme/icon-catalog.js'
import { SemanticIcon, semanticIconHref, createSemanticIconElement, iconMaskDataUrl, iconShapes } from '../src/theme/icons.js'
import { mountThemeRuntime, previewTheme, updateThemeSelection } from '../src/theme/runtime.js'
import { WorkflowSemanticIcon } from '../../../apps/desktop/src/renderer/src/components/semantic-icons/index.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
function getSymbol(name: Parameters<typeof semanticIconHref>[0]) { return document.getElementById(semanticIconHref(name).slice(1))! }
const cleanups: Array<() => void> = []
let root: Root | undefined
function mount(ui: Parameters<Root['render']>[0]) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(ui))
  return host
}
function runtime() {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  cleanups.push(mountThemeRuntime(window, { appAppearance: 'light' }))
}
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  cleanups.splice(0).forEach(cleanup => cleanup())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('shared semantic icon owner', () => {
  it('every catalog meaning has real declared geometry; live process and output differ without color', () => {
    expect(SEMANTIC_ICON_IDS.length).toBeGreaterThan(30)
    for (const id of SEMANTIC_ICON_IDS) {
      expect(ICON_GLYPHS[SEMANTIC_ICON_CATALOG[id].glyph], id).toBeDefined()
      expect(ICON_GLYPHS[SEMANTIC_ICON_CATALOG[id].glyph].length, id).toBeGreaterThan(0)
      expect(iconShapes(id).length, id).toBeGreaterThan(0)
    }
    expect(iconShapes('status.running')).not.toEqual(iconShapes('status.working'))
  })

  it.each([
    { kind: 'glyph', glyph: 'nonexistent-glyph' },
    { kind: 'glyph', glyph: 'x', onClick: 'script' },
    { kind: 'paths', paths: [{ d: 'EEEE' }] },
    { kind: 'paths', paths: [{ d: 'M1e309 1e309L1e309 1e309' }] },
    { kind: 'paths', paths: [{ d: 'M0 0 Z 5' }] },
    { kind: 'paths', paths: [{ d: 'M0 0 A2 2 0 3 0 10 10' }] },
    { kind: 'paths', paths: [{ d: 'M0 0 L10000 10000' }] },
    { kind: 'paths', paths: [{ d: 'M0 0 L12 12', fill: 'url(https://example.org/icon)' }] },
    { kind: 'paths', paths: [{ d: 'M0 0 L12 12', onload: 'script' }] },
    { kind: 'paths', paths: [{ d: 'M0 0 ' + 'l1 0 '.repeat(257) }] }
  ])('refuses unsupported or active icon data %j without modifying saved theme', asset => {
    expect(iconAssetSchema.safeParse(asset).success).toBe(false)
  })

  it('accepts finite curved/arc geometry and rejects unregistered semantic meanings', () => {
    expect(iconAssetSchema.safeParse({ kind: 'paths', paths: [{ d: 'M2 12 A10 10 180 0 1 22 12' }] }).success).toBe(true)
    expect(iconAssetSchema.safeParse({ kind: 'paths', paths: [{ d: 'M2 12 Q12 2 22 12 A10 10 0 0 1 2 12 Z', fill: 'currentColor' }] }).success).toBe(true)
    expect(themeDocumentSchema.safeParse({ ...GRAPHITE_THEME, icons: { 'action.fake': { kind: 'glyph', glyph: 'x' } } }).success).toBe(false)
  })

  it('retains actual consumer nodes and accessibility while a preview updates one sprite for React and native editor DOM', () => {
    runtime()
    const host = mount(<button aria-label="Close a surface" disabled><SemanticIcon name="action.close" size={19} /></button>)
    const node = createSemanticIconElement('action.close', document, { size: 14 })
    host.append(node)
    const button = host.querySelector('button')!
    const svg = button.querySelector('svg')!
    const use = svg.querySelector('use')!
    const before = getSymbol('action.close').innerHTML
    const addListener = vi.spyOn(window, 'addEventListener')
    previewTheme({ ...GRAPHITE_THEME, icons: { 'action.close': { kind: 'paths', paths: [{ d: 'M3 12L21 12' }] } } })
    expect(getSymbol('action.close').innerHTML).not.toBe(before)
    expect(getSymbol('action.close').querySelector('path')!.getAttribute('d')).toBe('M3 12L21 12')
    expect(button.querySelector('svg')).toBe(svg)
    expect(svg.querySelector('use')).toBe(use)
    expect(node.querySelector('use')!.getAttribute('href')).toBe(use.getAttribute('href'))
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('Close a surface')
    expect(svg.getAttribute('width')).toBe('19')
    expect(addListener).not.toHaveBeenCalled()
    previewTheme(undefined)
    expect(getSymbol('action.close').innerHTML).toBe(before)
  })

  it('color changes preserve retained symbols, icon changes reach the production Desktop workflow adapter', () => {
    runtime()
    const host = mount(<><WorkflowSemanticIcon status="failed" /><SemanticIcon name="status.working" /></>)
    expect(host.querySelector('[data-semantic-icon="status.failed"] use')!.getAttribute('href')).toBe(semanticIconHref('status.failed'))
    expect(host.querySelector('[data-semantic-icon="status.working"] use')!.getAttribute('href')).toBe(semanticIconHref('status.working'))
    expect(host.querySelector('.semantic-icon-motion--working')).not.toBeNull()
    const symbol = getSymbol('status.failed')
    updateThemeSelection({ appAppearance: 'dark' })
    expect(getSymbol('status.failed')).toBe(symbol)
    previewTheme({ ...GRAPHITE_THEME, icons: { 'status.failed': { kind: 'glyph', glyph: 'triangle-alert' } } })
    expect(getSymbol('status.failed').innerHTML).not.toBe(symbol.innerHTML)
  })

  it('native checkbox, disclosure and presence projections use the same live assets and style', () => {
    runtime()
    const rootStyle = document.documentElement.style
    const oldCheck = rootStyle.getPropertyValue('--native-checkbox-mask')
    const oldPresence = rootStyle.getPropertyValue('--native-presence-waiting-mask')
    previewTheme({ ...GRAPHITE_THEME, iconStyle: { ...GRAPHITE_THEME.iconStyle, strokeWidth: 2.5 }, icons: {
      'control.checkbox-checked': { kind: 'paths', paths: [{ d: 'M3 12L21 12' }] },
      'navigation.disclosure': { kind: 'glyph', glyph: 'plus' },
      'status.presence-waiting': { kind: 'glyph', glyph: 'triangle-alert' }
    } })
    expect(rootStyle.getPropertyValue('--native-checkbox-mask')).not.toBe(oldCheck)
    expect(decodeURIComponent(rootStyle.getPropertyValue('--native-checkbox-mask'))).toContain('d="M3 12L21 12"')
    expect(decodeURIComponent(rootStyle.getPropertyValue('--native-disclosure-mask'))).toContain('stroke-width="2.5"')
    expect(rootStyle.getPropertyValue('--native-presence-waiting-mask')).not.toBe(oldPresence)
    expect(getSymbol('control.checkbox-checked').querySelector('path')!.getAttribute('d')).toBe('M3 12L21 12')
    previewTheme(undefined)
    expect(rootStyle.getPropertyValue('--native-checkbox-mask')).toBe(oldCheck)
    expect(rootStyle.getPropertyValue('--native-presence-waiting-mask')).toBe(oldPresence)
  })

  it('native masks serialize only the geometry chosen by the shared owner', () => {
    const shapes = iconShapes('action.close', { 'action.close': { kind: 'paths', paths: [{ d: 'M3 12L21 12', fill: 'currentColor' }] } })
    const mask = decodeURIComponent(iconMaskDataUrl(shapes, GRAPHITE_THEME.iconStyle))
    expect(mask).toContain('d="M3 12L21 12"')
    expect(mask).toContain('viewBox="0 0 24 24"')
    expect(mask).not.toMatch(/<script|<foreignObject|href=|onload=/)
  })
})
