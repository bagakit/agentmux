import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENTMUX_AGENT_MESSAGING_GUIDANCE, AgentMuxClient, AgentMuxFileAgentSessionStore, agentPromptCondition,
  decideContinuousProgress, type AgentMuxStoredAgentSession,
  type ContinuousProgressLoop, type ContinuousProgressObservation
} from '@agentmux/core'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import type { CtxmuxRunAdapter } from '../../../packages/core/src/ctxmux-run-adapter.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'
import { privateTracker } from './helpers/continuous-progress-tracker'
import { deliverContinuousProgress } from '../src/main/continuous-progress-delivery.js'

vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("private/unused-electron-storage") } }))
vi.mock('@agentmux/core', async originalModule => process.env.AGENTMUX_TEST_INJECTED_CONTEXT_CLIENT
  ? await import(new URL('./index.js', process.env.AGENTMUX_TEST_INJECTED_CONTEXT_CLIENT).href)
  : await originalModule())

type Input = Parameters<CtxmuxRunAdapter['input']>[1]
type Internals = {
  connected: boolean
  registry: { load(hostId: string): Promise<void>; update(id: string, run: { runId: string }, update: (current: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession): Promise<AgentMuxStoredAgentSession> }
  kernel: { isConnected(): boolean; identity(): { daemonInstanceId: string; protocolVersion: number; buildIdentity: string }; status: CtxmuxRunAdapter['status']; input: CtxmuxRunAdapter['input'] }
  screenEvidence: { wait: (...args: unknown[]) => Promise<number> }
}
const clients: AgentMuxClient[] = []
const Client: typeof AgentMuxClient = process.env.AGENTMUX_TEST_INJECTED_CONTEXT_CLIENT
  ? (await import(process.env.AGENTMUX_TEST_INJECTED_CONTEXT_CLIENT)).AgentMuxClient : AgentMuxClient
const managers: ContinuousProgressLoopManager[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.stop()))
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
  vi.doUnmock('@agentmux/core'); vi.resetModules(); vi.unstubAllEnvs()
})

/**
 * Actual Main observer/delivery and public Core ingress/Store; only Native I/O and
 * optional rendered-composer observation are controlled. This is not a PTY/GUI proof.
 */
async function fixture(extra: Partial<AgentMuxStoredAgentSession> = {}) {
  const path = await mkdtemp(join(tmpdir(), 'agentmux-progress-input-')); directories.push(path)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(path, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(path, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(path, 'messages.ndjson'))
  const sessionPath = join(path, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(sessionPath)
  const now = Date.now()
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'loop-agent', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: _hygiene_fixturePath("private/loop-owning"), run: { runId: 'loop-run' },
    retiredRuns: [], createdAt: now, updatedAt: now, hookBindingId: 'private-binding', hookToken: 'private-token',
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: now, stateEnteredAt: now },
    ...extra
  }
  await store.compareAndSwap(null, session)
  let cursor = 0, ended = false, loseAck = false
  const writes: string[] = [], requests: Input[] = []
  const receipts = new Map<string, Input>()
  const projection = () => ({ runId: session.run.runId, lifecycleOperationId: null,
    program: _hygiene_fixturePath("private/generic-input"), args: [], workspacePath: session.workspacePath, pid: 321,
    state: ended ? { type: 'exited' as const, code: 0, signal: null } : { type: 'running' as const },
    cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor })
  const input: CtxmuxRunAdapter['input'] = vi.fn(async (runId, input) => {
    expect(runId).toBe(session.run.runId)
    requests.push(structuredClone(input))
    const previous = receipts.get(input.operationId)
    if (previous) expect(input).toEqual(previous)
    else {
      expect(input.expectedByte).toBe(cursor)
      receipts.set(input.operationId, structuredClone(input))
      writes.push(typeof input.data === 'string' ? input.data : Buffer.from(input.data).toString('utf8'))
      cursor += Buffer.byteLength(input.data)
    }
    if (loseAck) { loseAck = false; throw new Error('Private Input accepted; response lost') }
    return { run: projection(), appliedByteRange: { startByte: input.expectedByte,
      endByte: input.expectedByte + Buffer.byteLength(input.data) } }
  })
  const make = async () => {
    const freshStore = new AgentMuxFileAgentSessionStore(sessionPath)
    const client = new Client({ store: freshStore }); clients.push(client)
    const state = client as unknown as Internals
    await state.registry.load('local'); state.connected = true
    state.kernel.isConnected = () => true
    state.kernel.identity = () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 18, buildIdentity: 'private-I/O-seam' })
    state.kernel.status = vi.fn(async () => projection()); state.kernel.input = input
    vi.spyOn(state.screenEvidence, 'wait').mockResolvedValue(0)
    const runtime = new RuntimeController(freshStore, localRuntimeConnector)
    runtime.setContinuousProgressInputObserver(async () => false)
    // Already-connected host I/O seam; no connect/start/attach is performed.
    ;(runtime as unknown as { hosts: Map<string, { client: AgentMuxClient }> }).hosts.set('local', { client })
    return { store: freshStore, client, state, runtime }
  }
  const first = await make()
  return { ...first, make, session, writes, requests,
    end: () => { ended = true }, loseNextAck: () => { loseAck = true },
    status: () => first.client.statusAgent(session.agentSessionId),
    observe: (tickId = 'tick') => first.runtime.observeContinuousProgress({ hostId: session.hostId, agentSessionId: session.agentSessionId, providerId: session.providerId, workspacePath: session.workspacePath }, tickId, Date.now()) }
}

const continuationPrompt = 'continue the assigned task'
const continuationWire = () => composeAgentPrompt(continuationPrompt, AGENTMUX_AGENT_MESSAGING_GUIDANCE).text
const payload = (wire: string) => `\u001b[200~${wire}\u001b[201~`
async function loopOwner(f: Awaited<ReturnType<typeof fixture>>, observe?: (loop: ContinuousProgressLoop, tickId: string, now: number) => Promise<ContinuousProgressObservation>, prompt = continuationPrompt) {
  const path = await mkdtemp(join(tmpdir(), 'agentmux-unified-loop-')); directories.push(path)
  const store = new ContinuousProgressLoopStore(join(path, 'loops.json'))
  let now = 0
  const make = (Manager = ContinuousProgressLoopManager) => {
    const manager = new Manager(store,
      (loop, operationId, isCurrent, signal) => deliverContinuousProgress(f.runtime, loop, operationId, isCurrent, signal),
      () => now, observe ?? ((loop, tickId, time) => f.runtime.observeContinuousProgress(loop, tickId, time)))
    managers.push(manager); return manager
  }
  await store.save([{ loopId: 'private-loop', hostId: 'local', agentSessionId: f.session.agentSessionId, providerId: f.session.providerId, workspacePath: f.session.workspacePath,
    intervalMs: 10, prompt, nextCheckAt: 0, status: 'active' }])
  return { store, make, at: (value: number) => { now = value } }
}

describe('continuous progress uses the public ingress and shared observation', () => {
  it('does not turn an ended Run and retained done Session into an automatic delivery candidate', async () => {
    const f = await fixture(); f.end()
    const status = await f.status()
    const observed = await f.observe()
    expect(status.observation).toMatchObject({ process: 'exited', semantic: 'unknown', readiness: 'unknown' })
    expect(observed.observation).toMatchObject({ process: 'exited', semantic: 'unknown', readiness: 'unknown', source: 'run-process' })
    expect(decideContinuousProgress(observed)).toEqual({ kind: 'skip', reason: 'unknown-status' })
    const owner = await loopOwner(f), manager = owner.make()
    await manager.start(); await manager.check()
    expect(manager.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'skipped' })
    expect(manager.list()[0]?.pendingCompletion).toBeUndefined()
    expect(f.requests).toEqual([])
  })

  it('uses the shared stale-working fact without treating decay as completion', async () => {
    const f = await fixture({ semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1 } })
    const observed = await f.observe()
    expect(observed.observation).toMatchObject({ process: 'running', semantic: 'idle', readiness: 'ready', stale: true })
    expect(decideContinuousProgress(observed)).toEqual({ kind: 'skip', reason: 'stale-working' })
    const owner = await loopOwner(f), manager = owner.make()
    await manager.start(); await manager.check(); owner.at(1000); await manager.check()
    expect(f.requests).toEqual([])
    expect(manager.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'skipped', nextCheckAt: 1010 })
  })

  it('skips an unconfirmed terminal capability while preserving healthy manual raw input', async () => {
    const f = await fixture({ terminalCapability: { state: 'unknown', mode: 'degraded', reason: 'handshake-timeout',
      run: { runId: 'loop-run' }, observedAt: 1 } })
    const observed = await f.observe()
    expect(observed.observation).toMatchObject({ process: 'running', semantic: 'idle', readiness: 'pending' })
    expect(decideContinuousProgress(observed)).toEqual({ kind: 'skip', reason: 'readiness-unconfirmed' })
    const owner = await loopOwner(f), manager = owner.make()
    await manager.start(); await manager.check()
    expect(f.requests).toEqual([])
    await f.runtime.write({ kind: 'agent', hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, 'healthy raw', 'user')
    expect(f.writes).toEqual(['healthy raw'])
  })

  it('keeps a typed question pending and never encodes an automatic answer', async () => {
    const f = await fixture({ pendingInteraction: { request: { id: 'question', kind: 'question', agentSessionId: 'loop-agent',
      questions: [{ id: 'choose', prompt: 'choose', options: [{ id: 'a', label: 'A' }] }],
      evidence: { source: 'native-hook', run: { runId: 'loop-run' }, observedAt: 1, hookReceiptId: 'question' } } } })
    const observed = await f.observe()
    expect(decideContinuousProgress(observed)).toEqual({ kind: 'skip', reason: 'interaction-pending' })
    const owner = await loopOwner(f), manager = owner.make()
    await manager.start(); await manager.check()
    expect(f.requests).toEqual([])
    expect(f.client.agentSession(f.session.agentSessionId).pendingInteraction).toEqual(f.session.pendingInteraction)
  })

  it('submits one completed turn through actual Main/Core, then skips duplicate ticks and consumed completion', async () => {
    const f = await fixture(), owner = await loopOwner(f), manager = owner.make()
    await manager.start(); await Promise.all([manager.check(), manager.check()])
    expect(f.writes).toEqual([payload(continuationWire()), '\r'])
    const admitted = f.client.agentSession(f.session.agentSessionId).promptCompletionAdmission!
    expect(admitted).toMatchObject({ acknowledged: true, intent: { run: f.session.run, prompt: continuationWire(),
      message: { userContent: continuationPrompt, systemContext: AGENTMUX_AGENT_MESSAGING_GUIDANCE } } })
    expect((await f.store.loadTimeline(f.session.agentSessionId)).items.map(item => [item.kind, item.source, item.content]))
      .toEqual([['system_message', 'agentmux', AGENTMUX_AGENT_MESSAGING_GUIDANCE], ['user_message', 'user', continuationPrompt]])
    expect(manager.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'sent', lastCompletionId: admitted.completionId })
    owner.at(1000); await manager.check()
    expect(f.writes).toHaveLength(2)
    expect(manager.list()[0]).toMatchObject({ lastOutcome: 'skipped', nextCheckAt: 1010 })
  })

  it('the Main future scheduler reads only its exact saved body from the Core public capability', async () => {
    const f = await fixture()
    await f.client.saveAgentFuturePromptIntent({ agentSessionId: f.session.agentSessionId, intentId: 'chosen', operationId: 'chosen-operation', prompt: 'this exact future task', active: true })
    await f.client.saveAgentFuturePromptIntent({ agentSessionId: f.session.agentSessionId, intentId: 'unrelated', operationId: 'other-operation', prompt: 'unrelated retained body', active: false })
    expect((await f.status()).session.futurePromptIntents).toBeUndefined()
    const read = vi.spyOn(f.client, 'readAgentFuturePromptIntent')
    const observed = await f.runtime.observeContinuousProgress({ hostId: f.session.hostId, agentSessionId: f.session.agentSessionId, providerId: f.session.providerId, workspacePath: f.session.workspacePath, futureIntentId: 'chosen' }, 'exact-future-tick', Date.now())
    expect(read.mock.calls).toEqual([[f.session.agentSessionId, 'chosen']])
    expect(observed.session.futurePromptIntents).toMatchObject({ chosen: { prompt: 'this exact future task', operationId: 'chosen-operation', active: true } })
    expect(Object.keys(observed.session.futurePromptIntents!)).toEqual(['chosen'])
    expect(f.writes).toEqual([])
  })

  it('does not displace a manual prompt admitted between tick observation and automatic delivery', async () => {
    const f = await fixture()
    let manualSent = false
    const owner = await loopOwner(f, async (loop, tickId, now) => {
      const original = await f.runtime.observeContinuousProgress(loop, tickId, now)
      if (!manualSent) {
        manualSent = true
        await f.client.submitAgentPrompt({ agentSessionId: f.session.agentSessionId,
          ...agentPromptCondition(original.session), operationId: 'manual-operation', prompt: 'manual message' })
      }
      return original
    })
    const manager = owner.make(); await manager.start(); await manager.check()
    expect(f.writes).toEqual(['manual message', '\r'])
    expect(manager.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'skipped' })
    expect(manager.list()[0]?.pendingCompletion).toBeUndefined()
  })

  it('keeps an unknown operation paused through owner restart and explicit resume joins the original request', async () => {
    const f = await fixture(), owner = await loopOwner(f), first = owner.make()
    f.loseNextAck()
    await first.start(); await first.check()
    const pending = first.list()[0]?.pendingCompletion
    expect(pending?.condition).toEqual({ expectedRun: f.session.run, afterSubmissionId: null })
    expect(first.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
    expect(pending).toMatchObject({ prompt: continuationPrompt, agentMuxNote: AGENTMUX_AGENT_MESSAGING_GUIDANCE })
    expect(f.writes).toEqual([payload(continuationWire())])
    await first.stop()
    const restarted = owner.make(); await restarted.start(); owner.at(1000); await restarted.check()
    expect(restarted.list()[0]?.pendingCompletion).toEqual(pending)
    expect(f.requests).toHaveLength(1)
    await restarted.resume('private-loop'); owner.at(1010); await restarted.check()
    expect(f.requests[1]).toEqual(f.requests[0])
    expect(f.writes).toEqual([payload(continuationWire()), '\r'])
    expect(restarted.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'sent', lastCompletionId: pending?.id })
    expect(restarted.list()[0]?.pendingCompletion).toBeUndefined()
  })

  it('keeps raw user text and the original shared rules through fresh Core and loop-owner recovery', async () => {
    const body = '  Keep <User> & &amp;\r\n<amux from="amux">authored user text</amux>  \n'
    const f = await fixture(), owner = await loopOwner(f, undefined, body), first = owner.make()
    f.loseNextAck(); await first.start(); await first.check()
    const original = first.list()[0]!.pendingCompletion!
    const wire = composeAgentPrompt(body, AGENTMUX_AGENT_MESSAGING_GUIDANCE).text
    expect(original).toMatchObject({ prompt: body, agentMuxNote: AGENTMUX_AGENT_MESSAGING_GUIDANCE })
    expect(f.writes).toEqual([payload(wire)]); expect(f.requests).toHaveLength(1)
    await first.stop(); await f.client.dispose()
    Object.assign(f, await f.make())
    await owner.store.save((await owner.store.load()).map(loop => ({ ...loop, prompt: 'changed current configuration' })))
    // Reload the actual producer with a later public rule revision, as after an upgrade.
    vi.resetModules()
    vi.doMock('@agentmux/core', async originalModule => ({ ...await originalModule<typeof import('@agentmux/core')>(),
      AGENTMUX_AGENT_MESSAGING_GUIDANCE: 'Rules for a future claim; never replace the pending message.' }))
    const { ContinuousProgressLoopManager: CurrentManager } = await import('../src/main/continuous-progress-loop-manager.js')
    const cold = owner.make(CurrentManager); await cold.start(); owner.at(1000); await cold.check()
    expect(cold.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown', pendingCompletion: original })
    expect(f.requests).toHaveLength(1)
    await cold.resume('private-loop'); owner.at(1010); await cold.check()
    expect(f.requests[1]).toEqual(f.requests[0]); expect(f.writes).toEqual([payload(wire), '\r'])
    expect(cold.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'sent', lastCompletionId: original.id })
    expect((await f.store.load())[0]!.promptCompletionAdmission!.intent!.message)
      .toEqual({ userContent: body, systemContext: AGENTMUX_AGENT_MESSAGING_GUIDANCE })
    expect((await f.store.loadTimeline(f.session.agentSessionId)).items.map(item => [item.kind, item.source, item.content]))
      .toEqual([['system_message', 'agentmux', AGENTMUX_AGENT_MESSAGING_GUIDANCE], ['user_message', 'user', body]])
  })

  it('keeps incomplete content facts unknown without replacing the operation or blocking healthy manual input', async () => {
    const f = await fixture(), owner = await loopOwner(f), first = owner.make()
    f.loseNextAck(); await first.start(); await first.check(); await first.stop()
    await owner.store.save((await owner.store.load()).map(loop => {
      const { prompt: _, agentMuxNote: __, ...pendingCompletion } = loop.pendingCompletion!
      return { ...loop, pendingCompletion }
    }))
    const cold = owner.make(); await cold.start(); await cold.resume('private-loop'); owner.at(10); await cold.check()
    expect(cold.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
    expect(cold.list()[0]!.lastDecision).toContain('original automatic message content is unconfirmed')
    expect(cold.list()[0]!.lastDecision).toContain('manual input remains available')
    expect(cold.list()[0]!.pendingCompletion?.operationId).toBe(first.list()[0]!.pendingCompletion?.operationId)
    expect(f.requests).toHaveLength(1)
    await f.runtime.write({ kind: 'agent', hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, 'healthy manual', 'user')
    expect(f.writes).toEqual([payload(continuationWire()), 'healthy manual'])
    expect(f.client.agentSession(f.session.agentSessionId).run).toEqual(f.session.run)
  })

  it('keeps the original input fence when raw human input arrives after the completed-turn observation', async () => {
    const f = await fixture()
    let wrote = false
    const owner = await loopOwner(f, async (loop, tickId, now) => {
      const observed = await f.runtime.observeContinuousProgress(loop, tickId, now)
      if (!wrote) {
        wrote = true
        await f.runtime.write({ kind: 'agent', hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, 'manual raced', 'user')
      }
      return observed
    })
    const manager = owner.make(); await manager.start(); await manager.check()
    expect(f.writes).toEqual(['manual raced'])
    expect(manager.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'skipped' })
    expect(manager.list()[0]?.pendingCompletion).toBeUndefined()
  })
})


async function trackerLoop(f: Awaited<ReturnType<typeof fixture>>) {
  const owner = await loopOwner(f), manager = owner.make()
  const root = await mkdtemp(join(tmpdir(), 'agentmux-task-source-')); directories.push(root)
  const tracker = await privateTracker(root), source = await tracker.create('bound')
  await owner.store.save((await owner.store.load()).map(loop => ({ ...loop, taskSource: source })))
  await tracker.run('start-task', '--feature', source.ownerId, '--task', 'T-001')
  return { ...owner, manager, tracker, source }
}

describe('the Main loop consumes one explicit public task source', () => {
  it('pauses all-tasks-done pending closeout and completes only the publicly archived Feature', async () => {
    const f = await fixture(), bound = await trackerLoop(f)
    await bound.tracker.run('run-task-gate', '--feature', bound.source.ownerId, '--task', 'T-001')
    await bound.tracker.run('finish-task', '--feature', bound.source.ownerId, '--task', 'T-001', '--result', 'done')
    await bound.manager.start(); await bound.manager.check()
    expect(bound.manager.list()).toHaveLength(1)
    expect(bound.manager.list()[0]).toMatchObject({ status: 'paused', taskSource: bound.source, lastOutcome: 'skipped' })
    expect(bound.manager.list()[0]!.lastDecision).toContain('closeout is still required')
    expect(bound.manager.list()[0]!.lastDecision).not.toContain('business complete')
    expect(f.requests).toEqual([])
    await bound.tracker.run('closeout-feature', '--feature', bound.source.ownerId, '--mode', 'archive', '--execute', ...bound.tracker.closeoutArgs)
    await bound.manager.resume('private-loop'); await bound.manager.checkNow('private-loop')
    expect(bound.manager.list()[0]).toMatchObject({ status: 'stopped', taskSource: bound.source, lastOutcome: 'skipped' })
    expect(bound.manager.list()[0]!.lastDecision).toContain('business complete (archived)')
    expect(f.requests).toEqual([])
  }, 30_000)

  it('keeps genuine blocked and unreadable source facts separate and leaves manual input available', async () => {
    const f = await fixture(), bound = await trackerLoop(f)
    await bound.tracker.run('finish-task', '--feature', bound.source.ownerId, '--task', 'T-001', '--result', 'blocked', '--blocked-reason-class', 'external_blocker', '--blocked-reason', 'Private dependency unavailable', '--blocked-owner', 'Private test', '--blocked-resume-when', 'Private dependency available')
    await bound.manager.start(); await bound.manager.check()
    expect(bound.manager.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'skipped' })
    expect(bound.manager.list()[0]!.lastDecision).toContain('external_blocker: Private dependency unavailable')
    await bound.manager.stop()
    const stored = (await bound.store.load()).map(loop => ({ ...loop, status: 'active' as const, taskSource: { ...bound.source, ownerId: 'f-missing' } }))
    await bound.store.save(stored)
    const restarted = bound.make(); await restarted.start(); await restarted.checkNow('private-loop')
    expect(restarted.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
    expect(restarted.list()[0]!.lastDecision).not.toContain('business complete')
    expect(f.requests).toEqual([])
    await f.runtime.write({ kind: 'agent', hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, 'manual still works', 'user')
    expect(f.writes).toEqual(['manual still works'])
  }, 30_000)

  it('stops discarded and transferred sources without success or replacing the binding', async () => {
    const f = await fixture(), bound = await trackerLoop(f)
    await bound.tracker.run('finish-task', '--feature', bound.source.ownerId, '--task', 'T-001', '--result', 'cancelled', '--cancel-reason', 'Private cancellation')
    await bound.tracker.run('discard-feature', '--feature', bound.source.ownerId, '--reason', 'cancelled', ...bound.tracker.closeoutArgs)
    await bound.manager.start(); await bound.manager.check()
    expect(bound.manager.list()[0]).toMatchObject({ status: 'stopped', taskSource: bound.source })
    expect(bound.manager.list()[0]!.lastDecision).toContain('discarded; not business success')
    const next = await bound.tracker.create('transfer'), replacement = await bound.tracker.create('replacement', true, next.ownerId)
    await bound.tracker.run('transfer-feature', '--feature', next.ownerId, '--replacement', replacement.ownerId, ...bound.tracker.closeoutArgs)
    const loop = await bound.manager.create({ ...bound.manager.list()[0]!, intervalMs: 10, prompt: 'continue', taskSource: next })
    await bound.manager.checkNow(loop.loopId)
    expect(bound.manager.list().at(-1)).toMatchObject({ status: 'stopped', taskSource: next })
    expect(bound.manager.list().at(-1)!.lastDecision).toContain('transferred; not business success')
    expect(bound.manager.list().at(-1)!.lastDecision).toContain(replacement.ownerId)
    expect(f.requests).toEqual([])
  }, 30_000)

  it('keeps an unpublished proposal and wrong-owner source uncertain without deriving a new frontier', async () => {
    const f = await fixture(), bound = await trackerLoop(f)
    const unplanned = await bound.tracker.create('unplanned', false)
    await bound.store.save((await bound.store.load()).map(loop => ({ ...loop, taskSource: unplanned })))
    await bound.manager.start(); await bound.manager.check()
    expect(bound.manager.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown', taskSource: unplanned })
    expect(bound.manager.list()[0]!.lastDecision).toContain('missing persisted owner receipt')
    await bound.manager.stop()
    // A broken selected reader returns a genuine public receipt for a different Feature.
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    const proxy = join(bound.source.root, 'wrong-reader.sh')
    await writeFile(proxy, `exec /bin/bash ${quote(bound.source.readerPath)} get-owner-receipt --root ${quote(bound.source.root)} --feature ${quote(bound.source.ownerId)} --json\n`)
    const wrong = { ...unplanned, readerPath: proxy }
    await bound.store.save((await bound.store.load()).map(loop => ({ ...loop, status: 'active' as const, taskSource: wrong })))
    const restarted = bound.make(); await restarted.start(); await restarted.checkNow('private-loop')
    expect(restarted.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown', taskSource: wrong })
    expect(restarted.list()[0]!.lastDecision).toContain('identity, version or lifecycle is unconfirmed')
    expect(f.requests).toEqual([])
  }, 30_000)

  it('does not let source unavailability cancel or rebuild a frozen unknown operation', async () => {
    const f = await fixture(), bound = await trackerLoop(f)
    f.loseNextAck(); await bound.manager.start(); await bound.manager.check()
    const pending = bound.manager.list()[0]?.pendingCompletion
    expect(pending).toBeDefined(); expect(f.requests).toHaveLength(1)
    await bound.manager.stop()
    await bound.store.save((await bound.store.load()).map(loop => ({ ...loop, taskSource: { ...bound.source, ownerId: 'f-missing' } })))
    const restarted = bound.make(); await restarted.start(); await restarted.resume('private-loop'); await restarted.checkNow('private-loop')
    expect(f.requests[1]).toEqual(f.requests[0])
    expect(f.writes).toEqual([payload(continuationWire()), '\r'])
    expect(restarted.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'sent' })
    expect(restarted.list()[0]?.pendingCompletion).toBeUndefined()
  }, 30_000)
})
