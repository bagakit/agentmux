// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BrowserOutcomeCriteria } from '../src/renderer/src/components/BrowserOutcomeCriteria'
import type { BrowserOutcomeEvaluation, BrowserOutcomeStatus } from '../src/shared/browser-outcome-criteria'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const labels = { passed: 'Satisfied', 'not-met': 'Not satisfied', unavailable: 'Verification unavailable' }
const reasons = { passed: 'The recorded field equals its declared value.', 'not-met': 'The observed value differs from its declaration.', unavailable: 'The original recorded source cannot be read.' }
const evaluation = (status: BrowserOutcomeStatus): BrowserOutcomeEvaluation => ({
  context: { workspaceId: 'workspace', browserId: 'browser', operationId: 'original', navigationId: 'document' },
  status, conditions: [{ criterion: { kind: 'field-equals', key: 'result', expected: 0 }, status, reason: reasons[status] }]
})
async function mounted(props: Parameters<typeof BrowserOutcomeCriteria>[0]) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(createElement(BrowserOutcomeCriteria, props)) })
  return { container, close: async () => { await act(async () => root.unmount()); container.remove() } }
}

describe('real mounted completion condition presentation', () => {
  it.each(['passed', 'not-met', 'unavailable'] as const)('states %s once and retains its exact real reason', async status => {
    const item = await mounted({ evaluation: evaluation(status), onRun: async () => {} })
    try {
      expect(item.container.querySelector('summary')?.textContent).toBe(`Completion condition · ${labels[status]}`)
      expect(item.container.textContent!.split(labels[status])).toHaveLength(2)
      expect(item.container.querySelector('[role="status"]')?.textContent).toBe(reasons[status])
      expect([...item.container.querySelectorAll('[data-outcome-status]')].map(p => [p.getAttribute('data-outcome-status'), p.textContent])).toEqual([[status, reasons[status]]])
    } finally { await item.close() }
  })

  it('keeps every mixed condition reason, actual warning and historical context without another result heading', async () => {
    const value = evaluation('unavailable')
    value.conditions = (['passed', 'not-met', 'unavailable'] as const).map(status => evaluation(status).conditions[0]!)
    value.warning = 'Restore access to the original evidence; the Browser remains usable.'
    const item = await mounted({ evaluation: value, historical: true, onRun: async () => {}, onVerify: async () => {} })
    try {
      expect(item.container.querySelector('summary')?.textContent).toBe('Recorded check · Verification unavailable')
      expect(item.container.textContent!.split('Verification unavailable')).toHaveLength(2)
      expect([...item.container.querySelectorAll('[role="status"] p')].map(p => p.textContent)).toEqual([value.warning, reasons.passed, reasons['not-met'], reasons.unavailable])
      expect(item.container.textContent).toContain('This belongs to an earlier operation or document.')
      expect([...item.container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Check current field', 'Verify recorded evidence'])
    } finally { await item.close() }
  })

  it('does not invent completion when no evaluation exists', async () => {
    const item = await mounted({ onRun: async () => {} })
    try {
      expect(item.container.querySelector('summary')?.textContent).toBe('Completion condition')
      expect(item.container.querySelector('[role="status"]')).toBeNull()
      expect(item.container.querySelector('[data-outcome-status]')).toBeNull()
    } finally { await item.close() }
  })

  it('retains verification failures and input validation beside the original result without starting a producer', async () => {
    const onRun = vi.fn(async () => {}), onVerify = vi.fn(async () => { throw new Error('Source unavailable') })
    const item = await mounted({ evaluation: evaluation('passed'), onRun, onVerify })
    try {
      await act(async () => item.container.querySelectorAll('button')[1]!.click())
      expect(onVerify).toHaveBeenCalledTimes(1)
      expect(item.container.textContent).toContain('Recorded evidence could not be verified. Existing Browser work remains.')
      await act(async () => item.container.querySelectorAll('button')[0]!.click())
      expect(onRun).not.toHaveBeenCalled()
      expect(item.container.textContent).toContain('Use a CSS selector and a value of the declared type; number and boolean values use JSON.')
      expect(item.container.querySelector('[data-outcome-status]')?.textContent).toBe(reasons.passed)
    } finally { await item.close() }
  })
})
