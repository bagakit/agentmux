import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { readCodexPromptExecutionEvidence } from '../src/providers/codex-prompt-execution-evidence.js'
import { validateMessageNotification } from '../src/agent-message-notification.js'
import { nativeInputCorrelationKey } from '../src/native-input-correlation.js'
import type { AgentCurrentActivity, AgentMuxClientEvent, AgentNativePromptInputPlan } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

// The private owner clears AgentMux env; retain the evidence destination before that isolation.
const cliLoadedPath = process.env.AGENTMUX_INITIAL_IDLE_CLI_LOADED
const cliSourceLoader = new URL('./fixtures/a2a-initial-idle/source-loader.mjs', import.meta.url)

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Private initial-idle fixture cleanup failed')
})

async function fixture(mode: 'initial' | 'restored' | 'completed' | 'working' | 'unknown', loseAck: boolean | 'not-applied' = false, activity?: 'active' | 'unknown') {
  const h = await rpcOwnerFixture(['sender', 'recipient']); cleanup.push(h.close)
  const path = join(h.root, 'original-rollout.jsonl')
  const header = JSON.stringify({ type: 'session_meta', payload: { id: 'original-native' } }) + '\n'
  const record = (ordinal: number, type: string) => JSON.stringify({ type: 'event_msg', ordinal, payload: { type, turn_id: 'old-turn' } }) + '\n'
  await writeFile(path, header + (['restored', 'working'].includes(mode) ? record(1, 'task_started') : mode === 'completed' ? record(1, 'task_complete') : mode === 'unknown' ? '{bad-native-record}\n' : ''))
  const original = (await h.store.readMetadata('recipient'))!
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native', transcriptPath: path }
  const predecessor = mode === 'restored' ? await readCodexPromptExecutionEvidence({ args: [], workspacePath: h.root, nativeHandle }) : null
  const observedAt = Date.now()
  await h.store.compareAndSwapMetadata(original, { ...original, nativeHandle, updatedAt: observedAt,
    ...(predecessor ? { retiredRuns: [{ runId: 'prior-run' }], nativePromptPredecessor: {
      run: original.run, previousRun: { runId: 'prior-run' }, sourceId: predecessor.sourceId, evidenceId: predecessor.id } } : {}),
    ...(mode === 'completed' ? { semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt } } : {}) })
  await h.inner.registry.load('local')
  const providers = Reflect.get(h.client, 'providers') as AgentProviderRegistry
  const builtin = providers.get('codex')
  const readEvidence = vi.fn(readCodexPromptExecutionEvidence)
  let nativeAttempts = 0
  const send = vi.fn(async (wire: string, plan: AgentNativePromptInputPlan) => {
    nativeAttempts++
    const key = nativeInputCorrelationKey(plan.clientCorrelation!)
    if (key?.kind !== 'prompt') throw new Error('Original notification input correlation is missing')
    const stored = await new AgentMuxFileAgentSessionStore(h.store.path).readPromptAdmission('recipient', original.run, key.submissionId)
    expect(stored?.admission?.intent?.plan).toEqual(plan)
    expect(stored?.admission?.intent?.message).toEqual({ systemContext: wire, a2aNotificationId: key.submissionId })
    // Bound the counterexample even if a mutated dispatcher retries its own refusal forever.
    if (loseAck === 'not-applied' && nativeAttempts < 5) return { outcome: 'not-applied' as const, errorCode: -32602 }
    if (loseAck) throw new Error('Private queue accepted; original ACK unavailable')
    return { outcome: 'admitted' as const, queuedSubmissionId: 'queued-' + key.submissionId }
  })
  providers.replace({ ...builtin, observeSessionStatus: undefined, discoverNativeSession: undefined,
    readPromptExecutionEvidence: readEvidence, async prepareNativeInput(context, target) {
      expect(context.processId).toBe(1234); expect(target).toEqual({ providerId: 'codex', nativeSessionId: 'original-native', idleOnly: true })
      return { plan: { kind: 'native-rpc', protocolId: 'private-initial-idle-queue', sourceId: JSON.stringify([target.providerId, target.nativeSessionId]),
        threadId: target.nativeSessionId, actorId: 'private-native-writer', operation: 'queue-idle' },
        assertCurrent: async () => {}, send, dispose: async () => {} }
    } })
  let extraInputByte = 0
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), ...(id === original.run.runId ? { pid: 1234, acceptedInputBytes: h.run(id).acceptedInputBytes! + extraInputByte } : {}) }))
  if (activity) {
    const fact: AgentCurrentActivity = { state: activity, source: 'native-hook', run: original.run, nativeSessionId: nativeHandle.sessionId,
      nativeTurnId: 'current-turn', sourceId: 'current-activity-source', sequence: 1, hookReceiptId: 'original-hook', observedAt: Date.now() }
    Reflect.get(h.client, 'nativeCurrentActivities').set('recipient', { runId: original.run.runId, event: fact, fact, conflicted: false, invalidated: false })
  }
  const events: AgentMuxClientEvent[] = []; h.client.onEvent(event => events.push(event))
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: h.credentials }); cleanup.push(() => rpc.dispose())
  const cli = async (args: string[], recipient = false) => {
    const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: recipient ? 'recipient' : 'sender', AGENTMUX_AGENT_CAPABILITY: h.capability,
      ...(cliLoadedPath ? { AGENTMUX_INITIAL_IDLE_CLI_LOADED: cliLoadedPath } : {}) })
    const result = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, ...args], env, '', 15_000, cliSourceLoader)
    expect(result.code, result.stderr + result.stdout).toBe(0)
    return JSON.parse(result.stdout).result
  }
  const queue = new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson'))
  const notifications = Reflect.get(h.client, 'messageNotifications')
  const settled = async () => {
    // Wait for the owner started by public send, including journal observation catch-up.
    await notifications.observation?.ready
    const drains = Reflect.get(notifications, 'drains') as Map<string, { pending: Promise<void> }>
    while (drains.size) await Promise.all([...drains.values()].map(entry => entry.pending))
  }
  return { ...h, original, path, queue, cli, rpc, send, events, readEvidence, notifications, settled, changeByte: () => { extraInputByte++ } }
}

it.each(['initial', 'restored', 'completed'] as const)('source CLI sends a retained reference at %s idle through the original Core and Provider input owner', async mode => {
  const h = await fixture(mode), mid = 'original-' + mode, body = 'Opaque original body ' + mode
  const sent = await h.cli(['agent', 'send', '--to-session', 'recipient', '--message-id', mid, '--operation-id', 'send-' + mode, '--text', body])
  expect(sent).toMatchObject({ deliveryMode: 'reference', envelope: { body, recipientSessionId: 'recipient', recipientRunId: h.original.run.runId } })
  await vi.waitFor(async () => expect((await h.client.readMessage({ messageId: mid }))?.notification?.state, JSON.stringify(h.events)).toBe('submitted'), { timeout: 8000 })
  await h.settled()
  const original = (await h.queue.readByMessageId(mid))!, notice = (await h.queue.readNotification(original.notification!.notificationId!))!
  expect(notice.messageIds).toEqual([mid]); expect(notice.wire).not.toContain(body)
  expect(notice.wire).toContain('read-via="message --skill"')
  const claim = await h.client.inspectAgentPromptSubmission(notice.key)
  expect(claim?.admission?.native).toMatchObject({ outcome: 'admitted', plan: { operation: 'queue-idle' } })
  if (mode !== 'completed') {
    expect(notice.idle).toMatchObject({ nativeEvidence: { sourceId: expect.any(String), id: expect.any(String) }, inputByte: 0 })
    expect(notice.idle?.completionId).toBeUndefined(); expect(claim?.admission?.completionId).toBeUndefined()
    expect(h.client.agentSession('recipient').semanticStatus).toBeUndefined()
    expect(h.client.agentSession('recipient').currentActivity).toBeUndefined()
  } else expect(notice.idle?.completionId).toEqual(expect.any(String))
  const opened = await h.cli(['message', 'read', '--message-id', mid], true)
  expect(opened.message.envelope.body).toBe(body)
  const outbox = await h.rpc.call('message.events', { messageId: mid })
  expect(outbox.events.some(event => event.kind === 'a2a-notification-result')).toBe(true)
  expect(await new DurableAgentMuxMessageQueue(h.queue.path).readNotification(notice.notificationId)).toEqual(notice)
  expect(h.send).toHaveBeenCalledTimes(1)
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('an unknown activity observation does not erase independently confirmed native initial idle', async () => {
  const h = await fixture('initial', false, 'unknown')
  await h.rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, messageId: 'unknown-activity', operationId: 'send-unknown-activity', text: 'Original body' })
  await vi.waitFor(async () => expect((await h.client.readMessage({ messageId: 'unknown-activity' }))?.notification?.state).toBe('submitted'), { timeout: 8000 })
  expect(h.send).toHaveBeenCalledTimes(1)
})

it.each(['working', 'unknown', 'active'] as const)('retains the Inbox when native opportunity is %s and keeps normal manual input available', async mode => {
  const h = await fixture(mode === 'active' ? 'initial' : mode, false, mode === 'active' ? 'active' : undefined)
  await h.rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, messageId: 'pending-' + mode, operationId: 'send-pending-' + mode, text: 'Retained original body' })
  await h.settled()
  expect((await h.queue.readByMessageId('pending-' + mode))?.notification).toEqual({ state: 'pending' })
  expect(h.send).not.toHaveBeenCalled()
  if (mode === 'unknown') expect(h.events.some(event => event.type === 'agent-error' && event.code === 'A2A_NOTIFICATION_UNCONFIRMED')).toBe(true)
  await h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: h.original.run, operationId: 'healthy-manual',
    admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt: 'Existing manual ability', authorHuman: true })
  await vi.waitFor(() => expect(h.inner.kernel.input).toHaveBeenCalledWith(h.original.run.runId, expect.anything()), { timeout: 8000 })
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('reopens the exact unknown native-idle notice without replay and admits a distinct later MID independently', async () => {
  const h = await fixture('restored', true)
  const send = (id: string) => h.rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, messageId: id, operationId: 'send-' + id, text: 'Original body ' + id })
  await send('unknown-original')
  await vi.waitFor(async () => expect((await h.queue.readByMessageId('unknown-original'))?.notification?.state).toBe('unconfirmed'), { timeout: 8000 })
  await h.settled()
  const first = (await h.queue.readByMessageId('unknown-original'))!, notice = (await h.queue.readNotification(first.notification!.notificationId!))!
  const reopened = new DurableAgentMuxMessageQueue(h.queue.path)
  expect(await reopened.readNotification(notice.notificationId)).toEqual(notice)
  await h.notifications.restore(); await h.settled()
  expect(h.send).toHaveBeenCalledTimes(1)
  await send('independent-new')
  await vi.waitFor(async () => expect((await reopened.readByMessageId('independent-new'))?.notification?.state).toBe('unconfirmed'), { timeout: 8000 })
  await h.settled()
  expect(h.send).toHaveBeenCalledTimes(2)
  expect((await reopened.readByMessageId('independent-new'))?.notification?.key).not.toEqual(notice.key)
  expect(await reopened.readNotification(notice.notificationId)).toEqual(notice)
  expect(h.client.agentSession('recipient').run).toEqual(h.original.run)
})

it('validates native idle as a distinct durable boundary without accepting ambiguous or missing evidence', async () => {
  const h = await fixture('initial')
  await h.rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, messageId: 'validation', operationId: 'send-validation', text: 'Opaque original' })
  await vi.waitFor(async () => expect((await h.queue.readByMessageId('validation'))?.notification?.state).toBe('submitted'), { timeout: 8000 })
  const message = (await h.queue.readByMessageId('validation'))!, notice = (await h.queue.readNotification(message.notification!.notificationId!))!
  expect(validateMessageNotification(notice)).toEqual(notice)
  for (const idle of [{ inputByte: 0 }, { inputByte: 0, nativeEvidence: { id: 'id' } }, { inputByte: 0, nativeEvidence: { sourceId: 'source', id: 'id' }, completionId: 'fake-completion' }]) {
    expect(() => validateMessageNotification({ ...notice, idle } as typeof notice)).toThrow('original idle input boundary')
  }
  expect((await readFile(h.path, 'utf8')).includes('task_complete')).toBe(false)
})

it('a rejected claim cannot create another idle opportunity, while new MID, native evidence and input boundaries can', async () => {
  const h = await fixture('initial', 'not-applied')
  const send = (id: string) => h.rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, messageId: id, operationId: 'send-' + id, text: 'Original body ' + id })
  await send('rejected-original'); await h.settled()
  expect(h.send).toHaveBeenCalledTimes(1)
  expect((await h.queue.readByMessageId('rejected-original'))?.notification).toEqual({ state: 'pending' })
  h.notifications.changed('recipient'); await h.settled()
  expect(h.send).toHaveBeenCalledTimes(1)
  await send('new-reference'); await h.settled()
  expect(h.send).toHaveBeenCalledTimes(2)
  const evidence = await readCodexPromptExecutionEvidence({ args: [], workspacePath: h.root, nativeHandle: h.client.agentSession('recipient').nativeHandle! })
  h.readEvidence.mockResolvedValue({ ...evidence!, id: 'another-authoritative-idle', state: 'idle' })
  h.notifications.changed('recipient'); await h.settled()
  expect(h.send).toHaveBeenCalledTimes(3)
  h.changeByte(); h.notifications.changed('recipient'); await h.settled()
  expect(h.send).toHaveBeenCalledTimes(4)
  expect((await h.queue.readByMessageId('rejected-original'))?.envelope.body).toBe('Original body rejected-original')
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})
