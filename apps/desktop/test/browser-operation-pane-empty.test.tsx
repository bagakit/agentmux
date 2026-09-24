// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import type { BrowserOperation } from '../src/shared/browser-operation'

const fixture = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return { state: {
    applyBrowserEvent: vi.fn(), reportError: vi.fn(), setWorkspaceTool: vi.fn(),
    executeControl: vi.fn(async () => ({ operation: 'browser.history', operations: [] as BrowserOperation[] })),
    saveBrowserBookmark: vi.fn(), openFile: vi.fn(), browserAnnotationsByBrowserId: {},
    addBrowserAnnotation: vi.fn(), toolsOpen: false, config: null
  } }
})
vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign((selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state })
}))
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'

const tab = {
  id: 'browser', navigationId: 'navigation', browserId: 'browser', regionId: 'region',
  workspaceId: 'workspace', profileId: 'profile', kind: 'browser' as const,
  url: 'https://example.test/', title: 'Page', loading: false, canGoBack: false, canGoForward: false,
  viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null
}
const operation: BrowserOperation = {
  id: 'observed', browserId: tab.browserId, operator: { id: 'operator', name: 'Navigator' },
  startedAt: 1700000000000, phase: 'completed', summary: 'Observed page', url: tab.url,
  steps: [{ sequence: 1, method: 'pageInfo', label: 'Read page', startedAt: 1700000000001, status: 'completed' }]
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.state.executeControl.mockResolvedValue({ operation: 'browser.history', operations: [] })
})

async function withOpenHistory(check: (host: HTMLElement) => void | Promise<void>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(BrowserPane, { tab, visible: true })))
    const trigger = host.querySelector('.browser-operation-status__trigger')!
    expect(trigger).not.toBeNull()
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const action = document.querySelector('[role="menu"] [aria-label="Open browser activity timeline"]')!
    expect(action).not.toBeNull()
    await act(async () => action.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(fixture.state.executeControl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'browser.history', browserId: tab.browserId }))
    expect(host.querySelectorAll('[aria-label="Browser operation history"]')).toHaveLength(1)
    await check(host)
  } finally { await act(async () => root.unmount()); host.remove() }
}

it('uses the original history as the single empty state in the real Browser drawer', async () => {
  await withOpenHistory(host => {
    expect(host.querySelectorAll('.browser-rsi-history__empty')).toHaveLength(1)
    expect(host.textContent).toContain('No recorded Browser operations yet.')
    expect(host.querySelector('.browser-rsi-timeline')).toBeNull()
    expect(host.textContent).not.toContain('No browser activity yet')
    expect(host.querySelector('[aria-label="Close browser activity timeline"]')).not.toBeNull()
  })
})

it('keeps unresolved history visibly loading without claiming another empty activity', async () => {
  let resolve!: (value: { operation: string; operations: BrowserOperation[] }) => void
  fixture.state.executeControl.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await withOpenHistory(async host => {
    expect(host.textContent).toContain('Loading…')
    expect(host.querySelector('.browser-rsi-history__empty')).toBeNull()
    expect(host.querySelector('.browser-rsi-timeline')).toBeNull()
    await act(async () => resolve({ operation: 'browser.history', operations: [] }))
    expect(host.querySelectorAll('.browser-rsi-history__empty')).toHaveLength(1)
  })
})

it('keeps the history failure and Retry visible without a misleading empty activity', async () => {
  fixture.state.executeControl.mockRejectedValueOnce(new Error('Original history read failed'))
  await withOpenHistory(host => {
    expect(host.querySelectorAll('.browser-rsi-history__error')).toHaveLength(1)
    expect(host.textContent).toContain('Operation history is unavailable. Retry to restore the record view.')
    expect(Array.from(host.querySelectorAll('button')).filter(button => button.textContent === 'Retry')).toHaveLength(1)
    expect(host.querySelector('.browser-rsi-history__empty')).toBeNull()
    expect(host.querySelector('.browser-rsi-timeline')).toBeNull()
    expect(fixture.state.reportError).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
  })
})

it('still mounts the selected real nonempty operation and its original step', async () => {
  fixture.state.executeControl.mockResolvedValueOnce({ operation: 'browser.history', operations: [operation] })
  await withOpenHistory(host => {
    expect(host.querySelectorAll('.browser-rsi-history__item')).toHaveLength(1)
    expect(host.querySelector('[data-operation-id="observed"]')).not.toBeNull()
    expect(Array.from(host.querySelectorAll('[data-sequence]')).map(row => row.getAttribute('data-sequence'))).toEqual(['1'])
    expect(host.textContent).toContain('Read page')
    expect(host.querySelector('.browser-rsi-history__empty')).toBeNull()
  })
})
