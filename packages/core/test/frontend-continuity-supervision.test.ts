import { fixtureEpoch as _tailFixtureEpoch, fixturePath as _tailFixturePath } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionContinuitySupervisor as SourceSupervisor } from '../src/agent-session-recovery/supervisor.js'
const AgentSessionContinuitySupervisor: typeof SourceSupervisor = process.env.AGENTMUX_TEST_FRONTEND_SUPERVISOR_ENTRY ? (await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_FRONTEND_SUPERVISOR_ENTRY)).AgentSessionContinuitySupervisor : SourceSupervisor
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '../src/agent-session-recovery/continuity-contract.js'
import type { AgentTerminalFrontend } from '../src/agent-terminal-frontend.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).map(close => close())) })
function fixture(overrides: Partial<AgentTerminalFrontend> = {}) {
  const run = { runId: 'original-running-backend' }, nativeTarget = { kind: 'provider', providerId: 'codex', sessionId: 'original-native' }
  const root: any = { operationId: 'original-root', agentSessionId: 'original-session', trigger: 'startup', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY, retryInitialDelayMs: 5, retryMaxDelayMs: 5 },
    previousRun: { runId: 'old-ended-run' }, newRun: run, nativeTarget, kind: 'resumed', reason: 'interrupted-working', admittedAt: _tailFixtureEpoch(0, 0, 1), observedAt: _tailFixtureEpoch(0, 0, 1), rechecks: 0,
    evidence: { kind: 'run-ended', state: 'exited', observedAt: _tailFixtureEpoch(0, 0, 1) },
    supervision: { phase: 'observing', activeAttemptOperationId: 'original-root', attemptCount: 1, attemptLimit: 3, observedAt: _tailFixtureEpoch(0, 0, 1), reason: 'start-pending' } }
  let current: any = { kind: 'agent', agentSessionId: root.agentSessionId, hostId: 'local', workspacePath: _tailFixturePath("private-workspace"), run, nativeHandle: nativeTarget,
    nativeActor: { frontendControl: true }, continuity: root, continuityOperations: { [root.operationId]: root } }
  let frontend: AgentTerminalFrontend = { run, frontendId: 'first-tui', state: 'detached', backendState: 'running', source: 'managed-process', observedAt: _tailFixtureEpoch(0, 0, 2), exitCode: 23, ...overrides }
  const perform = vi.fn(async (input: any) => {
    processState = { type: 'running' }
    const attempt = current.continuityOperations[input.operationId]
    attempt.kind = 'reattachable'; attempt.reason = 'frontend-reconnected'
    attempt.frontendReconnect = { previousFrontendId: frontend.frontendId, frontendId: 'second-tui', outputAfterByte: 100 }
    current.continuity = attempt
    frontend = { ...frontend, frontendId: 'second-tui', state: 'attached', observedAt: _tailFixtureEpoch(0, 0, 3) }
    current.terminalHandshake = { run, frontendId: 'second-tui', acknowledged: true }
    supervisor.observe(current)
    return { kind: 'reattachable', session: current, previousRun: run, run, evidence: { kind: 'run-running', observedAt: _tailFixtureEpoch(0, 0, 3) } } as any
  })
  let lifecycle:any=null
  let processState: any = { type: 'running' }
  const readers: Array<{ changed: () => void; close: ReturnType<typeof vi.fn> }> = []
  const update = vi.fn(async (_session: any, change: any) => { current = change(current); return current })
  const status = vi.fn(async () => ({ runId: current.run.runId, workspacePath: current.workspacePath, state: processState }) as any)
  const supervisor = new AgentSessionContinuitySupervisor({ read: async () => current, lifecycle: async () => lifecycle, status,
    frontend: async () => frontend, watch: async (_run, changed) => {
      const close = vi.fn(async () => {}); readers.push({ changed, close }); return close
    }, update, perform, failed: (_id, error) => { throw error } })
  cleanup.push(() => supervisor.dispose())
  return { supervisor, perform, status, update, readers, root: () => current.continuityOperations[root.operationId], current: () => current,
    exit: (code: number | null, signal: string | null = null) => { processState = { type: 'exited', code, signal }; readers.at(-1)?.changed() },
    setFrontend: (value: Partial<AgentTerminalFrontend>) => { frontend = { ...frontend, ...value }; supervisor.observe(current, true) },
    stop: () => { lifecycle={kind:'stop',expectedRun:run} }, setLimit: (value: number) => { root.supervision.attemptLimit = value }, start: () => supervisor.observe(current) }
}
it('retries a failed frontend through the original intent on the same live Run without an input', async () => {
  const f = fixture(); f.start()
  await vi.waitFor(() => expect(f.root().supervision.reason).toBe('frontend-attached'))
  expect(f.perform).toHaveBeenCalledOnce()
  expect(f.perform.mock.calls[0]![0]).toMatchObject({ expectedRun: f.current().run, trigger: 'startup' })
  expect(f.perform.mock.calls[0]![0].input).toBeUndefined()
  expect(f.root().supervision).toMatchObject({ attemptCount: 2, reason: 'frontend-attached' })
  expect(f.root().supervision.contextEvidence).toBeUndefined()
  expect(f.current().continuity.recoveryInputs).toEqual({ reminder: '', continuation: '' })
})
it.each([{ state: 'attached' }, { state: 'unknown' }, { exitCode: 0 }, { backendState: 'unknown' }, { run: { runId: 'foreign' } }] as Partial<AgentTerminalFrontend>[])('keeps $state/$exitCode/$backendState observations from authorizing an automatic action', async observation => {
  const f = fixture(observation); f.start()
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.status).toHaveBeenCalled(); expect(f.perform).not.toHaveBeenCalled()
})
it('a native resume with zero retry budget pauses and a new startup can retry without rewriting its old counter', async () => {
  const f = fixture(); f.setLimit(1); f.start()
  await vi.waitFor(() => expect(f.root().supervision.reason).toBe('frontend-retry-budget-exhausted'))
  const before = structuredClone(f.root())
  expect(f.supervisor.retainedAutomaticIntent(f.current(), { agentSessionId: f.current().agentSessionId, expectedRun: f.current().run, operationId: 'new-app-startup', trigger: 'startup' })).toBeUndefined()
  expect(f.root()).toEqual(before); expect(f.perform).not.toHaveBeenCalled()
})
it('does not reactivate a cancelled root for a new startup', async () => {
  const f = fixture(); f.root().supervision.phase = 'cancelled'; f.root().supervision.reason = 'explicit-control'
  expect(f.supervisor.retainedAutomaticIntent(f.current(), { agentSessionId: f.current().agentSessionId, expectedRun: f.current().run, operationId: 'new-startup', trigger: 'startup' })?.operationId).toBe('original-root')
  f.start(); await new Promise(resolve => setTimeout(resolve, 20)); expect(f.perform).not.toHaveBeenCalled()
})
it('keeps an attached frontend observable without forging a scoped ACK; a later exact exit remains recoverable', async () => {
  const f = fixture({ state: 'attached' })
  f.root().kind = 'reattachable'; delete f.root().newRun; f.root().previousRun = f.current().run
  f.root().frontendReconnect = { previousFrontendId: 'old-tui', frontendId: 'first-tui', outputAfterByte: 10 }
  f.current().terminalHandshake = { run: f.current().run, frontendId: 'old-tui', acknowledged: true }
  const originalAck = structuredClone(f.current().terminalHandshake)
  f.start(); await vi.waitFor(() => expect(f.root().supervision.reason).toBe('frontend-attached'))
  expect(f.root().supervision.phase).toBe('observing'); expect(f.perform).not.toHaveBeenCalled()
  expect(f.current().terminalHandshake).toEqual(originalAck); expect(f.root().supervision.contextEvidence).toBeUndefined()
  f.setFrontend({ state: 'detached', exitCode: 31, observedAt: _tailFixtureEpoch(0, 0, 100) })
  await vi.waitFor(() => expect(f.perform).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(f.root().supervision.reason).toBe('frontend-attached'))
})

it('a pending exact Stop closes only its original recovery before a frontend attempt',async()=>{
 const f=fixture();f.stop();f.start();await vi.waitFor(()=>expect(f.root().supervision.phase).toBe('cancelled'));expect(f.perform).not.toHaveBeenCalled()
})
it('unknown frontend actions stay on their original operation after the observation budget ends',async()=>{
 const f=fixture();f.root().kind='pending';f.root().reason='operation-unconfirmed';f.root().rechecks=3;f.root().frontendReconnect={previousFrontendId:'first-tui',outputAfterByte:0};delete f.root().newRun;f.root().previousRun=f.current().run;f.start()
 await vi.waitFor(()=>expect(f.root().supervision.reason).toBe('original-operation-unconfirmed'))
 expect(f.supervisor.retainedAutomaticIntent(f.current(),{agentSessionId:f.current().agentSessionId,expectedRun:f.current().run,operationId:'new-startup',trigger:'startup'})?.operationId).toBe('original-root');expect(f.perform).not.toHaveBeenCalled()
})
it('quiet observation does no extra status work for unrelated Session events',async()=>{
 const f=fixture();f.start();await vi.waitFor(()=>expect(f.root().supervision.reason).toBe('frontend-attached'))
 await new Promise(resolve=>setTimeout(resolve,10));const calls=f.status.mock.calls.length;expect(calls).toBeGreaterThan(0)
 for(let i=0;i<100;i++){f.supervisor.wake('unrelated-session');f.supervisor.observe({...f.current(),agentSessionId:'unrelated-session',continuity:undefined,continuityOperations:{}})}
 await new Promise(resolve=>setTimeout(resolve,10));expect(f.status).toHaveBeenCalledTimes(calls)
})

it.each(['starting', 'unknown'] as const)('keeps an unconfirmed %s frontend quiet while retaining the exact Run lifecycle reader', async state => {
  const f = fixture({ state }); f.start()
  await vi.waitFor(() => expect(f.root().supervision.reason).toBe('provider-unverified'))
  expect(f.root().supervision).toMatchObject({ phase: 'observing', attemptCount: 1, process: { run: f.current().run, state: 'running' } })
  expect(f.readers).toHaveLength(1); expect(f.readers[0]!.close).not.toHaveBeenCalled()
  const writes = f.update.mock.calls.length, reads = f.status.mock.calls.length
  for (let i = 0; i < 5; i++) {
    f.supervisor.wake(f.current().agentSessionId)
    await vi.waitFor(() => expect(f.status.mock.calls.length).toBe(reads + i + 1))
  }
  expect(f.update).toHaveBeenCalledTimes(writes); expect(f.readers).toHaveLength(1)
  expect(f.perform).not.toHaveBeenCalled()
  f.exit(1)
  await vi.waitFor(() => expect(f.perform).toHaveBeenCalledOnce())
  expect(f.root().supervision.attemptCount).toBe(2)
  expect(f.perform.mock.calls[0]![0].input).toBeUndefined()
})

it.each([
  { code: 0, signal: null, phase: 'settled', reason: 'normal-exit' },
  { code: null, signal: 'SIGTERM', phase: 'paused', reason: 'exit-outcome-unverified' }
])('retains an unknown frontend reader without authorizing retry for $reason', async ({ code, signal, phase, reason }) => {
  const f = fixture({ state: 'unknown' }); f.start()
  await vi.waitFor(() => expect(f.root().supervision.reason).toBe('provider-unverified'))
  f.exit(code, signal)
  await vi.waitFor(() => expect(f.root().supervision).toMatchObject({ phase, reason }))
  expect(f.perform).not.toHaveBeenCalled()
})

it('honors an exact Stop and the original budget after an unconfirmed frontend later exits', async () => {
  for (const stopped of [true, false]) {
    const f = fixture({ state: 'starting' }); f.setLimit(1); f.start()
    await vi.waitFor(() => expect(f.root().supervision.reason).toBe('provider-unverified'))
    if (stopped) f.stop()
    f.exit(1)
    await vi.waitFor(() => expect(f.root().supervision.reason).toBe(stopped ? 'user-stop' : 'retry-budget-exhausted'))
    expect(f.perform).not.toHaveBeenCalled()
  }
})

it.each([undefined, { acknowledged: true, run: { runId: 'original-running-backend' } }])('does not pause an attached generation or invent bootstrap evidence from an old unscoped ACK (%j)', async acknowledgement => {
  const f = fixture({ state: 'attached' })
  f.current().terminalHandshake = acknowledgement
  const before = structuredClone(f.current().terminalHandshake)
  f.start(); await vi.waitFor(() => expect(f.root().supervision.reason).toBe('frontend-attached'))
  expect(f.root().supervision.phase).toBe('observing')
  expect(f.current().terminalHandshake).toEqual(before)
  expect(f.root().supervision.contextEvidence).toBeUndefined(); expect(f.perform).not.toHaveBeenCalled()
})
