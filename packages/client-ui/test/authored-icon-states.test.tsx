// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AUTHORED_ICON_DEFINITIONS, AUTHORED_ICON_DESIGNS, AUTHORED_ICON_GLYPH_IDS, AUTHORED_ICON_GLYPHS } from '../src/theme/icon-authored.js'
import { SemanticIcon, createSemanticIconElement, semanticIconHref, ICON_ANIMATIONS } from '../src/theme/icons.js'
import { mountThemeRuntime, previewTheme } from '../src/theme/runtime.js'
import { GRAPHITE_THEME } from '../src/theme/catalog.js'
import { parseThemeFile, serializeThemeFile } from '../src/theme/schema.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let release: (() => void) | undefined
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; release?.(); release = undefined; document.body.replaceChildren(); vi.unstubAllGlobals() })

it('requires a complete state design beside every authored drawing, with registered local parts for explicit motion', () => {
  const ids = Object.keys(AUTHORED_ICON_DEFINITIONS) as typeof AUTHORED_ICON_GLYPH_IDS
  expect(ids.length).toBeGreaterThan(0)
  expect(AUTHORED_ICON_GLYPH_IDS).toEqual(ids)
  expect(Object.keys(AUTHORED_ICON_DESIGNS)).toEqual(ids)
  for (const id of ids) {
    const definition = AUTHORED_ICON_DEFINITIONS[id], design = AUTHORED_ICON_DESIGNS[id]
    expect(AUTHORED_ICON_GLYPHS[id]).toBe(definition.shapes)
    expect(design.rest.trim().length, id).toBeGreaterThan(0)
    for (const [, attrs] of definition.shapes) {
      if ('data-semantic-icon-part' in attrs && ['feedback-forward', 'feedback-down', 'feedback-trace'].includes(attrs['data-semantic-icon-part'])) expect('pathLength' in attrs ? attrs.pathLength : undefined, id).toBe('1')
    }
    expect(design.motion.description.trim().length, id).toBeGreaterThan(0)
    expect(ICON_ANIMATIONS).toContain(design.motion.animation)
    if (design.motion.kind === 'still') expect(design.motion.animation).toBe('none')
    else {
      expect(definition.shapes.some(([, attrs]) => 'data-semantic-icon-part' in attrs), id).toBe(true)
      expect(design.motion.trigger.trim().length, id).toBeGreaterThan(0)
      if (design.motion.kind === 'once') expect(design.motion.animation).toBe('feedback')
      else expect(['work', 'stream', 'execute', 'wait', 'orbit']).toContain(design.motion.animation)
    }
  }
})

it('keeps React and native static/finite instances on the original shared drawing without path copies', () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<SemanticIcon name="action.edit-demonstration" animation="feedback" />))
  expect(host.querySelector('[data-icon-animation="feedback"]')).not.toBeNull()
  const native = createSemanticIconElement('action.edit-demonstration', document)
  expect(native.tagName.toLowerCase()).toBe('svg')
  expect(native.querySelector('use')!.getAttribute('href')).toBe(host.querySelector('use')!.getAttribute('href'))
  expect(native.querySelector('path')).toBeNull()
  const feedback = createSemanticIconElement('action.edit-demonstration', document, { animation: 'feedback' })
  expect(feedback.getAttribute('data-icon-animation')).toBe('feedback')
  expect(feedback.querySelector('use')!.getAttribute('href')).toBe(semanticIconHref('action.edit-demonstration'))
})

it('retains explicit user drawings and theme files while state presentation changes, and restores registered parts through the original owner', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  release = mountThemeRuntime(window, { appAppearance: 'light' })
  const custom = parseThemeFile(serializeThemeFile({ ...GRAPHITE_THEME, id: 'custom.saved-states', name: 'Saved original', icons: {
    'status.browser-running': { kind: 'paths', paths: [{ d: 'M3 4h18v16H3Z', fill: 'none' }] },
    'action.edit-demonstration': { kind: 'glyph', glyph: 'activity' }
  } }))
  const saved = serializeThemeFile(custom)
  expect(previewTheme(custom).applied).toBe(true)
  for (const [name, animation] of [['status.browser-running', 'execute'], ['action.edit-demonstration', 'feedback']] as const) {
    const symbol = document.getElementById(semanticIconHref(name).slice(1))!
    expect(symbol.children.length).toBeGreaterThan(0); expect(symbol.querySelector('[data-semantic-icon-part]')).toBeNull()
    createSemanticIconElement(name, document, { animation })
  }
  expect(serializeThemeFile(custom)).toBe(saved)
  expect(previewTheme(GRAPHITE_THEME).applied).toBe(true)
  expect(document.querySelector('#agentmux-icon-status\\.browser-running [data-semantic-icon-part="execution-arrow"]')).not.toBeNull()
})
