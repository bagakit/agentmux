// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import type { SessionSnapshot } from '../src/shared/contracts.js'
vi.mock('../src/renderer/src/components/SessionPane.js', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => createElement('div', { 'data-observing': sessionId }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface.js'
import { useAppStore } from '../src/renderer/src/store.js'

function agent(id: string, state: 'waiting' | 'working' | 'done', observedAt: number): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo/agentmux',
    label: id === 'needs-you' ? 'Review the patch' : id,
    createdAt: observedAt,
    updatedAt: observedAt,
    processState: state === 'done' ? 'exited' : 'running',
    latestOutputBytes: 0,
    status: { state, source: 'run-process', observedAt },
    capabilities: {} as never,
    ...(state === 'waiting' ? { pendingInteraction: {} as never } : {}),
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}`, generation: 1 } }
  } as SessionSnapshot
}

describe('Global Agents attention inbox', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    useAppStore.setState({ agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, mainSurface: 'agents' })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(baseline, true)
    vi.restoreAllMocks()
  })

  it('orders Needs you before results and working rows', async () => {
    useAppStore.setState({ sessions: [agent('done', 'done', 3), agent('needs-you', 'waiting', 1), agent('working', 'working', 2)], providerCatalog: [] })
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    const groups = [...container.querySelectorAll<HTMLElement>('.global-agents-group')]
    expect(groups.map((group) => group.dataset.bucket)).toEqual(['needs-you', 'working', 'done', 'error'])
    expect(container.querySelector('[data-session-id="needs-you"]')).toBeTruthy()
  })

  it('clicking a card opens an observation workspace without navigating', async () => {
    const selectSession = vi.fn()
    useAppStore.setState({ sessions: [agent('needs-you', 'waiting', 1)], providerCatalog: [], selectSession: selectSession as never })
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    await act(async () => (container.querySelector('[data-session-id="needs-you"]') as HTMLButtonElement).click())
    expect(selectSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('needs-you')
    expect(useAppStore.getState().mainSurface).toBe('agents')
    expect(container.querySelector('[data-observing="needs-you"]')).toBeTruthy()
  })

  it('states the empty state instead of rendering a vacuous inbox', async () => {
    useAppStore.setState({ sessions: [], providerCatalog: [] })
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    expect(container.querySelector('.global-agents-empty')).toBeTruthy()
    expect(container.querySelector('.global-agents-group')).toBeNull()
  })
})
