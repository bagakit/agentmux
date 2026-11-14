// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerSession, composerConfig } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { SessionPane } from '../src/renderer/src/components/SessionPane'

// The original Store, SessionPane and hidden AgentSessionComposer remain mounted.
// Terminal bytes and the rich editor/mailbox presentation are controlled leaves.
vi.mock('@agentmux/client-ui/components/AgentComposer', () => ({
  AgentComposer: ({ value }: { value: string }) => createElement('output', { 'data-draft': true }, value)
}))
vi.mock('../src/renderer/src/components/SessionMailbox', () => ({
  SessionMailbox: ({ children }: ComponentProps<typeof import('../src/renderer/src/components/SessionMailbox').SessionMailbox>) => children?.(null, null, { current: null })
}))
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ session }: { session: SessionSnapshot }) => createElement('output', {
    'data-original-run': session.control.run.runId, 'data-status': session.status.state, 'data-clock': session.status.observedAt
  })
}))

type ProcessEvent = Extract<RuntimeEvent['event'], { type: 'process-state' }>
const original = useAppStore.getState(), draft = 'Original unsent input 中'
let session: ReturnType<typeof composerSession>, other: ReturnType<typeof composerSession>, root: Root, host: HTMLDivElement
const current = () => useAppStore.getState().sessions[0]!
const observation = (target: SessionSnapshot = session, changes: Partial<ProcessEvent> = {}, hostId = target.hostId): RuntimeEvent => ({
  type: 'core', hostId, event: { type: 'process-state', ...(target.kind === 'agent' ? { agentSessionId: target.control.agentSessionId } : {}),
    run: target.control.run, state: 'running', pid: 1, evidence: { source: 'run-process', observedAt: 1, run: target.control.run }, ...changes }
})
const apply = (changes: Partial<ProcessEvent> = {}) => useAppStore.getState().applyEvent(observation(session, changes))
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  session = { ...composerSession('retained-original'),
    completedInteractionResponse: { requestId: 'original-request', operationId: 'original-typed-response', acknowledged: true } }
  other = composerSession('unrelated-original')
  useAppStore.setState({ config: composerConfig, sessions: [session, other], timelines: {}, agentNames: {},
    agentComposerDrafts: { [session.id]: draft }, agentSteerQueues: {}, recoveryCandidates: [],
    viewModes: { [session.id]: 'terminal' }, pendingAgentLaunches: {}, runtimeEndpointWarnings: [] })
  host = document.body.appendChild(document.createElement('div')); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); useAppStore.setState(original, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function mount() {
  await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false}
    visible={false} linkOrigin={{ workspaceId: 'workspace' }} />))
  expect(host.querySelector('[data-draft]')?.textContent).toBe(draft)
  expect(host.querySelector('[data-original-run]')?.getAttribute('data-original-run')).toBe(session.control.run.runId)
}
it('100 identical process observations retain the original Store and hidden Pane/Composer without commits', async () => {
  await mount()
  for (const target of [other, session]) {
    const state = useAppStore.getState(), before = rendererPerformance.snapshot().consumers
    let replacements = 0
    const off = useAppStore.subscribe((next, previous) => { if (next.sessions !== previous.sessions) replacements++ })
    try { for (let n = 0; n < 100; n++) await act(async () => useAppStore.getState().applyEvent(observation(target))) }
    finally { off() }
    const after = rendererPerformance.snapshot().consumers
    expect(replacements).toBe(0); expect(useAppStore.getState()).toBe(state)
    for (const consumer of ['composer', 'sessionPane'] as const) {
      expect(after[consumer].hidden.commits - before[consumer].hidden.commits, consumer + ' repeated-fact commits').toBe(0)
      expect(after[consumer].hidden.checks - before[consumer].hidden.checks, consumer + ' repeated-fact checks').toBe(0)
    }
  }
  expect(current()).toBe(session); expect(current().control).toBe(session.control)
  expect(Reflect.get(current(), 'completedInteractionResponse')).toBe(session.completedInteractionResponse)
  expect(host.querySelector('[data-draft]')?.textContent).toBe(draft)
})
it('a fresh same-state process observation reaches the original mounted consumer and retains its draft and Run', async () => {
  await mount(); const before = rendererPerformance.snapshot().consumers
  await act(async () => apply({ evidence: { source: 'run-process', observedAt: 2, run: session.control.run } }))
  expect(current().updatedAt).toBe(2); expect(current().status.observedAt).toBe(2)
  expect(host.querySelector('[data-original-run]')?.getAttribute('data-clock')).toBe('2')
  expect(rendererPerformance.snapshot().consumers.sessionPane.hidden.commits).toBeGreaterThan(before.sessionPane.hidden.commits)
  expect(current().control).toBe(session.control); expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe(draft)
  expect(Reflect.get(current(), 'completedInteractionResponse')).toBe(session.completedInteractionResponse)
  const accepted = useAppStore.getState(); await act(async () => apply({ evidence: { source: 'run-process', observedAt: 2, run: session.control.run } }))
  expect(useAppStore.getState()).toBe(accepted)
})
it.each(['working', 'waiting', 'blocked', 'done'] as const)('fresh running evidence preserves authoritative native %s while updating its clock', state => {
  const status = { state, source: 'native-hook' as const, observedAt: 1, detail: 'Original native fact' }
  session = { ...session, status }; useAppStore.setState({ sessions: [session, other] })
  apply({ evidence: { source: 'run-process', observedAt: 2, run: session.control.run } })
  expect(current().status).toBe(status); expect(current().updatedAt).toBe(2); expect(current().processState).toBe('running')
  expect(current().control).toBe(session.control); expect(Reflect.get(current(), 'capabilities')).toBe(session.capabilities)
  const accepted = useAppStore.getState(); apply({ evidence: { source: 'run-process', observedAt: 2, run: session.control.run } })
  expect(useAppStore.getState()).toBe(accepted)
})
it('same-clock exit signal/code/reason changes and their removal remain observable', () => {
  apply({ state: 'exited', exitCode: 1, exitSignal: 'SIGSEGV', exitReason: 'crashed' })
  expect(current().processState).toBe('exited'); expect(current().status).toMatchObject({ state: 'error', detail: 'signal SIGSEGV', exitCode: 1, exitReason: 'crashed' })
  const crashed = current(); apply({ state: 'exited', exitCode: 0, exitReason: 'user-stopped' })
  expect(current()).not.toBe(crashed); expect(current().status).toMatchObject({ state: 'exited', exitCode: 0, exitReason: 'user-stopped' }); expect(current().status).not.toHaveProperty('detail')
  apply({ state: 'exited' }); expect(current().status).not.toHaveProperty('exitCode'); expect(current().status).not.toHaveProperty('exitReason')
  const accepted = useAppStore.getState(); apply({ state: 'exited' }); expect(useAppStore.getState()).toBe(accepted)
  expect(current().control).toBe(session.control); expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe(draft)
})
it('same-clock interruption reason changes, optional clearing and unobserved recovery are genuine facts', () => {
  apply({ state: 'interrupted', interruptionReason: 'daemon_restart' })
  expect(current().interruptionReason).toBe('daemon_restart'); expect(current().status.detail).toBe('The Runtime restarted and interrupted this Run.')
  apply({ state: 'interrupted' }); expect(current()).not.toHaveProperty('interruptionReason')
  expect(current().status.detail).toBe('The Run was interrupted; the cause was not reported.')
  session = { ...session, runUnobserved: true }; Object.defineProperty(session, 'interruptionReason', { value: undefined, enumerable: true })
  useAppStore.setState({ sessions: [session, other] }); apply()
  expect(current()).not.toHaveProperty('runUnobserved'); expect(current()).not.toHaveProperty('interruptionReason')
  const accepted = useAppStore.getState(); apply(); expect(useAppStore.getState()).toBe(accepted)
})
it('an unchanged ended-Run Session still clears its live tool independently and preserves the continuity failure', () => {
  session = { ...session, processState: 'exited', status: { state: 'error', source: 'run-process', observedAt: 1,
    continuity: 'conflict', continuityConflict: 'session-run-changed', detail: 'Original Run changed during recovery' } }
  const timeline = { agentSessionId: session.id, revision: 1, items: [], liveTool: { itemId: 'tool', hostId: session.hostId,
    runId: session.control.run.runId, epoch: 1, observedAt: 1, startedAt: 1 } }
  useAppStore.setState({ sessions: [session, other], timelines: { [session.id]: timeline } })
  const before = useAppStore.getState(); apply({ state: 'exited' })
  expect(current()).toBe(session); expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().timelines[session.id]).not.toHaveProperty('liveTool')
  expect(useAppStore.getState().timelines[session.id]?.items).toBe(timeline.items)
  expect(current().status).toMatchObject({ continuity: 'conflict', continuityConflict: 'session-run-changed', detail: 'Original Run changed during recovery' })
  const accepted = useAppStore.getState(); apply({ state: 'exited' }); expect(useAppStore.getState()).toBe(accepted)
  apply(); expect(current().status).not.toHaveProperty('continuity'); expect(current().processState).toBe('running')
})
it('stale evidence and a different Host or Run retain the original state and capabilities', () => {
  const state = useAppStore.getState()
  for (const event of [observation(session, {}, 'other-host'), observation(session, { run: { runId: 'other-run' } }),
    observation(session, { evidence: { source: 'run-process', observedAt: 0, run: session.control.run } })]) {
    useAppStore.getState().applyEvent(event); expect(useAppStore.getState()).toBe(state)
  }
  expect(current().control).toBe(session.control); expect(Reflect.get(current(), 'capabilities')).toBe(session.capabilities)
})
it('terminal process facts without an Agent identity retain equal projections and deliver real interruption and recovery', () => {
  const terminal: SessionSnapshot = { id: 'terminal-run', kind: 'terminal', providerId: null, hostId: session.hostId,
    workspacePath: session.workspacePath, label: 'Original terminal', createdAt: 1, updatedAt: 1, latestOutputBytes: 0,
    processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 },
    control: { kind: 'terminal', hostId: session.hostId, runId: 'terminal-run', run: { runId: 'terminal-run' } } }
  useAppStore.setState({ sessions: [terminal, session] })
  const state = useAppStore.getState(); useAppStore.getState().applyEvent(observation(terminal))
  expect(useAppStore.getState()).toBe(state)
  useAppStore.getState().applyEvent(observation(terminal, { state: 'interrupted', interruptionReason: 'daemon_restart' }))
  expect(current().interruptionReason).toBe('daemon_restart'); expect(current().processState).toBe('interrupted')
  useAppStore.getState().applyEvent(observation(terminal)); expect(current()).not.toHaveProperty('interruptionReason')
  expect(current().processState).toBe('running'); expect(current().control).toBe(terminal.control)
  expect(useAppStore.getState().sessions[1]).toBe(session)
})
