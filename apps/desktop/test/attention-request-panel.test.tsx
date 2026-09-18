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

const request = { kind: 'question', id: 'request-a', questions: [{ id: 'channel', title: 'Choose a release channel', prompt: 'Where should this go?', options: [{ id: 'stable', label: 'Stable' }, { id: 'canary', label: 'Canary' }] }] } as never
const session = {
  id: 'attention-a', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo', label: 'Release agent',
  createdAt: 1, updatedAt: 2, processState: 'running', latestOutputBytes: 0, status: { state: 'waiting', source: 'run-process', observedAt: 2 },
  capabilities: {}, pendingInteraction: request, control: { kind: 'agent', hostId: 'local', agentSessionId: 'attention-a', run: { runId: 'run-a', generation: 1 } }
} as unknown as SessionSnapshot

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
})
