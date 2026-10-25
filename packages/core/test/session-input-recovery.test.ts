import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentInputSubmissionReceipt } from '../src/agent-input-receipt-codec.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY, type AgentMuxContinuityOperation } from '../src/agent-session-recovery/continuity-contract.js'
import type { AgentInputJournalEntry, AgentInputSubmissionReceipt } from '../src/agent-input-wait.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentMuxMessageEnvelope, AgentMuxMessageIdentity } from '../src/agent-message-envelope.js'
import type { AgentExternalMessageAuthor } from '../src/external-author.js'
import type { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** Actual Core, journal, Store, coordinator and RPC. The Runtime port is controlled;
 * retained continuity operations are authoritative fixture inputs, not a real native resume. */
async function fixture() {
  const h = await rpcOwnerFixture(['sender', 'recipient']); cleanup.push(h.close)
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'retained-native' }
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(original, { ...original, nativeHandle })
  await h.inner.registry.load('local')
  let client = h.client, currentRun = original.run.runId, serial = 0, loseReply = false
  const ended = new Set<string>(), beforeWrites: AgentInputJournalEntry[] = []
  const baseInput = h.inner.kernel.input as (id: string, input: { operationId: string; expectedByte: number; data: string }) => Promise<unknown>
  const queue = Reflect.get(client, 'messageQueue') as DurableAgentMuxMessageQueue
  const key = (id: string) => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: original.run, submissionId: id })
  const input = (id: string, authorHuman = true) => ({ agentSessionId: 'recipient', expectedRun: original.run,
    operationId: id, prompt: 'Retained input ' + id + '\n原文', admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const, authorHuman })
  const run = (id: string) => ({ ...h.run(id), state: ended.has(id) ? { type: 'exited' as const, code: 0, signal: null } : { type: 'running' as const } })
  const writes = vi.fn(async (id: string, op: { operationId: string; expectedByte: number; data: string }) => {
    const current = (await h.store.readMetadata('recipient'))!
    const claimKey = current.promptCompletionAdmission?.inputKey
    if (claimKey) {
      const activeQueue = Reflect.get(client, 'messageQueue') as DurableAgentMuxMessageQueue
      const owner = await activeQueue.resolveInputOwnerKey(claimKey)
      const entry = await activeQueue.inspectInput({ key: owner })
      if (entry) beforeWrites.push(structuredClone(entry))
    }
    const reply = await baseInput(id, op)
    if (loseReply) throw new Error('The original Runtime reply was lost after applying its bytes')
    return reply
  })
  const installRuntime = async (owner: AgentMuxClient, connected: boolean) => {
    const inner = owner as unknown as typeof h.inner
    await inner.registry.load('local'); inner.connected = connected
    inner.kernel.isConnected = () => true
    inner.kernel.identity = () => ({ daemonInstanceId: 'private-runtime', protocolVersion: 1, buildIdentity: 'controlled' })
    inner.kernel.status = vi.fn(async (id: string) => run(id))
    inner.kernel.input = writes
    inner.kernel.stop = vi.fn()
  }
  await installRuntime(client, false)
  const settled = async () => {
    for (;;) {
      const restoring = Reflect.get(client, 'inputWaitingRestore') as Promise<void> | undefined
      if (restoring) await restoring
      const pending = [...(Reflect.get(client, 'inputWaitingRecipients') as Map<string, { pending: Promise<void> }>).values()]
      if (!pending.length && !Reflect.get(client, 'inputWaitingRestore')) return
      await Promise.all(pending.map(entry => entry.pending))
    }
  }
  const publish = (event: Parameters<AgentMuxClientEventPublisher['publish']>[0]) =>
    (Reflect.get(client, 'publisher') as AgentMuxClientEventPublisher).publish(event)
  const wake = async (kind: 'session' | 'connection' = 'session') => {
    Reflect.set(client, 'connected', true)
    publish(kind === 'session' ? { type: 'agent-session', session: client.agentSession('recipient') }
      : { type: 'connection-state', state: 'restored', observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
        evidence: { source: 'run-process', observedAt: 1 } })
    await settled()
  }
  const save = async (id: string, authorHuman = true) => {
    const receipt = await client.submitAgentPrompt(input(id, authorHuman)) as AgentInputSubmissionReceipt
    await settled()
    expect(receipt).toMatchObject({ key: key(id), persistence: 'confirmed' })
    expect((await client.inspectAgentInput({ key: key(id) }))?.status).toBe('waiting')
    expect(writes).not.toHaveBeenCalled()
    return (await queue.inspectInput({ key: key(id) }))!
  }
  const resumeFacts = async (alter?: (next: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession) => {
    const previous = (await h.store.readMetadata('recipient'))!
    ended.add(currentRun); currentRun = 'resumed-recipient-' + ++serial
    const operation: AgentMuxContinuityOperation = { operationId: 'resume-' + serial, agentSessionId: 'recipient', trigger: 'startup',
      policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY, continuationEnabled: false }, previousRun: previous.run, newRun: { runId: currentRun },
      nativeTarget: nativeHandle, admittedAt: 1, observedAt: 1, rechecks: 0, kind: 'resumed', reason: 'run-ended',
      evidence: { kind: 'run-ended', state: 'exited', observedAt: 1 } }
    const next: AgentMuxStoredAgentSession = { ...previous, run: operation.newRun!, retiredRuns: [...previous.retiredRuns, previous.run],
      nativeBinding: { source: 'semantic-resume-target', run: operation.newRun!, observedAt: 1 },
      continuity: operation, continuityOperations: { ...previous.continuityOperations, [operation.operationId]: operation } }
    delete next.promptCompletionAdmission
    delete next.terminalPromptSubmission
    delete next.terminalPromptDelivery
    await h.store.compareAndSwap(previous, alter ? alter(next) : next)
    await (Reflect.get(client, 'registry') as typeof h.inner.registry).load('local')
    return (await h.store.readMetadata('recipient'))!
  }
  const reopen = async () => {
    await client.dispose(); client = new AgentMuxClient({ store: h.store }); const reopened = client; cleanup.push(() => reopened.dispose())
    await installRuntime(client, false)
  }
  // The supplemental lifecycle test runs the real resume owner. Executable
  // discovery, Hook ingress and terminal handshake are controlled leaf ports.
  const resume = async () => {
    const inner = client as any
    inner.connected = true
    inner.kernel.start = vi.fn(async () => { currentRun = 'resumed-recipient-' + ++serial; return { ...run(currentRun), pid: 1234 } })
    inner.kernel.list = async () => [run(currentRun)]
    inner.hookServer.isRunning = () => true
    inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
    inner.ensureManagedHooks = async () => {}
    inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
    const providers = Reflect.get(client, 'providers') as AgentProviderRegistry, builtin = providers.get('codex')
    const { discoverNativeSession: _discovery, observeSessionStatus: _status, ...provider } = builtin
    providers.replace(provider)
    vi.spyOn(client as unknown as { probePreparedAgent: typeof client.probeAgent }, 'probePreparedAgent').mockResolvedValue({ providerId: 'codex', executable: 'codex', installed: true, capabilities: builtin.catalog.capabilities })
    ended.add(currentRun)
    return await client.resumeAgent({ agentSessionId: 'recipient', operationId: 'public-resume', prompt: 'Explicit resume task' })
  }
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'retained-input.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const read = async (id: string) => (await rpc.call('agent.input.inspect', { key: key(id) })).input!
  return { ...h, get client() { return client }, original, nativeHandle, queue, key, input, save, resumeFacts, resume, reopen, wake, settled, writes, beforeWrites, rpc, read,
    loseReply: () => { loseReply = true }, connect: () => { Reflect.set(client, 'connected', true) } }
}

it('first delivers a retained human input on the verified resumed Session and exposes the actual admission through the original RPC key', async () => {
  const h = await fixture(), saved = await h.save('accepted-human'), resumed = await h.resumeFacts()
  await h.wake()
  const receipt = await h.read('accepted-human'), actualKey = { ...saved.intent.key, expectedRun: resumed.run }
  expect(receipt).toMatchObject({ key: saved.intent.key, ref: saved.control.ref, status: 'terminal-confirmed',
    control: { state: 'dispatch-authorized', deliveryKey: actualKey }, admission: { run: resumed.run, admission: { inputKey: actualKey,
      inputDispatch: { ref: saved.control.ref, deliveryKey: actualKey } } } })
  expect(parseAgentInputSubmissionReceipt(receipt)).toEqual(receipt)
  expect(h.writes.mock.calls.map(([id]) => id)).toEqual([resumed.run.runId, resumed.run.runId])
  expect(h.writes.mock.calls.map(([, op]) => op.data)).toEqual(['\u001b[200~' + h.input('accepted-human').prompt + '\u001b[201~', '\r'])
  expect(h.beforeWrites).toHaveLength(2)
  for (const before of h.beforeWrites) {
    expect(before.intent).toEqual(saved.intent)
    expect(before.control).toMatchObject({ ref: saved.control.ref, state: 'dispatch-authorized', deliveryKey: actualKey, gateId: receipt.control.gateId })
  }
  const mailbox = await h.rpc.call('agent.input.ls', { hostId: 'local', agentSessionId: 'recipient' })
  expect(mailbox.items).toHaveLength(1)
  expect(mailbox.items[0]).toMatchObject({ kind: 'item', item: { kind: 'controlled', intent: { key: saved.intent.key }, receipt: { key: saved.intent.key } } })
  await h.wake('connection'); await h.wake()
  expect(h.writes).toHaveBeenCalledTimes(2)
  expect(await h.client.inspectAgentPromptSubmission(saved.intent.key)).toBeNull()
  expect(await h.queue.inspectInput({ key: actualKey })).toBeNull()
  expect(await h.queue.resolveInputOwnerKey(actualKey)).toEqual(saved.intent.key)
  const { admissionIntent: _manual, ...uncontrolled } = h.input('accepted-human')
  const bypass = await h.client.submitAgentPrompt({ ...uncontrolled, expectedRun: resumed.run,
    afterSubmissionId: null }).then(() => null, error => error)
  expect(bypass).toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(h.writes).toHaveBeenCalledTimes(2)
})

it('reopens Core over the original journal and resumes an enabled human wait without a second submit', async () => {
  const h = await fixture(), saved = await h.save('reopened-human')
  await h.reopen(); const resumed = await h.resumeFacts(); await h.wake('connection')
  expect(await h.read('reopened-human')).toMatchObject({ ref: saved.control.ref, key: saved.intent.key, status: 'terminal-confirmed',
    control: { deliveryKey: { ...saved.intent.key, expectedRun: resumed.run } } })
  expect(h.writes).toHaveBeenCalledTimes(2)
})

it('reopens an enabled same-Run human wait after a connection loss without requiring semantic recovery', async () => {
  const h = await fixture(), saved = await h.save('same-run')
  await h.reopen(); await h.wake('connection')
  expect(await h.read('same-run')).toMatchObject({ ref: saved.control.ref, status: 'terminal-confirmed' })
  expect((await h.read('same-run')).control.deliveryKey).toBeUndefined()
  expect(h.writes.mock.calls.every(([id]) => id === h.original.run.runId)).toBe(true)
})

it.each(['native-target', 'provider', 'executor', 'missing-chain', 'ambiguous-chain'] as const)('retains unclaimed input when the recovered %s cannot establish the original target', async mismatch => {
  const h = await fixture(), saved = await h.save('unconfirmed-target')
  await h.resumeFacts(next => {
    if (mismatch === 'native-target') return { ...next, nativeHandle: { ...h.nativeHandle, sessionId: 'another-native' } }
    if (mismatch === 'provider') return { ...next, providerId: 'claude', nativeHandle: { ...h.nativeHandle, providerId: 'claude' } }
    if (mismatch === 'executor') return { ...next, executorId: 'another-executor' }
    if (mismatch === 'missing-chain') { const { continuity: _current, continuityOperations: _operations, ...without } = next; return without }
    return { ...next, continuityOperations: { ...next.continuityOperations, conflicting: { ...next.continuity!, operationId: 'conflicting', previousRun: { runId: 'unrelated-run' } } } }
  })
  await h.wake(); await h.wake('connection')
  expect(h.writes).not.toHaveBeenCalled()
  const receipt = await h.read('unconfirmed-target')
  expect(receipt).toMatchObject({ ref: saved.control.ref, status: 'waiting', admission: null })
  expect(receipt.control.deliveryKey).toBeUndefined()
  expect((await h.queue.inspectInput({ key: saved.intent.key }))?.intent).toEqual(saved.intent)
})

it.each(['stopped', 'authorized-unknown'] as const)('does not reconstruct a %s wait after reopening on a recovered Session', async state => {
  const h = await fixture(), saved = await h.save('retained-control')
  if (state === 'stopped') await h.client.stopAgentInputWaiting({ ref: saved.control.ref, cancelOperationId: 'original-stop' })
  else await h.queue.authorizeInputDispatch(saved.control.ref)
  await h.reopen(); await h.resumeFacts(); await h.wake('connection')
  const receipt = await h.read('retained-control')
  expect(receipt).toMatchObject({ ref: saved.control.ref, status: state === 'stopped' ? 'stopped' : 'unknown' })
  expect(h.writes).not.toHaveBeenCalled()
  expect(receipt.control.deliveryKey).toBeUndefined()
})

it('retains an actual unknown original byte claim across semantic recovery without dispatching it again', async () => {
  const h = await fixture(); h.connect(); h.loseReply()
  const saved = await h.client.submitAgentPrompt(h.input('unknown-applied')) as AgentInputSubmissionReceipt
  await h.settled()
  expect(await h.read('unknown-applied')).toMatchObject({ status: 'unknown', ref: saved.ref })
  expect(h.writes).toHaveBeenCalledTimes(1)
  await h.reopen(); await h.resumeFacts(); await h.wake('connection')
  expect(await h.read('unknown-applied')).toMatchObject({ status: 'unknown', ref: saved.ref })
  expect(h.writes).toHaveBeenCalledTimes(1)
})

it('does not reconstruct nonhuman prompt authority from a durable source flag', async () => {
  const h = await fixture(), saved = await h.save('nonhuman', false)
  await h.reopen(); await h.resumeFacts(); await h.wake('connection')
  expect(await h.read('nonhuman')).toMatchObject({ ref: saved.control.ref, status: 'waiting', admission: null })
  expect(h.writes).not.toHaveBeenCalled()
})

it('keeps a live author check out of cold recovery and rejoins the same input only with current authority', async () => {
  const h = await fixture(), originalAuthority = vi.fn(async () => {})
  const saved = await h.client.submitAgentPrompt(h.input('live-human'), { assertCurrent: originalAuthority }) as AgentInputSubmissionReceipt
  await h.settled(); expect(saved.status).toBe('waiting'); expect(h.writes).not.toHaveBeenCalled()
  const oldChecks = originalAuthority.mock.calls.length
  await h.reopen(); await h.wake('connection')
  expect(await h.read('live-human')).toMatchObject({ key: saved.key, ref: saved.ref, status: 'waiting', admission: null })
  expect(h.writes).not.toHaveBeenCalled(); expect(originalAuthority).toHaveBeenCalledTimes(oldChecks)
  const currentAuthority = vi.fn(async () => {})
  await h.client.rejoinAgentInputWaiting({ ref: saved.ref }, { assertCurrent: currentAuthority }); await h.settled()
  expect(await h.read('live-human')).toMatchObject({ key: saved.key, status: 'terminal-confirmed' })
  expect(currentAuthority).toHaveBeenCalled(); expect(h.writes).toHaveBeenCalledTimes(2)
})

it('first delivers the retained input when the public resume lifecycle publishes its committed original Session', async () => {
  const h = await fixture(), saved = await h.save('lifecycle-human')
  const resumed = await h.resume(); await h.settled()
  expect(resumed.continuity).toMatchObject({ kind: 'resumed', previousRun: h.original.run, newRun: resumed.run, nativeTarget: h.nativeHandle })
  expect(await h.read('lifecycle-human')).toMatchObject({ key: saved.intent.key, ref: saved.control.ref, status: 'terminal-confirmed',
    control: { deliveryKey: { ...saved.intent.key, expectedRun: resumed.run } }, admission: { run: resumed.run } })
  expect(h.writes.mock.calls.map(([id]) => id)).toEqual([resumed.run.runId, resumed.run.runId])
  expect(h.writes.mock.calls[0]![1].data).toBe('\u001b[200~' + h.input('lifecycle-human').prompt + '\u001b[201~')
})

it.each(['agent', 'external'] as const)('does not reconstruct %s message authority when Core reopens', async author => {
  const h = await fixture()
  const external: AgentExternalMessageAuthor = { kind: 'external', connectionId: 'connection',
    actor: { application: { domain: 'example.test', appId: 'app' }, idType: 'user-id', userId: 'external-user' },
    externalConversationId: 'room', externalMessageId: 'external-message', bindingId: 'binding', bindingRevision: 1, grantId: 'grant', grantRevision: 1 }
  const sender: AgentMuxMessageIdentity = author === 'agent' ? { kind: 'agent-session', agentSessionId: 'sender' } : external
  const envelope: AgentMuxMessageEnvelope = { schema: 'agentmux.a2a.v1', messageId: 'foreign-input', operationId: 'foreign-send', createdAt: 1,
    sender, recipient: { kind: 'agent-session', agentSessionId: 'recipient' }, senderSessionId: author === 'agent' ? 'sender' : null,
    senderRunId: author === 'agent' ? 'run-sender' : null, recipientSessionId: 'recipient', recipientRunId: h.original.run.runId,
    threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null, body: 'Original foreign input' }
  const assertCurrent = vi.fn(async () => {})
  const saved = await h.client.submitAgentMessage({ agentSessionId: 'recipient', envelope,
    admissionIntent: { kind: 'manual-actor', expectedRun: h.original.run }, execution: 'immediate',
    ...(author === 'agent' ? { caller: h.credentials } : {}) }, author === 'external' ? { externalAuthor: { identity: external, assertCurrent } } : undefined) as AgentInputSubmissionReceipt
  await h.settled(); expect(saved.status).toBe('waiting'); expect(h.writes).not.toHaveBeenCalled()
  const checks = assertCurrent.mock.calls.length
  await h.reopen(); await h.resumeFacts(); await h.wake('connection')
  const receipt = (await h.rpc.call('agent.input.inspect', { key: saved.key })).input!
  expect(receipt).toMatchObject({ key: saved.key, ref: saved.ref, status: 'waiting', admission: null })
  expect(receipt.control.deliveryKey).toBeUndefined()
  expect(h.writes).not.toHaveBeenCalled(); expect(assertCurrent).toHaveBeenCalledTimes(checks)
})

it('keeps the actual dispatch Run frozen when its byte outcome is unknown and the Session resumes again', async () => {
  const h = await fixture(), saved = await h.save('frozen-delivery'), first = await h.resumeFacts()
  h.loseReply(); await h.wake()
  const claimed = await h.read('frozen-delivery')
  expect(claimed).toMatchObject({ key: saved.intent.key, ref: saved.control.ref, status: 'unknown',
    control: { state: 'dispatch-authorized', deliveryKey: { ...saved.intent.key, expectedRun: first.run } }, admission: { run: first.run } })
  expect(h.writes).toHaveBeenCalledTimes(1)
  await h.reopen(); const second = await h.resumeFacts(); await h.wake('connection')
  const after = await h.read('frozen-delivery')
  expect(after).toMatchObject({ key: saved.intent.key, ref: saved.control.ref, status: 'unknown', control: claimed.control, admission: { run: first.run } })
  expect(second.run).not.toEqual(first.run); expect(h.writes).toHaveBeenCalledTimes(1)
})

it('discards a late preclaim Run observation after the Session moves and authorizes only the current recovery target', async () => {
  const h = await fixture(), saved = await h.save('late-preparation'), first = await h.resumeFacts()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), released = new Promise<void>(resolve => { release = resolve })
  const originalStatus = h.inner.kernel.status as (id: string) => Promise<ReturnType<typeof h.run>>
  let held = false
  h.inner.kernel.status = vi.fn(async (id: string) => {
    const observed = await originalStatus(id)
    if (!held && id === first.run.runId) { held = true; enter(); await released }
    return observed
  })
  const firstWake = h.wake(); await entered
  expect((await h.read('late-preparation')).control.state).toBe('enabled')
  const current = await h.resumeFacts(), nextWake = h.wake()
  release(); await Promise.all([firstWake, nextWake])
  const receipt = await h.read('late-preparation')
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ key: saved.intent.key, ref: saved.control.ref, status: 'terminal-confirmed',
    control: { deliveryKey: { ...saved.intent.key, expectedRun: current.run } }, admission: { run: current.run } })
  expect(h.writes.mock.calls.map(([id]) => id)).toEqual([current.run.runId, current.run.runId])
})

it('retains the original wait when its recovery target observation fails and resumes it after a connection restoration', async () => {
  const h = await fixture(), saved = await h.save('target-observation'), first = await h.resumeFacts()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), released = new Promise<void>(resolve => { release = resolve })
  const originalStatus = h.inner.kernel.status as (id: string) => Promise<ReturnType<typeof h.run>>
  let held = false
  h.inner.kernel.status = vi.fn(async (id: string) => {
    const observed = await originalStatus(id)
    if (!held && id === first.run.runId) { held = true; enter(); await released }
    return observed
  })
  const pending = h.wake(); await entered
  const current = await h.resumeFacts()
  // The delayed old Run read fails its binding before Core rechecks the current
  // target. Fail that exact Store observation once, leaving the journal healthy.
  const metadata = vi.spyOn(h.store, 'readMetadata').mockRejectedValueOnce(new Error('Current target observation unavailable'))
  release(); await pending
  expect(metadata.mock.calls[0]).toEqual(['recipient'])
  metadata.mockRestore()
  const waiting = await h.read('target-observation')
  expect(waiting).toMatchObject({ key: saved.intent.key, ref: saved.control.ref, status: 'waiting', admission: null,
    control: { state: 'enabled', waiting: { phase: 'service', reason: 'observation-failed', wake: 'session-restored',
      observation: { phase: 'current-target' }, failure: { message: 'Current target observation unavailable' } } } })
  expect(h.writes).not.toHaveBeenCalled()
  await h.wake('connection')
  expect(await h.read('target-observation')).toMatchObject({ key: saved.intent.key, ref: saved.control.ref, status: 'terminal-confirmed',
    control: { deliveryKey: { ...saved.intent.key, expectedRun: current.run } }, admission: { run: current.run } })
  expect(h.writes.mock.calls.map(([id]) => id)).toEqual([current.run.runId, current.run.runId])
})
