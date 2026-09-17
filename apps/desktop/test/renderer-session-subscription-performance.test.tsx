// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'

const counters = vi.hoisted(() => ({ workspace: 0, avatar: 0 }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench.js', () => ({
  WorkspaceWorkbench: () => { counters.workspace += 1; return <output data-workspace-probe /> }
}))
vi.mock('../src/renderer/src/components/AgentProviderIcon.js', () => ({
  AgentProviderIcon: () => { counters.avatar += 1; return <span data-provider-icon /> },
  agentProviderLabel: (id: string) => id
}))
import { App } from '../src/renderer/src/App.js'
import { AgentAvatar, ExecutorIdentityContext } from '../src/renderer/src/components/AgentAvatar.js'
import { useAppStore } from '../src/renderer/src/store.js'
import * as memoryCandidates from '../src/renderer/src/lib/surface-memory-budget-candidates.js'
import { useSurfaceMemoryBudget } from '../src/renderer/src/lib/surface-memory-budget-coordinator.js'
import { sessionPresentationById } from '../src/renderer/src/lib/session-presentation.js'
import { AgentRoster, AgentTreePanel } from '../src/renderer/src/components/AgentRoster.js'
import * as roster from '../src/renderer/src/lib/agent-roster.js'
import * as tree from '../src/renderer/src/lib/agent-tree.js'
import { RendererResourceOwners } from '../src/renderer/src/components/RendererResourceOwners.js'
import { useTerminalRegionParked } from '../src/renderer/src/lib/terminal-cold-parking-coordinator.js'
import { recordForWorkbenchTab, useWorkbenchTabSessions } from '../src/renderer/src/lib/workbench-session-subscriptions.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo',
    label: id, createdAt: 1, updatedAt: 1, latestOutputBytes: 0, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}
const initial = useAppStore.getState()
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  counters.workspace = 0
  counters.avatar = 0
  const tab = createWorkbenchTab('tab', { kind: 'agent', phase: 'attached', regionId: 'region', workspaceId: 'workspace', sessionId: 'visible' })
  useAppStore.setState({
    ...initial, initialize: vi.fn(async () => () => {}), loading: false, config,
    sessions: [agent('visible'), agent('background')], tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('group', [tab.id]) },
    mainSurface: 'workbench', activeWorkspaceId: 'workspace', error: null
  }, true)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
})

async function updateBackgroundStatus(observedAt: number) {
  await act(async () => useAppStore.getState().applyEvent({
    type: 'core', hostId: 'local', event: {
      type: 'agent-status', agentSessionId: 'background', state: 'working',
      evidence: { source: 'native-hook', observedAt }
    }
  }))
}

describe('mounted Renderer session subscription cost', () => {
  it('keeps unrelated Session status, naming and timeline updates outside a mounted Tab consumer', async () => {
    const tab = useAppStore.getState().tabs.tab!
    let renders = 0
    function TabProbe() {
      const sessions = useWorkbenchTabSessions(tab)
      renders += 1
      return <output data-tab-state>{sessions.map((session) => `${session.id}:${session.status.state}`).join(',')}</output>
    }
    await act(async () => root.render(<TabProbe />))
    expect(container.querySelector('[data-tab-state]')?.textContent).toBe('visible:running')
    expect(recordForWorkbenchTab({ visible: 'Own name', background: 'Unrelated name' }, tab)).toEqual({ visible: 'Own name' })
    const before = renders
    await updateBackgroundStatus(Date.now())
    expect(renders).toBe(before)
    await act(async () => useAppStore.getState().applyEvent({
      type: 'core', hostId: 'local', event: {
        type: 'agent-status', agentSessionId: 'visible', state: 'waiting',
        evidence: { source: 'native-hook', observedAt: Date.now() + 1 }
      }
    }))
    expect(renders).toBeGreaterThan(before)
    expect(container.querySelector('[data-tab-state]')?.textContent).toBe('visible:waiting')
  })

  it('does not notify a Terminal parking consumer when its parked set is unchanged', async () => {
    let renders = 0
    function ParkingProbe() {
      const parked = useTerminalRegionParked('region')
      renders += 1
      return <output data-parking-probe>{parked ? 'parked' : 'warm'}</output>
    }
    await act(async () => root.render(<RendererResourceOwners workbenchVisible measurementActive={false}><ParkingProbe /></RendererResourceOwners>))
    expect(container.querySelector('[data-parking-probe]')?.textContent).toBe('warm')
    expect(renders).toBeGreaterThan(0)
    const before = renders
    // The actual Region's semantic observation changes, while its lifecycle/parking facts do not.
    await act(async () => useAppStore.getState().applyEvent({
      type: 'core', hostId: 'local', event: {
        type: 'agent-status', agentSessionId: 'visible', state: 'working',
        evidence: { source: 'native-hook', observedAt: Date.now() }
      }
    }))
    expect(renders).toBe(before)
  })

  it('keeps the mounted status decay owner active without replacing Session or Run identity', async () => {
    const session = agent('visible')
    const stale = { ...session, status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() - 16 * 60_000 } }
    useAppStore.setState({ sessions: [stale] })
    await act(async () => root.render(<App />))
    expect(container.querySelector('main.main-shell')).not.toBeNull()
    expect(useAppStore.getState().sessions.map((entry) => [entry.id, entry.status.state, entry.control.run.runId])).toEqual([
      ['visible', 'running', 'run-visible']
    ])
  })

  it('shares one index traversal across every Avatar lookup and unrelated Store writes', () => {
    let reads = 0
    const sessions = Array.from({ length: 32 }, (_, position) => {
      const session = agent(`indexed-${position}`)
      Object.defineProperty(session, 'id', { get() { reads += 1; return `indexed-${position}` } })
      return session
    })
    expect(sessions).toHaveLength(32)
    for (let consumer = 0; consumer < 16; consumer += 1) {
      expect(sessionPresentationById(sessions).get('indexed-31')).toBe(sessions[31])
    }
    expect(reads).toBe(32)
    const changed = { ...agent('indexed-31'), label: 'Updated identity' }
    const next = [...sessions.slice(0, -1), changed]
    expect(sessionPresentationById(next).get('indexed-31')).toBe(changed)
    expect(sessionPresentationById(next).get('indexed-0')).toBe(sessions[0])
  })

  it('keeps sorting and grouping unmounted while Agent disclosures are closed', async () => {
    const buildRoster = vi.spyOn(roster, 'buildAgentRoster')
    const buildTree = vi.spyOn(tree, 'buildAgentTree')
    await act(async () => root.render(<>
      <AgentRoster total={2} />
      <AgentTreePanel filter="all" count={2} heading="All Agents" label="Show every Agent" />
    </>))
    expect(container.querySelectorAll('button')).toHaveLength(2)
    expect(buildRoster).not.toHaveBeenCalled()
    expect(buildTree).not.toHaveBeenCalled()
    for (let index = 0; index < 12; index += 1) await updateBackgroundStatus(Date.now() + index)
    expect(buildRoster).not.toHaveBeenCalled()
    expect(buildTree).not.toHaveBeenCalled()
    const trigger = container.querySelector<HTMLButtonElement>('.agent-tree__disclose')!
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(buildTree).toHaveBeenCalled()
    expect(buildRoster).toHaveBeenCalled()
    expect(document.querySelectorAll('.agent-tree .agent-roster__row')).toHaveLength(2)
    await act(async () => useAppStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === 'visible' ? { ...session, label: 'Updated visible Agent' } : session) })))
    expect(document.querySelector('.agent-tree')?.textContent).toContain('Updated visible Agent')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    const before = buildTree.mock.calls.length
    await updateBackgroundStatus(Date.now() + 100)
    expect(buildTree.mock.calls.length).toBe(before)
  })

  it('does not rerender the window work surface for an unrelated Session status update', async () => {
    await act(async () => root.render(<App />))
    expect(container.querySelector('main.main-shell')).not.toBeNull()
    expect(container.querySelectorAll('[data-workspace-probe]')).toHaveLength(1)
    expect(counters.workspace).toBeGreaterThan(0)
    const before = counters.workspace
    for (let index = 0; index < 12; index += 1) await updateBackgroundStatus(Date.now() + index)
    expect(useAppStore.getState().sessions.find((session) => session.id === 'background')?.status.state).toBe('working')
    expect(counters.workspace - before).toBe(0)
    expect(useAppStore.getState().sessions.find((session) => session.id === 'visible')?.control.run.runId).toBe('run-visible')
  })

  it('does not recompute Browser/Monaco candidates for Agent status changes', async () => {
    const collect = vi.spyOn(memoryCandidates, 'collectSurfaceMemoryCandidates')
    let commits = 0
    function BudgetProbe() { useSurfaceMemoryBudget({ workbenchVisible: true }); return <output data-budget-probe /> }
    await act(async () => root.render(<Profiler id="budget" onRender={() => { commits += 1 }}><BudgetProbe /></Profiler>))
    expect(container.querySelector('[data-budget-probe]')).not.toBeNull()
    expect(collect).toHaveBeenCalled()
    const beforeCalls = collect.mock.calls.length
    const beforeCommits = commits
    for (let index = 0; index < 12; index += 1) await updateBackgroundStatus(Date.now() + index)
    expect(collect.mock.calls.length - beforeCalls).toBe(0)
    expect(commits - beforeCommits).toBe(0)
    await act(async () => useAppStore.setState({ dirtyDocuments: { file: true } }))
    expect(collect.mock.calls.length).toBeGreaterThan(beforeCalls)
  })

  it('updates only the matching Avatar presentation and ignores bookkeeping-only Session changes', async () => {
    await act(async () => root.render(
      <ExecutorIdentityContext.Provider value={{ config }}>
        <AgentAvatar sessionId="visible" />
      </ExecutorIdentityContext.Provider>
    ))
    expect(container.querySelector('[data-provider-icon]')).not.toBeNull()
    expect(counters.avatar).toBeGreaterThan(0)
    const before = counters.avatar
    await updateBackgroundStatus(Date.now())
    await act(async () => useAppStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === 'visible' ? { ...session, updatedAt: session.updatedAt + 1 } : session) })))
    expect(counters.avatar - before).toBe(0)
    await act(async () => useAppStore.getState().applyEvent({
      type: 'core', hostId: 'local', event: {
        type: 'agent-status', agentSessionId: 'visible', state: 'waiting',
        evidence: { source: 'native-hook', observedAt: Date.now() + 1 }, detail: 'Your answer is needed'
      }
    }))
    expect(container.querySelector('.agent-avatar')?.getAttribute('aria-label')).toContain('waiting')
    expect(counters.avatar).toBeGreaterThan(before)
  })
})
