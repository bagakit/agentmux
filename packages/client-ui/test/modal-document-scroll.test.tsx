// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import * as Modal from '../src/components/Modal.js'

function backgroundWheel(target: HTMLElement): boolean {
  const Event = target.ownerDocument.defaultView!.WheelEvent
  const event = new Event('wheel', { bubbles: true, cancelable: true, deltaY: 40 })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

function hasScrollLockStyle(document: Document): boolean {
  return Array.from(document.head.querySelectorAll('style')).some(style => style.textContent?.includes('body[data-scroll-locked]'))
}

function createDocuments() {
  const mount = document.createElement('div'), rootA = document.createElement('div')
  const outsideA = document.createElement('div'), frame = document.createElement('iframe')
  document.body.append(mount, rootA, outsideA, frame)
  const child = frame.contentDocument!
  expect(child.defaultView).not.toBeNull()
  const rootB = child.createElement('div'), outsideB = child.createElement('div')
  child.body.append(rootB, outsideB)
  return { mount, rootA, outsideA, child, rootB, outsideB, frame, root: createRoot(mount) }
}

function Scene({ container, name }: { container: HTMLElement; name: string }) {
  return <Modal.Root open><Modal.Portal container={container}>
    <Modal.Overlay data-scroll-scrim={name} /><Modal.Content>
      <Modal.Title>{name}</Modal.Title><Modal.Description>Original document and input boundary</Modal.Description>
      <input aria-label={`${name} draft`} defaultValue="Original unsent draft" />
      <div data-scroll-content="" style={{ overflowY: 'auto', height: 100 }}>Scrollable content</div>
    </Modal.Content>
  </Modal.Portal></Modal.Root>
}

async function render(root: Root, children: React.ReactNode) {
  await act(async () => root.render(children))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
}

it('moves the original modal scroll boundary and stylesheet from A to a real iframe document B and back', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const d = createDocuments()
  let original: HTMLInputElement | null = null
  try {
    for (const destination of [d.rootA, d.rootB, d.rootA]) {
      await render(d.root, <Scene container={destination} name="Original moved request" />)
      const activeDocument = destination.ownerDocument, inA = activeDocument === document
      expect(destination.querySelector('[data-scroll-scrim]')?.ownerDocument).toBe(activeDocument)
      expect(destination.querySelector('[role="dialog"]')?.ownerDocument).toBe(activeDocument)
      const input = destination.querySelector('input')!
      if (!original) { original = input; input.value = 'Edited unsent draft' }
      expect(input).toBe(original)
      expect(input.value).toBe('Edited unsent draft')
      expect(backgroundWheel(d.outsideA)).toBe(inA)
      expect(backgroundWheel(d.outsideB)).toBe(!inA)
      expect(document.body.hasAttribute('data-scroll-locked')).toBe(inA)
      expect(d.child.body.hasAttribute('data-scroll-locked')).toBe(!inA)
      expect(hasScrollLockStyle(document)).toBe(inA)
      expect(hasScrollLockStyle(d.child)).toBe(!inA)

      const scroller = destination.querySelector<HTMLElement>('[data-scroll-content]')!
      Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: 100 } })
      scroller.scrollTop = 20
      expect(backgroundWheel(scroller)).toBe(false)
    }
  } finally {
    await act(async () => d.root.unmount())
    expect(backgroundWheel(d.outsideA)).toBe(false)
    expect(backgroundWheel(d.outsideB)).toBe(false)
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false)
    expect(d.child.body.hasAttribute('data-scroll-locked')).toBe(false)
    expect(hasScrollLockStyle(document)).toBe(false)
    expect(hasScrollLockStyle(d.child)).toBe(false)
    d.mount.remove(); d.rootA.remove(); d.outsideA.remove(); d.frame.remove()
    vi.unstubAllGlobals()
  }
})

it('keeps two document scroll stacks independent and releases only the closed document', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const d = createDocuments()
  try {
    await render(d.root, <><Scene container={d.rootA} name="Original A" /><Scene container={d.rootB} name="Original B" /></>)
    expect(backgroundWheel(d.outsideA)).toBe(true)
    expect(backgroundWheel(d.outsideB)).toBe(true)
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true)
    expect(d.child.body.hasAttribute('data-scroll-locked')).toBe(true)
    expect(hasScrollLockStyle(document)).toBe(true)
    expect(hasScrollLockStyle(d.child)).toBe(true)
    await render(d.root, <><Scene container={d.rootA} name="Original A" />{null}</>)
    expect(backgroundWheel(d.outsideA)).toBe(true)
    expect(backgroundWheel(d.outsideB)).toBe(false)
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true)
    expect(d.child.body.hasAttribute('data-scroll-locked')).toBe(false)
    expect(hasScrollLockStyle(document)).toBe(true)
    expect(hasScrollLockStyle(d.child)).toBe(false)
  } finally {
    await act(async () => d.root.unmount())
    expect(backgroundWheel(d.outsideA)).toBe(false)
    expect(backgroundWheel(d.outsideB)).toBe(false)
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false)
    expect(d.child.body.hasAttribute('data-scroll-locked')).toBe(false)
    expect(hasScrollLockStyle(document)).toBe(false)
    expect(hasScrollLockStyle(d.child)).toBe(false)
    d.mount.remove(); d.rootA.remove(); d.outsideA.remove(); d.frame.remove()
    vi.unstubAllGlobals()
  }
})

it('retains the original scroll packages default API and no-DOM server rendering', () => {
  const require = createRequire(import.meta.url)
  const dialogRequire = createRequire(require.resolve('@radix-ui/react-dialog'))
  const scrollRequire = createRequire(dialogRequire.resolve('react-remove-scroll'))
  const { RemoveScroll } = dialogRequire('react-remove-scroll')
  const { RemoveScrollBar } = scrollRequire('react-remove-scroll-bar')
  const { styleSingleton } = scrollRequire('react-style-singleton')
  const Style = styleSingleton()
  vi.stubGlobal('document', undefined)
  vi.stubGlobal('window', undefined)
  try {
    expect(renderToString(<RemoveScroll><span>Original content</span></RemoveScroll>)).toContain('Original content')
    expect(renderToString(<RemoveScrollBar />)).toBe('')
    expect(renderToString(<Style styles="body { overflow: hidden; }" />)).toBe('')
  } finally { vi.unstubAllGlobals() }
})
