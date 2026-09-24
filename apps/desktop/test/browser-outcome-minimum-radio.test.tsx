import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Window, type HTMLInputElement } from 'happy-dom'
import { describe, expect, it } from 'vitest'
import { BrowserOutcomeCriteria } from '../src/renderer/src/components/BrowserOutcomeCriteria'
import { auditMinimumRadioGeometry, readMinimumRadioGeometry } from '../scripts/browser-outcome-probe-scenario.mjs'

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
    probe: { cdp: { evaluate: async (expression: string) => { reads.push(expression); return JSON.parse(JSON.stringify(window.eval(expression))) } } } }
  return { ctx, window, radios, reads, stage, close: () => window.happyDOM.cancelAsync() }
}

describe('minimum completion radios source observer', () => {
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
