// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserOperation } from '../src/shared/browser-operation'
import { BrowserOperationWarning } from '../src/renderer/src/components/BrowserOperationSurface'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const operation: BrowserOperation = {
  id: 'observed-operation', browserId: 'browser', operator: { id: 'operator', name: 'Navigator' },
  startedAt: 1, phase: 'running', summary: 'Review settings', url: 'https://example.test', steps: []
}

describe('Current Browser service notice', () => {
  it('shows current combined notices and removes only the recovered contribution while preserving operation history', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    const historical = 'The earlier action could not be confirmed.'
    const current = 'The current page feedback is unavailable; the page remains usable.'
    const previous = { ...operation, phase: 'failed' as const, warning: historical }
    try {
      await act(async () => root.render(createElement(BrowserOperationWarning, {
        activity: { operation: previous, control: 'agent', warning: `${historical}\n${current}` }
      })))
      const details = host.querySelector<HTMLButtonElement>('[aria-label="Show browser warning details"]')!
      expect(details).not.toBeNull()
      await act(async () => details.click())
      expect(host.querySelector('pre')!.textContent).toBe(`${historical}\n${current}`)
      await act(async () => root.render(createElement(BrowserOperationWarning, {
        activity: { operation: previous, control: 'agent', warning: historical }
      })))
      expect(host.textContent).toContain(historical); expect(host.textContent).not.toContain(current)
      expect(host.querySelector('pre')).toBeNull()
      expect(host.querySelector('[aria-label="Show browser warning details"]')).toBeNull()
      await act(async () => root.render(createElement(BrowserOperationWarning, {
        activity: { operation: previous, control: 'agent' }
      })))
      expect(host.textContent).toContain(historical); expect(previous.warning).toBe(historical)
    } finally { await act(async () => root.unmount()) }
  })

})
