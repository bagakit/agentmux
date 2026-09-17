import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '@agentmux/core'
import type { AgentSessionRecoveryCandidate, AppConfig, RuntimeSnapshot, SessionSnapshot } from '../src/shared/contracts.js'
import { agentStartupRecoveryDecision } from '../src/renderer/src/lib/idle-agent-restore-policy.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

const now = 200_000_000
const done = (stateEnteredAt: number): AgentStatus => ({ state: 'done', source: 'native-hook', observedAt: now, stateEnteredAt })
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private policy fixture' }], executors: {},
  workspaces: [{ id: 'workspace', name: 'Private', hostId: 'local', path: '/private/policy', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
function candidate(id: string, semanticStatus?: AgentStatus): AgentSessionRecoveryCandidate {
  return { agentSessionId: id, hostId: 'local', workspacePath: '/private/policy', providerId: 'codex', executorId: 'probe',
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    label: id, createdAt: 1, updatedAt: now, run: { runId: `run-${id}` }, ...(semanticStatus ? { semanticStatus } : {}) }
}
function projected(id: string, processState: SessionSnapshot['processState'], semanticStatus?: AgentStatus): SessionSnapshot {
  const value = candidate(id, semanticStatus)
  return { ...value, id, kind: 'agent', processState, latestOutputBytes: 0,
    status: { state: processState === 'exited' ? 'exited' : 'running', source: 'run-process', observedAt: now },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: value.run } }
}

describe('fixed Desktop startup policy', () => {
  it.each(['exited', 'interrupted', 'missing'] as const)('applies the exact one-day boundary to %s', (runState) => {
    for (const age of [3_600_001, 7_200_000, 86_399_999, 86_400_000]) {
      expect(agentStartupRecoveryDecision({ runState, semanticStatus: done(now - age), canonical: true, now })).toEqual({ kind: 'resume' })
    }
    expect(agentStartupRecoveryDecision({ runState, semanticStatus: done(now - 86_400_001), canonical: true, now })).toEqual({ kind: 'pending', reason: 'idle-over-day' })
  })
  it.each([undefined, done(now + 1), done(NaN), done(Infinity), done(-1),
    { state: 'done', source: 'native-hook', observedAt: now },
    { state: 'working', source: 'native-hook', observedAt: now, stateEnteredAt: now },
    { state: 'waiting', source: 'native-hook', observedAt: now, stateEnteredAt: now },
    { state: 'blocked', source: 'native-hook', observedAt: now, stateEnteredAt: now },
    { state: 'error', source: 'native-hook', observedAt: now, stateEnteredAt: now },
    { state: 'done', source: 'user', observedAt: now, stateEnteredAt: now }
  ] satisfies Array<AgentStatus | undefined>)('never substitutes observation time for idle evidence %#', (semanticStatus) => {
    expect(agentStartupRecoveryDecision({ runState: 'missing', ...(semanticStatus ? { semanticStatus } : {}), canonical: true, now }).kind).toBe('pending')
  })
  it('reattaches a healthy Run even when idle evidence or host ownership is unknown', () => {
    expect(agentStartupRecoveryDecision({ runState: 'running', canonical: false, now })).toEqual({ kind: 'reattach' })
    expect(agentStartupRecoveryDecision({ runState: 'exited', semanticStatus: done(now), canonical: false, now })).toEqual({ kind: 'pending', reason: 'runtime-unverified' })
    expect(agentStartupRecoveryDecision({ runState: 'missing', semanticStatus: { ...done(now), source: 'acp' }, canonical: true, now })).toEqual({ kind: 'resume' })
  })
})

let store: typeof import('../src/renderer/src/store.js').useAppStore
let api: typeof import('../src/renderer/src/lib/api.js').api
let dispose: (() => void) | undefined
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(now)
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  store = (await import('../src/renderer/src/store.js')).useAppStore
  api = (await import('../src/renderer/src/lib/api.js')).api
  vi.spyOn(store.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
})
afterEach(() => { dispose?.(); dispose = undefined; vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function seed(ids: string[]) {
  const tabs = Object.fromEntries(ids.map((id) => [`tab-${id}`, createWorkbenchTab(`tab-${id}`, {
    regionId: `region-${id}`, kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: id
  })]))
  const layouts = { workspace: createWorkspaceLayout('private-group', Object.keys(tabs)) }
  const focus = { execution: { sessionId: ids[0]!, history: ids.map((id, index) => ({ sessionId: id, focusedAt: now - index })) }, pmo: { sessionId: null } }
  const drafts = Object.fromEntries(ids.map(id => [id, `Original draft ${id}`]))
  store.setState({ loading: true, restoredWorkbench: { tabs, layouts }, agentFocus: focus, agentComposerDrafts: drafts, activeWorkspaceId: 'workspace' })
  return { tabs, layouts, focus, drafts }
}
async function initialize() { dispose = await store.getState().initialize(); expect(store.getState().loading).toBe(false) }
function assertWorkbench(original: ReturnType<typeof seed>) {
  const state = store.getState()
  expect(state.tabs).toEqual(original.tabs)
  expect(state.layouts.workspace).toEqual(original.layouts.workspace)
  expect(state.agentFocus).toEqual(original.focus)
  expect(state.agentComposerDrafts).toEqual(original.drafts)
}

describe('actual Store cold start', () => {
  it('preserves nonempty healthy/expired/unknown ended and missing surfaces without resume or input', async () => {
    const ids = ['healthy', 'ended-old', 'ended-unknown', 'missing-old', 'missing-working']
    const original = seed(ids)
    const healthy = projected('healthy', 'running', done(1))
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [healthy, projected('ended-old', 'exited', done(1)), projected('ended-unknown', 'exited')],
      timelines: {}, recoveryCandidates: [candidate('missing-old', done(1)), candidate('missing-working', { state: 'working', source: 'native-hook', observedAt: now, stateEnteredAt: now })] })
    const recover = vi.spyOn(api.sessions, 'recover')
    const write = vi.spyOn(api.sessions, 'write')
    await initialize(); assertWorkbench(original)
    expect(store.getState().sessions.map(value => value.id)).toEqual(ids)
    expect(store.getState().sessions.find(value => value.id === 'healthy')).toEqual(healthy)
    expect(store.getState().sessions.find(value => value.id === 'missing-old')?.status.detail).toContain('Idle for over a day')
    store.getState().setAgentComposerDraft('missing-old', 'Drafting never resumes')
    expect(store.getState().agentComposerDrafts['missing-old']).toBe('Drafting never resumes')
    expect(recover).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(api.sessions.stop).not.toHaveBeenCalled()
  })
  it('consumes the native epoch through both ended and missing recovery paths', async () => {
    const ids = ['ended-recent', 'missing-recent']; const original = seed(ids)
    let snapshot: RuntimeSnapshot = { sessions: [projected(ids[0]!, 'exited', done(now - 86_400_000))], timelines: {}, recoveryCandidates: [candidate(ids[1]!, done(now - 7_200_000))] }
    vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => snapshot)
    const recover = vi.spyOn(api.sessions, 'recover').mockImplementation(async control => {
      const session = projected(control.kind === 'agent' ? control.agentSessionId : '', 'running')
      snapshot = { ...snapshot, sessions: [...snapshot.sessions.filter(value => value.id !== session.id), session], recoveryCandidates: snapshot.recoveryCandidates.filter(value => value.agentSessionId !== session.id) }
      return { kind: 'resumed', session }
    })
    await initialize(); assertWorkbench(original)
    expect(recover.mock.calls.map(([control]) => control)).toEqual([
      { kind: 'agent', hostId: 'local', agentSessionId: 'missing-recent', run: { runId: 'run-missing-recent' } },
      { kind: 'agent', hostId: 'local', agentSessionId: 'ended-recent', run: { runId: 'run-ended-recent' } }
    ])
    expect(store.getState().sessions.map(value => [value.id, value.processState])).toEqual([['missing-recent', 'running'], ['ended-recent', 'running']])
  })
  it.each(['rejected', 'empty', 'unverified'] as const)('does not turn %s observation into missing/spawn or lost focus', async mode => {
    const original = seed(['unknown'])
    const snapshot = vi.spyOn(api.sessions, 'snapshot')
    if (mode === 'rejected') snapshot.mockRejectedValue(new Error('Runtime observation timed out'))
    else snapshot.mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: mode === 'unverified' ? [candidate('unknown', done(now))] : [], ...(mode === 'unverified' ? { runtimeOwnershipWarnings: ['local'] } : {}) })
    const recover = vi.spyOn(api.sessions, 'recover')
    await initialize(); assertWorkbench(original); expect(recover).not.toHaveBeenCalled()
  })
  it('keeps a refused recent ended Session once and removes only an explicit retirement', async () => {
    seed(['refused', 'retired'])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [projected('refused', 'exited', done(now)), projected('retired', 'exited', done(now))], timelines: {}, recoveryCandidates: [] })
    vi.spyOn(api.sessions, 'recover').mockImplementation(async control => control.kind === 'agent' && control.agentSessionId === 'retired'
      ? { kind: 'retired', agentSessionId: 'retired', previousRun: control.run, evidence: { kind: 'user-retired', observedAt: now } }
      : { kind: 'unavailable', reason: 'native-handle-unavailable', agentSessionId: 'refused', previousRun: control.run, evidence: { kind: 'run-ended', state: 'exited', observedAt: now } })
    await initialize()
    expect(store.getState().sessions.map(value => value.id)).toEqual(['refused'])
    expect(Object.keys(store.getState().tabs)).toEqual(['tab-refused'])
    expect(store.getState().sessions[0]?.status.continuityReason).toBe('native-handle-unavailable')
    expect(store.getState().sessions[0]?.processState).toBe('exited')
    expect(store.getState().error).toContain('retired')
  })
})
