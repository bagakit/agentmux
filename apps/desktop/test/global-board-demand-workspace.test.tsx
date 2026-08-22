// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

vi.mock('../src/renderer/src/components/SessionPane.js', () => ({
  SessionPane: ({ sessionId }: { sessionId: string }) => createElement('div', { 'data-test-session': sessionId }, `terminal:${sessionId}`)
}))

import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface.js'
import { useAppStore } from '../src/renderer/src/store.js'

const config = { workspaces: [{ id: 'repo', hostId: 'local', name: 'Repo', path: '/repo', kind: 'folder' }] } as AppConfig
const baseline = useAppStore.getState()
function makeSession(id = 'session-1'): SessionSnapshot {
  return {
    id, hostId: 'local', workspacePath: '/repo', label: 'Build auth flow', createdAt: 1, updatedAt: 2,
    processState: 'running', latestOutputBytes: 0, status: { state: 'working', source: 'run-process', observedAt: 2 },
    kind: 'terminal', providerId: null, control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id, generation: 1 } }
  }
}

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useAppStore.setState({ config, sessions: [makeSession()], demands: { 'demand:one': { id: 'demand:one', title: 'Build auth flow', description: '', status: 'in_progress', priority: 'normal', projectId: 'repo', projectName: 'Repo', sessionIds: ['session-1'], createdAt: 1, updatedAt: 2, source: 'default-topic' } }, selectedDemandId: null, mainSurface: 'board' })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(baseline, true)
})

describe('global Board demand workspace', () => {
  it('keeps Board visible and opens the selected demand in the same surface', async () => {
    await act(async () => root.render(createElement(GlobalBoardSurface)))
    const card = container.querySelector('[data-demand-id="demand:one"]') as HTMLButtonElement
    expect(card).toBeTruthy()
    await act(async () => card.click())
    expect(container.querySelector('.global-board-columns')).toBeTruthy()
    expect(container.querySelector('.global-demand-workspace')).toBeTruthy()
    expect(container.querySelector('[data-test-session="session-1"]')?.textContent).toBe('terminal:session-1')
    expect(useAppStore.getState().mainSurface).toBe('board')
  })

  it('keeps a persisted demand visible when its Session is gone', async () => {
    useAppStore.setState({ sessions: [], demands: {
      'demand:recover': { id: 'demand:recover', title: 'Recover the work surface', description: 'Keep context after restart', status: 'in_progress', priority: 'normal', projectId: 'repo', projectName: 'Repo', sessionIds: ['gone'], createdAt: 1, updatedAt: 3, source: 'default-topic' }
    } })
    await act(async () => root.render(createElement(GlobalBoardSurface)))
    expect(container.querySelector('[data-demand-id="demand:recover"]')?.textContent).toContain('Recover the work surface')
    await act(async () => (container.querySelector('[data-demand-id="demand:recover"]') as HTMLButtonElement).click())
    expect(container.querySelector('.global-demand-workspace')?.textContent).toContain('No Session linked yet')
  })
})
