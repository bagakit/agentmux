// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
const config = { workspaces: [{ id: 'repo', hostId: 'local', name: 'Repo', path: '/repo', kind: 'folder' }] } as AppConfig
const baseline = useAppStore.getState()
function makeSession(id = 'session-1'): SessionSnapshot { return { id, hostId: 'local', workspacePath: '/repo', label: 'Build auth flow', createdAt: 1, updatedAt: 2, processState: 'running', latestOutputBytes: 0, status: { state: 'working', source: 'run-process', observedAt: 2 }, kind: 'terminal', providerId: null, control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } } }
let root: Root, container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); useAppStore.setState({ config, sessions: [makeSession()], demands: { 'demand:one': { id: 'demand:one', title: 'Build auth flow', description: 'Keep the original intent.', status: 'in_progress', priority: 'normal', projectId: 'repo', projectName: 'Repo', sessionIds: ['session-1'], createdAt: 1, updatedAt: 2, source: 'default-topic' } }, selectedDemandId: null, mainSurface: 'board' }) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
async function openExecution() { const details = container.querySelector<HTMLDetailsElement>('.goals-execution')!; expect(details.open).toBe(false); await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) }) }

describe('Goal reading workspace', () => {
  it('keeps the default list beside the readable goal without mounting extra terminal views', async () => {
    await act(async () => root.render(createElement(GlobalBoardSurface)))
    const row = container.querySelector<HTMLElement>('[data-demand-id="demand:one"]')!; expect(row).toBeTruthy()
    await act(async () => { row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(container.querySelector('.goals-list')).toBeTruthy(); expect(container.querySelector('.goals-detail')).toBeTruthy()
    expect(container.querySelector('[aria-label="Goal title"]')).toBeTruthy(); expect(container.querySelector('[aria-label="Goal description"]')).toBeTruthy()
    expect(container.querySelector('.goals-execution__row')).toBeNull(); expect(container.querySelector('.xterm')).toBeNull(); expect(useAppStore.getState().mainSurface).toBe('board')
    await act(async () => (container.querySelector('[aria-label="Back to goals"]') as HTMLButtonElement).click())
    expect(useAppStore.getState().selectedDemandId).toBeNull(); expect(document.activeElement).toBe(row)
  })
  it('preserves a missing Session identity and shows recovery when execution is requested', async () => {
    useAppStore.setState({ sessions: [], selectedDemandId: 'demand:one' }); await act(async () => root.render(createElement(GlobalBoardSurface)))
    await openExecution(); expect(container.querySelector('.goals-execution')?.textContent).toContain('Linked Sessions are not yet available')
    expect(useAppStore.getState().demands['demand:one'].sessionIds).toEqual(['session-1'])
  })
  it('edits the title and body through the persisted owner instead of making a second entry', async () => {
    const original = useAppStore.getState().demands['demand:one']
    let current = { ...original, executorId: null, tags: [], plannedStartAt: null, targetAt: null, parentDemandId: null, phaseIndex: null, revision: 1, activities: [], decisions: [] }
    const update = vi.spyOn(api.demands, 'update').mockImplementation(async (id, patch) => { current = { ...current, ...patch, revision: current.revision + 1 }; return { schema: 'agentmux.demand-receipt.v1', operation: 'update', operationId: 'update', revision: current.revision, demand: current } as never })
    useAppStore.setState({ selectedDemandId: original.id }); await act(async () => root.render(createElement(GlobalBoardSurface)))
    for (const [label, text] of [['Goal title', 'Readable goal'], ['Goal description', 'A directly editable body']]) {
      const input = container.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!
      expect(input).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
      await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    }
    expect(update).toHaveBeenCalledWith(original.id, { title: 'Readable goal' }); expect(update).toHaveBeenCalledWith(original.id, { description: 'A directly editable body' })
    expect(Object.keys(useAppStore.getState().demands)).toEqual([original.id]); expect(useAppStore.getState().demands[original.id]).toMatchObject({ title: 'Readable goal', description: 'A directly editable body', sessionIds: ['session-1'] })
  })
  it('keeps all properties reachable in one closed disclosure and avoids zero-Session filler', async () => {
    useAppStore.setState({ selectedDemandId: 'demand:one', sessions: [], demands: { 'demand:one': { ...useAppStore.getState().demands['demand:one'], sessionIds: [], tags: ['design'], phaseIndex: 1 } } }); await act(async () => root.render(createElement(GlobalBoardSurface)))
    const properties = container.querySelector<HTMLDetailsElement>('.goals-properties')!; expect(properties.open).toBe(false); expect(properties.querySelector('summary')?.textContent).toBe('More properties')
    expect(properties.querySelectorAll('select')).toHaveLength(5)
    for (const label of ['Goal work status', 'Goal priority', 'Goal project', 'Goal assignee', 'Parent goal']) expect(properties.querySelector(`[aria-label="${label}"]`)).toBeTruthy()
    expect(properties.querySelector<HTMLInputElement>('[aria-label="Goal tags"]')?.value).toBe('design'); expect(properties.querySelectorAll('input[type="date"]')).toHaveLength(2); expect(properties.querySelector('input[type="number"]')).toBeTruthy()
    expect(container.querySelector('.agent-topology-summary')).toBeNull(); expect(container.querySelector('.goals-execution__link')).toBeNull(); expect(container.textContent).not.toContain('0 Sessions')
  })
  it('opens each linked Session through the original Space navigation and discloses topology on demand', async () => {
    const selectSession = vi.fn(); const sessions = [makeSession(), makeSession('session-2')]
    useAppStore.setState({ selectedDemandId: 'demand:one', selectSession, sessions, demands: { 'demand:one': { ...useAppStore.getState().demands['demand:one'], sessionIds: ['session-1', 'session-2'] } } }); await act(async () => root.render(createElement(GlobalBoardSurface)))
    await openExecution(); const rows = [...container.querySelectorAll('.goals-execution__row')]; expect(rows).toHaveLength(2)
    for (const row of rows) await act(async () => (row.querySelector('button') as HTMLButtonElement).click())
    expect(selectSession.mock.calls).toEqual([['session-1'], ['session-2']]); expect(useAppStore.getState().sessions).toEqual(sessions)
    const topology = container.querySelector<HTMLDetailsElement>('.goals-topology')!; expect(topology.open).toBe(false); expect(container.querySelector('.agent-topology-summary')).toBeNull()
    await act(async () => { topology.open = true; topology.dispatchEvent(new Event('toggle')) }); expect(container.querySelector('.agent-topology-summary')).toBeTruthy()
  })
})
