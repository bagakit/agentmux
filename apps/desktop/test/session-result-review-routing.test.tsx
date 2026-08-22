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

import { SessionPane } from '../src/renderer/src/components/SessionPane.js'
import { useAppStore } from '../src/renderer/src/store.js'

const session = {
  id: 'mounted-result', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo', label: 'Mounted result',
  createdAt: 1, updatedAt: 2, processState: 'exited', latestOutputBytes: 0,
  status: { state: 'done', source: 'run-process', observedAt: 2 }, capabilities: {},
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'mounted-result', run: { runId: 'run-mounted', generation: 1 } }
} as unknown as SessionSnapshot

describe('SessionResultReview production routing', () => {
  const baseline = useAppStore.getState()
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    useAppStore.setState({ sessions: [session], timelines: { 'mounted-result': { agentSessionId: 'mounted-result', revision: 1, items: [] } }, config: { appearance: { terminalTheme: 'graphite' }, executors: {}, workspaces: [{ id: 'repo', path: '/repo', name: 'Repo', hostId: 'local', kind: 'folder' }] } as never })
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true) })

  it('mounts the result review strip through SessionPane', async () => {
    await act(async () => root.render(createElement(SessionPane, { sessionId: 'mounted-result', surfaceKind: 'agent', interactiveResize: false, visible: true, linkOrigin: { workspaceId: 'repo', tabGroupId: 'group' } })))
    expect(container.querySelector('.session-result-review')).toBeTruthy()
    expect(container.querySelector('.session-result-review button')?.textContent).toContain('Activity')
  })
})
