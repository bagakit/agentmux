// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSemanticIconElement, semanticIconHref, iconShapes, iconSvgDataUrl } from '../src/theme/icons.js'
import { mountThemeRuntime, previewTheme } from '../src/theme/runtime.js'
import { BUILTIN_THEMES, GRAPHITE_THEME } from '../src/theme/catalog.js'
import { serializeThemeFile, parseThemeFile, type ThemeIconAsset } from '../src/theme/schema.js'
let release: () => void
const symbol = () => document.getElementById(semanticIconHref('status.waiting').slice(1))!
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  release = mountThemeRuntime(window, { appAppearance: 'light' })
})
afterEach(() => { release(); document.body.replaceChildren(); vi.unstubAllGlobals() })
it('projects the one registered hourglass drawing into native wait and static uses without per-instance shape copies', () => {
  const active = createSemanticIconElement('status.waiting', document, { animation: 'wait', size: 18 })
  const still = createSemanticIconElement('status.waiting', document)
  document.body.append(active, still)
  expect(active.dataset.iconAnimation).toBe('wait'); expect(still.tagName.toLowerCase()).toBe('svg')
  expect(active.querySelector('path')).toBeNull()
  expect(active.querySelector('use')!.getAttribute('href')).toBe(still.querySelector('use')!.getAttribute('href'))
  const use = active.querySelector('use')!
  for (const theme of BUILTIN_THEMES) {
    expect(previewTheme(theme).applied).toBe(true)
    expect([...symbol().querySelectorAll('[data-semantic-icon-part]')].map(e => e.getAttribute('data-semantic-icon-part'))).toEqual(['hourglass-frame', 'hourglass-upper', 'hourglass-lower', 'hourglass-grain'])
    expect(active.querySelector('use')).toBe(use)
  }
})
it('keeps a coherent still hourglass in the original data-image projection as well as the root sprite', () => {
  const data = iconSvgDataUrl(iconShapes('status.waiting'), GRAPHITE_THEME.iconStyle, '#267a48')
  const svg = decodeURIComponent(data.slice('url("data:image/svg+xml,'.length, -2))
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(parsed.querySelector('[data-semantic-icon-part="hourglass-upper"]')!.getAttribute('fill')).toBe('currentColor')
  expect(parsed.querySelector('[data-semantic-icon-part="hourglass-lower"]')!.getAttribute('transform')).toBe('translate(0 18) scale(1 0) translate(0 -18)')
  expect(parsed.querySelector('[data-semantic-icon-part="hourglass-grain"]')!.getAttribute('opacity')).toBe('0')
})
it('retains user glyph and paths without inventing flowing parts, then restores authored parts via the same theme owner', () => {
  const assets: ThemeIconAsset[] = [{ kind: 'glyph', glyph: 'activity' }, { kind: 'paths', paths: [{ d: 'M6 3h12L6 21h12Z' }] }]
  for (const asset of assets) {
    const saved = parseThemeFile(serializeThemeFile({ ...GRAPHITE_THEME, id: 'custom.original-hourglass', name: 'Saved original', icons: { 'status.waiting': asset } }))
    const before = serializeThemeFile(saved)
    expect(previewTheme(saved).applied).toBe(true)
    expect(symbol().querySelector('[data-semantic-icon-part]')).toBeNull()
    expect(symbol().children.length).toBeGreaterThan(0)
    expect(serializeThemeFile(saved)).toBe(before)
  }
  expect(previewTheme(GRAPHITE_THEME).applied).toBe(true)
  expect(symbol().querySelector('[data-semantic-icon-part="hourglass-upper"]')).not.toBeNull()
})
