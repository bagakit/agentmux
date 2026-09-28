import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import { describe, expect, it } from 'vitest'
import { showDiagnostic } from '../scripts/browser-local-recovery-probe-scenario.mjs'

// Source-only boundary model. Execute the scenario's actual CDP/Main reads; these
// explicit CSS rectangles cannot prove Native layout, visibility or screenshot quality.
const browserId = 'browser-original', operationId = 'operation-original', sequence = 3
const actual = { id: operationId, startedAt: 1 }
const diagnostic = { step: { sequence }, item: { content: {
  message: 'Recovery: action-completed. Goal: inspect the declared result. 1/2 attempts; 82/5000 ms; 1313/65536 bytes.',
  nextAction: 'Review the recorded outcome before continuing.'
} } }
const readableLabel = 'final recovery goal and budget readable in the real evidence UI'
type Box = { x: number; y: number; width: number; height: number }
type Options = {
  missing?: 'evidence' | 'message' | 'nextAction' | 'rail'
  hidden?: 'message' | 'nextAction'
  noClientRects?: 'message' | 'nextAction'
  messageBounds?: Box
  nextActionBounds?: Box
  railBounds?: Box
  observedOperationId?: string
  beforeSample?: (index: number, model: ReturnType<typeof model>) => void
  samples?: number
}
function model(options: Options = {}) {
  const window = new Window({ width: 800, height: 600 })
  const document = window.document
  document.body.innerHTML = `<section class="browser-surface">
    <div data-native-browser-stage="${browserId}"></div>
    <aside class="browser-trace-rail">
      <section aria-label="Browser operation history"><button class="browser-rsi-history__item"><time datetime="${new Date(actual.startedAt).toISOString()}"></time></button></section>
      <ol class="browser-rsi-timeline" data-operation-id="${operationId}"><li class="browser-rsi-timeline__step is-selected" data-sequence="${sequence}"><button class="browser-rsi-timeline__step-button">Inspect step</button></li></ol>
      <section class="browser-step-evidence" aria-label="Evidence for step ${sequence}: inspect result"><p id="message"></p><p id="next-action"></p></section>
    </aside>
  </section>`
  const message = document.querySelector('#message')!, nextAction = document.querySelector('#next-action')!
  const rail = document.querySelector('.browser-trace-rail')!, evidence = document.querySelector('.browser-step-evidence')!
  message.textContent = diagnostic.item.content.message
  nextAction.textContent = diagnostic.item.content.nextAction
  const scrolls: unknown[] = [], captures: unknown[] = [], reads: string[] = [], clicks: string[] = []
  const geometry = (element: typeof message, box: Box, count = 1) => {
    Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => ({ ...box, right: box.x + box.width, bottom: box.y + box.height }) })
    Object.defineProperty(element, 'getClientRects', { configurable: true, value: () => Array.from({ length: count }, () => box) })
  }
  geometry(message, options.messageBounds ?? { x: 620, y: 100, width: 160, height: 80 }, options.noClientRects === 'message' ? 0 : 1)
  geometry(nextAction, options.nextActionBounds ?? { x: 620, y: 190, width: 160, height: 40 }, options.noClientRects === 'nextAction' ? 0 : 1)
  geometry(rail, options.railBounds ?? { x: 600, y: 80, width: 200, height: 440 })
  const stage = { x: 0, y: 80, width: 600, height: 440 }
  geometry(document.querySelector('[data-native-browser-stage]')!, stage)
  Object.defineProperty(message, 'scrollIntoView', { value: (args: unknown) => scrolls.push(args) })
  if (options.hidden) (options.hidden === 'message' ? message : nextAction).setAttribute('style', 'visibility: hidden')
  if (options.missing === 'evidence') evidence.remove()
  if (options.missing === 'message') message.remove()
  if (options.missing === 'nextAction') nextAction.remove()
  if (options.missing === 'rail') { rail.replaceWith(...rail.childNodes) }
  const native = { webContents: { id: 7, isDestroyed: () => false, getURL: () => 'https://fixture.invalid/current' },
    getBounds: () => stage, getVisible: () => true }
  const nativeWindow = { webContents: { getZoomFactor: () => 1 }, contentView: { children: [native] } }
  const receipt: Record<string, any> = { localRecovery: { kind: 'locator' } }
  let sampleIndex = 0
  const ctx = { browserId, desktopRoot: '/fixture/desktop', receipt,
    selectors: (selector: string) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`,
    click: async (_cdp: unknown, expression: string) => {
      const targets = window.eval(expression)
      expect(targets).toHaveLength(1)
      clicks.push(targets[0].className)
      // Model boundary only: history selection already exists, as it would after the real click.
      if (options.observedOperationId && clicks.length === 2) document.querySelector('.browser-rsi-timeline')!.setAttribute('data-operation-id', options.observedOperationId)
    },
    waitFor: async (label: string, read: () => Promise<unknown>) => {
      for (let index = 0; index < (label === readableLabel ? options.samples ?? 1 : 1); index++) {
        const result = await read()
        if (result) return result
      }
      throw new Error(`Browser recovery timed out: ${label}`)
    },
    capture: async (...args: unknown[]) => { captures.push(args.slice(1)) },
    probe: { cdp: { evaluate: async (expression: string) => {
      reads.push(expression)
      // This is the exact emitted observation program, not a second geometry oracle.
      if (expression.includes("coordinateSpace:'renderer-css-px'")) options.beforeSample?.(sampleIndex++, result)
      return JSON.parse(JSON.stringify(window.eval(expression)))
    } }, main: { evaluate: async (expression: string) => runInNewContext(expression, {
      process: { getBuiltinModule: () => ({ createRequire: () => () => ({ BrowserWindow: { getAllWindows: () => [nativeWindow] } }) }) }
    }) } }
  }
  const result = { ctx, window, message, nextAction, rail, geometry, scrolls, captures, reads, clicks,
    close: () => window.happyDOM.cancelAsync() }
  return result
}

// Mirror only the canonical's shared-receipt catch/finally serialization boundary.
// No launch, cleanup, deadline, process or layout implementation is replaced here.
async function runAndPersist(fixture: ReturnType<typeof model>) {
  let error: unknown, saved: Record<string, any> | undefined
  try { await showDiagnostic(fixture.ctx, actual, diagnostic, 'narrow') }
  catch (caught) { error = caught; fixture.ctx.receipt.failure = String(caught) }
  finally { saved = JSON.parse(JSON.stringify(fixture.ctx.receipt)) }
  return { error, saved: saved! }
}

describe('local recovery diagnostic Source observation, without a Desktop', () => {
  it.each([
    [{ missing: 'evidence' }, 'message-missing', false],
    [{ missing: 'message' }, 'message-missing', false],
    [{ missing: 'nextAction' }, 'next-action-missing', false],
    [{ hidden: 'message' }, 'message-hidden', false],
    [{ hidden: 'nextAction' }, 'next-action-hidden', false],
    [{ noClientRects: 'message' }, 'message-no-client-rects', false],
    [{ noClientRects: 'nextAction' }, 'next-action-no-client-rects', false],
    [{ missing: 'rail' }, 'rail-missing', true],
    [{ messageBounds: { x: 810, y: 100, width: 160, height: 80 } }, 'message-no-intersection', true],
    [{ nextActionBounds: { x: 620, y: 610, width: 160, height: 40 } }, 'next-action-no-intersection', true]
  ] as const)('preserves the final %j observation through failure receipt serialization', async (options, reason, scrolled) => {
    const fixture = model(options)
    try {
      const { error, saved } = await runAndPersist(fixture)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toBe(`Error: Browser recovery timed out: ${readableLabel}`)
      expect(saved.localRecovery.diagnosticUiSample).toMatchObject({
        label: 'narrow', browserId, operationId, sequence, observedOperationId: operationId, selectedSequence: String(sequence),
        readable: false, reason, coordinateSpace: 'renderer-css-px', scrollApplied: scrolled,
        viewport: { x: 0, y: 0, width: 800, height: 600 }
      })
      expect(Object.keys(saved.localRecovery.diagnosticUiSample)).toContain('message')
      expect(Object.keys(saved.localRecovery.diagnosticUiSample)).toContain('nextAction')
      expect(Object.keys(saved.localRecovery.diagnosticUiSample)).toContain('rail')
      expect(saved.localRecovery.ui).toBeUndefined()
      expect(saved.localRecovery.nativeOwners).toBeUndefined()
      expect(fixture.captures).toEqual([])
      expect(fixture.scrolls).toEqual(scrolled ? [{ block: 'nearest' }] : [])
      expect(fixture.reads.length).toBeGreaterThan(0)
    } finally { fixture.close() }
  })

  it('retains both clipped rectangles and the exact text when the original readability gate passes', async () => {
    const fixture = model({ messageBounds: { x: 590, y: 70, width: 220, height: 80 }, nextActionBounds: { x: 620, y: 490, width: 200, height: 60 } })
    try {
      const { error, saved } = await runAndPersist(fixture)
      expect(error).toBeUndefined()
      expect(saved.localRecovery.diagnosticUiSample).toMatchObject({ readable: true, reason: 'readable', operationId, observedOperationId: operationId,
        message: { present: true, clientRects: 1, bounds: { x: 590, y: 70, width: 220, height: 80 }, intersection: { x: 600, y: 80, width: 200, height: 70 } },
        nextAction: { present: true, clientRects: 1, bounds: { x: 620, y: 490, width: 200, height: 60 }, intersection: { x: 620, y: 490, width: 180, height: 30 } },
        rail: { present: true, bounds: { x: 600, y: 80, width: 200, height: 440 } } })
      expect(saved.localRecovery.ui).toEqual([{ label: 'narrow', operationId, text: diagnostic.item.content.message, nextAction: diagnostic.item.content.nextAction,
        intersection: { x: 600, y: 80, width: 200, height: 70 }, bounds: { x: 590, y: 70, width: 220, height: 80 },
        nextActionBounds: { x: 620, y: 490, width: 200, height: 60 }, nextActionIntersection: { x: 620, y: 490, width: 180, height: 30 } }])
      expect(saved.localRecovery.nativeOwners).toHaveLength(1)
      expect(fixture.captures).toEqual([['narrow-local-recovery-locator-diagnostic', 'operations', 'https://fixture.invalid/current']])
      expect(fixture.clicks).toEqual(['browser-rsi-history__item', 'browser-rsi-timeline__step-button'])
      expect(fixture.scrolls).toEqual([{ block: 'nearest' }])
    } finally { fixture.close() }
  })

  it('overwrites one bounded sample with the last failed reply and keeps both intersections', async () => {
    const fixture = model({ samples: 3, beforeSample: (index, view) => view.geometry(view.message, { x: 810 + index, y: 100, width: 160, height: 80 }) })
    try {
      const { saved } = await runAndPersist(fixture)
      expect(saved.localRecovery.diagnosticUiSample).toMatchObject({ reason: 'message-no-intersection',
        message: { bounds: { x: 812, y: 100 }, intersection: { x: 812, y: 100, width: 0, height: 80 } },
        nextAction: { intersection: { x: 620, y: 190, width: 160, height: 40 } } })
      expect(Object.keys(saved.localRecovery)).toEqual(['kind', 'diagnosticUiSample'])
      expect(fixture.scrolls).toEqual([{ block: 'nearest' }, { block: 'nearest' }, { block: 'nearest' }])
    } finally { fixture.close() }
  })

  it('keeps the requested identity separate from a foreign observed operation and preserves the original rejection', async () => {
    const fixture = model({ observedOperationId: 'operation-foreign' })
    try {
      const { error, saved } = await runAndPersist(fixture)
      expect(error).toBeInstanceOf(Error)
      expect(saved.localRecovery.diagnosticUiSample).toMatchObject({ operationId, observedOperationId: 'operation-foreign', sequence, readable: true })
      expect(saved.localRecovery.ui).toBeUndefined()
      expect(fixture.captures).toEqual([])
    } finally { fixture.close() }
  })
})
