// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { GlobalAgentsSurface } from '../src/renderer/src/components/GlobalAgentsSurface.js'
import { useAppStore } from '../src/renderer/src/store.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

function session(id: string, pendingInteraction?: unknown): SessionSnapshot {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo', label: id,
    createdAt: 1, updatedAt: 2, processState: 'running', latestOutputBytes: 0,
    status: { state: 'waiting', source: 'run-process', observedAt: id === 'a' ? 1 : 2 }, capabilities: {},
    ...(pendingInteraction ? { pendingInteraction } : {}),
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}`, generation: 1 } }
  } as unknown as SessionSnapshot
}

const request = { kind: 'question', id: 'request-a', questions: [{ id: 'q', title: 'Choose', prompt: 'Choose one', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }] }
const replacement = { kind: 'question', id: 'request-b', questions: [{ id: 'q', title: 'New request', prompt: 'Choose the replacement', options: [{ id: 'next', label: 'Next' }] }] }

describe('attention request resolution boundaries', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true) })

  it('does not invent answer controls when Core has no typed request', async () => {
    useAppStore.setState({ sessions: [session('a')], providerCatalog: [] })
    await act(async () => root.render(createElement(GlobalAgentsSurface)))
    await act(async () => (container.querySelector('[data-session-id="a"]') as HTMLElement).click())
    await act(async () => (container.querySelector('.global-board-action') as HTMLElement).click())
    expect(container.querySelector('[aria-label="Agent question"]')).toBeNull()
    expect(container.textContent).toContain('Core has not exposed a typed request')
  })

  it('keeps A and B request identities separate when the list changes', async () => {
    const selectSession = vi.fn()
    useAppStore.setState({ sessions: [session('a', request), session('b', request)], providerCatalog: [], selectSession: selectSession as never })
    await act(async () => root.render(createElement(GlobalAgentsSurface)))
    const rows = [...container.querySelectorAll<HTMLElement>('.global-session-card')]
    await act(async () => rows[1]!.click())
    await act(async () => (container.querySelector('.global-board-action') as HTMLElement).click())
    expect(container.querySelector('.attention-request-panel')?.textContent).toContain('b')
    expect(selectSession).not.toHaveBeenCalled()
  })


  async function openReview(id: string): Promise<void> {
    await act(async () => root.render(createElement(GlobalAgentsSurface)))
    await act(async () => (container.querySelector(`[data-session-id="${id}"]`) as HTMLElement).click())
    await act(async () => (container.querySelector('.global-board-action') as HTMLElement).click())
  }

  it('waits for Core to clear the request before moving to the next Agent', async () => {
    let resolveResponse!: () => void
    const response = new Promise<void>((resolve) => { resolveResponse = resolve })
    useAppStore.setState({ sessions: [session('a', request), session('b', replacement)], providerCatalog: [], respondInteraction: vi.fn(() => response) as never })
    await openReview('a')
    const answer = [...container.querySelectorAll<HTMLButtonElement>('.agent-interaction button')].find((button) => button.textContent?.includes('Yes'))!
    await act(async () => answer.click())
    resolveResponse()
    await act(async () => response)
    expect(container.querySelector('.attention-request-panel')?.textContent).toContain('Choose one')
    expect(container.querySelector('.agent-interaction button')?.disabled).toBe(true)

    await act(async () => useAppStore.setState({ sessions: [session('a'), session('b', replacement)] }))
    expect(container.querySelector('.attention-request-panel')?.textContent).toContain('New request')
    expect(container.querySelector('.attention-request-panel')?.textContent).toContain('Choose the replacement')
  })

  it('does not paint the next request when an old response rejects late', async () => {
    let rejectResponse!: (error: Error) => void
    const response = new Promise<void>((_resolve, reject) => { rejectResponse = reject })
    useAppStore.setState({ sessions: [session('a', request), session('b', replacement)], providerCatalog: [], respondInteraction: vi.fn(() => response) as never })
    await openReview('a')
    const answer = [...container.querySelectorAll<HTMLButtonElement>('.agent-interaction button')].find((button) => button.textContent?.includes('Yes'))!
    await act(async () => answer.click())
    await act(async () => useAppStore.setState({ sessions: [session('a'), session('b', replacement)] }))
    expect(container.querySelector('.attention-request-panel')?.textContent).toContain('New request')
    rejectResponse(new Error('late old response failure'))
    await act(async () => response.catch(() => undefined))
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('.attention-request-panel')?.textContent).toContain('New request')
  })

  it('keeps the same request and reports an answer failure', async () => {
    useAppStore.setState({ sessions: [session('a', request)], providerCatalog: [], respondInteraction: vi.fn(() => Promise.reject(new Error('Core rejected answer'))) as never })
    await openReview('a')
    const answer = [...container.querySelectorAll<HTMLButtonElement>('.agent-interaction button')].find((button) => button.textContent?.includes('Yes'))!
    await act(async () => answer.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Core rejected answer')
    expect(container.querySelector('.attention-request-panel')?.textContent).toContain('Choose one')
  })

  it('shows a replacement request and never advances the old response', async () => {
    let resolveResponse!: () => void
    const response = new Promise<void>((resolve) => { resolveResponse = resolve })
    useAppStore.setState({ sessions: [session('a', request)], providerCatalog: [], respondInteraction: vi.fn(() => response) as never })
    await openReview('a')
    const answer = [...container.querySelectorAll<HTMLButtonElement>('.agent-interaction button')].find((button) => button.textContent?.includes('Yes'))!
    await act(async () => answer.click())
    await act(async () => useAppStore.setState({ sessions: [session('a', replacement)] }))
    expect(container.querySelector('.attention-request-panel')?.textContent).toContain('New request')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('request changed')
    resolveResponse()
    await act(async () => response)
    expect(container.querySelector('.attention-request-panel')?.textContent).toContain('New request')
  })

  it('returns focus to Review here when Escape closes the panel', async () => {
    useAppStore.setState({ sessions: [session('a', request)], providerCatalog: [] })
    await act(async () => root.render(createElement(GlobalAgentsSurface)))
    await act(async () => (container.querySelector('[data-session-id="a"]') as HTMLElement).click())
    const review = container.querySelector('.global-board-action') as HTMLButtonElement
    review.focus()
    await act(async () => review.click())
    const panel = container.querySelector('.attention-request-panel') as HTMLElement
    expect(panel.contains(document.activeElement)).toBe(true)
    await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(container.querySelector('.attention-request-panel')).toBeNull()
    expect(document.activeElement).toBe(review)
  })
})
