import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { SemanticIcon, semanticIconComponent, createSemanticIconElement, semanticIconHref } from '../src/theme/icons.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.replaceChildren() })

it('keeps all semantic names static until an instance explicitly selects an animation', () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const Working = semanticIconComponent('status.working')
  act(() => root!.render(<><Working /><SemanticIcon name="status.streaming" /><SemanticIcon name="status.browser-running" /></>))
  expect(host.querySelectorAll('svg')).toHaveLength(3)
  expect(host.querySelector('.semantic-icon-motion')).toBeNull()
  act(() => root!.render(<Working animation="work" size={12} color="#267a48"><title>Current work</title></Working>))
  expect(host.querySelector('.semantic-icon-motion')?.getAttribute('data-icon-animation')).toBe('work')
  expect(host.querySelector('svg')?.style.color).toBe('#267a48')
  expect(host.querySelector('title')?.textContent).toBe('Current work')
  expect(host.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('status.working'))
  act(() => root!.render(<Working animation="none" />))
  expect(host.querySelectorAll('svg')).toHaveLength(1)
  expect(host.querySelector('.semantic-icon-motion')).toBeNull()
})

it('honors explicit instance pen and color, then style, then theme defaults without changing other instances', () => {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<><SemanticIcon name="status.working" color="tomato" strokeWidth={2.4} strokeLinecap="butt" strokeLinejoin="bevel"
    style={{ color: 'blue', strokeWidth: 1, strokeLinecap: 'square' }} aria-label="Current output" role="img" />
    <SemanticIcon name="status.working" style={{ color: 'gold', strokeWidth: 2 }} /><SemanticIcon name="status.working" /></>))
  const [explicit, styled, inherited] = [...host.querySelectorAll('svg')]
  expect(explicit!.style.color).toBe('tomato'); expect(explicit!.style.strokeWidth).toBe('2.4')
  expect(explicit!.style.strokeLinecap).toBe('butt'); expect(explicit!.style.strokeLinejoin).toBe('bevel')
  expect(explicit!.getAttribute('aria-label')).toBe('Current output'); expect(explicit!.getAttribute('role')).toBe('img')
  expect(styled!.style.color).toBe('gold'); expect(styled!.style.strokeWidth).toBe('2')
  expect(inherited!.style.color).toBe(''); expect(inherited!.style.strokeWidth).toBe('var(--icon-stroke-width, 1.75)')
})

it('native static callers retain an SVG while explicit native animation uses the same semantic projection and options', () => {
  const node: SVGSVGElement = createSemanticIconElement('status.working', document)
  expect(node.tagName.toLowerCase()).toBe('svg'); expect(node.style.strokeWidth).toBe('var(--icon-stroke-width, 1.75)')
  const animated = createSemanticIconElement('status.working', document, { animation: 'work', color: 'tomato', strokeWidth: 2.4, strokeLinecap: 'butt', size: 10 })
  expect(animated.tagName.toLowerCase()).toBe('span'); expect(animated.dataset.iconAnimation).toBe('work')
  const svg = animated.querySelector('svg')!
  expect(svg.style.color).toBe('tomato'); expect(svg.style.strokeWidth).toBe('2.4'); expect(svg.style.strokeLinecap).toBe('butt')
  expect(svg.getAttribute('width')).toBe('10'); expect(svg.querySelector('use')!.getAttribute('href')).toBe(node.querySelector('use')!.getAttribute('href'))
})
