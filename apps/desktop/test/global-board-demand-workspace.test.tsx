const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'
import { openHostGoalTransport } from './helpers/host-goal-transport'
const config = { workspaces: [{ id: 'repo', hostId: 'local', name: 'Repo', path: _hygiene_fixturePath("repo"), kind: 'folder' }] } as AppConfig
const baseline = useAppStore.getState()
function makeSession(id = 'session-1'): SessionSnapshot { return { id, hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), label: 'Build auth flow', createdAt: 1, updatedAt: 2, processState: 'running', latestOutputBytes: 0, status: { state: 'working', source: 'run-process', observedAt: 2 }, kind: 'terminal', providerId: null, control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } } }
let root: Root, container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); useAppStore.setState({ config, sessions: [makeSession()], demands: { 'demand:one': { id: 'demand:one', title: 'Build auth flow', description: 'Keep the original intent.', status: 'in_progress', priority: 'normal', projectId: 'repo', projectName: 'Repo', sessionIds: ['session-1'], createdAt: 1, updatedAt: 2, source: 'default-topic' } }, selectedDemandId: null, mainSurface: 'board' }) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
// The Team is a single sidebar consumer, ahead of low-emphasis Goal properties.
function relationships() { const people = container.querySelector<HTMLElement>('.goal-team')!; expect(people).not.toBeNull(); return people }
async function editDescription() { await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit goal description"]')!.click()); return container.querySelector<HTMLTextAreaElement>('[aria-label="Goal description"]')! }

describe('Goal reading workspace', () => {
  it('keeps the default list beside the readable goal without mounting extra terminal views', async () => {
    await act(async () => root.render(createElement(GlobalBoardSurface)))
    const row = container.querySelector<HTMLElement>('[data-demand-id="demand:one"]')!; expect(row).toBeTruthy()
    await act(async () => { row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(container.querySelector('.goals-list')).toBeTruthy(); expect(container.querySelector('.goals-detail')).toBeTruthy()
    // The intent reads as rendered text; its original-text editor opens on Edit.
    expect(container.querySelector('[aria-label="Goal title"]')).toBeTruthy(); expect(container.querySelector('[aria-label="Goal description"]')).toBeNull()
    expect(container.querySelector('.goals-intent__reading')?.textContent).toContain('Keep the original intent.'); expect(await editDescription()).toBeTruthy()
    expect(container.querySelector('.xterm')).toBeNull(); expect(useAppStore.getState().mainSurface).toBe('board')
    await act(async () => (container.querySelector('[aria-label="Back to goals"]') as HTMLButtonElement).click())
    expect(useAppStore.getState().selectedDemandId).toBeNull(); expect(document.activeElement).toBe(row)
  })
  it('preserves a missing Session identity and shows recovery when execution is requested', async () => {
    useAppStore.setState({ sessions: [], selectedDemandId: 'demand:one' }); await act(async () => root.render(createElement(GlobalBoardSurface)))
    // The missing Session stays readable by its identity, with recovery.
    const missing = relationships().querySelector<HTMLElement>('[data-goal-team-unconfirmed="session-1"]')!
    expect(missing.textContent).toContain('session-1'); expect(missing.textContent).toContain('Host is not confirmed'); expect(missing.querySelector('.focus-context')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Choose related Goal sessions"]')?.disabled).toBe(false)
    expect(useAppStore.getState().demands['demand:one'].sessionIds).toEqual(['session-1'])
  })
  it('edits the title and body through the persisted owner instead of making a second entry', async () => {
    // Only Electron IPC is substituted: edits reach the original Host Goal owner through its public codec.
    const host = await openHostGoalTransport({ config })
    try {
    const seeded = useAppStore.getState().demands['demand:one']
    const saved = (await host.demands.create({ id: seeded.id, title: seeded.title, description: seeded.description, status: seeded.status, sessionIds: seeded.sessionIds })).demand
    const original = { ...seeded, updatedAt: saved.updatedAt, createdAt: saved.createdAt }
    useAppStore.setState({ demands: { [original.id]: original } })
    useAppStore.setState({ selectedDemandId: original.id }); await act(async () => root.render(createElement(GlobalBoardSurface)))
    for (const [label, text] of [['Goal title', 'Readable goal'], ['Goal description', 'A directly editable body']]) {
      const input = label === 'Goal description' ? await editDescription() : container.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!
      expect(input).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
      await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await host.settle() })
    }
    expect(host.bodies('demand.update').map(({ demandId, patch }) => [demandId, patch])).toEqual([[original.id, { title: 'Readable goal' }], [original.id, { description: 'A directly editable body' }]])
    expect(Object.keys(useAppStore.getState().demands)).toEqual([original.id]); expect(useAppStore.getState().demands[original.id]).toMatchObject({ title: 'Readable goal', description: 'A directly editable body', sessionIds: ['session-1'] })
    expect((await host.demands.list()).map(goal => [goal.id, goal.title, goal.description])).toEqual([[original.id, 'Readable goal', 'A directly editable body']])
    } finally { await host.dispose() }
  })
  it('keeps all properties reachable in one closed disclosure and avoids zero-Session filler', async () => {
    useAppStore.setState({ selectedDemandId: 'demand:one', sessions: [], demands: { 'demand:one': { ...useAppStore.getState().demands['demand:one'], sessionIds: [], tags: ['design'] } } }); await act(async () => root.render(createElement(GlobalBoardSurface)))
    // Status, priority and Project are the always-visible common row; everything else stays in one closed disclosure.
    const common = container.querySelector<HTMLElement>('[aria-label="Common Goal properties"]')!
    expect([...common.querySelectorAll<HTMLElement>('.selection-field')].map(node => node.getAttribute('aria-label'))).toEqual(['Goal work status', 'Goal priority', 'Goal project'])
    const properties = container.querySelector<HTMLDetailsElement>('.goals-properties')!; expect(properties.open).toBe(false); expect(properties.querySelector('summary')?.textContent).toBe('More properties')
    expect(container.querySelectorAll('.goals-properties')).toHaveLength(1)
    await act(async () => { properties.open = true; properties.dispatchEvent(new Event('toggle')) })
    expect([...properties.querySelectorAll<HTMLElement>('.selection-field')].map(node => node.getAttribute('aria-label'))).toEqual(['Parent goal'])
    expect(properties.querySelector<HTMLInputElement>('[aria-label="Goal tags"]')?.value).toBe('design'); expect(properties.querySelectorAll('input[type="date"]')).toHaveLength(2)
    expect(properties.querySelectorAll('input[type="number"]')).toHaveLength(1)
    expect(properties.querySelector<HTMLInputElement>('[aria-label="Goal batch"]')).toMatchObject({ type: 'number', min: '0', step: '1' })
    // Assignment is chosen in Collaboration, not as a property select.
    expect(properties.querySelector('[aria-label="Goal assignee"]')).toBeNull(); expect(container.querySelector('[aria-label="Choose Goal assignees"]')).toBeTruthy()
    // No zero-Session filler: with no linked Session there is no arrangement disclosure or topology.
    expect(container.querySelector('.goals-topology')).toBeNull(); expect(container.querySelector('.agent-topology-summary')).toBeNull(); expect(container.textContent).not.toContain('0 Sessions')
  })
  it('opens each linked Session through the original Space navigation and discloses topology on demand', async () => {
    // Goal collaboration links Agent Sessions; these linked discussions are original Agents with exact Core identities.
    const agent = (id: string) => ({ ...makeSession(id), kind: 'agent', providerId: 'codex', executorId: 'codex', agentSessionUpdatedAt: 2,
      capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
      control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: id + '-run' } } }) as SessionSnapshot
    const selectSession = vi.fn(); const sessions = [agent('session-1'), agent('session-2')]
    useAppStore.setState({ config: { ...config, executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } }, appearance: { terminalTheme: 'graphite' } } as AppConfig, selectedDemandId: 'demand:one', selectSession, sessions, demands: { 'demand:one': { ...useAppStore.getState().demands['demand:one'], sessionIds: ['session-1', 'session-2'],
      participations: sessions.map(session => ({ id: 'source-' + session.id, operationId: 'source-' + session.id, kind: 'discussion' as const, hostId: 'local', agentSessionId: session.id, entryPoint: 'goal.discuss', recordedAt: 1 })) } } }); await act(async () => root.render(createElement(GlobalBoardSurface)))
    const rows = [...relationships().querySelectorAll<HTMLButtonElement>('button.focus-context')]; expect(rows).toHaveLength(2)
    expect(rows.every(row => !row.disabled)).toBe(true)
    for (const row of rows) await act(async () => row.click())
    expect(selectSession.mock.calls).toEqual([['session-1'], ['session-2']]); expect(useAppStore.getState().sessions).toEqual(sessions)
    const topology = container.querySelector<HTMLDetailsElement>('.goals-topology')!; expect(topology.open).toBe(false); expect(container.querySelector('.agent-topology-summary')).toBeNull()
    await act(async () => { topology.open = true; topology.dispatchEvent(new Event('toggle')) }); expect(container.querySelector('.agent-topology-summary')).toBeTruthy()
  })
})
