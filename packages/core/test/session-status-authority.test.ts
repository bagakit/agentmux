import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { fixturePath } from './helpers/fixture-values.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeController } from '../../../apps/desktop/src/main/runtime-controller.js'
import { projectRuntimeEvent } from '../../../apps/desktop/src/renderer/src/lib/session-state.js'
import type { AppConfig } from '../../../apps/desktop/src/shared/contracts.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore, normalizeStoredAgentSession } from '../src/agent-session-store.js'
import { AgentHookServer } from '../src/hook-server.js'
import { AgentMuxError } from '../src/errors.js'
import { agentTurnCompletionIdentity, agentTurnEndEvidence } from '../src/agent-session-identity.js'
import { parseRpcAgentSession } from '../src/rpc-native-codec.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { currentAgentSemanticStatus, observeAgent } from '../src/agent-status-freshness.js'
import { retiredReopenFixture } from './fixtures/retired-reopen.js'
import type { AgentMuxStoredAgentSession, NativeHookEnvelope, AgentMuxClientEvent } from '../src/types.js'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const fixtureReceipts: Array<{ processId: number; mainNativeSessionId: string; childNativeSessionId: string; exited: boolean; recordsRemoved: boolean }> = []
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (process.env.AGENTMUX_STATUS_PROOF_FILE) await writeFile(process.env.AGENTMUX_STATUS_PROOF_FILE, JSON.stringify({ userRuntimeTouched: false, privateFixtures: fixtureReceipts, cleanup: { remaining: fixtureReceipts.filter(item => !item.exited || !item.recordsRemoved) } }, null, 2))
})

async function processWitness() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-status-authority-')))
  const main = join(root, 'rollout-main.jsonl'), child = join(root, 'rollout-child.jsonl')
  await writeFile(main, JSON.stringify({ type: 'session_meta', payload: { id: 'main-native', source: 'cli' } }) + '\n')
  await writeFile(child, JSON.stringify({ type: 'session_meta', payload: { id: 'child-native', source: { subagent: { thread_spawn: { parent_thread_id: 'main-native' } } } } }) + '\n')
  const process: ChildProcess = spawn(processExec(), ['-e', "const fs=require('fs'); for(const p of process.argv.slice(1)) fs.openSync(p,'r+'); console.log('open');setInterval(()=>{},1000)", main, child], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const receipt = { processId: process.pid!, mainNativeSessionId: 'main-native', childNativeSessionId: 'child-native', exited: false, recordsRemoved: false }; fixtureReceipts.push(receipt)
  cleanup.push(async () => {
    if (process.exitCode === null && process.signalCode === null) { process.kill('SIGTERM'); await new Promise<void>(resolve => process.once('exit', () => resolve())) }
    receipt.exited = process.exitCode !== null || process.signalCode !== null
    await rm(root, { recursive: true, force: true }); receipt.recordsRemoved = true
  })
  await new Promise<void>((resolve, reject) => { process.stdout!.once('data', () => resolve()); process.once('error', reject); process.once('exit', code => reject(new Error(`Private witness exited ${code}`))) })
  return { root, pid: process.pid!, main, stopPrivate: async () => {
    if (process.exitCode === null && process.signalCode === null) { process.kill('SIGTERM'); await new Promise<void>(resolve => process.once('exit', () => resolve())) }
  } }
}
function processExec() { return process.execPath }

type Internals = {
  connected: boolean; registry: { load(host: string): Promise<void> }
  kernel: Record<string, any>; hookServer: AgentHookServer
  acceptHookEvent(event: NativeHookEnvelope, signal: AbortSignal): Promise<void>
}
async function harness(options: { provider?: string; legacy?: boolean; hookBound?: boolean; protectedTarget?: boolean; nativePath?: boolean; unavailable?: boolean } = {}) {
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  const fixture = await processWitness(), providerId = options.provider ?? 'codex'
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', fixture.root)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(fixture.root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(fixture.root, 'messages.ndjson'))
  const store = new AgentMuxMemoryAgentSessionStore()
  const initial: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'status-subject', providerId, executorId: providerId,
    hostId: 'local', workspacePath: fixture.root, run: { runId: `private-${fixture.pid}` }, retiredRuns: [],
    hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1),
    ...(options.legacy || options.hookBound || options.protectedTarget ? { nativeHandle: { kind: 'provider' as const, providerId, sessionId: 'old-native', ...(options.nativePath ? { transcriptPath: fixture.main } : {}) } } : {}),
    ...(options.hookBound ? { nativeBinding: { source: 'native-hook' as const, run: { runId: `private-${fixture.pid}` }, observedAt: reshapeFixtureEpoch(0, 0, 1) } } : {}),
    ...(options.protectedTarget ? { nativeBinding: { source: 'semantic-resume-target' as const, run: { runId: `private-${fixture.pid}` }, observedAt: reshapeFixtureEpoch(0, 0, 1) } } : {})
  }
  await store.compareAndSwap(null, initial)
  const client = new AgentMuxClient({ store }), internal = client as unknown as Internals
  await internal.registry.load('local'); internal.connected = true
  let inputBytes = 0, processId = options.unavailable ? 2147483000 : fixture.pid
  const run = () => ({ nativeService: null, runId: initial.run.runId, lifecycleOperationId: null, program: processExec(), args: [],
    workspacePath: fixture.root, pid: processId, state: { type: 'running' }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: inputBytes })
  internal.kernel.isConnected = () => true
  internal.kernel.status = async () => run()
  internal.kernel.list = async () => [run()]
  internal.kernel.identity = () => ({ daemonInstanceId: 'private-fixture-runtime' })
  internal.kernel.input = async (_run: string, op: { data: string }) => { const startByte = inputBytes; inputBytes += Buffer.byteLength(op.data); return { run: run(), appliedByteRange: { startByte, endByte: inputBytes } } }
  internal.kernel.cancelContinuationRender = () => {}
  internal.kernel.prepareStop = async (runId: string, operationKey: string) => ({ runId, operationKey, daemonInstance: 'private-fixture-runtime' })
  internal.kernel.stop = async () => fixture.stopPrivate()
  internal.kernel.start = vi.fn(async () => { throw new Error('Private counterexample forbids starting another process') })
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  const server = new AgentHookServer((event, signal) => internal.acceptHookEvent(event, signal), 0)
  internal.hookServer = server
  await server.start(); const binding = server.createBinding(initial.agentSessionId, providerId, initial.hookBindingId, initial.hookToken)
  await binding.bindRun(initial.run.runId)
  cleanup.push(async () => { await client.dispose() })
  let count = 0
  const post = async (eventName: string, payload: Record<string, unknown> = {}) => {
    return await fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: `receipt-${++count}`, eventName, payload: { session_id: 'main-native', ...payload } }) })
  }
  const feed = async (eventName: string, payload: Record<string, unknown> = {}) => {
    const response = await post(eventName, payload)
    expect(response.status, await response.text()).toBe(204)
  }
  let submission = 0
  const consume = async () => {
    // The existing ordered Runtime byte port is the fixture seam; Core owns the semantic claim.
    await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(initial.agentSessionId)),
      agentSessionId: initial.agentSessionId, operationId: `private-semantic-${++submission}`, prompt: 'new task', execution: 'immediate' })
  }
  return { client, store, kernel: internal.kernel, server, binding, post, feed, consume, events, initial, fixture, setPid: (pid: number) => { processId = pid }, stored: async () => (await store.load())[0]!, input: (source: 'user' | 'terminal-protocol' = 'user') => client.writeAgent({ agentSessionId: initial.agentSessionId, expectedRun: initial.run, source, data: 'x' }) }
}

describe('Session status authority through authenticated Core ingress and public observation', () => {
  it('consumes current idle without erasing historical completion or inventing ACK activity', async () => {
    const h = await harness(); await h.feed('Stop')
    const before = await h.stored(), completion = agentTurnCompletionIdentity(before)
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('idle')
    await h.input()
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('idle')
    await h.consume()
    const after = await h.stored()
    expect(after.semanticStatus?.state).toBe('done')
    expect(agentTurnCompletionIdentity(after)).toBe(completion)
    expect(agentTurnEndEvidence(after)?.id).toBe(before.terminalPromptReadiness?.id)
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation).toMatchObject({ semantic: 'unknown', readiness: 'ready', process: 'running' })
    expect(parseRpcAgentSession((await h.client.statusAgent(h.initial.agentSessionId)).session).semanticStatus?.idleEvidenceConsumed).toBe(true)
    await h.feed('PostToolUse', { tool_name: 'shell' })
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('unknown')
    expect((await h.stored()).hookReceipt?.decision).toMatchObject({ activityApplied: false, reason: 'main-turn-already-ended' })
    await h.feed('UserPromptSubmit'); expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('active')
    await h.feed('Stop'); expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('idle')
  })
  it('terminal protocol replies do not consume a completed user turn', async () => {
    const h = await harness(); await h.feed('Stop'); await h.input('terminal-protocol')
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('idle')
  })
  it('fresh child work contributes overall activity without reopening the ended main turn or replacing its locator', async () => {
    const h = await harness(); await h.feed('Stop'); const before = await h.stored()
    await h.feed('PreToolUse', { agent_id: 'child-native', tool_name: 'request_user_input', transcript_path: fixturePath("foreign-child-record") })
    // A child's permission is not a main interaction or a working observation.
    expect((await h.stored()).pendingInteraction).toBeUndefined()
    await h.feed('PostToolUse', { agent_id: 'child-native', tool_name: 'shell' })
    const after = await h.stored()
    expect(after.nativeHandle).toEqual(before.nativeHandle)
    expect(after.semanticStatus?.observedAt).toBe(before.semanticStatus?.observedAt)
    expect(agentTurnEndEvidence(after)?.id).toBe(before.terminalPromptReadiness?.id)
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('active')
    expect(parseRpcAgentSession((await h.client.statusAgent(h.initial.agentSessionId)).session).hookReceipt).toMatchObject({ subject: { kind: 'child', reason: 'codex-child-of-confirmed-main' }, decision: { activityApplied: true, lifecycleApplied: false } })
    await h.feed('PostToolUse', { tool_name: 'shell' })
    expect((await h.stored()).semanticStatus?.observedAt).toBe(before.semanticStatus?.observedAt)
    await h.input(); expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('active')
    await h.consume(); expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('unknown')
  })
  it('keeps pending parent completion until the proven child settles', async () => {
    const h = await harness(); await h.feed('SubagentStart', { agent_id: 'child-native' }); await h.feed('Stop')
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('active')
    const boundary = (await h.stored()).terminalPromptReadiness!.id
    await h.feed('SubagentStop', { agent_id: 'child-native' })
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('idle')
    expect((await h.stored()).terminalPromptReadiness?.id).not.toBeUndefined()
    expect(boundary).not.toBeUndefined()
  })
  it('an unconfirmed child cannot borrow a confirmed parent membership', async () => {
    const h = await harness(); await h.feed('PostToolUse', { agent_id: 'unopened-foreign-child', tool_name: 'shell' })
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('unknown')
    expect((await h.stored()).hookReceipt?.subject).toMatchObject({ kind: 'unknown', reason: 'native-child-membership-unconfirmed' })
    expect((await h.stored()).nativeHandle).toBeUndefined()
  })
  it('process witness admits the actual main despite a legacy locator mismatch and preserves that unknown target', async () => {
    const h = await harness({ legacy: true }); await h.feed('UserPromptSubmit')
    const session = await h.stored()
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('active')
    expect(session.nativeHandle?.sessionId).toBe('old-native')
    expect(session.observedNativeHandle?.sessionId).toBe('main-native')
    expect(session.hookReceipt?.subject?.kind).toBe('main')
    expect(h.events.some(event => event.type === 'agent-error' && event.code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')).toBe(true)
  })
  it('public locator provenance reports the actual promotion or retained foreign target', async () => {
    const corrected = await harness({ hookBound: true }); await corrected.feed('UserPromptSubmit')
    const accepted = parseRpcAgentSession((await corrected.client.statusAgent(corrected.initial.agentSessionId)).session)
    expect(accepted.nativeHandle?.sessionId).toBe('main-native')
    expect(accepted.nativeBinding).toMatchObject({ source: 'process-witness', run: corrected.initial.run })
    expect(accepted.observedNativeHandle).toBeUndefined()
    expect(accepted.hookReceipt).toMatchObject({ subject: { kind: 'main' }, decision: { activityApplied: true } })
    expect(corrected.events.filter(event => event.type === 'agent-error' && event.code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')).toHaveLength(0)

    const foreign = await harness({ hookBound: true }); await foreign.feed('UserPromptSubmit', { session_id: 'foreign-native' })
    const retained = parseRpcAgentSession((await foreign.client.statusAgent(foreign.initial.agentSessionId)).session)
    expect(retained.nativeHandle?.sessionId).toBe('old-native')
    expect(retained.nativeBinding?.source).toBe('native-hook')
    expect(retained.observedNativeHandle?.sessionId).toBe('main-native')
    expect(retained.hookReceipt).toMatchObject({ subject: { kind: 'foreign' }, decision: { activityApplied: false } })
    expect(foreign.events.filter(event => event.type === 'agent-error' && event.code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('The target was preserved'), evidence: expect.objectContaining({ run: foreign.initial.run }) })
    ])
  })
  it('retirement preserves a known locator mismatch and public Continue refuses that exact wrong target', async () => {
    const h = await harness({ legacy: true }); await h.feed('UserPromptSubmit')
    await h.client.stopAgent(h.initial.agentSessionId, h.initial.run)
    const descriptor = (await h.client.sessionHistorySources())[0]!
    expect(descriptor.state).toBe('retired')
    expect(descriptor.history?.nativeHandle?.sessionId).toBe('old-native')
    expect(descriptor.history?.observedNativeHandle?.sessionId).toBe('main-native')
    await expect(h.client.reopenAgent({ agentSessionId: h.initial.agentSessionId, expectedRetiredAt: descriptor.retiredAt!, operationId: 'private-continue-refusal' })).rejects.toMatchObject({ code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED' })
    expect(h.kernel.start).not.toHaveBeenCalled()
    expect((await h.client.sessionHistorySources())[0]?.history?.nativeHandle?.sessionId).toBe('old-native')
  })
  it('never redirects an explicit Level B target when the Run witness differs', async () => {
    const h = await harness({ protectedTarget: true }); await h.feed('UserPromptSubmit')
    const session = await h.stored()
    expect(session.nativeHandle?.sessionId).toBe('old-native')
    expect(session.nativeBinding?.source).toBe('semantic-resume-target')
    expect(session.hookReceipt).toMatchObject({ subject: { kind: 'unknown', reason: 'resume-target-mismatch' }, decision: { activityApplied: false } })
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('unknown')
    expect((await h.input()).appliedByteRange).not.toBeNull()
  })
  it.each([
    { provider: 'claude', key: 'session_id', start: 'UserPromptSubmit', permission: 'PermissionRequest', tool: { tool_name: 'Bash', tool_use_id: 'native-call', tool_input: { command: 'Private fixture command' } } },
    { provider: 'copilot', key: 'sessionId', start: 'userPromptSubmitted', permission: 'permissionRequest', tool: { toolName: 'bash', toolArgs: { command: 'Private fixture command' } } }
  ])('$provider native identity changes require declared membership and retain an exact Level B target', async protocol => {
    const first = await harness({ provider: protocol.provider }); await first.feed(protocol.start, { [protocol.key]: 'old-native' })
    expect((await first.client.statusAgent(first.initial.agentSessionId)).observation.semantic).toBe('active')
    expect(parseRpcAgentSession(first.client.agentSession(first.initial.agentSessionId)).nativeHandle?.sessionId).toBe('old-native')
    expect(first.client.agentSession(first.initial.agentSessionId).hookReceipt?.subject?.reason).toBe('native-session-first-observation')
    for (const protectedTarget of [false, true]) {
      const h = await harness({ provider: protocol.provider, legacy: !protectedTarget, protectedTarget })
      await h.feed(protocol.permission, { [protocol.key]: 'foreign-native', ...protocol.tool, agentmuxUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, observedAt: reshapeFixtureEpoch(0, 0, 1) } })
      const rejected = parseRpcAgentSession((await h.client.statusAgent(h.initial.agentSessionId)).session)
      expect(rejected.nativeHandle?.sessionId).toBe('old-native')
      expect(rejected.pendingInteraction).toBeUndefined(); expect(rejected.turnUsage).toBeUndefined()
      expect(rejected.hookReceipt).toMatchObject({ lifecycleEvent: null,
        subject: { kind: protectedTarget ? 'unknown' : 'foreign', reason: protectedTarget ? 'resume-target-mismatch' : 'native-session-mismatch' },
        decision: { activityApplied: false, lifecycleApplied: false } })
      expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('unknown')
      expect(h.events.some(event => event.type === 'agent-error' && event.code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')).toBe(true)
      expect((await h.input()).appliedByteRange).not.toBeNull()
      await h.feed(protocol.start, { [protocol.key]: 'old-native' })
      expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('active')
      if (protectedTarget) expect(h.client.agentSession(h.initial.agentSessionId).nativeBinding?.source).toBe('semantic-resume-target')
      const accepted = h.client.agentSession(h.initial.agentSessionId)
      expect(accepted.hookReceipt?.subject?.reason).toBe('native-session-match')
      await h.feed(protocol.permission, { [protocol.key]: 'foreign-native', ...protocol.tool })
      const after = parseRpcAgentSession(h.client.agentSession(h.initial.agentSessionId))
      expect(after.nativeHandle).toEqual(accepted.nativeHandle)
      expect(after.semanticStatus).toEqual(accepted.semanticStatus)
      expect(after.pendingInteraction).toBeUndefined()
      expect(after.hookReceipt?.decision?.activityApplied).toBe(false)
      expect(after.hookReceipt?.subject?.reason).toBe(protectedTarget ? 'resume-target-mismatch' : 'native-session-mismatch')
    }
  })
  it('explicit Provider native transitions remain legal for ordinary sessions and cannot redirect a resume target', async () => {
    const ordinary = await harness({ provider: 'pi', legacy: true, nativePath: true })
    await ordinary.feed('session_start', { session_id: 'fork-native', reason: 'fork', previousSessionFile: ordinary.fixture.main, session_file: join(ordinary.fixture.root, 'fork.jsonl') })
    expect(ordinary.client.agentSession(ordinary.initial.agentSessionId).nativeHandle?.sessionId).toBe('fork-native')
    expect(ordinary.client.agentSession(ordinary.initial.agentSessionId).hookReceipt?.subject?.reason).toBe('provider-native-membership')
    const resumed = await harness({ provider: 'pi', protectedTarget: true, nativePath: true })
    await resumed.feed('session_start', { session_id: 'fork-native', reason: 'fork', previousSessionFile: resumed.fixture.main, session_file: join(resumed.fixture.root, 'fork.jsonl') })
    const result = parseRpcAgentSession(resumed.client.agentSession(resumed.initial.agentSessionId))
    expect(result.nativeHandle).toEqual(resumed.initial.nativeHandle)
    expect(result.nativeBinding?.source).toBe('semantic-resume-target')
    expect(result.hookReceipt).toMatchObject({ subject: { kind: 'unknown', reason: 'resume-target-mismatch' }, decision: { activityApplied: false, lifecycleApplied: false } })
    expect((await resumed.input()).appliedByteRange).not.toBeNull()
    await resumed.feed('before_agent_start', { session_id: 'old-native' })
    expect(resumed.client.agentSession(resumed.initial.agentSessionId).nativeHandle).toEqual(resumed.initial.nativeHandle)
    expect(resumed.client.agentSession(resumed.initial.agentSessionId).nativeBinding?.source).toBe('semantic-resume-target')
  })
  it('Core rejects adapter output that redirects an explicit Level B target while retaining public Run input', async () => {
    const h = await harness({ provider: 'pi', protectedTarget: true, nativePath: true })
    const provider = h.client.providers.get('pi'), normalize = provider.normalizeHook
    // A deliberately invalid adapter seam ignores the supplied protected target contract.
    vi.spyOn(provider, 'normalizeHook').mockImplementation((envelope, context) => normalize(envelope, { ...context, protectedNativeTarget: false }))
    const response = await h.post('session_start', { session_id: 'fork-native', reason: 'fork', previousSessionFile: h.fixture.main, session_file: join(h.fixture.root, 'fork.jsonl') })
    expect(response.status).toBe(503); await response.text()
    expect(parseRpcAgentSession(h.client.agentSession(h.initial.agentSessionId)).nativeHandle).toEqual(h.initial.nativeHandle)
    expect(h.client.agentSession(h.initial.agentSessionId).hookReceipt).toBeUndefined()
    expect(h.events.some(event => event.type === 'agent-error' && event.code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')).toBe(true)
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.process).toBe('running')
    expect((await h.input()).appliedByteRange).not.toBeNull()
  })
  it('foreign and missing process-native evidence remain explained unknown without taking away input', async () => {
    const h = await harness(); await h.feed('UserPromptSubmit', { session_id: 'foreign-native' })
    expect((await h.stored()).hookReceipt).toMatchObject({ subject: { kind: 'foreign' }, decision: { activityApplied: false } })
    const unavailable = await harness({ unavailable: true }); await unavailable.feed('UserPromptSubmit')
    expect((await unavailable.stored()).hookReceipt?.subject).toMatchObject({ kind: 'unknown', reason: 'native-witness-unavailable' })
    expect((await unavailable.input()).appliedByteRange).not.toBeNull()
  })
  it('keeps missing-witness work bounded and retries through the existing explicit native history refresh', async () => {
    const h = await harness({ unavailable: true })
    const discovery = vi.spyOn(h.client.providers.get('codex'), 'discoverNativeSession')
    await h.feed('UserPromptSubmit'); await h.feed('PostToolUse', { agent_id: 'child-native', tool_name: 'shell' })
    expect(discovery).toHaveBeenCalledTimes(1)
    h.setPid(h.fixture.pid)
    await expect(h.client.sessionHistoryPage(h.initial.agentSessionId, { limit: 1, commandOverride: fixturePath("private-status-fixture-missing-helper") })).rejects.toThrow('configured native read helper')
    await h.feed('UserPromptSubmit')
    expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('active')
    expect((await h.stored()).nativeHandle?.transcriptPath).toBe(h.fixture.main)
  })
  it.each([1, 2])('abandoned witness status %i drains the real Hook ingress without cancelling the Run', async stalledCall => {
    const h = await harness(), status = h.kernel.status
    let calls = 0, release!: (value: unknown) => void
    h.kernel.status = async (...args: unknown[]) => ++calls === stalledCall
      ? await new Promise(resolve => { release = resolve }) : await status(...args)
    try {
      const timedOut = await h.post('UserPromptSubmit')
      expect(timedOut.status).toBe(503); await timedOut.text()
      const bindings = (h.server as unknown as { bindings: Map<string, { accepting: boolean }> }).bindings
      await vi.waitFor(() => expect(bindings.get(h.binding.endpoint.token)?.accepting).toBe(true), { timeout: 500 })
      await h.feed('UserPromptSubmit')
      expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('active')
      expect((await h.input()).appliedByteRange).not.toBeNull()
    } finally { release?.(await status(h.initial.run.runId)) }
  })
  it('actual Main snapshot and Renderer consume the same current facts and retain historical completion', async () => {
    const h = await harness(); await h.feed('Stop')
    const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: {}, workspaces: [],
      appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
    const controller = new RuntimeController(h.store, async () => h.client)
    controller.commit(await controller.prepare(config))
    cleanup.push(async () => controller.dispose())
    const before = await controller.snapshot(config)
    expect(before.sessions[0]?.status.state).toBe('done')
    const state = { sessions: before.sessions, timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
    await h.input()
    const core = (await h.client.statusAgent(h.initial.agentSessionId)).session
    const live = projectRuntimeEvent(state, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: core } }).state
    expect(live.sessions[0]?.status.state).toBe('done')
    expect(live.sessions[0]?.semanticStatus?.state).toBe('done')
    expect(live.tabs).toBe(state.tabs); expect(live.layouts).toBe(state.layouts)
    const cold = await controller.snapshot(config)
    expect(cold.sessions[0]?.status.state).toBe('done')
    expect(cold.sessions[0]?.semanticStatus?.state).toBe('done')
    await h.feed('PostToolUse', { agent_id: 'child-native', tool_name: 'shell' })
    const child = (await h.client.statusAgent(h.initial.agentSessionId)).session
    const active = projectRuntimeEvent(live, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: child } }).state
    expect(active.sessions[0]?.status.state).toBe('working')
    expect((await controller.snapshot(config)).sessions[0]?.status.state).toBe('working')
    expect(active.sessions[0]?.semanticStatus?.observedAt).toBe(core.semanticStatus?.observedAt)
    const childRevision = child.semanticStatus!.currentActivityRevision!
    await h.consume()
    const consumed = parseRpcAgentSession((await h.client.statusAgent(h.initial.agentSessionId)).session)
    const revoked = projectRuntimeEvent(active, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: consumed } }).state
    expect(revoked.sessions[0]?.status.state).toBe('running')
    expect((await controller.snapshot(config)).sessions[0]?.status.state).toBe('running')
    expect(consumed.semanticStatus?.currentActivityRevision).toBeGreaterThan(childRevision)
    expect(consumed.semanticStatus?.observedAt).toBe(core.semanticStatus?.observedAt)
    expect(consumed.semanticStatus?.state).toBe('done')
    expect(consumed.semanticStatus?.aggregateActivityAt).toBeUndefined()
    expect(agentTurnCompletionIdentity(consumed)).toBe(agentTurnCompletionIdentity(core))
    // Replaying an old child snapshot cannot roll the current owner revision back.
    expect(projectRuntimeEvent(revoked, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: child } }).state).toBe(revoked)
    await h.input()
    expect((await h.client.statusAgent(h.initial.agentSessionId)).session.semanticStatus?.currentActivityRevision).toBe(consumed.semanticStatus?.currentActivityRevision)
    await h.feed('PostToolUse', { agent_id: 'child-native', tool_name: 'shell' })
    const again = (await h.client.statusAgent(h.initial.agentSessionId)).session
    const workingAgain = projectRuntimeEvent(revoked, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: again } }).state
    expect(workingAgain.sessions[0]?.status.state).toBe('working')
    await h.consume()
    const consumedAgain = (await h.client.statusAgent(h.initial.agentSessionId)).session
    const unknownAgain = projectRuntimeEvent(workingAgain, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: consumedAgain } }).state
    expect(unknownAgain.sessions[0]?.status.state).toBe('running')
    expect((await controller.snapshot(config)).sessions[0]?.status.state).toBe('running')
    const disconnected = { ...workingAgain, sessions: workingAgain.sessions.map(item => ({ ...item, status: { ...item.status, state: 'disconnected' as const } })) }
    expect(projectRuntimeEvent(disconnected, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: consumedAgain } }).state.sessions[0]?.status.state).toBe('disconnected')
  })
  it('first child activity followed by semantic admission revokes current work even with an unchanged native clock', async () => {
    const h = await harness(); const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    await h.feed('Stop'); const completed = (await h.client.statusAgent(h.initial.agentSessionId)).session
    expect(completed.semanticStatus?.currentActivityRevision).toBeUndefined()
    const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: {}, workspaces: [],
      appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
    const controller = new RuntimeController(h.store, async () => h.client)
    controller.commit(await controller.prepare(config)); cleanup.push(async () => controller.dispose())
    const before = await controller.snapshot(config)
    const state = { sessions: before.sessions, timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
    await h.feed('PostToolUse', { agent_id: 'child-native', tool_name: 'shell' })
    const child = (await h.client.statusAgent(h.initial.agentSessionId)).session
    expect(currentAgentSemanticStatus(child.semanticStatus)?.state).toBe('working')
    const active = projectRuntimeEvent(state, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: child } }).state
    expect(active.sessions[0]?.status.state).toBe('working')
    expect((await controller.snapshot(config)).sessions[0]?.status.state).toBe('working')
    await h.consume()
    const consumed = parseRpcAgentSession((await h.client.statusAgent(h.initial.agentSessionId)).session)
    expect(currentAgentSemanticStatus(consumed.semanticStatus)?.state).toBe('running')
    expect(consumed.semanticStatus?.currentActivityRevision).toBeGreaterThan(child.semanticStatus!.currentActivityRevision!)
    expect(consumed.semanticStatus?.observedAt).toBe(child.semanticStatus?.aggregateActivityAt)
    expect(agentTurnCompletionIdentity(consumed)).toBe(agentTurnCompletionIdentity(completed))
    const unknown = projectRuntimeEvent(active, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: consumed } }).state
    expect(unknown.sessions[0]?.status.state).toBe('running')
    expect((await controller.snapshot(config)).sessions[0]?.status.state).toBe('running')
    // Even an accepted equal Session timestamp cannot replay an earlier owner activity revision.
    expect(projectRuntimeEvent(unknown, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: child } }).state).toBe(unknown)
    await h.feed('UserPromptSubmit')
    const reopened = (await h.client.statusAgent(h.initial.agentSessionId)).session
    expect(reopened.semanticStatus?.currentActivityRevision).toBeGreaterThan(consumed.semanticStatus!.currentActivityRevision!)
    expect(reopened.semanticStatus?.observedAt).toBe(consumed.semanticStatus?.observedAt)
    expect(projectRuntimeEvent(unknown, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: reopened } }).state.sessions[0]?.status.state).toBe('working')
    clock.mockRestore()
  })
  it('public lifecycle target provenance uses this operation observation despite a backwards wall clock', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(reshapeFixtureEpoch(0, 0, 2_000))
    // Existing durable lifecycle fixture controls only SDK process/Hook seams; no native Agent is started.
    const f = await retiredReopenFixture(); cleanup.push(f.close)
    clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 1_000))
    await expect(f.client.reopenAgent(f.input)).resolves.toMatchObject({ nativeBinding: { source: 'semantic-resume-target', observedAt: reshapeFixtureEpoch(0, 0, 1_000) } })
    const reopened = f.client.agentSession(f.old.agentSessionId)
    expect(parseRpcAgentSession(reopened).nativeBinding?.run).toEqual(reopened.run)
    f.inner.kernel.status.mockImplementation(async (id: string) => f.run(id, id !== reopened.run.runId))
    clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 500))
    await expect(f.client.resumeAgent({ agentSessionId: f.old.agentSessionId, operationId: 'private-backwards-clock', prompt: 'Private fixture prompt' })).resolves.toMatchObject({ nativeBinding: { source: 'semantic-resume-target', observedAt: reshapeFixtureEpoch(0, 0, 500) } })
    const resumed = parseRpcAgentSession(f.client.agentSession(f.old.agentSessionId))
    expect(resumed.nativeBinding?.run).toEqual(resumed.run)
    expect(resumed.updatedAt).toBeGreaterThan(reopened.updatedAt)
    expect(f.starts).toHaveLength(2)
    expect(f.stops).toEqual([])
    const pending = await retiredReopenFixture(); cleanup.push(pending.close)
    pending.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => {
      pending.starts.push(input)
      throw new AgentMuxError('Private fixture lost start acknowledgement', 'CTXMUX_io', undefined, { disposition: 'unknown', confirmedInputBytes: null })
    })
    await expect(pending.client.reopenAgent(pending.input)).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
    clock.mockReturnValue(reshapeFixtureEpoch(0, 0, 250))
    await expect(pending.client.reconcileAgentReopen(pending.input)).resolves.toMatchObject({ nativeBinding: { source: 'semantic-resume-target', observedAt: reshapeFixtureEpoch(0, 0, 250) } })
    expect(pending.starts).toHaveLength(1)
    expect(pending.stops).toEqual([])
    clock.mockRestore()
  })
  it('public observation explains neutral main, child-only and pending-parent completion decisions', async () => {
    const h = await harness(); await h.feed('unknown-native-event')
    let session = parseRpcAgentSession((await h.client.statusAgent(h.initial.agentSessionId)).session)
    expect(session.hookReceipt?.subject?.kind).toBe('main')
    expect(session.hookReceipt?.decision).toEqual({ activityApplied: false, lifecycleApplied: false, reason: 'no-semantic-rule' })
    await h.feed('SubagentStop', { agent_id: 'child-native' })
    session = parseRpcAgentSession((await h.client.statusAgent(h.initial.agentSessionId)).session)
    expect(session.hookReceipt?.decision).toEqual({ activityApplied: false, lifecycleApplied: false, reason: 'child-observation-only' })
    await h.feed('SubagentStart', { agent_id: 'child-native' }); await h.feed('Stop'); await h.feed('SubagentStop', { agent_id: 'child-native' })
    session = parseRpcAgentSession((await h.client.statusAgent(h.initial.agentSessionId)).session)
    expect(session.hookReceipt?.subject?.kind).toBe('child')
    expect(session.hookReceipt?.decision).toEqual({ activityApplied: true, lifecycleApplied: true, reason: 'pending-parent-completion-applied' })
  })
  it('nested Hermes protocol shares the public input/completion/current activity boundary', async () => {
    const h = await harness({ provider: 'hermes' }); await h.feed('on_session_end', { extra: { completed: true } })
    const before = await h.stored(); expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('idle')
    await h.input(); expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('idle')
    expect(agentTurnCompletionIdentity(await h.stored())).toBe(agentTurnCompletionIdentity(before))
    await h.feed('pre_llm_call', { extra: { status: 'ok' } }); expect((await h.client.statusAgent(h.initial.agentSessionId)).observation.semantic).toBe('active')
    expect(normalizeStoredAgentSession(await h.stored()).hookReceipt?.decision?.activityApplied).toBe(true)
    expect(h.client.agentSession(h.initial.agentSessionId).hookReceipt?.subject?.reason).toBe('run-bound-protocol')
  })
})
