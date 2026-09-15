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
import { api } from '../src/renderer/src/lib/api.js'

const config = { workspaces: [{ id: 'repo', hostId: 'local', name: 'Repo', path: '/repo', kind: 'folder' }] } as AppConfig
const baseline = useAppStore.getState()
function makeSession(id = 'session-1'): SessionSnapshot {
  return {
    id, hostId: 'local', workspacePath: '/repo', label: 'Build auth flow', createdAt: 1, updatedAt: 2,
    processState: 'running', latestOutputBytes: 0, status: { state: 'working', source: 'run-process', observedAt: 2 },
    kind: 'terminal', providerId: null, control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } }
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
  vi.restoreAllMocks()
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
    expect(container.querySelector('.global-demand-workspace')?.textContent).toContain('Linked Sessions are not yet available')
    expect(useAppStore.getState().demands['demand:recover'].sessionIds).toEqual(['gone'])
    expect(container.querySelector('[aria-label="Session arrangement"]')).toBeNull()
  })

  it('edits title and description in place through the same persisted Demand entry', async () => {
    const update = vi.spyOn(api.demands, 'update')
    await act(async () => root.render(createElement(GlobalBoardSurface)))
    await act(async () => (container.querySelector('[data-demand-id="demand:one"]') as HTMLButtonElement).click())
    const pane = container.querySelector('.global-demand-workspace')!
    expect(pane.querySelectorAll('[aria-label="Demand title"]')).toHaveLength(1)
    expect(pane.querySelector('.global-demand-workspace__identity strong')).toBeNull()
    const title = pane.querySelector<HTMLInputElement>('[aria-label="Demand title"]')!
    expect(title.value).toBe('Build auth flow')
    await act(async () => {
      title.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Readable demand')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => title.blur())
    const description = pane.querySelector<HTMLTextAreaElement>('[aria-label="Demand description"]')!
    await act(async () => {
      description.focus()
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(description, 'A directly editable body')
      description.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => description.blur())
    expect(update).toHaveBeenCalledWith('demand:one', { title: 'Readable demand' })
    expect(update).toHaveBeenCalledWith('demand:one', { description: 'A directly editable body' })
    expect(Object.keys(useAppStore.getState().demands)).toEqual(['demand:one'])
    expect(useAppStore.getState().demands['demand:one']).toMatchObject({
      id: 'demand:one', title: 'Readable demand', description: 'A directly editable body', sessionIds: ['session-1']
    })
  })

  it('keeps routing visible, secondary properties disclosed and zero-Session work compact', async () => {
    useAppStore.setState({ selectedDemandId: 'demand:one', sessions: [], demands: {
      'demand:one': { ...useAppStore.getState().demands['demand:one'], sessionIds: [], tags: ['design'], phaseIndex: 1 }
    } })
    await act(async () => root.render(createElement(GlobalBoardSurface)))
    const pane = container.querySelector('.global-demand-workspace')!
    expect(pane.querySelectorAll('.global-demand-workspace__properties select')).toHaveLength(4)
    for (const label of ['Demand status', 'Demand priority', 'Demand project', 'Demand assignee']) {
      expect(pane.querySelector(`[aria-label="${label}"]`)).not.toBeNull()
    }
    const metadata = pane.querySelector<HTMLDetailsElement>('.global-demand-workspace__metadata')!
    expect(metadata.open).toBe(false)
    expect(metadata.querySelector('summary')?.textContent).toBe('More properties')
    expect(metadata.querySelector<HTMLInputElement>('[aria-label="Demand tags"]')?.value).toBe('design')
    expect(metadata.querySelectorAll('input[type="date"]')).toHaveLength(2)
    expect(metadata.querySelector('input[type="number"]')).not.toBeNull()
    expect(pane.querySelector('[aria-label="Session arrangement"]')).toBeNull()
    expect(pane.querySelector('.agent-topology-summary')).toBeNull()
    expect(pane.querySelector('.global-demand-workspace__regions')).toBeNull()
    expect(pane.querySelector('.global-demand-workspace__empty')?.textContent).toContain('Open PMO')
    expect(pane.querySelector<HTMLDetailsElement>('.global-demand-workspace__assignment')?.open).toBe(false)
  })

  it('preserves observation and arrangement for two linked Sessions', async () => {
    useAppStore.setState({ selectedDemandId: 'demand:one', sessions: [makeSession(), makeSession('session-2')], demands: {
      'demand:one': { ...useAppStore.getState().demands['demand:one'], sessionIds: ['session-1', 'session-2'] }
    } })
    await act(async () => root.render(createElement(GlobalBoardSurface)))
    expect([...container.querySelectorAll('[data-test-session]')].map((node) => node.getAttribute('data-test-session'))).toEqual(['session-1', 'session-2'])
    expect(container.querySelector('[aria-label="Session arrangement"]')).not.toBeNull()
    expect(container.querySelector<HTMLDetailsElement>('.global-demand-workspace__assignment')?.open).toBe(true)
  })
})
