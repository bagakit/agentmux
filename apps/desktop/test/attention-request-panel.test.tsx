// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
// See attention-request-resolution.test.ts for the same reason: mock TerminalView so
// GlobalFocusSurface's fallback SessionObservationRegions path doesn't trip.
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))

import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { api } from '../src/renderer/src/lib/api.js'

type AgentSnapshot = Extract<SessionSnapshot, { kind: 'agent' }>
const request = { kind: 'question', id: 'request-a', questions: [{ id: 'channel', title: 'Choose a release channel', prompt: 'Where should this go?', options: [{ id: 'stable', label: 'Stable' }, { id: 'canary', label: 'Canary' }] }] } as never
const session = {
  id: 'attention-a', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo', label: 'Release agent',
  createdAt: 1, updatedAt: 2, processState: 'running', latestOutputBytes: 0, status: { state: 'waiting', source: 'run-process', observedAt: 2 },
  capabilities: {}, pendingInteraction: request, control: { kind: 'agent', hostId: 'local', agentSessionId: 'attention-a', run: { runId: 'run-a' } }
} as unknown as AgentSnapshot

// GlobalFocusSurface renders session cards inside project lanes derived from `config.workspaces`.
// Without a workspace matching /repo, deriveFocusProjectLanes returns [] and no session card is
// rendered — every test below fails at the first `.click()` with "Cannot read properties of null".
const testConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [{ id: 'workspace', name: 'Repository', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
} as unknown as ReturnType<typeof useAppStore.getState>['config']

describe('Needs you request panel', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    useAppStore.setState({ config: testConfig, sessions: [session], providerCatalog: [], mainSurface: 'agents', tabs: {}, timelines: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })

  function reviewButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('.focus-toolbar__review')
    expect(button).toBeTruthy()
    return button!
  }

  it('opens the typed request from the Focus toolbar without leaving the selected context', async () => {
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    await act(async () => (container.querySelector('[data-session-id="attention-a"]') as HTMLElement).click())
    const review = reviewButton()
    await act(async () => review.click())
    expect(container.querySelector('.attention-request-panel')).toBeTruthy()
    expect(container.querySelector('[aria-label="Agent question"]')).toBeTruthy()
    expect(useAppStore.getState().mainSurface).toBe('agents')
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('attention-a')
  })

  it('routes the response through the existing Core interaction owner', async () => {
    const respondInteraction = vi.spyOn(api.sessions, 'respondInteraction').mockResolvedValue(undefined)
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    await act(async () => (container.querySelector('[data-session-id="attention-a"]') as HTMLElement).click())
    await act(async () => reviewButton().click())
    const answer = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Stable')) as HTMLButtonElement
    await act(async () => answer.click())
    expect(respondInteraction).toHaveBeenCalledExactlyOnceWith(session.control, { kind: 'question', requestId: 'request-a', outcome: 'answered', answers: [{ questionId: 'channel', optionId: 'stable' }] })
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('attention-a')
  })

  it.each([
    ['Allow once', { outcome: 'selected', optionId: 'once' }],
    ['Deny', { outcome: 'selected', optionId: 'deny' }],
    ['Cancel', { outcome: 'cancelled' }]
  ])('reviews a permission from the actual Focus card and sends %s to its original owner', async (label, decision) => {
    const permission = {
      ...session,
      pendingInteraction: {
        kind: 'permission', id: 'permission-a', agentSessionId: session.id, title: 'Write the release note?',
        options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }, { id: 'deny', label: 'Deny', kind: 'reject-once' }],
        evidence: { source: 'native-hook', observedAt: 2, run: { runId: 'run-a' }, hookReceiptId: 'permission-receipt-a' }
      }
    } satisfies AgentSnapshot
    const { pendingInteraction: _pending, ...healthy } = session
    const neighbor = {
      ...healthy, id: 'healthy-neighbor', label: 'Other work',
      status: { state: 'working', source: 'native-hook', observedAt: 2 },
      control: { kind: 'agent', hostId: 'local', agentSessionId: 'healthy-neighbor', run: { runId: 'neighbor-run' } }
    } satisfies AgentSnapshot
    useAppStore.setState({ sessions: [permission, neighbor] })
    const respondInteraction = vi.spyOn(api.sessions, 'respondInteraction').mockResolvedValue(undefined)
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    const card = container.querySelector<HTMLElement>('[data-session-id="attention-a"]')
    expect(card).not.toBeNull()
    await act(async () => card!.click())
    const opener = reviewButton()
    opener.focus()
    await act(async () => opener.click())
    const request = container.querySelector('[aria-label="Agent permission request"]')
    expect(request?.getAttribute('data-request-id')).toBe('permission-a')
    const option = [...request!.querySelectorAll('button')].find(button => button.textContent?.trim() === label)
    expect(option).toBeDefined()
    await act(async () => option!.click())
    expect(respondInteraction).toHaveBeenCalledExactlyOnceWith(permission.control, { kind: 'permission', requestId: 'permission-a', decision })
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(permission.id)
    expect(useAppStore.getState().sessions).toEqual([permission, neighbor])
    // An accepted API call is not confirmation that Core cleared the request.
    expect(container.querySelector('[data-request-id="permission-a"]')).not.toBeNull()
    expect(option!.disabled).toBe(true)
    await act(async () => option!.click())
    expect(respondInteraction).toHaveBeenCalledTimes(1)
    // This is a typed publication fixture, not a native Provider/Hook producer.
    const { pendingInteraction: _answered, ...completed } = permission
    await act(async () => useAppStore.setState({ sessions: [{ ...completed, status: { state: 'working', source: 'native-hook', observedAt: 3 } }, neighbor] }))
    expect(container.querySelector('[data-request-id="permission-a"]')).toBeNull()
    expect(container.querySelector('.attention-request-panel__empty')?.textContent).toContain('All caught up')
    expect(opener.isConnected).toBe(false)
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close request"]')!
    close.focus()
    await act(async () => close.click())
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    expect(container.querySelector('.attention-request-panel')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Search contexts"]'))
    expect(useAppStore.getState().mainSurface).toBe('agents')
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(permission.id)
    expect(useAppStore.getState().sessions[1]).toBe(neighbor)
  })

  it('keeps a later control focus when the request close callback runs', async () => {
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    await act(async () => container.querySelector<HTMLElement>('[data-session-id="attention-a"]')!.click())
    const opener = reviewButton()
    opener.focus()
    await act(async () => opener.click())
    const callbacks: FrameRequestCallback[] = []
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { callbacks.push(callback); return callbacks.length })
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close request"]')!
    close.focus()
    await act(async () => close.click())
    const laterControl = container.querySelector<HTMLButtonElement>('.focus-toolbar__identity')!
    laterControl.focus()
    expect(callbacks).toHaveLength(1)
    await act(async () => callbacks[0]!(0))
    expect(document.activeElement).toBe(laterControl)
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(session.id)
    expect(useAppStore.getState().sessions).toEqual([session])
  })

  it('returns to a visible control after reviewing through the keyboard context menu', async () => {
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    await act(async () => container.querySelector<HTMLElement>('[data-session-id="attention-a"]')!.click())
    const identity = container.querySelector<HTMLButtonElement>('.focus-toolbar__identity')!
    identity.focus()
    await act(async () => identity.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true })))
    const review = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Review request')
    expect(review).toBeDefined()
    review!.focus()
    await act(async () => review!.click())
    const panel = container.querySelector('.attention-request-panel')!
    expect(panel).not.toBeNull()
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(review!.isConnected).toBe(false)
    const close = panel.querySelector<HTMLButtonElement>('[aria-label="Close request"]')!
    close.focus()
    await act(async () => close.click())
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Search contexts"]'))
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(session.id)
    expect(useAppStore.getState().sessions).toEqual([session])
  })

  it('does not focus the old search when the user has already left Focus', async () => {
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    await act(async () => container.querySelector<HTMLElement>('[data-session-id="attention-a"]')!.click())
    const opener = reviewButton()
    opener.focus()
    await act(async () => opener.click())
    const { pendingInteraction: _answered, ...completed } = session
    await act(async () => useAppStore.setState({ sessions: [{ ...completed, status: { state: 'working', source: 'native-hook', observedAt: 3 } }] }))
    expect(opener.isConnected).toBe(false)
    const callbacks: FrameRequestCallback[] = []
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { callbacks.push(callback); return callbacks.length })
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close request"]')!
    close.focus()
    await act(async () => close.click())
    await act(async () => useAppStore.getState().setMainSurface('workbench'))
    expect(callbacks).toHaveLength(1)
    await act(async () => callbacks[0]!(0))
    expect(document.activeElement).toBe(document.body)
    expect(useAppStore.getState().mainSurface).toBe('workbench')
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(session.id)
  })

  it('returns to the search when Review was activated without first focusing its button', async () => {
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    await act(async () => container.querySelector<HTMLElement>('[data-session-id="attention-a"]')!.click())
    expect(document.activeElement).toBe(document.body)
    await act(async () => reviewButton().click())
    const panel = container.querySelector('.attention-request-panel')!
    expect(panel.contains(document.activeElement)).toBe(true)
    const close = panel.querySelector<HTMLButtonElement>('[aria-label="Close request"]')!
    close.focus()
    await act(async () => close.click())
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Search contexts"]'))
    expect(useAppStore.getState().sessions).toEqual([session])
  })
})
