// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserOperation } from '../src/shared/browser-operation'
import { BrowserOperationTimeline } from '../src/renderer/src/components/BrowserOperationSurface'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const operation: BrowserOperation = {
  id: 'recorded-operation', browserId: 'browser', operator: { id: 'operator', name: 'Navigator' },
  startedAt: 1700000000000, phase: 'indeterminate', summary: 'Review settings', url: 'https://example.test',
  warning: 'The result is unknown. Review the page before retrying.',
  steps: [
    { sequence: 1, method: 'snapshot', label: 'Read page', startedAt: 1700000000100, status: 'completed', summary: 'large-result-shape-'.repeat(400) },
    { sequence: 2, method: 'click', label: 'Open settings', startedAt: 1700000000200, status: 'failed', target: { role: 'button', name: 'Settings', ordinal: 2, count: 3 }, summary: 'The click did not complete' },
    { sequence: 3, method: 'snapshot', label: 'Read updated page', startedAt: 1700000000300, status: 'running' },
    { sequence: 4, method: 'click', label: 'Open profile', startedAt: 1700000000400, status: 'stopped' }
  ]
}

describe('compact browser operation rows', () => {
  it('keeps all observed states and selected identity, with details mounted on demand', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const select = vi.fn()
    try {
      await act(async () => root.render(createElement(BrowserOperationTimeline, { operation, selectedSequence: 2, onSelectStep: select })))
      const rows = Array.from(host.querySelectorAll<HTMLLIElement>('.browser-rsi-timeline__step'))
      expect(rows.map(row => row.dataset.sequence)).toEqual(['1', '2', '3', '4'])
      expect(rows.map(row => row.querySelector('.browser-rsi-timeline__status')!.textContent)).toEqual(['completed', 'failed', 'running', 'stopped'])
      expect(rows.map(row => row.querySelector('button')!.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false'])
      expect(rows[1]!.classList.contains('is-selected')).toBe(true)
      expect(rows[1]!.textContent).toContain('button “Settings” · 2/3')
      expect(host.textContent).toContain('Needs review')
      expect(host.textContent).toContain(operation.warning)
      expect(host.querySelectorAll('.browser-rsi-timeline__step-detail')).toHaveLength(0)
      expect(host.textContent).not.toContain('large-result-shape-')
      const button = rows[0]!.querySelector('button')!
      await act(async () => button.click())
      expect(select).toHaveBeenCalledExactlyOnceWith(operation.steps[0])
      expect(button.getAttribute('aria-expanded')).toBe('true')
      expect(rows[0]!.querySelector('p')!.textContent).toBe(operation.steps[0]!.summary)
      await act(async () => button.click())
      expect(host.querySelectorAll('.browser-rsi-timeline__step-detail')).toHaveLength(0)
      // Moving between operations never reuses a previous operation's local disclosure state.
      await act(async () => button.click())
      await act(async () => root.render(createElement(BrowserOperationTimeline, { operation: { ...operation, id: 'other-operation' } })))
      expect(host.querySelectorAll('.browser-rsi-timeline__step-detail')).toHaveLength(0)
    } finally { await act(async () => root.unmount()); host.remove() }
  })

  it('allows read-only detail inspection without inventing a host action', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      await act(async () => root.render(createElement(BrowserOperationTimeline, { operation })))
      const failed = host.querySelector<HTMLButtonElement>('[data-sequence="2"] button')!
      expect(failed.getAttribute('aria-expanded')).toBe('false')
      await act(async () => failed.click())
      expect(host.querySelector('.browser-rsi-timeline__step-detail')!.textContent).toContain('The click did not complete')
    } finally { await act(async () => root.unmount()) }
  })

  it('keeps the reported failure/recovery line persistent and full diagnostics reachable on demand', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const warning = 'The step failed. Review the page before retrying.\n    at private-worker-frame'
    try {
      await act(async () => root.render(createElement(BrowserOperationTimeline, { operation: { ...operation, warning } })))
      expect(host.querySelector('[role="status"]')!.textContent).toContain('The step failed. Review the page before retrying.')
      expect(host.textContent).not.toContain('private-worker-frame')
      const details = host.querySelector<HTMLButtonElement>('[aria-label="Show browser warning details"]')!
      expect(details).not.toBeNull()
      await act(async () => details.click())
      expect(host.querySelector('.browser-rsi-notice pre')!.textContent).toBe(warning)
      await act(async () => details.click())
      expect(host.querySelector('.browser-rsi-notice pre')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })
})
