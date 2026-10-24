// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME } from '../src/theme/catalog.js'
import { SemanticIcon, createSemanticIconElement, semanticIconHref } from '../src/theme/icons.js'
import { removeIconSprite, updateIconSprite } from '../src/theme/icon-sprite.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  removeIconSprite(document)
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
function theme(icons = GRAPHITE_THEME.icons) {
  updateIconSprite(document, { ...GRAPHITE_THEME, icons }, '#ffffff')
}
function symbol(name: string) { return document.getElementById(`agentmux-icon-${name}`) }
function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  return host
}

it('moves only the declared pen onto an HTML bone and retains the original SVG contract', () => {
  theme()
  const host = mount()
  act(() => root!.render(<SemanticIcon name="status.working" animation="work" size={19}
    color="tomato" strokeWidth={2.4} strokeLinecap="butt" strokeLinejoin="bevel"
    aria-label="Current output" role="img"><title>Current work</title></SemanticIcon>))
  const svg = host.querySelector<SVGSVGElement>('.semantic-icon')!
  expect(svg.getAttribute('width')).toBe('19')
  expect(svg.getAttribute('aria-label')).toBe('Current output')
  expect(svg.getAttribute('role')).toBe('img')
  expect(svg.querySelector('title')?.textContent).toBe('Current work')
  expect(svg.style.color).toBe('tomato')
  expect(svg.style.strokeWidth).toBe('2.4')
  expect(svg.style.strokeLinecap).toBe('butt')
  expect(svg.style.strokeLinejoin).toBe('bevel')
  const bone = host.querySelector('.semantic-icon-work-pen')!
  expect(bone.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
  expect(bone.getAttribute('data-semantic-icon-part')).toBe('writing-pen')
  expect(host.querySelectorAll('use')).toHaveLength(2)
  expect(host.querySelector('.semantic-icon-work-body use')?.getAttribute('href')).toBe(semanticIconHref('status.working'))
  expect(bone.querySelector('use')?.getAttribute('href')).toBe('#agentmux-icon-status.working--work-pen')
  const originalPen = symbol('status.working')!.querySelector('[data-semantic-icon-part="writing-pen"]')!
  const projectedPen = symbol('status.working--work-pen')!.firstElementChild!
  expect(projectedPen.getAttribute('d')).toBe(originalPen.getAttribute('d'))
  expect(projectedPen.hasAttribute('data-semantic-icon-part')).toBe(false)
  expect(symbol('status.working')!.children).toHaveLength(2)
})

it('keeps detached native work references current through custom themes and restoration', () => {
  theme()
  const native = createSemanticIconElement('status.working', document, { animation: 'work', size: 10 })
  const svg = native.querySelector('.semantic-icon')!
  const body = native.querySelector('.semantic-icon-work-body use')!
  const bone = native.querySelector('.semantic-icon-work-pen')!
  const pen = bone.querySelector('use')!
  const addListener = vi.spyOn(window, 'addEventListener')
  theme({ ...GRAPHITE_THEME.icons, 'status.working': { kind: 'paths', paths: [{ d: 'M3 12L21 12' }] } })
  document.body.append(native)
  expect(native.querySelector('.semantic-icon')).toBe(svg)
  expect(native.querySelector('.semantic-icon-work-body use')).toBe(body)
  expect(native.querySelector('.semantic-icon-work-pen')).toBe(bone)
  expect(bone.querySelector('use')).toBe(pen)
  expect(symbol('status.working')!.querySelector('path')!.getAttribute('d')).toBe('M3 12L21 12')
  expect(symbol('status.working--work-pen')).toBeNull()
  const rules = document.querySelector('[data-semantic-icon-sprite] > style')!.textContent!
  expect(rules).not.toContain('[data-semantic-work="status.working"]')
  native.remove()
  theme()
  document.body.append(native)
  expect(native.querySelector('.semantic-icon-work-body use')).toBe(body)
  expect(bone.querySelector('use')).toBe(pen)
  expect(symbol('status.working--work-pen')!.querySelector('path')).not.toBeNull()
  expect(addListener).not.toHaveBeenCalled()
})

it('retains work articulation during presentation updates and changes its live semantic target', () => {
  theme()
  const host = mount()
  act(() => root!.render(<SemanticIcon name="status.working" animation="work" size={12}><title>Writing</title></SemanticIcon>))
  const svg = host.querySelector('.semantic-icon')!
  const bone = host.querySelector('.semantic-icon-work-pen')!
  act(() => root!.render(<SemanticIcon name="status.working" animation="work" size={20} color="gold"><title>Still writing</title></SemanticIcon>))
  expect(host.querySelector('.semantic-icon')).toBe(svg)
  expect(host.querySelector('.semantic-icon-work-pen')).toBe(bone)
  expect(svg.querySelector('title')?.textContent).toBe('Still writing')
  act(() => root!.render(<SemanticIcon name="action.close" animation="work" />))
  expect(host.querySelector('.semantic-icon')).toBe(svg)
  expect(host.querySelector('.semantic-icon-work-body use')?.getAttribute('href')).toBe(semanticIconHref('action.close'))
  expect(symbol('action.close--work-pen')).toBeNull()
  act(() => root!.render(<SemanticIcon name="status.working" animation="none" />))
  const still = host.querySelector('.semantic-icon')!
  expect(still.querySelector('foreignObject')).toBeNull()
  expect(still.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.working'))
})

it('preserves static and other explicit animation projections', () => {
  theme()
  const host = mount()
  act(() => root!.render(<><SemanticIcon name="status.working" /><SemanticIcon name="status.streaming" animation="stream" /></>))
  expect(host.querySelector('foreignObject')).toBeNull()
  expect(host.querySelectorAll('svg')).toHaveLength(2)
  expect(host.querySelectorAll('use')).toHaveLength(2)
  const native = createSemanticIconElement('status.streaming', document, { animation: 'stream' })
  expect(native.querySelector('foreignObject')).toBeNull()
  expect(native.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.streaming'))
})

it('includes complete work geometry references in serialized React and native markup', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<SemanticIcon name="status.working" animation="work"><title>Current work</title></SemanticIcon>)
  const native = createSemanticIconElement('status.working', document, { animation: 'work' })
  expect(host.querySelector('title')?.textContent).toBe('Current work')
  for (const element of [host, native]) {
    expect(element.querySelectorAll('.semantic-icon-work-pen')).toHaveLength(1)
    expect(element.querySelectorAll('use')).toHaveLength(2)
    expect(element.querySelector('.semantic-icon-work-body use')?.getAttribute('href')).toBe(semanticIconHref('status.working'))
    expect(element.querySelector('.semantic-icon-work-pen use')?.getAttribute('href')).toBe('#agentmux-icon-status.working--work-pen')
  }
})
