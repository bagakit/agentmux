import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Window, type HTMLInputElement } from 'happy-dom'
import { describe, expect, it } from 'vitest'
import { BrowserOutcomeCriteria } from '../src/renderer/src/components/BrowserOutcomeCriteria'
import { auditMinimumRadioGeometry, observeMinimumBrowserOutcome, readMinimumRadioGeometry } from '../scripts/browser-outcome-probe-scenario.mjs'

// Source-only read/oracle audit: production markup, emitted readonly probe, explicit geometry model.
// Actual CSS pixels, native focus and the real two-Region Split remain canonical Native gates.
function fixture() {
  const window = new Window({ url: 'http://127.0.0.1:9876/a' })
  const browser = window as any
  const pageUrl = window.location.href
  window.document.body.innerHTML = `<div data-workbench-region-id="region-original"><section class="browser-surface">
    <input aria-label="Browser address" value="${pageUrl}"><div class="browser-stage"></div><aside class="browser-trace-rail">
    ${renderToStaticMarkup(createElement(BrowserOutcomeCriteria, { onRun: async () => {} }))}</aside></section></div>`
  const radios = [...window.document.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
  const rect = (x: number, y: number, width: number, height: number) => new browser.DOMRect(x, y, width, height)
  const region = window.document.querySelector('[data-workbench-region-id]')!
  const stage = window.document.querySelector('.browser-stage')!
  const trace = window.document.querySelector('.browser-trace-rail')!
  region.getBoundingClientRect = () => rect(510, 36, 234.5, 592)
  stage.getBoundingClientRect = () => rect(510, 74, 234.5, 314)
  trace.getBoundingClientRect = () => rect(510, 388, 234.5, 240)
  const labels = radios.map(radio => radio.closest('label')!)
  radios.forEach((radio, index) => {
    radio.checked = radio.value === 'number' // Source fixture state, outside the probe.
    radio.getBoundingClientRect = () => rect(518 + index * 70, 470, 13, 13)
    labels[index]!.getBoundingClientRect = () => rect(516 + index * 70, 464, 64, 25)
  })
  radios.find(radio => radio.checked)!.focus()
  browser.document.elementsFromPoint = (x: number, y: number) => labels.filter(label => {
    const r = label.getBoundingClientRect()
    return x >= r.x && x <= r.right && y >= r.y && y <= r.bottom
  })
  browser.Range.prototype.getClientRects = function () { return [rect(533, 470, 40, 12)] }
  const reads: string[] = []
  const ctx = { pageUrl, selectors: (selector: string) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`,
    probe: { cdp: { evaluate: async (expression: string) => { reads.push(expression); return JSON.parse(JSON.stringify(await window.eval(expression))) } } } }
  return { ctx, window, radios, reads, stage, close: () => window.happyDOM.cancelAsync() }
}

describe('minimum completion radios source observer', () => {
  it('executes the complete real module observer through minimum size, one Tab, original geometry and capture', async () => {
    const item = fixture()
    const calls: unknown[] = []
    const browserId = 'original-browser'
    const receipt: { browserOutcome: { minimumRadio?: any } } = { browserOutcome: {} }
    // Explicit Source doubles for Main, public history, input and capture. The
    // imported observer and its emitted geometry reader/oracle execute unchanged.
    ;(item.window as any).agentmux = { browser: { listOperationHistory: async () => {
      calls.push(['history'])
      return [{ id: 'owned-operation-b', browserId }, { id: 'foreign-operation', browserId: 'sibling-browser' },
        { id: 'owned-operation-a', browserId }]
    } } }
    const sourceProcess = { getBuiltinModule: (name: string) => {
      expect(name).toBe('module')
      return { createRequire: (file: string) => {
        expect(file).toBe('/source-desktop/package.json')
        return (dependency: string) => {
          expect(dependency).toBe('electron')
          return { BrowserWindow: { getAllWindows: () => [{ getMinimumSize: () => {
            calls.push(['minimum-size']); return [1000, 660]
          } }] } }
        }
      } }
    } }
    const probe = { ...item.ctx.probe,
      main: { evaluate: async (expression: string) => new Function('process', `return (${expression})`)(sourceProcess) },
      cdp: { ...item.ctx.probe.cdp, call: async (method: string, parameters: any) => {
        calls.push([method, parameters])
        expect(method).toBe('Input.dispatchKeyEvent')
        if (parameters.type === 'keyDown') item.radios.find(radio => radio.checked)!.focus()
      } }
    }
    const ctx = { ...item.ctx, probe, browserId, desktopRoot: '/source-desktop', receipt,
      resize: async (original: unknown, width: number, height: number) => {
        expect(original).toBe(probe); calls.push(['resize', width, height])
      },
      click: async (original: unknown, expression: string) => {
        expect(original).toBe(probe.cdp)
        const controls = await item.window.eval(expression)
        expect(controls).toHaveLength(1)
        expect(controls[0].closest('label').firstChild.textContent.trim()).toBe('CSS selector')
        controls[0].focus(); calls.push(['click', 'CSS selector'])
      },
      capture: async (original: unknown, label: string, content: string) => {
        expect(original).toBe(probe)
        expect(receipt.browserOutcome.minimumRadio?.regionId).toBe('region-original')
        calls.push(['capture', label, content])
      }
    }
    try {
      let failure: { name: string; message: string } | null = null
      try { await observeMinimumBrowserOutcome(ctx) }
      catch (error) { failure = { name: (error as Error).name, message: (error as Error).message } }
      // Missing real module dependencies become an owning Assertion RED rather
      // than an unhandled import/runtime exit from the test process.
      expect(failure).toBeNull()
      expect(calls).toEqual([
        ['history'], ['minimum-size'], ['resize', 1000, 660], ['click', 'CSS selector'],
        ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }],
        ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }],
        ['history'], ['capture', 'minimum-split-browser-completion-radios', 'operations'], ['resize', 1440, 900]
      ])
      expect(item.reads).toHaveLength(3)
      expect(item.reads[0]).toBe('window.agentmux.browser.listOperationHistory()')
      expect(item.reads[2]).toBe(item.reads[0])
      const observed = receipt.browserOutcome.minimumRadio
      expect(observed.regionId).toBe('region-original')
      expect(observed.region.width).toBe(234.5)
      expect(observed.radios.map((radio: any) => [radio.value, radio.checked, radio.focused, radio.points.map((point: any) => point.owned)])).toEqual([
        ['string', false, false, [true, true, true, true, true]],
        ['number', true, true, [true, true, true, true, true]],
        ['boolean', false, false, [true, true, true, true, true]]
      ])
      expect(() => auditMinimumRadioGeometry(observed)).not.toThrow()
    } finally { await item.close() }
  })

  it('reads the actual finite production labels, checked choice and original nonempty hit stacks', async () => {
    const item = fixture()
    try {
      const observed = await readMinimumRadioGeometry(item.ctx)
      expect(observed.radios.map((radio: { value: string; label: string; checked: boolean; focused: boolean }) => [radio.value, radio.label, radio.checked, radio.focused])).toEqual([
        ['string', 'Text', false, false], ['number', 'Number', true, true], ['boolean', 'Checked', false, false]
      ])
      expect(observed.regionId).toBe('region-original')
      expect(item.reads).toHaveLength(1)
      expect(() => auditMinimumRadioGeometry(observed)).not.toThrow()
    } finally { await item.close() }
  })

  it('rejects an empty real control collection from the emitted read', async () => {
    const item = fixture()
    try {
      for (const radio of item.radios) radio.remove()
      const observed = await readMinimumRadioGeometry(item.ctx)
      expect(observed.radios).toEqual([])
      expect(() => auditMinimumRadioGeometry(observed)).toThrow()
    } finally { await item.close() }
  })

  it('rejects unreadable labels and an unowned original edge hit', async () => {
    const item = fixture()
    try {
      const observed = await readMinimumRadioGeometry(item.ctx)
      expect(observed.radios).toHaveLength(3)
      const clipped = structuredClone(observed); clipped.radios[1].textLines = 5
      expect(() => auditMinimumRadioGeometry(clipped)).toThrow(/readable/)
      const covered = structuredClone(observed); covered.radios[1].points[4].owned = false
      expect(() => auditMinimumRadioGeometry(covered)).toThrow(/owns/)
    } finally { await item.close() }
  })

  it('rejects a zero-area actual page and the wrong claimed minimum split width', async () => {
    const item = fixture()
    try {
      item.stage.getBoundingClientRect = () => new (item.window as any).DOMRect(510, 74, 234.5, 0)
      const emptyPage = await readMinimumRadioGeometry(item.ctx)
      expect(emptyPage.radios).toHaveLength(3)
      expect(() => auditMinimumRadioGeometry(emptyPage)).toThrow(/positive area/)
      const wrongMinimum = structuredClone(emptyPage); wrongMinimum.stage.height = 314; wrongMinimum.region.width = 244.5
      expect(() => auditMinimumRadioGeometry(wrongMinimum)).toThrow(/minimum two-Region/)
    } finally { await item.close() }
  })
})
