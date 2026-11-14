// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import type { AgentMuxAgentSession, AgentMuxNativeService } from '@agentmux/core'
import { DEFAULT_AGENT_CONTINUITY_POLICY, type AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import { useAppStore } from '../src/renderer/src/store'
import { runServiceProjection, useRunService } from '../src/renderer/src/lib/run-service-projection'
import { composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'

const initial = useAppStore.getState()
let root: Root, host: HTMLDivElement
const registry = new FinalizationRegistry<{ collected: boolean }>(observation => { observation.collected = true })
const pause = () => new Promise(resolve => setTimeout(resolve, 15))
async function collect() { for (let n = 0; n < 20; n++) { globalThis.gc!(); await pause() } }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  runServiceProjection.clear()
  host = document.body.appendChild(document.createElement('div')); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  runServiceProjection.clear(); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function service(revision: number, pressured = false): AgentMuxNativeService {
  return { revision, owner: { type: 'serving' }, output: pressured ? { type: 'backpressured' } : { type: 'serving' },
    input: { phase: { type: 'open' }, unsettledCommands: 0, unsettledRequestBytes: 0, writeBlocked: false,
      completedInputBytes: 5, currentSize: { cols: 80, rows: 24 }, activeConfirmedBytes: 0 }, terminalFault: null }
}
function CurrentService() {
  const session = useAppStore(state => state.sessions[0]), current = useRunService(session)
  return <output data-run={session?.control.run.runId} data-clock={session?.kind === 'agent' ? session.agentSessionUpdatedAt : undefined}
    data-pressure={current?.output.type}>{current?.revision ?? 'unknown'}</output>
}
function event(revision: number, runId: string, pressured = false) {
  return { type: 'core' as const, hostId: 'local', event: { type: 'run-service' as const, agentSessionId: 'reader-original',
    run: { runId }, nativeService: service(revision, pressured), evidence: { source: 'run-process' as const, observedAt: revision, run: { runId } } } }
}
it('the mounted reader keeps same-key subscription and current seeds, while old handed-out readers keep their original Run', async () => {
  const original = { ...composerSession('reader-original'), nativeService: service(1) }, makeReader = runServiceProjection.reader,
    originalSubscribe = runServiceProjection.subscribe, registrations = { started: 0, stopped: 0 }
  const observe = (subscribe: (listener: () => void) => () => void) => (listener: () => void) => {
    registrations.started++
    const stop = subscribe(listener)
    return () => { registrations.stopped++; stop() }
  }
  // Observe both existing Session-based callers and the hook's key reader. An
  // owner-retention inverse must still run these behavior assertions normally.
  vi.spyOn(runServiceProjection, 'subscribe').mockImplementation((session, listener) => observe(originalSubscribe.bind(null, session))(listener))
  vi.spyOn(runServiceProjection, 'reader').mockImplementation(session => {
    const reader = makeReader(session)
    return { ...reader, subscribe: observe(reader.subscribe) }
  })
  const oldReader = makeReader(original)
  useAppStore.setState({ sessions: [original] })
  await act(async () => root.render(<CurrentService />))
  const node = host.querySelector('output')
  expect(node?.textContent).toBe('1'); expect(registrations).toEqual({ started: 1, stopped: 0 })
  await act(async () => useAppStore.setState({ sessions: [{ ...original, nativeService: service(2, true) }] }))
  expect(host.querySelector('output')).toBe(node); expect(node?.textContent).toBe('2')
  expect(node?.getAttribute('data-pressure')).toBe('backpressured')
  expect(registrations).toEqual({ started: 1, stopped: 0 })
  await act(async () => useAppStore.setState({ sessions: [{ ...original, nativeService: service(1) }] }))
  expect(node?.textContent).toBe('2')
  const moved = { ...original, nativeService: service(1), control: { ...original.control, run: { runId: 'reader-next-run' } } }
  await act(async () => useAppStore.setState({ sessions: [moved] }))
  const nextReader = makeReader(moved)
  expect(registrations).toEqual({ started: 2, stopped: 1 }); expect(runServiceProjection.read(original)).toBeNull()
  expect(oldReader.snapshot()).toBe(0); expect(runServiceProjection.apply(event(4, original.control.run.runId))).toBe(false)
  const oldListener = vi.fn(), nextVersion = nextReader.snapshot()
  const stopOld = oldReader.subscribe(oldListener)
  expect(runServiceProjection.read(original)?.revision).toBe(1)
  await act(async () => { expect(runServiceProjection.apply(event(4, original.control.run.runId, true))).toBe(true) })
  expect(oldListener).toHaveBeenCalledTimes(2) // Original seed, then the exact old Run's health event.
  expect(nextReader.snapshot()).toBe(nextVersion); expect(node?.getAttribute('data-run')).toBe('reader-next-run')
  stopOld(); expect(runServiceProjection.read(original)).toBeNull()
  await act(async () => root.render(null)); expect(runServiceProjection.read(moved)).toBeNull()
  expect(registrations).toEqual({ started: 2, stopped: 2 })
})
it('the actual reader preserves unknown and mismatched Host qualification without admitting a service seed', async () => {
  useAppStore.setState({ sessions: [] })
  await act(async () => root.render(<CurrentService />)); expect(host.textContent).toBe('unknown')
  const original = { ...composerSession('reader-original'), hostId: 'different-host', nativeService: service(99) }
  await act(async () => useAppStore.setState({ sessions: [original] }))
  expect(host.textContent).toBe('unknown'); expect(runServiceProjection.read(original)).toBeNull()
  expect(runServiceProjection.apply(event(100, original.control.run.runId))).toBe(false)
})
function seedObsoleteInput() {
  const session = { ...composerSession('reader-original'), nativeService: service(1) }
  const key = { kind: 'message' as const, agentSessionId: session.id, expectedRun: session.control.run, messageId: 'reader-original-message' }
  const continuity: AgentMuxContinuityOperation = { operationId: 'reader-original-operation', agentSessionId: session.id, trigger: 'startup',
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: session.control.run, admittedAt: 1, observedAt: 2, rechecks: 0,
    kind: 'pending', reason: 'operation-unconfirmed', evidence: { kind: 'run-running', observedAt: 2 },
    messageInput: { ref: { key, waitGeneration: 1 }, key, admissionIntent: { kind: 'session-conversation', expectedRun: session.control.run },
      prompt: 'Original reader input', message: { userContent: 'Original reader complete body'.repeat(40000), authorHuman: true },
      lifecycleOperationId: 'reader-original-lifecycle' } }
  const core: AgentMuxAgentSession = { kind: 'agent', agentSessionId: session.id, providerId: session.providerId, executorId: session.executorId,
    hostId: session.hostId, workspacePath: session.workspacePath, run: session.control.run, retiredRuns: [], createdAt: 1, updatedAt: 2, continuity }
  useAppStore.setState({ sessions: [session], timelines: {}, pendingAgentLaunches: {}, recoveryCandidates: [],
    agentComposerDrafts: { [session.id]: 'Keep original reader draft' }, runtimeEndpointWarnings: [] })
  useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: { type: 'agent-session', session: core } })
  const owned = useAppStore.getState().sessions[0]!, observation = { collected: false }
  if (owned.kind !== 'agent' || !owned.continuity?.messageInput) throw Error('The actual Store must own the original input')
  registry.register(owned.continuity.messageInput.message, observation)
  const { continuity: _continuity, ...clear } = core
  return { session, observation, clear }
}
it('the original mounted reader retains current input and releases a retired Session graph after real Store clears', async () => {
  expect(globalThis.gc, 'Collection runs only in an isolated test fork').toBeTypeOf('function')
  const trace = Error.stackTraceLimit; Error.stackTraceLimit = 0
  try {
    const { session, observation, clear } = seedObsoleteInput()
    await act(async () => root.render(<CurrentService />))
    const node = host.querySelector('output')
    await collect(); expect(observation.collected, 'The original Store still owns its current pending input').toBe(false)
    for (let n = 0; n < 5; n++) await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId,
      event: { type: 'agent-session', session: { ...clear, updatedAt: 3 + n } } }))
    expect(host.querySelector('output')).toBe(node); expect(node?.getAttribute('data-clock')).toBe('7')
    expect(useAppStore.getState().sessions[0]?.control).toEqual(session.control)
    expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep original reader draft')
    await collect(); expect(observation.collected, 'The mounted key reader must release the retired Session input').toBe(true)
  } finally { Error.stackTraceLimit = trace }
})
