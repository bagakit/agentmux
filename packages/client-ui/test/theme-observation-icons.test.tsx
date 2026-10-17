// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME } from '../src/theme/catalog.js'
import { themeDocumentSchema } from '../src/theme/schema.js'
import { ICON_GLYPHS } from '../src/theme/icon-catalog.js'
import { SemanticIcon, semanticIconHref, createSemanticIconElement, iconShapes } from '../src/theme/icons.js'
import { mountThemeRuntime, previewTheme } from '../src/theme/runtime.js'

import { getSemanticIconCatalog } from '../src/theme/index.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
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


describe('observation status icon meanings', () => {
  it('discovers distinct observation and interruption meanings while retaining exact user overrides in both projections', () => {
    const catalog = getSemanticIconCatalog()
    for (const id of ['status.activity-unknown', 'status.interrupted'] as const) expect(catalog.icons.find(icon => icon.id === id)).toBeDefined()
    expect(iconShapes('status.activity-unknown')).not.toEqual(iconShapes('status.idle'))
    expect(iconShapes('status.activity-unknown')).not.toEqual(iconShapes('status.presence-unknown'))
    expect(iconShapes('status.interrupted')).not.toEqual(iconShapes('status.killed'))
    expect(iconShapes('status.interrupted')).not.toEqual(iconShapes('status.paused'))
    expect(iconShapes('status.interrupted')).not.toEqual(iconShapes('status.failed'))
    const custom = { ...GRAPHITE_THEME, icons: { 'status.activity-unknown': { kind: 'glyph' as const, glyph: 'x' as const } } }
    expect(themeDocumentSchema.safeParse(custom).success).toBe(true)
    runtime()
    const host = mount(<SemanticIcon name="status.activity-unknown" size={12} animation="none" />)
    const native = createSemanticIconElement('status.activity-unknown', document, { size: 12, animation: 'none' }); host.append(native)
    const symbol = document.getElementById(semanticIconHref('status.activity-unknown').slice(1))!
    const original = symbol.innerHTML
    expect(previewTheme(custom).applied).toBe(true)
    expect(iconShapes('status.activity-unknown', custom.icons)).toEqual(ICON_GLYPHS.x)
    expect(document.getElementById(semanticIconHref('status.activity-unknown').slice(1))!.innerHTML).not.toBe(original)
    expect(host.querySelectorAll('[data-semantic-icon="status.activity-unknown"]')).toHaveLength(2)
    expect(native.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.activity-unknown'))
    expect(host.querySelector('.semantic-icon-motion')).toBeNull()
  })
})
