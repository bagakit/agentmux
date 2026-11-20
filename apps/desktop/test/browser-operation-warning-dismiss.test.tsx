// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserActivityState, BrowserOperation } from '@agentmux/browser/model'

vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign((select: (state: unknown) => unknown) => select({ sessions: {}, config: null }), { getState: () => ({}) }) }))

import { BrowserOperationTimeline, BrowserOperationWarning } from '../src/renderer/src/components/BrowserOperationSurface'

/**
 * A Browser notice the person has read can be put away. That hides only this notice on this page;
 * the operation record and the timeline keep it, and a different notice shows again on its own.
 */
const STOPPED = 'The script did not finish within 29999ms and was stopped. It was in waitForElement() after 2 completed page calls.'
const operation = { id: 'op-1', browserId: 'b1', operator: { kind: 'agent', name: 'Builder' }, phase: 'stopped', summary: STOPPED,
  steps: [], startedAt: 1, warning: STOPPED } as unknown as BrowserOperation
const activity = (warning?: string): BrowserActivityState => ({ operation, control: 'agent', ...(warning ? { warning } : {}) })

let root: Root, container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('Browser notice dismissal', () => {
  it('hides the notice the person dismissed and keeps it in the timeline', async () => {
    await act(async () => root.render(<><BrowserOperationWarning activity={activity(STOPPED)} /><BrowserOperationTimeline operation={operation} /></>))
    expect(container.querySelector('.browser-operation-warning')?.textContent).toContain('did not finish within 29999ms')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss this Browser notice"]')!.click())
    expect(container.querySelector('.browser-operation-warning')).toBeNull()
    expect(container.querySelector('.browser-rsi-timeline__warning')?.textContent).toContain('did not finish within 29999ms')
  })

  it('shows a different notice again on its own', async () => {
    await act(async () => root.render(<BrowserOperationWarning activity={activity(STOPPED)} />))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss this Browser notice"]')!.click())
    await act(async () => root.render(<BrowserOperationWarning activity={activity(STOPPED)} />))
    expect(container.querySelector('.browser-operation-warning'), 'the same notice stays dismissed').toBeNull()
    await act(async () => root.render(<BrowserOperationWarning activity={activity('Native input isolation was unconfirmed during this operation.')} />))
    expect(container.querySelector('.browser-operation-warning')?.textContent).toContain('Native input isolation')
  })

  it('the timeline notice cannot be dismissed, because the record is not a notice', async () => {
    await act(async () => root.render(<BrowserOperationTimeline operation={operation} />))
    expect(container.querySelector('.browser-rsi-timeline [aria-label="Dismiss this Browser notice"]')).toBeNull()
  })
})
