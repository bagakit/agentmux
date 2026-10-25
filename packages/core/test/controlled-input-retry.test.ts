import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { parseAgentInputMailboxPage } from '../src/agent-input-mailbox-codec.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '../src/agent-session-recovery/continuity-contract.js'
import type { AgentInputSubmissionReceipt } from '../src/agent-input-wait.js'
import type { AgentExternalMessageAuthor } from '../src/external-author.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentProviderPreparedNativeInput } from '../src/agent-provider.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const useCli = process.env.AGENTMUX_TEST_INPUT_RETRY_CLI === '1'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** Real file Store, original journal, hosted external authority and public RPC; only Runtime I/O is controlled. */
async function fixture(plan: 'single' | 'render' | 'native' = 'single') {
  const h = await rpcOwnerFixture(['recipient']); cleanup.push(h.close)
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }
  const old = (await h.store.readMetadata('recipient'))!
  const nativeActor = { protocolId: 'fixture-native-protocol', actorId: 'original-actor', lifecycleOperationId: 'original-native-launch', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
  await h.store.compareAndSwap(old, { ...old, nativeHandle, ...(plan === 'native' ? { nativeActor } : {}) })
  let client = h.client, activeRun = old.run.runId, mode: 'refuse' | 'unknown' | 'accept' | 'partial' = 'refuse', authorized = true, expireAfterCheck = false
  const baseInput = h.inner.kernel.input as (id: string, input: { operationId: string; expectedByte: number; data: string }) => Promise<unknown>
  const writes = vi.fn(async (id: string, operation: { operationId: string; expectedByte: number; data: string }) => {
    if (mode === 'refuse' || mode === 'partial' && operation.data === '\r') throw new AgentMuxError('Exact operation was refused before applying bytes.', 'CTXMUX_input_cursor_mismatch', 'not_applied', { disposition: 'not_applied', confirmedInputBytes: 0 })
    const result = await baseInput(id, operation)
    if (mode === 'unknown') throw new Error('Lost original Runtime reply after bytes were applied')
    return result
  })
  const nativeWrites = vi.fn<AgentProviderPreparedNativeInput['send']>(async () => mode === 'refuse'
    ? { outcome: 'not-applied', errorCode: -32600 } : { outcome: 'admitted', turnId: 'original-native-turn' })
  const install = async () => {
    const inner = client as unknown as typeof h.inner
    await inner.registry.load('local'); inner.connected = true
    inner.kernel.isConnected = () => true; inner.kernel.identity = () => ({ daemonInstanceId: 'fixture-runtime', protocolVersion: 1, buildIdentity: 'fixture' })
    inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), ...(plan === 'native' ? { pid: 1234 } : {}) })); inner.kernel.input = writes; inner.kernel.stop = vi.fn()
    if (plan === 'single') vi.spyOn(client.providers.get('codex'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
    if (plan === 'native') client.providers.get('codex').prepareNativeInput = async (context, selected) => {
      expect(context.nativeActor).toEqual(nativeActor)
      expect(selected).toMatchObject({ providerId: 'codex', nativeSessionId: nativeHandle.sessionId })
      return { plan: { kind: 'native-rpc', protocolId: nativeActor.protocolId, actorId: nativeActor.actorId,
        sourceId: JSON.stringify(['codex', nativeHandle.sessionId]), threadId: nativeHandle.sessionId, operation: 'start-or-steer' },
        assertCurrent: async () => {}, send: nativeWrites, dispose: () => {} }
    }
  }
  await install()
  const author: AgentExternalMessageAuthor = { kind: 'external', connectionId: 'connection',
    actor: { application: { domain: 'example.test', appId: 'application' }, idType: 'user-id', userId: 'original-author' },
    externalConversationId: 'original-room', externalMessageId: 'platform-message', bindingId: 'binding', bindingRevision: 1, grantId: 'grant', grantRevision: 1 }
  const assertCurrent = vi.fn(async (identity, intent) => {
    expect(identity).toEqual(author)
    expect(intent).toMatchObject({ agentSessionId: 'recipient', expectedRun: old.run, operationId: 'original-operation', messageId: 'original-message', body: 'Original external input\n原文' })
    if (!authorized) throw new AgentMuxError('Original author grant revoked.', 'INGRESS_ACTOR_NOT_AUTHORIZED')
    if (expireAfterCheck) { authorized = false; expireAfterCheck = false }
  })
  const identity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-host', protocolVersion: 2 as const, processId: process.pid,
    ctxmux: client.runtimeIdentity(), availability: 'connected' as const })
  let hosted = new AgentMuxHostedRuntimeService(client, h.store.path, identity, undefined, { assertCurrent })
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'retry.sock'), coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => hosted })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  let peer = await connectHostedAgentMux({ rpc }); cleanup.push(async () => { await peer.dispose(); hosted.dispose(); if (client !== h.client) await client.dispose() })
  const settled = async () => {
    for (;;) {
      const pending = [...(Reflect.get(client, 'inputWaitingRecipients') as Map<string, { pending: Promise<void> }>).values()]
      if (!pending.length) return
      await Promise.all(pending.map(item => item.pending))
    }
  }
  const key = { kind: 'message' as const, agentSessionId: 'recipient', expectedRun: old.run, messageId: 'original-message' }
  const read = async () => (await rpc.call('agent.input.inspect', { key })).input!
  const submit = async () => {
    await peer.submitAgentMessage({ agentSessionId: 'recipient', execution: 'immediate', admissionIntent: plan === 'native'
      ? { kind: 'native-conversation', expectedRun: old.run, source: { providerId: 'codex', nativeSessionId: nativeHandle.sessionId } }
      : { kind: 'manual-actor', expectedRun: old.run }, envelope: {
      schema: 'agentmux.a2a.v1', operationId: 'original-operation', messageId: key.messageId, sender: author, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
      senderSessionId: null, senderRunId: null, recipientSessionId: 'recipient', recipientRunId: old.run.runId, createdAt: 1, body: 'Original external input\n原文',
      threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null
    } })
    await settled(); return await read()
  }
  const rejoin = (receipt: AgentInputSubmissionReceipt) => rpc.call('agent.input.rejoin', { ref: receipt.ref })
  const wireMailboxes = async (receipt: AgentInputSubmissionReceipt) => {
    const read = { agentSessionId: 'recipient' }
    const [routed, hosted] = await Promise.all([rpc.call('agent.input.ls', { hostId: 'local', ...read }), peer.readAgentInputMailbox(read)])
    for (const page of [routed, hosted]) {
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({ kind: 'item', item: { kind: 'controlled', intent: { key }, receipt } })
    }
    const tampered = structuredClone(hosted), entry = tampered.items[0]!
    if (entry.kind !== 'item' || entry.item.kind !== 'controlled' || !entry.item.receipt?.control.deliveryKey) throw new Error('Expected original controlled successor')
    const delivery = entry.item.receipt.control.deliveryKey
    if (delivery.kind !== 'message') throw new Error('Expected original message input')
    delivery.messageId = 'foreign-logical-message'
    expect(() => parseAgentInputMailboxPage(tampered, read)).toThrow()
    return hosted
  }
  const recipientRejoin = (receipt: AgentInputSubmissionReceipt, capability = h.capability) => rpc.call('agent.input.rejoin', { ref: receipt.ref },
    { credentials: { agentSessionId: 'recipient', capability } })
  const reopen = async () => {
    await peer.dispose(); hosted.dispose(); await client.dispose()
    client = new AgentMuxClient({ store: h.store }); await install()
    hosted = new AgentMuxHostedRuntimeService(client, h.store.path, identity, undefined, { assertCurrent })
    peer = await connectHostedAgentMux({ rpc })
  }
  const resumeFacts = async () => {
    const previous = (await h.store.readMetadata('recipient'))!; activeRun = 'resumed-original-run'
    const operation = { operationId: 'original-resume', agentSessionId: 'recipient', trigger: 'input', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY, continuationEnabled: false },
      previousRun: previous.run, newRun: { runId: activeRun }, nativeTarget: nativeHandle, admittedAt: 1, observedAt: 1, rechecks: 0, kind: 'resumed' as const,
      reason: 'run-ended', evidence: { kind: 'run-ended' as const, state: 'exited' as const, observedAt: 1 } }
    const next: AgentMuxStoredAgentSession = { ...previous, run: operation.newRun, retiredRuns: [...previous.retiredRuns, previous.run],
      nativeBinding: { source: 'semantic-resume-target', run: operation.newRun, observedAt: 1 }, continuity: operation,
      continuityOperations: { ...previous.continuityOperations, [operation.operationId]: operation } }
    delete next.promptCompletionAdmission; delete next.terminalPromptSubmission
    await h.store.compareAndSwap(previous, next); await (client as unknown as typeof h.inner).registry.load('local')
  }
  return { ...h, get client() { return client }, key, old, read, submit, rejoin, wireMailboxes, recipientRejoin, reopen, resumeFacts, rpc, settled, writes, nativeWrites, assertCurrent,
    setMode(value: typeof mode) { mode = value }, revoke() { authorized = false }, expireAfterNextCheck() { expireAfterCheck = true },
    disconnect() { Reflect.set(client, 'connected', false) },
    advanceCursor: () => baseInput(activeRun, { operationId: 'independent-terminal-input', expectedByte: h.run(activeRun).acceptedInputBytes!, data: 'intervening input' }),
    cli: (ref: AgentInputSubmissionReceipt['ref']) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'agent', 'input', 'rejoin', '--input', '-'], objectCliEnvironment(h.root), JSON.stringify({ ref })) }
}

it.each(['single', 'render'] as const)('public author rejoin creates one %s successor at the current byte fence and preserves the failed receipt', async plan => {
  const h = await fixture(plan), first = await h.submit()
  expect(first).toMatchObject({ key: h.key, status: 'not-applied', observation: 'closed', control: { state: 'dispatch-authorized' } })
  const failed = await h.client.inspectAgentPromptSubmission(h.key), writesBefore = h.writes.mock.calls.length
  await h.advanceCursor(); h.setMode('accept')
  const [a, b] = await Promise.all([h.rejoin(first), h.rejoin(first)])
  expect(a.ref).toEqual(b.ref); expect(a.ref.waitGeneration).toBe(first.ref.waitGeneration + 1)
  await h.settled()
  const completed = await h.read()
  expect(completed).toMatchObject({ key: h.key, status: 'terminal-confirmed', ref: a.ref,
    control: { deliveryKey: { ...h.key, attemptId: expect.any(String) }, retry: { previousKey: h.key, previousGateId: first.control.gateId, previousWaitGeneration: first.ref.waitGeneration } } })
  expect(completed.admission!.admission!.inputKey).toEqual(completed.control.deliveryKey)
  expect(completed.admission!.admission!.intent!.prompt).toBe(failed!.admission!.intent!.prompt)
  expect(completed.admission!.admission!.startByte).toBe(Buffer.byteLength('intervening input'))
  expect(await h.client.inspectAgentPromptSubmission(h.key)).toEqual(failed)
  expect(h.writes.mock.calls.length - writesBefore).toBe(plan === 'single' ? 1 : 2)
  expect((await h.rejoin(first)).ref).toEqual(completed.ref)
  expect(h.writes.mock.calls.length - writesBefore).toBe(plan === 'single' ? 1 : 2)
  const mailbox = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })
  expect(mailbox.items).toHaveLength(1)
  await h.wireMailboxes(completed)
  if (useCli) {
    const result = await h.cli(first.ref)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).result).toMatchObject({ key: h.key, ref: completed.ref, status: 'terminal-confirmed' })
  }
})

it('retries a confirmed whole native refusal with a fresh correlation and the same original conversation', async () => {
  const h = await fixture('native'), first = await h.submit()
  expect(first.status).toBe('not-applied')
  const original = await h.client.inspectAgentPromptSubmission(h.key)
  h.setMode('accept'); await h.rejoin(first); await h.settled()
  const complete = await h.read()
  expect(complete).toMatchObject({ key: h.key, status: 'admitted', ref: { waitGeneration: first.ref.waitGeneration + 1 },
    admission: { admission: { transport: 'native', native: { outcome: 'admitted' } } } })
  expect(h.nativeWrites).toHaveBeenCalledTimes(2)
  const [originalPlan, successorPlan] = h.nativeWrites.mock.calls.map(([, plan]) => plan)
  expect(successorPlan).toMatchObject({ threadId: originalPlan!.threadId, sourceId: originalPlan!.sourceId, actorId: originalPlan!.actorId })
  expect(successorPlan!.clientCorrelation).not.toEqual(originalPlan!.clientCorrelation)
  expect(await h.client.inspectAgentPromptSubmission(h.key)).toEqual(original)
  expect(h.writes).not.toHaveBeenCalled()
  const page = await h.wireMailboxes(complete), entry = structuredClone(page.items[0]!)
  if (entry.kind !== 'item' || entry.item.kind !== 'controlled' || !entry.item.receipt?.control.deliveryKey) throw new Error('Expected original native successor')
  entry.item.receipt.control.deliveryKey.expectedRun = { runId: 'unrelated-native-run' }
  entry.item.receipt.admission = null; entry.item.receipt.status = 'unknown'
  expect(() => parseAgentInputMailboxPage({ ...page, items: [entry] }, { agentSessionId: 'recipient' })).toThrow()
})

it('allows the exact recipient to continue one refused external input while rechecking its original author', async () => {
  const h = await fixture(), first = await h.submit(), original = await h.client.inspectAgentPromptSubmission(h.key)
  h.setMode('accept')
  const [a, b] = await Promise.all([h.recipientRejoin(first), h.recipientRejoin(first)]); await h.settled()
  expect(a.ref).toEqual(b.ref)
  expect(await h.read()).toMatchObject({ status: 'terminal-confirmed', key: h.key, ref: { waitGeneration: first.ref.waitGeneration + 1 } })
  expect(h.writes).toHaveBeenCalledTimes(2)
  expect(await h.client.inspectAgentPromptSubmission(h.key)).toEqual(original)
  expect((await h.recipientRejoin(first)).ref).toEqual(a.ref)
  expect(h.assertCurrent).toHaveBeenCalled()
})

it('does not let recipient continuation bypass revoked original author authority', async () => {
  const h = await fixture(), first = await h.submit(), before = h.writes.mock.calls.length
  h.revoke(); h.setMode('accept')
  await expect(h.recipientRejoin(first)).rejects.toMatchObject({ code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect(await h.read()).toEqual(first); expect(h.writes).toHaveBeenCalledTimes(before)
})

it('reconstructs an unclaimed successor after Core reopens and verifies the same Session resume using current external authority', async () => {
  const h = await fixture(), first = await h.submit(), original = await h.client.inspectAgentPromptSubmission(h.key)
  h.disconnect()
  const waiting = await h.rejoin(first); await h.settled()
  expect(await h.read()).toMatchObject({ status: 'waiting', ref: waiting.ref, control: { retry: { previousKey: h.key } } })
  await h.reopen(); await h.resumeFacts(); h.setMode('accept')
  const before = h.writes.mock.calls.length
  await h.rejoin(waiting); await h.settled()
  expect(await h.read()).toMatchObject({ key: h.key, ref: waiting.ref, status: 'terminal-confirmed',
    control: { deliveryKey: { ...h.key, expectedRun: { runId: 'resumed-original-run' }, attemptId: expect.any(String) } } })
  expect(h.writes.mock.calls.slice(before).map(([id]) => id)).toEqual(['resumed-original-run'])
  expect(await h.client.inspectAgentPromptSubmission(h.key)).toEqual(original)
  expect(h.assertCurrent).toHaveBeenCalled()
  await h.wireMailboxes(await h.read())
})

it.each(['unknown', 'partial', 'accept'] as const)('does not create another attempt for %s original effects', async effect => {
  const h = await fixture(effect === 'partial' ? 'render' : 'single'); h.setMode(effect)
  const first = await h.submit(), original = await h.client.inspectAgentPromptSubmission(h.key), before = h.writes.mock.calls.length
  expect(first.status).toBe(effect === 'accept' ? 'terminal-confirmed' : 'unknown')
  h.setMode('accept'); await h.rejoin(first); await h.settled()
  expect(await h.read()).toEqual(first); expect(h.writes).toHaveBeenCalledTimes(before)
  expect(await h.client.inspectAgentPromptSubmission(h.key)).toEqual(original)
})

it('refuses a revoked original external author without changing the failed receipt or stopping its healthy Run', async () => {
  const h = await fixture(), first = await h.submit(), before = h.writes.mock.calls.length
  h.revoke(); h.setMode('accept')
  await expect(h.rejoin(first)).rejects.toMatchObject({ code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect(await h.read()).toEqual(first); expect(h.writes).toHaveBeenCalledTimes(before)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('rechecks the original authority inside the predecessor CAS before creating a successor', async () => {
  const h = await fixture(), first = await h.submit(), before = h.writes.mock.calls.length
  h.expireAfterNextCheck(); h.setMode('accept')
  await expect(h.rejoin(first)).rejects.toMatchObject({ code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect(await h.read()).toEqual(first); expect(h.writes).toHaveBeenCalledTimes(before)
})

it('retains each rejected attempt and reads current facts for an older ref without creating another attempt', async () => {
  const h = await fixture(), first = await h.submit(), original = await h.client.inspectAgentPromptSubmission(h.key)
  await h.rejoin(first); await h.settled()
  const second = await h.read(), secondKey = second.control.deliveryKey!
  expect(second).toMatchObject({ status: 'not-applied', ref: { key: h.key, waitGeneration: first.ref.waitGeneration + 1 } })
  const secondRecord = await h.client.inspectAgentPromptSubmission(secondKey), before = h.writes.mock.calls.length
  expect(await h.rejoin(first)).toEqual(second); expect(h.writes).toHaveBeenCalledTimes(before)
  h.setMode('accept'); await h.rejoin(second); await h.settled()
  const complete = await h.read()
  expect(complete).toMatchObject({ status: 'terminal-confirmed', ref: { key: h.key, waitGeneration: first.ref.waitGeneration + 2 }, control: { retry: { previousKey: secondKey } } })
  expect(complete.control.deliveryKey).not.toEqual(secondKey)
  expect(await h.client.inspectAgentPromptSubmission(h.key)).toEqual(original)
  expect(await h.client.inspectAgentPromptSubmission(secondKey)).toEqual(secondRecord)
  expect(await h.rpc.call('agent.input.inspect', { key: secondKey })).toEqual({ record: secondRecord })
  expect((await h.rejoin(first)).ref).toEqual(complete.ref)
  expect(h.writes).toHaveBeenCalledTimes(before + 1)
})
