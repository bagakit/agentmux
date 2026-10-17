// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { msUntilSemanticStatusStale } from '@agentmux/core/agent-status'
import type { SessionSnapshot } from '../src/shared/contracts'
import { ActivityMetrics } from '../src/renderer/src/components/ProjectActivityMetrics'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { useAgentAttentionNotifications } from '../src/renderer/src/hooks/useAgentAttentionNotifications'
import { sessionBoardColumn } from '../src/renderer/src/lib/project-board'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
function current(id: string, state: 'active' | 'idle' | 'unknown', display: Agent['status']['state'] = 'running'): Agent & { currentActivity: NonNullable<Agent['currentActivity']> & { nativeTurnId: string } } {
  const original = composerSession(id), now = Date.now()
  return { ...original, nativeSessionId: `native-${id}`, nativeHandle: { kind: 'provider', providerId: original.providerId, sessionId: `native-${id}` },
    status: { state: display, source: 'native-hook', observedAt: now },
    currentActivity: { state, source: 'native-hook', run: original.control.run, nativeSessionId: `native-${id}`,
      nativeTurnId: `turn-${id}`, sourceId: `source-${id}`, sequence: 1, hookReceiptId: `receipt-${id}`, observedAt: now } }
}
function request(id = 'pending'): Agent {
  const original = current(id, 'active', 'working')
  return { ...original, pendingInteraction: { kind: 'permission', id: `request-${id}`, agentSessionId: id,
    title: 'Allow the original operation?', options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }],
    evidence: { source: 'native-hook', observedAt: Date.now(), run: original.control.run, hookReceiptId: `request-receipt-${id}` } } }
}
const metric = (key: string) => dom.container.querySelector(`[data-probe-metrics] .project-activity__metric--${key}`)
const project = () => dom.container.querySelector<HTMLButtonElement>('button.project-rail-row')!
async function mount(sessions: SessionSnapshot[]) {
  useAppStore.setState({ sessions, timelines: {}, agentNames: {}, config: composerConfig,
    activeWorkspaceId: composerConfig.workspaces[0]!.id, collapsedProjectGroups: {}, tabs: {}, layouts: {},
    agentComposerDrafts: { original: 'Keep the original draft' } })
  await dom.render(<><section data-probe-metrics><ActivityMetrics sessions={sessions} /></section><WorkspaceSidebar /></>)
  expect(project()).not.toBeNull()
}
beforeEach(() => {
  vi.spyOn(api.sessions, 'historySources')
  vi.spyOn(api.sessions, 'historyPage')
})

it('does not call a process-only running Agent idle in real activity and sidebar consumers', async () => {
  const original = composerSession('original')
  await mount([original])
  expect(metric('idle')).toBeNull()
  expect(metric('working')).toBeNull()
  expect(metric('unknown')?.textContent).toBe('1')
  expect(project().getAttribute('aria-label')).toContain('1 activity unknown')
  expect(project().hasAttribute('data-running')).toBe(false)
  expect(api.sessions.historySources).not.toHaveBeenCalled()
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions[0]).toBe(original)
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Keep the original draft')
})

it('honors current native active and idle independently of retained Board placement', async () => {
  const working = current('working', 'active'), idle = current('idle', 'idle', 'working')
  await mount([working, idle])
  expect(metric('working')?.textContent).toBe('1')
  expect(metric('idle')?.textContent).toBe('1')
  expect(metric('unknown')).toBeNull()
  expect(project().getAttribute('aria-label')).toContain('1 Agent is working')
  expect(project().getAttribute('aria-label')).toContain('1 idle')
  expect(project().getAttribute('data-running')).toBe('true')
  expect(sessionBoardColumn(working)).toBe('working')
  expect(sessionBoardColumn(idle)).toBe('working')
  const controls = useAppStore.getState().sessions.map(session => session.control)
  await act(async () => useAppStore.setState({ sessions: [working, { ...idle, latestOutputBytes: 512 }] }))
  expect(project().getAttribute('aria-label')).toContain('1 idle')
  expect(useAppStore.getState().sessions.map(session => session.control)).toEqual(controls)
  await act(async () => useAppStore.setState({ sessions: [{ ...working, currentActivity: { ...working.currentActivity!, state: 'idle', sequence: 2 } }, idle] }))
  expect(project().getAttribute('aria-label')).toContain('2 idle')
  expect(project().getAttribute('aria-label')).not.toContain('Agent is working')
  expect(project().hasAttribute('data-running')).toBe(false)
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
})

it.each(['stale', 'unsupported', 'interrupted', 'unobserved'] as const)('keeps %s activity unknown in both original consumers', async kind => {
  let original = current(kind, 'active', 'working')
  if (kind === 'stale') {
    const age = msUntilSemanticStatusStale(original.status, Date.now())
    original = { ...original, status: { ...original.status, observedAt: Date.now() - age },
      currentActivity: { ...original.currentActivity!, observedAt: Date.now() - age } }
  }
  if (kind === 'unsupported') original = { ...original, capabilities: { ...original.capabilities, timeline: 'unavailable' } }
  if (kind === 'interrupted') original = { ...original, processState: 'interrupted' }
  if (kind === 'unobserved') original = { ...original, runUnobserved: true }
  await mount([original])
  expect(metric('working')).toBeNull()
  expect(metric('idle')).toBeNull()
  expect(metric('unknown')?.textContent).toBe('1')
  expect(project().getAttribute('aria-label')).toContain('1 activity unknown')
  expect(project().hasAttribute('data-running')).toBe(false)
  expect(useAppStore.getState().sessions[0]!.control).toBe(original.control)
})

it('retains typed pending and real failure attention without calling either idle or working', async () => {
  const pending = request(), failed = { ...current('failed', 'idle'), status: { state: 'error' as const, source: 'native-hook' as const, observedAt: Date.now(), detail: 'Original operation failed' } }
  const terminal: SessionSnapshot = { ...composerSession('terminal'), kind: 'terminal', providerId: null,
    status: { state: 'waiting', source: 'run-process', observedAt: Date.now() },
    control: { kind: 'terminal', hostId: 'local', runId: 'original-terminal', run: { runId: 'original-terminal' } } }
  await mount([pending, failed, terminal])
  expect(metric('needs-you')?.textContent).toBe('1')
  expect(metric('error')?.textContent).toBe('1')
  expect(metric('working')).toBeNull()
  expect(metric('idle')).toBeNull()
  const count = vi.spyOn(api.ui, 'setAgentAttentionCount').mockResolvedValue(true)
  function Attention() { useAgentAttentionNotifications(); return null }
  await dom.render(<Attention />)
  expect(count).toHaveBeenCalledWith(1)
  expect(useAppStore.getState().sessions[0]).toBe(pending)
  expect(useAppStore.getState().sessions[1]).toBe(failed)
  await mount([{ ...pending, status: failed.status }])
  expect(metric('needs-you')?.textContent).toBe('1')
  expect(metric('error')?.textContent).toBe('1')
  expect(metric('working')).toBeNull()
  expect(metric('idle')).toBeNull()
  await mount([pending, current('legacy-request', 'unknown', 'waiting')])
  expect(metric('needs-you')?.textContent).toBe('2')
  expect(project().getAttribute('aria-label')).toContain('2 Agents need you')
})

it('does not turn a retained completion into a current result after an exact native activity update', async () => {
  await mount([current('native-idle', 'idle', 'done')])
  expect(metric('idle')?.textContent).toBe('1')
  expect(metric('done')).toBeNull()
  await mount([{ ...composerSession('complete'), status: { state: 'done', source: 'native-hook', observedAt: Date.now() } }])
  expect(metric('done')?.textContent).toBe('1')
  expect(metric('idle')).toBeNull()
})

it('keeps a confirmed turn conclusion when its Run exits without inventing current idle activity', async () => {
  const original = { ...composerSession('completed-run'), processState: 'exited' as const,
    status: { state: 'done' as const, source: 'native-hook' as const, observedAt: Date.now() } }
  await mount([original])
  expect(metric('done')?.textContent).toBe('1')
  expect(metric('unknown')?.textContent).toBe('1')
  expect(metric('idle')).toBeNull()
  expect(metric('working')).toBeNull()
  expect(project().getAttribute('aria-label')).toContain('1 activity unknown')
  expect(useAppStore.getState().sessions[0]!.control).toBe(original.control)
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
  await mount([{ ...original, status: { ...original.status, source: 'run-process' } }])
  expect(metric('done')).toBeNull()
  expect(metric('unknown')?.textContent).toBe('1')
})

it('keeps same-ID Host subjects counted independently without changing their original controls', async () => {
  const local = current('same', 'active'), remote = current('same', 'idle'), remoteRun = { runId: 'other-original-run' }
  const other = { ...remote, hostId: 'other-host', control: { ...remote.control, hostId: 'other-host', run: remoteRun },
    currentActivity: { ...remote.currentActivity!, run: remoteRun } }
  await mount([local, other])
  expect(metric('working')?.textContent).toBe('1')
  expect(metric('idle')?.textContent).toBe('1')
  expect(project().getAttribute('aria-label')).toContain('1 Agent is working')
  expect(project().getAttribute('aria-label')).not.toContain('1 idle')
  expect(useAppStore.getState().sessions).toEqual([local, other])
  expect(useAppStore.getState().sessions[0]!.control).toBe(local.control)
  expect(useAppStore.getState().sessions[1]!.control).toBe(other.control)
})
