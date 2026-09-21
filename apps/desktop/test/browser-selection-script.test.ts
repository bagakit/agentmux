import { describe, expect, it } from 'vitest'
import {
  buildBrowserAnnotationMarkerScript,
  buildCancelBrowserAnnotationMarkerScript,
  buildBrowserElementSelectionScript,
  buildCancelBrowserElementSelectionScript
} from '../src/main/browser-selection-script.js'

describe('Browser selection isolated-world scripts', () => {
  it('emits parseable JavaScript for every isolated-world command', () => {
    const marker = {
      id: 'annotation-1',
      index: 0,
      rectViewport: { x: 1, y: 2, width: 30, height: 40 },
      rectPage: { x: 5, y: 6, width: 30, height: 40 },
      isFixed: false
    }
    for (const script of [
      buildBrowserElementSelectionScript(1),
      buildCancelBrowserElementSelectionScript(2),
      buildBrowserAnnotationMarkerScript([marker], 3),
      buildCancelBrowserAnnotationMarkerScript(3)
    ]) {
      expect(() => new Function(script)).not.toThrow()
    }
  })

  it('uses a closed, pointer-transparent overlay and bounded extraction', () => {
    const script = buildBrowserElementSelectionScript(7)

    expect(script).toContain("attachShadow({ mode: 'closed' })")
    expect(script).toContain('pointer-events:none')
    expect(script).toContain("document.addEventListener('click', onClick, true)")
    expect(script).toContain('event.composedPath()')
    expect(script).toContain('CSS.escape(current.id)')
    expect(script).toContain('event.stopImmediatePropagation()')
    expect(script).toContain('Array.from(element.attributes).slice(0, 64)')
    expect(script).toContain("event.key !== 'Escape'")
    expect(script.match(/if \(!event\.isTrusted\) return;/g)).toHaveLength(3)
    expect(script).toContain('reject(error)')
    expect(script).not.toContain("typeof event.composedPath")
    expect(script).not.toContain("typeof globalThis.CSS")
    expect(script).not.toContain("typeof event.stopImmediatePropagation")
    expect(script).not.toContain("mode: 'open'")
  })

  it('builds an explicit cancellation command', () => {
    const script = buildCancelBrowserElementSelectionScript(8)
    expect(script).toContain('previous.cancel()')
    expect(script).toContain('previous.revision > revision')
  })

  it('serializes only validated marker data into a closed non-interactive overlay', () => {
    const script = buildBrowserAnnotationMarkerScript([{
      id: 'annotation-1',
      index: 0,
      rectViewport: { x: 1, y: 2, width: 30, height: 40 },
      rectPage: { x: 5, y: 6, width: 30, height: 40 },
      isFixed: false
    }], 9)

    expect(script).toContain('annotation-1')
    expect(script).toContain("attachShadow({ mode: 'closed' })")
    expect(script).toContain('pointer-events:none')
    expect(script).not.toContain("mode: 'open'")
  })

  it('orders late selection and marker operations by Main-owned revision', () => {
    expect(buildBrowserElementSelectionScript(11)).toContain('previous.revision >= revision')
    expect(buildBrowserAnnotationMarkerScript([], 12)).toContain('previous.revision >= revision')
    expect(buildCancelBrowserAnnotationMarkerScript(12)).toContain('state.revision === 12')
  })
})

it('retains only the actual chosen node for the current inspection, ignores synthetic events, and clears the retained DOM owner', async () => {
  const { runInNewContext } = await import('node:vm')
  const { buildSelectedBrowserElementExpression } = await import('../src/main/browser-selection-script.js')
  const listeners = new Map<string, (event: unknown) => void>()
  const document: any = {
    title: 'Fixture', documentElement: null,
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name)
  }
  class Element {
    readonly ownerDocument = document
    readonly style: Record<string, string> = {}
    readonly attributes: { name: string; value: string }[] = []
    readonly tagName = 'BUTTON'
    readonly innerText = 'Actual selected button'
    readonly textContent = 'Actual selected button'
    readonly outerHTML = '<button>Actual selected button</button>'
    readonly parentElement = null
    readonly previousElementSibling = null
    readonly nextElementSibling = null
    appendChild() {}
    append() {}
    setAttribute() {}
    getAttribute() { return null }
    contains() { return false }
    remove() {}
    attachShadow() { return { append() {} } }
    getBoundingClientRect() { return { x: 0, y: 0, width: 200, height: 50 } }
  }
  document.body = new Element()
  document.documentElement = document.body
  document.createElement = () => new Element()
  const world = { document, Element, getComputedStyle: () => ({ position: 'static' }),
    CSS: { escape: (value: string) => value }, location: { href: 'https://example.test/' }, window: { scrollX: 0, scrollY: 0 } }
  const context = (await import('node:vm')).createContext(world)
  const node = new Element()
  const event = (isTrusted: boolean) => ({ isTrusted, target: node, composedPath: () => [node], preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} })
  const inspectionToken = 'main-owned-inspection-token'
  const selecting = runInNewContext(buildBrowserElementSelectionScript(20, inspectionToken), context) as Promise<unknown>
  listeners.get('click')!(event(false))
  expect(runInNewContext(buildSelectedBrowserElementExpression(20, inspectionToken), context)).toBeUndefined()
  expect(listeners.has('click')).toBe(true)
  listeners.get('click')!(event(true))
  expect(await selecting).toMatchObject({ accessibleName: 'Actual selected button' })
  expect(runInNewContext(buildSelectedBrowserElementExpression(20, inspectionToken), context)).toBe(node)
  expect(runInNewContext(buildSelectedBrowserElementExpression(19, inspectionToken), context)).toBeUndefined()
  expect(runInNewContext(buildSelectedBrowserElementExpression(20, 'unrelated-inspection-token'), context)).toBeUndefined()
  expect(listeners.size).toBe(0)
  const retained = runInNewContext('globalThis.__agentMuxBrowserSelection', context)
  runInNewContext(buildCancelBrowserElementSelectionScript(20), context)
  expect(retained.selectedTarget).toBeNull()
  expect(runInNewContext(buildSelectedBrowserElementExpression(20, inspectionToken), context)).toBeUndefined()
  expect(listeners.size).toBe(0)
})
