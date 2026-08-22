// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/ActivityView.js', () => ({ ActivityView: () => null }))
vi.mock('../src/renderer/src/components/AgentSessionComposer.js', () => ({ AgentSessionComposer: () => null }))
vi.mock('../src/renderer/src/components/AgentInteractionCard.js', () => ({ AgentInteractionCard: () => null }))

import { GlobalAgentsSurface } from '../src/renderer/src/components/GlobalAgentsSurface.js'
import { SessionPane } from '../src/renderer/src/components/SessionPane.js'
import { restorePersistedUiState, useAppStore } from '../src/renderer/src/store.js'

const waiting = {
  id: 'attention-loop', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo', label: 'Review agent',
  createdAt: 1, updatedAt: 2, processState: 'running', latestOutputBytes: 0,
  status: { state: 'waiting', source: 'run-process', observedAt: 2 }, capabilities: {},
  pendingInteraction: { kind: 'question', id: 'question-1', questions: [{ id: 'choice', title: 'Choose', prompt: 'Choose a path', options: [{ id: 'yes', label: 'Yes' }] }] },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'attention-loop', run: { runId: 'run-attention', generation: 1 } }
} as unknown as SessionSnapshot

const done = {
  ...waiting,
  id: 'result-loop', label: 'Result agent', processState: 'exited',
  status: { state: 'done', source: 'run-process', observedAt: 3 }, pendingInteraction: undefined,
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'result-loop', run: { runId: 'run-result', generation: 1 } }
} as unknown as SessionSnapshot

describe('Agents attention and result review loop', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    useAppStore.setState({
      sessions: [waiting, done], providerCatalog: [],
      config: { appearance: { terminalTheme: 'graphite' }, executors: {}, workspaces: [{ id: 'repo', path: '/repo', name: 'Repo', hostId: 'local', kind: 'folder' }] } as never,
      timelines: { 'result-loop': { agentSessionId: 'result-loop', revision: 1, items: [] } }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(baseline, true)
    vi.restoreAllMocks()
  })

  it('keeps the durable surface, opens Needs you in place, and routes a result back to its Session', async () => {
    expect(restorePersistedUiState(useAppStore.getState().config!, { mainSurface: 'agents' }).mainSurface).toBe('agents')
    await act(async () => root.render(createElement(GlobalAgentsSurface)))
    const review = container.querySelector('[data-session-id="attention-loop"] .global-agents-row__open') as HTMLElement
    await act(async () => review.click())
    expect(container.querySelector('.attention-request-panel')).toBeTruthy()
    expect(useAppStore.getState().mainSurface).toBe(baseline.mainSurface)

    const selectSession = vi.fn()
    useAppStore.setState({ selectSession: selectSession as never })
    await act(async () => root.render(createElement(SessionPane, {
      sessionId: 'result-loop', surfaceKind: 'agent', interactiveResize: false, visible: true,
      linkOrigin: { workspaceId: 'repo', tabGroupId: 'group' }
    })))
    expect(container.querySelector('.session-result-review')).toBeTruthy()
    const continueButton = [...container.querySelectorAll<HTMLButtonElement>('.session-result-review button')]
      .find((button) => button.textContent?.includes('Continue in Session'))
    expect(continueButton).toBeTruthy()
    await act(async () => continueButton!.click())
    expect(selectSession).toHaveBeenCalledWith('result-loop')
  })
})
