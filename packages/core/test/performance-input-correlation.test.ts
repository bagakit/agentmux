import { expect, it, vi } from 'vitest'
import { createInputPerformanceRecorder, readInputObservation, sanitizeInputObservationArguments } from '../src/performance-diagnostics.js'
import { createRendererPerformance } from '../../../apps/desktop/src/renderer/src/lib/renderer-performance'
const inputOutcome = (request: Promise<unknown>) => request.then(() => ({ ok: true }), error => ({ ok: false, error }))

import { correlationParent, flushInput, inputCorrelationCore, inputDeferred } from './helpers/input-correlation.js'

it('uses fixed bounded detached local facts, snapshot ages, source-qualified duplicates and unknown omission coverage', async () => {
  let ms = 0
  const recorder = createInputPerformanceRecorder(() => ms, () => 10_000 - ms)
  const parent = correlationParent(), sender = { webContentsId: 12, window: { windowId: 4, webContentsId: 12, generation: 2 } }
  const first = recorder.begin({ sessionId: 'session', runId: 'original', kind: 'user', bytes: 3, hostId: 'host', parent, sender, stage: 'received' })
  first.executionOwner('daemon')
  ms = 20; await first.measure('connected-client', async () => { ms = 50 })
  first.stage('queued'); ms = 80; first.dequeue()
  await first.measure('operation', async () => { ms = 100; await first.measure('native-input', async () => { ms = 125 }) })
  let snapshot = recorder.snapshot()
  expect(snapshot.oldestPendingMs).toBe(125)
  expect(snapshot.active[0]).toMatchObject({ hostId: 'host', ownerInstanceId: 'daemon', parentMatch: 'unique', totalMs: 125,
    phases: { 'connected-client': 30, queued: 30, operation: 45, 'native-input': 25 } })
  snapshot.active[0]!.parent!.sequence = 999; snapshot.active[0]!.sender!.window!.generation = 999
  snapshot.active[0]!.phases.queued = 999; parent.sequence = 999; sender.window.generation = 999
  expect(recorder.snapshot().active[0]).toMatchObject({ parent: correlationParent(), sender: { window: { generation: 2 } }, phases: { queued: 30 } })
  const duplicate = recorder.begin({ sessionId: 'session', runId: 'other-run', kind: 'user', bytes: 1, parent: correlationParent() })
  const differentSource = recorder.begin({ sessionId: 'session', runId: 'original', kind: 'protocol', bytes: 1, parent: correlationParent('protocol') })
  expect(recorder.snapshot().active.map(entry => entry.parentMatch)).toEqual(['ambiguous', 'ambiguous', 'unique'])
  duplicate.settle(true); differentSource.settle(true); first.settle(true)
  expect(recorder.snapshot().oldestPendingMs).toBeNull()
  const pending = Array.from({ length: 65 }, (_, i) => recorder.begin({ sessionId: null, runId: `r-${i}`, kind: 'terminal', bytes: 0, parent: correlationParent('paste', i + 1) }))
  ms = 200
  snapshot = recorder.snapshot()
  expect(snapshot).toMatchObject({ pending: 65, omittedActive: 1, oldestPendingMs: null })
  expect(snapshot.active).toHaveLength(64)
  expect(snapshot.active.every(entry => entry.parentMatch === 'unknown-omitted')).toBe(true)
  pending.forEach(handle => handle.settle(true))
  snapshot = recorder.snapshot()
  expect(snapshot.recent).toHaveLength(32); expect(snapshot.omittedRecent).toBe(36)
  expect(snapshot.recent.every(entry => entry.parentMatch === 'unknown-omitted')).toBe(true)
})

it('optional reference parser never invokes getters and rejects malformed identity/source/sequence without touching business data', () => {
  const valid = correlationParent()
  expect(readInputObservation(valid)).toEqual(valid)
  for (const invalid of [null, { ...valid, observerId: 'wrong' }, { ...valid, source: 'semantic' }, { ...valid, sequence: 0 },
    { ...valid, sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, extra: 1 }, Object.defineProperty({}, 'observerId', { get() { throw new Error('must not run') } })]) {
    expect(readInputObservation(invalid)).toBeNull()
  }
  const input = Object.defineProperty({ agentSessionId: 'session', data: 'original' }, 'observation', { enumerable: true, get() { throw new Error('must not run') } })
  expect(sanitizeInputObservationArguments('writeAgent', [input])).toEqual([{ agentSessionId: 'session', data: 'original' }])
  expect(sanitizeInputObservationArguments('submitAgentPrompt', [input])[0]).toBe(input)
})

it('reserves before dispatch with per-source sequence and recorder nonce; failed nonce leaves request settlement available', async () => {
  let ms = 0, nonceCalls = 0
  const renderer = createRendererPerformance(() => ms, () => 100, () => { nonceCalls++; return correlationParent().observerId })
  const target = { hostId: 'local', sessionId: 'session', runId: 'original' }
  const one = renderer.beginInputRequest('user', ms, target), two = renderer.beginInputRequest('protocol', ms, target)
  const three = renderer.beginInputRequest('user', ms, target)
  expect(one.parent).toEqual(correlationParent()); expect(two.parent).toEqual(correlationParent('protocol'))
  expect(three.parent).toEqual(correlationParent('user', 2)); expect(nonceCalls).toBe(1)
  const rebuilt = createRendererPerformance(() => ms, () => 100, () => '22222222-2222-4222-8222-222222222222')
  expect(rebuilt.beginInputRequest('user', ms, target).parent?.observerId).not.toBe(one.parent?.observerId)
  const pending = inputDeferred(); one.observe(pending.promise); one.observe(pending.promise)
  ms = 40; expect(renderer.snapshot().inputRequestDetails.oldestPendingMs).toBe(40)
  pending.resolve(); await flushInput()
  expect(renderer.snapshot().inputRequests.user).toMatchObject({ started: 2, completed: 1, pending: 1 })
  expect(renderer.snapshot().inputRequestDetails).toMatchObject({ started: 3, completed: 1, pending: 2 })
  const noNonce = createRendererPerformance(() => ms, () => 100, () => { throw new Error('crypto unavailable') })
  const request = noNonce.beginInputRequest('paste', ms, target)
  expect(request.parent).toBeUndefined()
  request.observe(Promise.resolve()); await flushInput()
  expect(noNonce.snapshot().inputRequestDetails).toMatchObject({ completed: 1, pending: 0, recent: [{ parent: null, parentMatch: 'absent' }] })
})

it('actual Core FIFO keeps parent tied to original Run and captures the actual native owner after queued connection change', async () => {
  const f = await inputCorrelationCore()
  f.gates.status = inputDeferred(); f.gates.native = inputDeferred()
  try {
    const request = { agentSessionId: 'private-agent', expectedRun: { runId: 'original' }, source: 'user' as const }
    const a = f.core.writeAgent({ ...request, data: 'first', observation: correlationParent() })
    const b = f.core.writeAgent({ ...request, data: 'second', observation: correlationParent('user', 2) })
    await flushInput()
    expect((await f.core.clientPerformanceDiagnostics()).input.active.map(entry => [entry.parent?.sequence, entry.stage])).toEqual([[1, 'current-run'], [2, 'queued']])
    f.changeDaemon('current-daemon'); f.gates.status.resolve(); await flushInput()
    expect((await f.core.clientPerformanceDiagnostics()).input.active[0]).toMatchObject({ stage: 'native-input', ownerInstanceId: 'current-daemon', hostId: 'local', parent: correlationParent() })
    f.gates.native.resolve(); await Promise.all([a, b])
    expect(f.input.mock.calls.map(([run, op]) => [run, op.data, op.expectedByte, op.ownerInstanceId])).toEqual([
      ['original', 'first', 0, 'current-daemon'], ['original', 'second', 5, 'current-daemon']])
    expect(f.input.mock.calls.every(([, op]) => !('observation' in op) && !('parent' in op))).toBe(true)
    let failure: unknown
    try { await f.core.writeAgent({ ...request, data: 'failure', observation: correlationParent('user', 3) }) } catch (error) { failure = error }
    expect(failure).toBe(f.originalError)
    const changed = await f.core.writeAgent({ ...request, expectedRun: { runId: 'wrong' }, data: 'untouched', observation: correlationParent() }).then(() => null, error => error)
    expect(changed).toMatchObject({ code: 'STALE_AGENT_SESSION' }); expect(f.input).toHaveBeenCalledTimes(3)
    expect((await f.core.clientPerformanceDiagnostics()).input.recent.at(-1)).toMatchObject({ parent: correlationParent('user', 3), result: 'failed', stage: 'native-input' })
    const terminalOperation = { ownerInstanceId: 'original-operation-owner', operationId: 'original-terminal-operation', expectedByte: 11, data: 'failure' }
    const terminalFailure = await f.core.writeTerminal({ runId: 'original' }, terminalOperation, correlationParent('protocol', 2)).then(() => null, error => error)
    expect(terminalFailure).toBe(f.originalError)
    expect(f.input.mock.calls.at(-1)![1]).toBe(terminalOperation)
    expect((await f.core.clientPerformanceDiagnostics()).input.recent.at(-1)).toMatchObject({ ownerInstanceId: 'original-operation-owner', parent: correlationParent('protocol', 2), result: 'failed' })
  } finally { await f.dispose() }
})

it.each(['bigint', 'cycle', 'getter', 'marker'] as const)('actual Hosted encoder discards bad optional %s while preserving original Agent and terminal bytes', async variant => {
  const f = await inputCorrelationCore()
  try {
    const cycle: any = {}; cycle.self = cycle
    const invalid = variant === 'bigint' ? 1n : variant === 'cycle' ? cycle : variant === 'marker' ? { $agentmuxValue: 'invalid-marker' } : null
    const input: any = { agentSessionId: 'private-agent', expectedRun: { runId: 'original' }, source: 'terminal-protocol', data: Uint8Array.of(128, 255) }
    if (variant === 'getter') Object.defineProperty(input, 'observation', { enumerable: true, get() { throw new Error('optional getter must not execute') } })
    else input.observation = invalid
    expect(await inputOutcome(f.hosted.writeAgent(input))).toEqual({ ok: true })
    expect(await inputOutcome(f.hosted.writeTerminal({ runId: 'original' }, { ownerInstanceId: 'controlled-daemon', operationId: 'terminal', expectedByte: 2, data: 'terminal' }, invalid as any))).toEqual({ ok: true })
    expect(f.input.mock.calls.map(([, op]) => op.data)).toEqual([Uint8Array.of(128, 255), 'terminal'])
    expect((await f.core.clientPerformanceDiagnostics()).input.recent.map(entry => entry.parent)).toEqual([null, null])
  } finally { await f.dispose() }
})

it('actual Hosted strict receiver drops corrupt optional markers before decoding but retains rejection of corrupt business fields', async () => {
  const f = await inputCorrelationCore()
  try {
    const business = { agentSessionId: 'private-agent', expectedRun: { runId: 'original' }, data: 'safe', source: 'user' }
    const malformedWireRecord = { $agentmuxValue: 'record', entries: [['missing-value']] }
    expect(await inputOutcome(f.rawInvoke('writeAgent', [{ ...business, observation: malformedWireRecord }]))).toEqual({ ok: true })
    expect(await inputOutcome(f.rawInvoke('writeAgent', [{ $agentmuxValue: 'record', entries: [...Object.entries(business), ['observation', malformedWireRecord]] }]))).toEqual({ ok: true })
    expect(await inputOutcome(f.rawInvoke('writeTerminal', [{ runId: 'original' }, { ownerInstanceId: 'controlled-daemon', operationId: 'raw-terminal', expectedByte: 8, data: 't' }, malformedWireRecord]))).toEqual({ ok: true })
    expect(f.input.mock.calls.map(([, op]) => op.data)).toEqual(['safe', 'safe', 't'])
    expect((await f.core.clientPerformanceDiagnostics()).input.recent.every(entry => entry.parent === null)).toBe(true)
    const failed = await f.rawInvoke('writeAgent', [{ ...business, data: malformedWireRecord, observation: correlationParent() }]).then(() => null, error => error)
    expect(failed).toBeInstanceOf(Error)
    expect(f.input).toHaveBeenCalledTimes(3)
    await f.hosted.writeAgent({ ...business, source: 'user', observation: correlationParent() })
    expect((await f.core.clientPerformanceDiagnostics()).input.recent.at(-1)).toMatchObject({ parent: correlationParent(), parentMatch: 'unique' })
  } finally { await f.dispose() }
})


it('late settlement retains the original execution instance and duplicate label instead of adopting the next request owner', async () => {
  const f = await inputCorrelationCore(); f.gates.native = inputDeferred()
  try {
    const input = { agentSessionId: 'private-agent', expectedRun: { runId: 'original' }, source: 'user' as const, observation: correlationParent() }
    const one = f.core.writeAgent({ ...input, data: 'old' }); await flushInput()
    expect((await f.core.clientPerformanceDiagnostics()).input.active[0]).toMatchObject({ stage: 'native-input', ownerInstanceId: 'controlled-daemon' })
    f.changeDaemon('replacement-daemon')
    const two = f.core.writeAgent({ ...input, data: 'new' }); await flushInput()
    expect((await f.core.clientPerformanceDiagnostics()).input.active.every(entry => entry.parentMatch === 'ambiguous')).toBe(true)
    f.gates.native.resolve(); await Promise.all([one, two])
    expect((await f.core.clientPerformanceDiagnostics()).input.recent.map(entry => [entry.ownerInstanceId, entry.parentMatch])).toEqual([
      ['controlled-daemon', 'ambiguous'], ['replacement-daemon', 'ambiguous']])
    expect(f.input.mock.calls.map(([, operation]) => operation.ownerInstanceId)).toEqual(['controlled-daemon', 'replacement-daemon'])
  } finally { await f.dispose() }
})


it('actual Hosted codec preserves reserved-key business records while stripping only bad optional metadata before encode', async () => {
  const f = await inputCorrelationCore(), observed = vi.spyOn(f.core, 'writeAgent')
  try {
    let markerReads = 0
    const entries = [['business', 'retained'], ['observation', 'ordinary nested business data']]
    const input = Object.defineProperty({ agentSessionId: 'private-agent', expectedRun: { runId: 'original' }, data: 'reserved-safe', source: 'user', entries, observation: 1n },
      '$agentmuxValue', { enumerable: true, get() { markerReads++; return 'record' } })
    expect(await inputOutcome(f.hosted.writeAgent(input as never))).toEqual({ ok: true })
    expect(markerReads).toBe(1)
    expect(observed.mock.calls[0]![0]).toMatchObject({ $agentmuxValue: 'record', entries, data: 'reserved-safe' })
    expect(Object.hasOwn(observed.mock.calls[0]![0], 'observation')).toBe(false)
    expect(f.input.mock.calls.map(([, operation]) => operation.data)).toEqual(['reserved-safe'])
    expect((await f.core.clientPerformanceDiagnostics()).input.recent[0]).toMatchObject({ parent: null })
    const ordinaryReservedRecord = { $agentmuxValue: 'record', agentSessionId: 'private-agent', expectedRun: { runId: 'original' }, data: 'data-property-safe', source: 'user', entries, observation: 1n }
    expect(await inputOutcome(f.hosted.writeAgent(ordinaryReservedRecord as never))).toEqual({ ok: true })
    expect(observed.mock.calls[1]![0]).toMatchObject({ $agentmuxValue: 'record', entries, data: 'data-property-safe' })
    expect(Object.hasOwn(observed.mock.calls[1]![0], 'observation')).toBe(false)
    expect(f.input.mock.calls.map(([, operation]) => operation.data)).toEqual(['reserved-safe', 'data-property-safe'])
  } finally { await f.dispose() }
})
