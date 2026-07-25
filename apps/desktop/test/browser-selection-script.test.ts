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
