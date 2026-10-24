// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SemanticIcon, createSemanticIconElement, semanticIconHref } from '../src/theme/icons.js'
import { mountThemeRuntime, previewTheme } from '../src/theme/runtime.js'
import { BUILTIN_THEMES, GRAPHITE_THEME } from '../src/theme/catalog.js'
import { parseThemeFile, serializeThemeFile, type ThemeIconAsset } from '../src/theme/schema.js'
import { WorkflowStatusGlyph } from '../src/components/WorkflowObservation.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root, release: () => void, host: HTMLDivElement
const symbol = () => document.getElementById(semanticIconHref('status.working').slice(1))!
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  release = mountThemeRuntime(window, { appAppearance: 'light' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); release(); host.remove(); vi.unstubAllGlobals() })

it('uses the single root pen leaf through actual current Workflow and native consumers while recorded and default icons stay static', () => {
  act(() => root.render(<><WorkflowStatusGlyph status="running" /><WorkflowStatusGlyph status="running" recorded /><SemanticIcon name="status.working" /></>))
  const native = createSemanticIconElement('status.working', document, { animation: 'work', size: 12 }); host.append(native)
  expect(host.querySelectorAll('[data-icon-animation="work"]')).toHaveLength(2)
  expect(host.querySelectorAll('svg.semantic-icon')).toHaveLength(4)
  expect(host.querySelector('[data-semantic-icon="status.running"]')!.closest('[data-icon-animation]')).toBeNull()
  const workingIcons = host.querySelectorAll('[data-icon-animation="work"] > svg.semantic-icon')
  expect(workingIcons).toHaveLength(2)
  for (const svg of workingIcons) {
    expect(svg.querySelector('use')!.getAttribute('href')).toBe(semanticIconHref('status.working'))
    expect(svg.parentElement!.querySelector('.semantic-icon-work-pen use')!.getAttribute('href')).toBe('#agentmux-icon-status.working--work-pen')
    expect(svg.querySelector('path')).toBeNull() // Geometry is retained once in the root, never duplicated per instance.
  }
  const pen = symbol().querySelector('[data-semantic-icon-part="writing-pen"]')!
  expect(pen.tagName.toLowerCase()).toBe('path')
  expect(pen.getAttribute('d')).toBe('M9 20l1-4 9-9 3 3-9 9-4 1Z')
  const text = symbol().querySelector('path:not([data-semantic-icon-part])')!
  expect(text.getAttribute('d')).toBe('M4 6h8 M4 12h5')
  expect(symbol().querySelectorAll('[data-semantic-icon-part]')).toHaveLength(1)
  act(() => root.render(<WorkflowStatusGlyph status="completed" />))
  expect(host.querySelector('[data-semantic-icon="status.completed"]')!.closest('[data-icon-animation]')).toBeNull()
})

it('retains the same mounted references and original pen options through all builtin theme projections', () => {
  act(() => root.render(<SemanticIcon name="status.working" animation="work" size={14} color="tomato" strokeWidth={2.4} />))
  const svg = host.querySelector('svg')!, use = svg.querySelector('use')!
  for (const theme of BUILTIN_THEMES) {
    act(() => { expect(previewTheme(theme).applied, theme.id).toBe(true) })
    expect(symbol().querySelectorAll('[data-semantic-icon-part="writing-pen"]'), theme.id).toHaveLength(1)
    expect(host.querySelector('svg')).toBe(svg); expect(svg.querySelector('use')).toBe(use)
    expect(svg.style.color).toBe('tomato'); expect(svg.style.strokeWidth).toBe('2.4')
    expect(svg.getAttribute('width')).toBe('14')
  }
})

it('never guesses a moving pen from a user glyph or matching custom path, and restores authored parts through the original theme owner', () => {
  const native = createSemanticIconElement('status.working', document, { animation: 'work', size: 12 }); host.append(native)
  const use = native.querySelector('use')!
  const assets: ThemeIconAsset[] = [{ kind: 'glyph', glyph: 'activity' }, { kind: 'paths', paths: [{ d: 'M9 20l1-4 9-9 3 3-9 9-4 1Z' }] }]
  for (const asset of assets) {
    const saved = parseThemeFile(serializeThemeFile({ ...GRAPHITE_THEME, id: 'custom.original-pen', name: 'Original choice', icons: { 'status.working': asset } }))
    const before = serializeThemeFile(saved)
    act(() => { expect(previewTheme(saved).applied).toBe(true) })
    expect(symbol().children.length).toBeGreaterThan(0)
    expect(symbol().querySelector('[data-semantic-icon-part]')).toBeNull()
    expect(native.querySelector('use')).toBe(use)
    expect(serializeThemeFile(saved)).toBe(before)
  }
  act(() => { expect(previewTheme(GRAPHITE_THEME).applied).toBe(true) })
  expect(symbol().querySelector('[data-semantic-icon-part="writing-pen"]')).not.toBeNull()
  expect(native.querySelector('use')).toBe(use)
})
