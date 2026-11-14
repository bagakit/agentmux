import { appendFile, mkdir, readFile, rename, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentProviderSessionStatusObservationContext } from '../src/agent-provider.js'
import { NativeJsonlHistoryReader } from '../src/native-jsonl-history-reader.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxClient } from '../src/client.js'
import { captureExecutorInvocation } from '../src/agent-executor-invocation.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '../src/agent-session-recovery/continuity-contract.js'
import { encodeCwdDirname } from '../../providers/src/grok/native-history.js'
import { readGrokPromptExecutionEvidence, observeGrokSessionStatus } from '../src/providers/grok-session-status.js'
import { grokDone, grokUpdate, grokUser } from './fixtures/grok-updates.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { createGoalRuntime } from '../../../apps/host/src/goal-runtime.js'
import { ContinuousProgressLoopManager } from '../../../apps/host/src/continuous-progress-loop-manager.js'
import { deliverContinuousProgress } from '../../../apps/host/src/continuous-progress-delivery.js'
import type { AgentMuxRpcMethod, AgentMuxRpcParams } from '../src/public-rpc.js'
import type { AgentMuxStoredAgentSession, AgentProviderSessionStatus } from '../src/types.js'

const SID = 'recipient', NATIVE = 'original-grok', TURN = 'original-turn'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { try { for (const close of closes.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const start = (turn = TURN) => grokUser(NATIVE, 'Original input', turn)
const done = (turn = TURN) => grokDone(NATIVE, turn)
async function proof(value: Record<string, unknown>) {
  if (process.env.MOTE_GROK_STATUS_CASE_PROOF) await appendFile(process.env.MOTE_GROK_STATUS_CASE_PROOF, JSON.stringify(value) + '\n')
}

async function fixture(rows: unknown[] = [start(), done()], prepare?: (session: AgentMuxStoredAgentSession, path: string) => AgentMuxStoredAgentSession) {
  const f = await rpcOwnerFixture([SID, 'neighbor'], undefined, () => ({ providerId: 'grok', executorId: 'grok' }),
    () => ({ sessionExecutorConfiguration: async () => { throw Error('A current configuration cannot replace the original environment') } }))
  closes.push(f.close)
  f.inner.kernel.start = vi.fn(async () => { throw Error('No new Run is authorized by this observer') })
  const env = { GROK_HOME: join(f.root, 'original-profile'), HOME: join(f.root, 'original-home'), PRIVATE_SENTINEL: 'original-private-value' }
  const dir = join(env.GROK_HOME, 'sessions', encodeCwdDirname(f.root), NATIVE)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'updates.jsonl'), summary = join(dir, 'summary.json')
  await writeFile(path, jsonl(rows)); await writeFile(summary, JSON.stringify({ info: { id: NATIVE, cwd: f.root } }))
  const before = (await f.store.readMetadata(SID))!, original = captureExecutorInvocation('grok', 'grok', 'original-create', 'b'.repeat(64), { env })!
  const seed = { ...before, hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), nativeHandle: { kind: 'provider' as const, providerId: 'grok', sessionId: NATIVE },
    semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 },
    creation: { createOperationId: 'original-create', initialPrompt: 'not-requested' as const, intentDigest: 'b'.repeat(64), executorInvocationDigest: original.digest }, executorInvocation: original.value }
  const session = prepare?.(seed, path) ?? seed
  await f.store.compareAndSwap(before, session)
  const originalRun = f.inner.kernel.status as (id: string) => Promise<any>
  f.inner.kernel.status = vi.fn(async (id: string) => ({ ...await originalRun(id), program: '/original/grok', args: ['--model', 'original-model'] }))
  const service = new AgentMuxRpcService({ coreClients: f.coreClients }); closes.push(() => service.dispose())
  const inspect = () => service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: SID } })
  const saved = () => f.store.readMetadata(SID)
  const context = { command: '/original/grok', args: ['--model', 'original-model'], workspacePath: f.root, env, nativeHandle: session.nativeHandle,
    signal: new AbortController().signal }
  return { ...f, env, dir, path, summary, session, context, inspect, service, saved }
}

function resumed(session: AgentMuxStoredAgentSession, path: string): AgentMuxStoredAgentSession {
  const previousRun = { runId: 'original-ended-run' }
  const operationId = 'resume-original-conversation'
  return { ...session, retiredRuns: [previousRun], nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: NATIVE, transcriptPath: path },
    continuityOperations: { [operationId]: { operationId, agentSessionId: SID, trigger: 'standing-maintenance',
      policy: DEFAULT_AGENT_CONTINUITY_POLICY, kind: 'resumed', reason: 'standing-intent', previousRun, newRun: session.run,
      admittedAt: 1000, observedAt: 1200, rechecks: 0, evidence: { kind: 'agent-session-store' } } },
    hookReceipt: { id: 'current-native-hook', providerId: 'grok', agentSessionId: SID, run: session.run, eventName: 'stop',
      lifecycleEvent: null, nativeTurnId: TURN, observedAt: 2500,
      subject: { kind: 'main', basis: 'provider-protocol', nativeSessionId: NATIVE, reason: 'run-bound-protocol' } }
  }
}

it('reattaches a witnessed terminal of the resumed Run and delivers the still-due standing heartbeat once', async () => {
  const f = await fixture(undefined, resumed), run = f.session.run
  const diagnostics: string[] = []
  f.client.onEvent(event => { if (event.type === 'agent-error') diagnostics.push(event.code) })
  const bytes = await readFile(f.path)
  await truncate(f.path, bytes.byteLength - 1)

  const clock = Date.now()
  let records: any[] = []
  const runtime = createGoalRuntime({ clients: f.coreClients, checkIn: async () => ({ known: false, reason: 'not used' }) })
  const manager = new ContinuousProgressLoopManager({ load: async () => records, save: async (next: any[]) => { records = structuredClone(next) } } as any,
    (...args) => deliverContinuousProgress(runtime, ...args), () => clock,
    (loop, tick, now, signal) => runtime.observeContinuousProgress(loop, tick, now, signal), runtime)
  closes.push(() => manager.stop())
  const { schedule } = await manager.call('schedule.create', { target: { hostId: 'local', agentSessionId: SID, providerId: 'grok', workspacePath: f.root },
    everyMs: 60000, prompt: 'Original standing check', operationId: 'resumed-heartbeat', managedSource: { sourceId: 'original-mote', revision: 'original-role' } })
  manager.setMaintenanceOwner({ maintain: async () => {}, qualify: async () => ({ action: 'continue' }) })
  const due = schedule.nextCheckAt
  await manager.check(due)
  expect(manager.inspectLoop(schedule.loopId)).toMatchObject({ status: 'active', nextCheckAt: due, lastOutcome: 'skipped' })
  expect(manager.inspectLoop(schedule.loopId)?.lastInputRef).toBeUndefined()
  expect(f.run(run.runId).acceptedInputBytes).toBe(0)
  expect((await f.inspect()).status?.observation.semantic).toBe('unknown')

  await appendFile(f.path, bytes.subarray(-1))
  await f.client.refreshAgentSession(SID, run)
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation.semantic).toBe('idle'))
  expect((await f.saved())?.semanticStatus).toMatchObject({ state: 'done', nativeTurnId: TURN, observedAt: 2000 })
  const probe = new ObjectCliProbe(request => f.service.call(request.method as AgentMuxRpcMethod, request.params as AgentMuxRpcParams<AgentMuxRpcMethod>))
  await probe.start(); closes.push(() => probe.stop())
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + probe.socketPath, 'agent', 'inspect', '--session', SID], probe.environment())
  expect(cli.code, cli.stderr).toBe(0)
  const inspected = JSON.parse(cli.stdout).result.status
  expect(inspected.observation.semantic, JSON.stringify({ observation: inspected.observation, diagnostics })).toBe('idle')

  await manager.check(due)
  const sent = manager.inspectLoop(schedule.loopId)!
  expect(sent, JSON.stringify({ decision: sent.lastDecision, diagnostics })).toMatchObject({
    status: 'active', lastOutcome: 'sent', lastOccurrenceAt: due, nextCheckAt: due + 60000
  })
  const receipt = await f.client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: SID, expectedRun: run, submissionId: sent.lastTickId! })
  expect(receipt?.admission?.acknowledged).toBe(true)
  const written = f.run(run.runId).acceptedInputBytes
  expect(written).toBeGreaterThan(0)
  await manager.check(due)
  expect(f.run(run.runId).acceptedInputBytes).toBe(written)
  expect(f.inner.kernel.start).not.toHaveBeenCalled()
  expect(f.client.agentSession(SID)).toMatchObject({ run, nativeHandle: f.session.nativeHandle })
})

it.each(['no-hook', 'foreign-session', 'foreign-turn', 'child', 'old-end', 'unconfirmed-source'] as const)(
  'keeps a resumed initial terminal unconfirmed when its main witness is %s', async mismatch => {
    const rows = mismatch === 'old-end' ? [{ ...start(), timestamp: 0.7 }, { ...done(), timestamp: 0.9 }] : undefined
    const f = await fixture(rows, (session, path) => {
      const saved = resumed(session, path), hook = saved.hookReceipt!
      if (mismatch === 'no-hook') delete saved.hookReceipt
      if (mismatch === 'foreign-session') hook.subject!.nativeSessionId = 'another-conversation'
      if (mismatch === 'foreign-turn') hook.nativeTurnId = 'another-turn'
      if (mismatch === 'child') hook.subject!.kind = 'child'
      if (mismatch === 'unconfirmed-source') saved.nativeSourceObservation = {
        state: 'unknown', run: session.run, observedAt: session.updatedAt, reason: 'No exact native source'
      }
      return saved
    })
    const warnings: string[] = []
    f.client.onEvent(event => { if (event.type === 'agent-error') warnings.push(event.code) })
    await f.inspect()
    await vi.waitFor(async () => {
      const watch = f.inner.nativeStatusWatches.get(SID)
      await watch?.pending
      expect(watch?.recordId).toBeDefined()
    })
    expect((await f.inspect()).status?.observation.semantic).not.toBe('idle')
    expect((await f.saved())?.nativeTurnEnds).toBeUndefined()
    expect(f.rawInput).not.toHaveBeenCalled()
    expect(warnings).toContain('AGENT_NATIVE_STATUS_UNCONFIRMED')
  })

it('rejects a retained Hook receipt attributed to the prior Run before opening the observer', async () => {
  await expect(fixture(undefined, (session, path) => {
    const saved = resumed(session, path)
    saved.hookReceipt!.run = saved.retiredRuns[0]!
    return saved
  })).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
})

it('native final reaches public Client and real CLI, original input activity, and the Host due consumer', async () => {
  const f = await fixture(), run = f.session.run
  const observed = f.client.providers.get('grok').observeSessionStatus ? vi.spyOn(f.client.providers.get('grok'), 'observeSessionStatus') : undefined
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation.semantic).toBe('idle'))
  expect(observed?.mock.calls[0]?.[0]).toMatchObject({ command: '/original/grok', args: ['--model', 'original-model'], env: f.env })
  const publicSession = (await f.inspect()).session!
  expect(publicSession).toMatchObject({ agentSessionId: SID, run, nativeHandle: f.session.nativeHandle,
    semanticStatus: { state: 'done', source: 'native-transcript', nativeTurnId: TURN, observedAt: 2000 } })
  expect(JSON.stringify(publicSession)).not.toContain(f.env.PRIVATE_SENTINEL)
  const evidence = await readGrokPromptExecutionEvidence(f.context)
  expect(evidence).toMatchObject({ state: 'ended', nativeTurnId: TURN, endReason: 'completed' })
  const key = { kind: 'prompt' as const, agentSessionId: SID, expectedRun: run, submissionId: 'original-input' }
  expect(await f.client.readAgentInputActivity(key)).toMatchObject({ state: 'idle', source: 'native-provider', sourceId: evidence!.id })
  const probe = new ObjectCliProbe(request => f.service.call(request.method as AgentMuxRpcMethod, request.params as AgentMuxRpcParams<AgentMuxRpcMethod>))
  await probe.start(); closes.push(() => probe.stop())
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + probe.socketPath, 'agent', 'inspect', '--session', SID], probe.environment())
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.status.observation.semantic).toBe('idle')
  expect(probe.requests.map(r => r.method)).toEqual(['agent.inspect'])

  let clock = Date.now(), records: any[] = []
  const runtime = createGoalRuntime({ clients: f.coreClients, checkIn: async () => ({ known: false, reason: 'not used' }) })
  const manager = new ContinuousProgressLoopManager({ load: async () => records, save: async (next: any[]) => { records = structuredClone(next) } } as any,
    (...args) => deliverContinuousProgress(runtime, ...args), () => clock,
    (loop, tick, now, signal) => runtime.observeContinuousProgress(loop, tick, now, signal), runtime)
  closes.push(() => manager.stop())
  const arranged = await manager.call('schedule.create', { target: { hostId: 'local', agentSessionId: SID, providerId: 'grok', workspacePath: f.root },
    everyMs: 60000, prompt: 'Original internal Mote check', operationId: 'original-heartbeat', managedSource: { sourceId: 'original-mote', revision: 'original-role' } })
  manager.setMaintenanceOwner({ maintain: async () => {}, qualify: async () => ({ action: 'continue' }) })
  clock += 60000
  await manager.check(clock)
  const loop = manager.inspectLoop(arranged.schedule.loopId)!
  expect(loop, JSON.stringify(loop)).toMatchObject({ status: 'active', lastOutcome: 'sent', lastOccurrenceAt: clock, nextCheckAt: clock + 60000 })
  const record = await f.client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: SID, expectedRun: run, submissionId: loop.lastTickId! })
  expect(record?.admission?.acknowledged).toBe(true)
  expect(f.inner.kernel.start).not.toHaveBeenCalled()
  expect(f.client.agentSession(SID).run).toEqual(run)
  expect(f.client.agentSession('neighbor').semanticStatus).toBeUndefined()
  await proof({ scenario: 'public-cli-host-due', privateRoot: f.root, run, nativeHandle: f.session.nativeHandle,
    methods: probe.requests.map(request => request.method), scheduleId: loop.loopId, tick: loop.lastTickId, admissionAcknowledged: record?.admission?.acknowledged,
    nextCheckAt: loop.nextCheckAt, status: loop.status })
})

it('Stop, mismatched endings and delayed prior turns never manufacture the next idle', async () => {
  const f = await fixture([start()])
  await vi.waitFor(async () => expect((await f.inspect()).status?.session.semanticStatus?.nativeTurnId).toBe(TURN))
  const before = (await f.saved())!.semanticStatus
  await appendFile(f.path, jsonl([grokUpdate(NATIVE, { sessionUpdate: 'hook_execution', event_name: 'stop', prompt_id: TURN }, TURN, '_x.ai/session/update'), done('foreign-turn')]))
  await vi.waitFor(async () => expect(await readGrokPromptExecutionEvidence(f.context)).toMatchObject({ state: 'working', nativeTurnId: TURN }))
  expect((await f.inspect()).status?.session.semanticStatus).toEqual(before)
  await appendFile(f.path, jsonl([done(), start('next-turn'), done()]))
  await vi.waitFor(async () => expect((await f.inspect()).status?.session.semanticStatus).toMatchObject({ state: 'working', nativeTurnId: 'next-turn' }))
  expect((await f.inspect()).status?.observation.semantic).not.toBe('idle')
  await appendFile(f.path, jsonl([done('next-turn')]))
  await vi.waitFor(async () => expect((await f.inspect()).status?.session.semanticStatus).toMatchObject({ state: 'done', nativeTurnId: 'next-turn' }))
})

it.each(['partial', 'rotation', 'unknown-end'] as const)('a confirmed own idle becomes unconfirmed after %s; a later original read recovers without replacing the Run', async kind => {
  const f = await fixture()
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation.semantic).toBe('idle'))
  const originalEnd = (await f.saved())!.nativeTurnEnds
  const next = jsonl([start('next-turn')])
  if (kind === 'partial') await appendFile(f.path, next.slice(0, -3))
  else if (kind === 'rotation') { const replacement = join(f.dir, 'replacement'); await writeFile(replacement, jsonl([start('next-turn')])); await rename(replacement, f.path) }
  else await appendFile(f.path, jsonl([start('next-turn'), grokDone(NATIVE, 'next-turn', 'unrecognized-stop')]))
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation.semantic).not.toBe('idle'))
  expect((await f.saved())!.nativeTurnEnds).toEqual(originalEnd)
  if (kind === 'partial') await appendFile(f.path, next.slice(-3) + jsonl([done('next-turn')]))
  else await writeFile(f.path, jsonl([start('next-turn'), done('next-turn')]))
  await f.client.refreshAgentSession(SID, f.session.run)
  await vi.waitFor(async () => expect((await f.inspect()).status?.session.semanticStatus).toMatchObject({ state: 'done', nativeTurnId: 'next-turn' }))
  expect(f.client.agentSession(SID).run).toEqual(f.session.run)
})

it('wrong native identity and missing retained environment preserve unknown and healthy manual capability', async () => {
  const f = await fixture()
  await writeFile(f.summary, JSON.stringify({ info: { id: 'wrong-native', cwd: f.root } }))
  await expect(readGrokPromptExecutionEvidence(f.context)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await expect(readGrokPromptExecutionEvidence({ ...f.context, env: {} })).rejects.toMatchObject({ code: 'AGENT_NATIVE_STATUS_UNAVAILABLE' })
  const publicState = await f.inspect()
  expect(publicState.status?.observation.process).toBe('running')
  expect(publicState.status?.observation.semantic).not.toBe('idle')
  expect((await f.client.writeAgent({ agentSessionId: SID, expectedRun: f.session.run, data: 'manual', source: 'user' })).appliedByteRange).not.toBeNull()
})

it('retained read and incremental observer agree on source, complete records and monotonic turns', async () => {
  const f = await fixture([start()]), seen: AgentProviderSessionStatus[] = [], issues: string[] = []
  const watch = await observeGrokSessionStatus({ ...f.context, onStatus: value => seen.push(value), onUnavailable: value => issues.push(value) })
  closes.push(async () => watch.dispose())
  await appendFile(f.path, jsonl([done(), start('next-turn'), done(), done('next-turn')]))
  await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ state: 'done', nativeTurnId: 'next-turn' }))
  const evidence = await readGrokPromptExecutionEvidence(f.context)
  expect(evidence).toMatchObject({ state: 'ended', nativeTurnId: 'next-turn', nativeOrdinal: seen.at(-1)!.sequence })
  expect(seen.map(item => [item.state, item.nativeTurnId])).toEqual([['working', TURN], ['done', 'next-turn']])
  expect(issues).toEqual([])
  watch.dispose(); const count = seen.length
  await appendFile(f.path, jsonl([start('after-dispose')]))
  await new Promise(resolve => setTimeout(resolve, 25)); expect(seen).toHaveLength(count)
})

it('original private environment and Run survive a Core reader restart; late old-Run records cannot settle its successor', async () => {
  const f = await fixture()
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation.semantic).toBe('idle'))
  const before = (await f.saved())!, clock = before.semanticStatus!.observedAt
  await f.client.dispose()
  const restored = new AgentMuxClient({ store: f.store, sessionExecutorConfiguration: async () => { throw Error('Do not borrow changed settings after restart') } })
  closes.push(() => restored.dispose())
  const inner = restored as any
  const provider = restored.providers.get('grok'), observe = provider.observeSessionStatus!
  let reported: string | undefined
  vi.spyOn(provider, 'observeSessionStatus').mockImplementation(context => observe({ ...context, onStatus: value => { context.onStatus(value); reported = value.nativeTurnId } }))
  await inner.registry.load('local'); inner.connected = true
  inner.kernel.isConnected = () => true; inner.kernel.status = f.inner.kernel.status
  inner.kernel.identity = f.inner.kernel.identity; inner.kernel.observeOutput = f.inner.kernel.observeOutput
  inner.kernel.start = vi.fn(() => { throw Error('Observer restart must not start Native') })
  await vi.waitFor(async () => expect((await restored.statusAgent(SID)).observation.semantic).toBe('idle'))
  expect(restored.agentSession(SID).run).toEqual(before.run)
  expect(restored.agentSession(SID).nativeHandle).toEqual(before.nativeHandle)
  expect(restored.agentSession(SID).semanticStatus!.observedAt).toBe(clock)
  const original = (await f.saved())!
  await f.store.compareAndSwap(original, { ...original, run: { runId: 'successor-run' }, retiredRuns: [...original.retiredRuns, original.run],
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 123 }, updatedAt: 123 })
  await inner.registry.load('local')
  await appendFile(f.path, jsonl([start('late-old-run'), done('late-old-run')]))
  await vi.waitFor(() => expect(reported).toBe('late-old-run'))
  await inner.nativeStatusWatches.get(SID).pending
  expect((await f.saved())!.run.runId).toBe('successor-run')
  expect((await f.saved())!.semanticStatus).toMatchObject({ state: 'working', source: 'native-hook', observedAt: 123 })
  expect(inner.kernel.start).not.toHaveBeenCalled()
})

it('same source predecessor suppresses the old terminal without suppressing the first new turn', async () => {
  const f = await fixture(), previous = (await readGrokPromptExecutionEvidence(f.context))!
  const context = { ...f.context, nativePromptPredecessor: { run: { runId: 'resumed' }, previousRun: f.session.run,
    sourceId: previous.sourceId, evidenceId: previous.id } }
  expect(await readGrokPromptExecutionEvidence(context)).toMatchObject({ state: 'idle', sourceId: previous.sourceId })
  const seen: AgentProviderSessionStatus[] = []
  const watch = await observeGrokSessionStatus({ ...context, onStatus: value => seen.push(value), onUnavailable: value => { throw Error(value) } })
  closes.push(async () => watch.dispose())
  expect(seen).toEqual([])
  await appendFile(f.path, jsonl([start('next-turn'), done('next-turn')]))
  await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ state: 'done', nativeTurnId: 'next-turn' }))
  expect(seen.map(value => value.nativeTurnId)).toEqual(['next-turn'])
  await expect(readGrokPromptExecutionEvidence({ ...context, nativePromptPredecessor: { ...context.nativePromptPredecessor, sourceId: 'foreign-generation' } }))
    .rejects.toMatchObject({ code: 'AGENT_NATIVE_STATUS_SOURCE_CHANGED' })
})

it('failure is an original failed outcome and an unrecognized end cannot become a successful idle', async () => {
  const failed = { ...done(), params: { ...done().params, update: { ...done().params.update, error_kind: 'native_transport_error' } } }
  const f = await fixture([start(), failed])
  await vi.waitFor(async () => expect((await f.inspect()).status?.session.semanticStatus).toMatchObject({ state: 'error',
    failure: { nativeCode: 'native_transport_error', nativeTurnId: TURN } }))
  expect(await readGrokPromptExecutionEvidence(f.context)).toMatchObject({ state: 'ended', endReason: 'failed' })
  await appendFile(f.path, jsonl([start('next-turn'), grokDone(NATIVE, 'next-turn', 'unrecognized-stop')]))
  expect(await readGrokPromptExecutionEvidence(f.context)).toBeNull()
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation.semantic).not.toBe('idle'))
})

it('the generic status lane withdraws only its own idle on unknown and preserves an independent Hook fact', async () => {
  let context!: AgentProviderSessionStatusObservationContext
  const builtin = new AgentProviderRegistry().get('codex')
  const f = await rpcOwnerFixture([SID], undefined, () => ({ nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'other-protocol' } }),
    () => ({ providers: [{ ...builtin, observeSessionStatus: async value => { context = value; return { dispose() {} } } }] }))
  closes.push(f.close)
  await f.client.statusAgent(SID)
  await vi.waitFor(() => expect(context).toBeDefined())
  context.onStatus({ recordId: 'original-end', nativeTurnId: 'turn', state: 'done', endReason: 'completed', sequence: 1 })
  await vi.waitFor(async () => expect((await f.client.statusAgent(SID)).observation.semantic).toBe('idle'))
  context.onStatus({ recordId: 'original-gap', nativeTurnId: 'turn', state: 'unknown', sequence: 2 })
  await vi.waitFor(async () => expect((await f.client.statusAgent(SID)).observation.semantic).toBe('unknown'))
  context.onStatus({ recordId: 'new-confirmed-end', nativeTurnId: 'turn', state: 'done', endReason: 'completed', sequence: 3 })
  await vi.waitFor(async () => expect((await f.client.statusAgent(SID)).observation.semantic).toBe('idle'))
  context.onStatus({ recordId: 'late-old-gap', nativeTurnId: 'turn', state: 'unknown', sequence: 1 })
  await (f.client as any).nativeStatusWatches.get(SID).pending
  expect((await f.client.statusAgent(SID)).observation.semantic).toBe('idle')
  const saved = (await f.store.readMetadata(SID))!
  expect(saved.nativeTurnEnds?.turns.turn).toBeDefined()
  await f.store.compareAndSwap(saved, { ...saved, semanticStatus: { state: 'done', source: 'native-hook', observedAt: 42 } })
  await (f.client as any).registry.load('local')
  context.onUnavailable('AGENT_NATIVE_STATUS_UNAVAILABLE', 'The unrelated transcript observer is unavailable')
  await new Promise(resolve => setTimeout(resolve, 25))
  expect((await f.store.readMetadata(SID))!.semanticStatus).toMatchObject({ state: 'done', source: 'native-hook', observedAt: 42 })
})


it('a newer original Hook turn reaches authenticated ingress and fences the older native completion', async () => {
  const f = await fixture()
  // Establish the original completed turn before delivering its later Hook.
  // Starting the reader and the Hook concurrently does not prove this fence.
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation.semantic).toBe('idle'))
  const server = (f.client as any).hookServer
  Object.defineProperty(server, 'port', { value: 0 })
  await server.start()
  const binding = server.createBinding(SID, 'grok', f.session.hookBindingId, f.session.hookToken)
  await binding.bindRun(f.session.run.runId)
  const response = await fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId: 'new-turn-hook', eventName: 'user_prompt_submit',
      payload: { hookEventName: 'user_prompt_submit', sessionId: NATIVE, promptId: 'later-human-turn' } }) })
  expect(response.status, await response.text()).toBe(204)
  await vi.waitFor(async () => expect((await f.saved())!.hookReceipt).toMatchObject({ id: 'new-turn-hook', nativeTurnId: 'later-human-turn' }))
  expect((f.client as any).hookTurnPhases.get(f.session.run.runId)).toBe('in-turn')
  const watch = (f.client as any).nativeStatusWatches.get(SID), originalSequence = watch.sequence
  await appendFile(f.path, jsonl([done()]))
  await vi.waitFor(() => expect(watch.sequence).toBeGreaterThan(originalSequence))
  await watch.pending
  expect((await f.saved())!.nativeTurnEnds?.turns[TURN]).toBeDefined()
  expect((await f.inspect()).status?.session.semanticStatus).toMatchObject({ state: 'working', source: 'native-hook', nativeTurnId: 'later-human-turn' })
  expect((await f.inspect()).status?.observation.semantic).not.toBe('idle')
  await proof({ scenario: 'authenticated-hook-fences-old-end', privateRoot: f.root, receiptId: 'new-turn-hook',
    responseStatus: response.status, hookTurn: 'later-human-turn', laterOriginalEndObserved: true, currentSemantic: 'working' })
})


it('a foreign native row cannot borrow a correct summary or root', async () => {
  const f = await fixture([grokUser('foreign-native', 'Foreign input', TURN), grokDone('foreign-native', TURN)])
  await expect(readGrokPromptExecutionEvidence(f.context)).rejects.toMatchObject({ code: 'AGENT_NATIVE_STATUS_SOURCE_CHANGED' })
  expect((await f.inspect()).status?.observation.semantic).not.toBe('idle')
  expect(f.client.agentSession(SID).nativeHandle).toEqual(f.session.nativeHandle)
})


it('native control parsing reuses lazy large-record reading without treating payload size or prose as a boundary', async () => {
  const f = await fixture([start(), grokUpdate(NATIVE, { sessionUpdate: 'tool_call_update', rawOutput: 'x'.repeat(2 * 1024 * 1024) }, TURN), done()])
  expect(await readGrokPromptExecutionEvidence(f.context)).toMatchObject({ state: 'ended', nativeTurnId: TURN, endReason: 'completed' })
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation.semantic).toBe('idle'))
  await appendFile(f.path, jsonl([start('next-turn')]))
  await vi.waitFor(async () => expect((await f.inspect()).status?.session.semanticStatus).toMatchObject({ state: 'working', nativeTurnId: 'next-turn' }))
})

it.each(['read', 'observe'] as const)('a same-size source replaced inside the original stat-to-%s-open window cannot inherit the old source identity', async mode => {
  const f = await fixture(), previous = (await readGrokPromptExecutionEvidence(f.context))!
  const replacement = join(f.dir, 'replacement-before-open')
  await writeFile(replacement, await readFile(f.path)) // Same native Session, byte length and complete records, another actual inode.
  const originalOpen = NativeJsonlHistoryReader.open
  const spy = vi.spyOn(NativeJsonlHistoryReader, 'open').mockImplementationOnce(async (...args) => {
    await rename(replacement, f.path)
    return await originalOpen(...args)
  })
  const context = { ...f.context, nativePromptPredecessor: { run: { runId: 'resumed' }, previousRun: f.session.run,
    sourceId: previous.sourceId, evidenceId: previous.id } }
  const action = mode === 'read' ? readGrokPromptExecutionEvidence(context)
    : observeGrokSessionStatus({ ...context, onStatus: () => { throw Error('Replacement cannot supply an original status') }, onUnavailable: () => {} })
  await expect(action).rejects.toMatchObject({ code: 'AGENT_NATIVE_STATUS_SOURCE_CHANGED' })
  expect(spy).toHaveBeenCalledOnce()
})

it('a whole native cut is validated before the real Core and Host can consume a completed-then-partial idle', async () => {
  const f = await fixture([start()])
  await f.inspect(); await vi.waitFor(() => expect((f.client as any).nativeStatusWatches.get(SID)?.observer).toBeDefined())
  let clock = Date.now(), records: any[] = []
  const runtime = createGoalRuntime({ clients: f.coreClients, checkIn: async () => ({ known: false, reason: 'not used' }) })
  const manager = new ContinuousProgressLoopManager({ load: async () => records, save: async (next: any[]) => { records = structuredClone(next) } } as any,
    (...args) => deliverContinuousProgress(runtime, ...args), () => clock,
    (loop, tick, now, signal) => runtime.observeContinuousProgress(loop, tick, now, signal), runtime)
  closes.push(() => manager.stop())
  const arranged = await manager.call('schedule.create', { target: { hostId: 'local', agentSessionId: SID, providerId: 'grok', workspacePath: f.root },
    everyMs: 60000, prompt: 'Original care check', operationId: 'cut-heartbeat', managedSource: { sourceId: 'mote', revision: 'role' } })
  manager.setMaintenanceOwner({ maintain: async () => {}, qualify: async () => ({ action: 'continue' }) })
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const originalRead = NativeJsonlHistoryReader.prototype.readNext
  let afterEnd = false
  vi.spyOn(NativeJsonlHistoryReader.prototype, 'readNext').mockImplementation(async function () {
    if (afterEnd) { afterEnd = false; entered.resolve(); await gate.promise }
    const row = await originalRead.call(this)
    if ((row?.value.params as any)?.update?.sessionUpdate === 'turn_completed') afterEnd = true
    return row
  })
  const partial = jsonl([start('unconfirmed-next-turn')]).slice(0, -3)
  await appendFile(f.path, jsonl([done()]) + partial)
  await entered.promise
  try {
    // Drain all already published Core status callbacks while the source reader is held.
    await (f.client as any).nativeStatusWatches.get(SID).pending
    expect((await f.inspect()).status?.observation.semantic).not.toBe('idle')
    clock += 60000; await manager.check(clock)
    expect(manager.inspectLoop(arranged.schedule.loopId)!.lastOutcome).not.toBe('sent')
    expect(f.rawInput).not.toHaveBeenCalled()
  } finally { gate.resolve() }
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation.semantic).not.toBe('idle'))
})

it('two independent OS Core owners recover original native status and clock from the same source without reseeding', async () => {
  const f = await fixture()
  await f.client.dispose()
  const owner = fileURLToPath(new URL('./fixtures/grok-status-owner.mjs', import.meta.url))
  const actualLoader = new URL('../../../apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs', import.meta.url)
  const registration = `import { register } from 'node:module'; register(${JSON.stringify(actualLoader.href)}, ${JSON.stringify(import.meta.url)});`
  const pids: number[] = [], states: any[] = []
  const beforeBytes = await readFile(f.path)
  for (let index = 0; index < 2; index++) {
    const process = spawn(globalThis.process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(registration), owner, f.root, SID],
      { env: { ...globalThis.process.env, AGENTMUX_RUNTIME_DIRECTORY: f.root, AGENTMUX_STATE_DIRECTORY: join(f.root, 'state'),
        AGENTMUX_MESSAGE_QUEUE_PATH: join(f.root, 'messages.ndjson') }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', errors = ''
    process.stdout.on('data', data => { output += data }); process.stderr.on('data', data => { errors += data })
    const end = new Promise<number | null>(resolve => process.once('close', resolve))
    closes.push(async () => { if (process.exitCode === null) process.stdin.end(); await end })
    await vi.waitFor(() => expect(output, errors).toContain('"socket"'), { timeout: 30000 })
    const opened = JSON.parse(output.split('\n')[0]!)
    pids.push(opened.pid)
    let result: any
    await vi.waitFor(async () => {
      const cli = await runSourceObjectCli(['--endpoint', 'unix:' + opened.socket, 'agent', 'inspect', '--session', SID],
        { ...globalThis.process.env, AGENTMUX_RUNTIME_DIRECTORY: f.root })
      expect(cli.code, cli.stderr).toBe(0)
      result = JSON.parse(cli.stdout).result
      expect(result.status.observation.semantic, JSON.stringify({ status: result.status, ownerErrors: errors })).toBe('idle')
    }, { timeout: 30000 })
    states.push({ run: result.session.run, nativeHandle: result.session.nativeHandle, semanticStatus: result.session.semanticStatus })
    process.stdin.end(); expect(await end, errors).toBe(0)
    expect(output).toContain('"closed":true')
  }
  expect(pids[0]).not.toBe(pids[1])
  expect(states[0]).toEqual(states[1])
  expect(states[0].run).toEqual(f.session.run)
  expect(states[0].semanticStatus).toMatchObject({ state: 'done', nativeTurnId: TURN, observedAt: 2000 })
  expect(await readFile(f.path)).toEqual(beforeBytes)
  await proof({ scenario: 'two-os-status-readers', privateRoot: f.root, pids, states,
    unchangedOriginalBytes: true, sourceSHA256: createHash('sha256').update(beforeBytes).digest('hex'), noReseed: true })
})


it.each(['empty', 'metadata-only'] as const)('cold %s native source cannot retain a prior own idle; the original Run and manual path remain', async shape => {
  const f = await fixture()
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation.semantic).toBe('idle'))
  const before = (await f.saved())!
  await f.client.dispose()
  await writeFile(f.path, shape === 'empty' ? '' : jsonl([grokUpdate(NATIVE, { sessionUpdate: 'hook_execution', event_name: 'stop' }, TURN, '_x.ai/session/update')]))
  const restored = new AgentMuxClient({ store: f.store }); closes.push(() => restored.dispose())
  const issues: string[] = []; restored.onEvent(event => { if (event.type === 'agent-error') issues.push(event.code) })
  const inner = restored as any
  await inner.registry.load('local'); inner.connected = true
  inner.kernel.isConnected = () => true; inner.kernel.status = f.inner.kernel.status; inner.kernel.identity = f.inner.kernel.identity
  inner.kernel.observeOutput = f.inner.kernel.observeOutput; inner.kernel.openInput = f.inner.kernel.openInput
  await vi.waitFor(async () => expect((await restored.statusAgent(SID)).observation.semantic).not.toBe('idle'))
  await vi.waitFor(() => expect(issues).toContain('AGENT_NATIVE_STATUS_UNCONFIRMED'))
  expect((await f.saved())!.nativeTurnEnds).toEqual(before.nativeTurnEnds)
  expect(restored.agentSession(SID).run).toEqual(before.run)
  expect((await restored.writeAgent({ agentSessionId: SID, expectedRun: before.run, data: 'manual', source: 'user' })).appliedByteRange).not.toBeNull()
})

it.each(['working', 'source-gap'] as const)('a new %s observation immediately withdraws own idle while its native status write is held, including public and Host consumers', async shape => {
  const f = await fixture()
  await vi.waitFor(async () => expect((await f.inspect()).status?.observation.semantic).toBe('idle'))
  let clock = Date.now(), records: any[] = []
  const runtime = createGoalRuntime({ clients: f.coreClients, checkIn: async () => ({ known: false, reason: 'not used' }) })
  const manager = new ContinuousProgressLoopManager({ load: async () => records, save: async (next: any[]) => { records = structuredClone(next) } } as any,
    (...args) => deliverContinuousProgress(runtime, ...args), () => clock,
    (loop, tick, now, signal) => runtime.observeContinuousProgress(loop, tick, now, signal), runtime)
  closes.push(() => manager.stop())
  const arranged = await manager.call('schedule.create', { target: { hostId: 'local', agentSessionId: SID, providerId: 'grok', workspacePath: f.root },
    everyMs: 60000, prompt: 'Original Mote care', operationId: 'held-metadata-heartbeat', managedSource: { sourceId: 'mote', revision: 'role' } })
  manager.setMaintenanceOwner({ maintain: async () => {}, qualify: async () => ({ action: 'continue' }) })
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const originalWrite = f.store.compareAndSwapMetadata.bind(f.store)
  vi.spyOn(f.store, 'compareAndSwapMetadata').mockImplementation(async (...args) => {
    if (args[1].semanticStatus?.nativeTurnId === 'next-turn') { entered.resolve(); await gate.promise }
    return await originalWrite(...args)
  })
  const issues: string[] = []; f.client.onEvent(event => { if (event.type === 'agent-error') issues.push(event.code) })
  await appendFile(f.path, jsonl([start('next-turn')]))
  await entered.promise
  try {
    if (shape === 'source-gap') {
      await appendFile(f.path, '{"params":')
      await vi.waitFor(() => expect(issues).toContain('AGENT_NATIVE_STATUS_UNCONFIRMED'))
    }
    // The synchronous public projection and event are unknown before the optional
    // writer can settle. Exact durable reads may queue behind that existing writer,
    // but cannot expose its previous idle or dispatch an automatic input.
    expect(f.client.agentSession(SID).semanticStatus?.state).toBe('running')
    const observations: string[] = []
    const firstPublic = f.inspect().then(value => { observations.push(value.status!.observation.semantic); return value })
    clock += 60000; const checking = manager.check(clock)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(observations).not.toContain('idle')
    expect(f.rawInput).not.toHaveBeenCalled()
    gate.resolve()
    expect((await firstPublic).status?.observation).toMatchObject({ semantic: 'unknown', process: 'running' })
    await checking
    expect(manager.inspectLoop(arranged.schedule.loopId)!.lastOutcome).not.toBe('sent')
    expect(f.rawInput).not.toHaveBeenCalled()
    await proof({ scenario: 'held-status-write-gap', shape, privateRoot: f.root, originalCompletionRetained: true,
      immediatePublicProjection: 'unknown', firstSettledPublicObservation: 'unknown', hostDelivered: false, run: f.session.run })
  } finally { gate.resolve() }
})

it('an older completion write cannot clear a newer ingressed working fact before its own write settles', async () => {
  const f = await fixture([start()]), ingress = Promise.withResolvers<void>()
  const provider = f.client.providers.get('grok'), originalObserve = provider.observeSessionStatus!
  let receivedNext = false
  vi.spyOn(provider, 'observeSessionStatus').mockImplementation(context => originalObserve({ ...context, onStatus: value => {
    context.onStatus(value)
    if (value.nativeTurnId === 'next-turn') { receivedNext = true; ingress.resolve() }
  } }))
  await f.inspect(); await vi.waitFor(() => expect((f.client as any).nativeStatusWatches.get(SID)?.observer).toBeDefined())
  const gateA = Promise.withResolvers<void>(), gateB = Promise.withResolvers<void>()
  const enteredA = Promise.withResolvers<void>(), enteredB = Promise.withResolvers<void>()
  const originalWrite = f.store.compareAndSwapMetadata.bind(f.store)
  vi.spyOn(f.store, 'compareAndSwapMetadata').mockImplementation(async (...args) => {
    const status = args[1].semanticStatus
    if (status?.state === 'done' && status.nativeTurnId === TURN) { enteredA.resolve(); await gateA.promise }
    if (status?.state === 'working' && status.nativeTurnId === 'next-turn') { enteredB.resolve(); await gateB.promise }
    return await originalWrite(...args)
  })
  const intermediateIdle: string[] = []
  f.client.onEvent(event => { if (receivedNext && event.type === 'agent-session' && event.session.semanticStatus?.state === 'done') intermediateIdle.push(event.session.semanticStatus.nativeTurnId!) })
  try {
    await appendFile(f.path, jsonl([done()]))
    await enteredA.promise
    await appendFile(f.path, jsonl([start('next-turn')]))
    await ingress.promise
    gateA.resolve(); await enteredB.promise
    expect(f.client.agentSession(SID).semanticStatus?.state).toBe('running')
    expect(intermediateIdle).toEqual([])
    gateB.resolve()
    await (f.client as any).nativeStatusWatches.get(SID).pending
    expect((await f.inspect()).status?.session.semanticStatus).toMatchObject({ state: 'working', nativeTurnId: 'next-turn' })
  } finally { gateA.resolve(); gateB.resolve() }
})
