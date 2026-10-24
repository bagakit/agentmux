import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { sessionSemanticResumeSourceRuns } from '../src/agent-session-resume-sources.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { nativeInputCorrelationKey } from '../src/native-input-correlation.js'
import type { AgentMuxAgentSession, AgentNativePromptInputPlan } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'

const cliLoaded = process.env.AGENTMUX_RESUMED_INBOX_CLI_LOADED
const cliMutation = process.env.AGENTMUX_RESUMED_INBOX_MUTATION
const cliLoader = new URL('./fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url)
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** Actual Core resume lifecycle; Runtime and native protocol are deterministic private I/O ports. */
async function fixture(selected = false) {
  const h = await rpcOwnerFixture(['sender', 'recipient', 'other']); cleanup.push(h.close)
  const events: import('../src/types.js').AgentMuxClientEvent[] = []; h.client.onEvent(event => { events.push(event) })
  const queue = Reflect.get(h.client, 'messageQueue') as import('../src/agent-global-message-queue.js').DurableAgentMuxMessageQueue
  const notifications = Reflect.get(h.client, 'messageNotifications') as import('../src/agent-message-notifications.js').AgentMuxMessageNotifications
  const old = (await h.store.readMetadata('recipient'))!, nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }
  await h.store.compareAndSwapMetadata(old, { ...old, nativeHandle, updatedAt: Date.now(),
    ...(selected ? { nativeBinding: { source: 'user-selected' as const, run: old.run, observedAt: old.updatedAt } } : {}) }); await h.inner.registry.load('local')
  let currentRun = old.run.runId, serial = 0, availableIdle = false, unknownNative = false, refuseNative = false
  const ended = new Set<string>()
  const run = (id: string) => ({ ...h.run(id), pid: 1234, state: id === currentRun && !ended.has(id) ? { type: 'running' as const } : { type: 'exited' as const, code: 0, signal: null } })
  h.inner.kernel.status = vi.fn(async id => run(id))
  const start = vi.fn(async () => { currentRun = 'resumed-' + ++serial; return run(currentRun) })
  Object.assign(h.inner.kernel, { start, list: async () => [run(currentRun)] })
  const inner = h.client as any
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  inner.ensureManagedHooks = async () => {}; inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  const providers = Reflect.get(h.client, 'providers') as AgentProviderRegistry, builtin = providers.get('codex')
  const { discoverNativeSession: _discovery, observeSessionStatus: _status, ...provider } = builtin
  const terminalInput = h.inner.kernel.input
  if (!vi.isMockFunction(terminalInput)) throw new Error('The private Runtime input port must record its exact writes')
  const native = vi.fn(async (_wire: string, plan: AgentNativePromptInputPlan) => {
    const key = nativeInputCorrelationKey(plan.clientCorrelation!)
    if (key?.kind !== 'prompt') throw new Error('The original notification requires its typed prompt key')
    expect(key.expectedRun.runId).toBe(currentRun)
    if (unknownNative) throw new Error('Original private native ACK lost')
    if (refuseNative) return { outcome: 'not-applied' as const, errorCode: -32602 }
    return { outcome: 'admitted' as const, queuedSubmissionId: 'private-' + key.submissionId }
  })
  providers.replace({ ...provider,
    readPromptExecutionEvidence: async () => ({ state: availableIdle ? 'idle' : 'working', sourceId: 'private-native-source', id: 'private-evidence-' + currentRun }),
    async prepareNativeInput(_context, target) {
      return { plan: { kind: 'native-rpc', protocolId: 'private-inbox-protocol', sourceId: JSON.stringify([target.providerId, target.nativeSessionId]),
        threadId: target.nativeSessionId, actorId: 'private-writer', operation: target.idleOnly ? 'queue-idle' : 'start-or-steer' },
        assertCurrent: async () => {}, send: native, dispose: async () => {} }
    } })
  vi.spyOn(h.client, 'probeAgent').mockResolvedValue({ providerId: 'codex', executable: 'codex', installed: true, capabilities: builtin.catalog.capabilities })
  const append = async (id: string, recipient = 'recipient') => queue.append({ messageId: id, operationId: 'send-' + id, createdAt: Date.now(),
    sender: { kind: 'agent-session', agentSessionId: 'sender' }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: 'sender', senderRunId: 'run-sender', recipientSessionId: recipient, recipientRunId: recipient === 'recipient' ? currentRun : 'run-other',
    threadId: 'original-thread', correlationId: 'correlation-' + id, replyTo: null, workspaceId: null, body: 'Opaque original body ' + id }, { deliveryMode: 'reference' })
  const resume = async () => {
    const operationId = 'resume-' + (serial + 1)
    ended.add(currentRun)
    const result = await h.client.resumeAgent({ agentSessionId: 'recipient', operationId, prompt: 'Explicit private resume task' })
    expect(result.continuity).toMatchObject({ kind: 'resumed', previousRun: { runId: serial === 1 ? old.run.runId : 'resumed-' + (serial - 1) }, newRun: result.run, nativeTarget: nativeHandle })
    expect(result.nativeBinding).toMatchObject({ source: selected ? 'user-selected' : 'semantic-resume-target', run: result.run })
    return result
  }
  const settled = async () => {
    await Reflect.get(notifications, 'observation')?.ready
    const drains = Reflect.get(notifications, 'drains') as Map<string, { pending: Promise<void> }>
    while (drains.size) await Promise.all([...drains.values()].map(entry => entry.pending))
  }
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'inbox.sock'), coreClients: h.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: h.credentials }); cleanup.push(() => managed.dispose())
  const cli = async (args: string[]) => {
    const result = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, ...args], objectCliEnvironment(h.root,
      { ...(cliLoaded ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: cliLoaded } : {}),
        ...(cliMutation ? { AGENTMUX_RESUMED_INBOX_MUTATION: cliMutation } : {}) }), '', 20_000, cliLoader)
    expect(result.code, result.stderr + result.stdout).toBe(0)
    return JSON.parse(result.stdout).result
  }
  return { ...h, old, nativeHandle, queue, notifications, append, resume, settled, native, terminalInput, start, rpc, managed, cli, events,
    idle: () => { availableIdle = true }, loseNative: () => { unknownNative = true }, refuseNative: () => { refuseNative = true } }
}

it('source CLI freezes a new explicit notification on the resumed persistent recipient and reads it without changing the historical message', async () => {
  const f = await fixture(), original = await f.append('historical-a'), resumed = await f.resume()
  const result = await f.cli(['message', 'notify', '--host', 'local', '--message-id', 'historical-a', '--operation-id', 'explicit-on-b'])
  expect(result.notification).toMatchObject({ state: 'submitted', messageIds: ['historical-a'], key: { expectedRun: resumed.run } })
  expect((await f.queue.readByMessageId('historical-a'))!.envelope).toEqual(original.envelope)
  const read = await f.cli(['message', 'read', '--host', 'local', '--message-id', 'historical-a'])
  expect(read.message.envelope.recipientRunId).toBe(f.old.run.runId)
  expect(read.message.notification.key.expectedRun).toEqual(resumed.run)
  expect(() => parseRpcNativeResult('message.read', read, { hostId: 'local', messageId: 'historical-a' })).not.toThrow()
  const listed = await f.rpc.call('message.ls', { hostId: 'local', participantSessionId: 'recipient', direction: 'incoming' })
  expect(listed.messages[0]!.notification?.key?.expectedRun).toEqual(resumed.run)
  const before = await f.queue.readJournal(), writes = f.terminalInput.mock.calls.length
  const inspected = await f.cli(['message', 'notify', 'inspect', '--host', 'local', '--operation-id', 'explicit-on-b'])
  expect(inspected.notification).toEqual(result.notification); expect(inspected.input).toBeTruthy()
  expect(await f.queue.readJournal()).toEqual(before); expect(f.inner.kernel.input).toHaveBeenCalledTimes(writes)
  expect(f.native).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledTimes(1)
})

it('coalesces different historical Runs of the same recipient and keeps a retained operation on its original key after another recovery', async () => {
  const f = await fixture(), a = await f.append('a'); await f.resume(); const b = await f.append('b')
  const first = await f.rpc.call('message.notify', { hostId: 'local', operationId: 'frozen-b', messageIds: ['a', 'b'] })
  const oldKey = first.notification.key, writes = f.terminalInput.mock.calls.length
  await f.resume()
  const repeated = await f.rpc.call('message.notify', { hostId: 'local', operationId: 'frozen-b', messageIds: ['a', 'b'] }).then(value => ({ value }), error => ({ error }))
  expect(repeated).not.toHaveProperty('error'); expect('value' in repeated && repeated.value.notification.key).toEqual(oldKey)
  expect((await f.rpc.call('message.notify.inspect', { hostId: 'local', operationId: 'frozen-b' })).notification?.key).toEqual(oldKey)
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(writes)
  expect((await f.queue.readByMessageId('a'))?.envelope).toEqual(a.envelope); expect((await f.queue.readByMessageId('b'))?.envelope).toEqual(b.envelope)
  await f.append('wrong-recipient', 'other')
  await expect(f.rpc.call('message.notify', { hostId: 'local', operationId: 'wrong-target', messageIds: ['a', 'wrong-recipient'] })).rejects.toMatchObject({ code: 'MESSAGE_RECIPIENT_MISMATCH' })
})

it.each([false, true])('automatically selects untouched historical references through the actual Core Level B recovery chain (selected=%s)', async selected => {
  const f = await fixture(selected), a = await f.append('a'); await f.resume(); const b = await f.append('b'); const current = await f.resume()
  expect(sessionSemanticResumeSourceRuns(current)).toEqual([current.run.runId, 'resumed-1', f.old.run.runId])
  f.idle(); await f.notifications.restore(); await f.settled()
  expect(f.native).toHaveBeenCalledTimes(1)
  const notice = (await f.queue.readNotification((await f.queue.readByMessageId('a'))!.notification!.notificationId!))!
  expect(notice.messageIds).toEqual(['a', 'b']); expect(notice.key.expectedRun).toEqual(current.run); expect(notice.mode).toBe('idle')
  expect((await f.queue.readByMessageId('a'))?.envelope).toEqual(a.envelope); expect((await f.queue.readByMessageId('b'))?.envelope).toEqual(b.envelope)
  expect(f.native.mock.calls[0]![1].operation).toBe('queue-idle'); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it.each(['missing-chain', 'changed-target', 'changed-provider', 'wrong-binding', 'conflicting-predecessor'] as const)('does not expand automatic source Runs for %s while explicit user input remains available', async failure => {
  const f = await fixture(); await f.append('old-only'); const current = await f.resume()
  const altered = structuredClone(current)
  if (failure === 'missing-chain') { delete altered.continuity; delete altered.continuityOperations }
  else if (failure === 'changed-target') altered.nativeHandle = { ...f.nativeHandle, sessionId: 'another-native' }
  else if (failure === 'changed-provider') altered.nativeHandle = { ...f.nativeHandle, providerId: 'claude' }
  else if (failure === 'wrong-binding') altered.nativeBinding = { source: 'native-hook', run: current.run, observedAt: Date.now() }
  else altered.continuityOperations = { ...altered.continuityOperations, conflict: { ...altered.continuity!, operationId: 'conflict', previousRun: { runId: 'another-previous' } } }
  expect(sessionSemanticResumeSourceRuns(altered)).toEqual([current.run.runId])
  const before = await f.queue.pendingNotificationPosition('recipient', [current.run.runId])
  expect(before).toBe(0)
  expect(await f.queue.prepareNotification({ notificationId: 'bounded-current', agentSessionId: 'recipient', condition: agentPromptCondition(current),
    idle: { nativeEvidence: { sourceId: 'private-native-source', id: 'idle' }, inputByte: 0 }, sourceRuns: sessionSemanticResumeSourceRuns(altered) })).toBeNull()
  await f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: current.run, operationId: 'healthy-manual', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt: 'Still usable', authorHuman: true })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalled())
})

it('retains an unknown original notice across recovery and notifies a distinct new MID independently', async () => {
  const f = await fixture(); await f.append('unknown-original'); await f.resume(); f.idle(); f.loseNative()
  await f.notifications.restore(); await f.settled()
  const first = (await f.queue.readNotification((await f.queue.readByMessageId('unknown-original'))!.notification!.notificationId!))!
  expect(first.state).toBe('unconfirmed'); expect(f.native).toHaveBeenCalledTimes(1)
  await f.resume(); await f.notifications.restore(); await f.settled(); expect(f.native).toHaveBeenCalledTimes(1)
  await f.append('independent'); await f.notifications.restore(); await f.settled()
  expect(f.native).toHaveBeenCalledTimes(2); expect(await f.queue.readNotification(first.notificationId)).toEqual(first)
  expect((await f.queue.readByMessageId('independent'))?.notification?.key?.expectedRun).not.toEqual(first.key.expectedRun)
})

it('does not automatically reassign a manually attempted unknown MID while a new MID retains its independent notification and original byte guard', async () => {
  const f = await fixture(); await f.append('manual-unknown'); await f.resume()
  const write = f.terminalInput.mockRejectedValue(new Error('Original terminal write response lost'))
  await f.client.notifyMessages({ operationId: 'original-manual', messageIds: ['manual-unknown'] })
  await vi.waitFor(() => expect(write).toHaveBeenCalled())
  const original = (await f.queue.readNotification('original-manual'))!
  expect(original.state).toBe('unconfirmed')
  f.idle(); await f.notifications.restore(); await f.settled(); expect(f.native).not.toHaveBeenCalled()
  await f.append('independent-new'); await f.notifications.restore(); await f.settled()
  const record = (await f.queue.readJournal()).find(record => record.kind === 'a2a-notification' && record.notification.messageIds.includes('independent-new'))
  expect(record?.kind).toBe('a2a-notification')
  if (record?.kind !== 'a2a-notification') throw new Error('Missing independent original notice')
  expect(record.notification.notificationId).not.toBe(original.notificationId)
  const independentNotice = (await f.queue.readNotification(record.notification.notificationId))!
  expect(independentNotice.messageIds).toEqual(['independent-new'])
  expect(independentNotice.state).toBe('not-applied'); expect(independentNotice.reason).toBeTruthy()
  expect(f.native).not.toHaveBeenCalled()
  expect(await f.queue.readNotification('original-manual')).toEqual(original)
})

it('reopens old-version manual unknown derived rows without automatically replaying their original MID', async () => {
  const f = await fixture(); await f.append('old-version-unknown'); const current = await f.resume()
  const notice = (await f.queue.prepareNotification({ notificationId: 'old-version-manual', agentSessionId: 'recipient', condition: agentPromptCondition(current), messageIds: ['old-version-unknown'] }))!
  await f.queue.recordNotificationResult(notice.notificationId, 'unconfirmed')
  const before = await f.queue.readJournal(), db = new DatabaseSync(f.queue.path)
  const incarnation = db.prepare('SELECT incarnation FROM metadata').get()!.incarnation
  // Exact previous implementation projection: manual active=0, original position never assigned.
  db.exec('DROP TRIGGER a2a_unresolved_notification_insert; DROP TRIGGER a2a_unresolved_notification_result; DROP TABLE a2a_unresolved_notification_references')
  db.prepare('UPDATE a2a_message_notifications SET notification_id=NULL WHERE message_id=?').run('old-version-unknown')
  db.prepare('UPDATE a2a_notifications SET active=0 WHERE notification_id=?').run(notice.notificationId); db.close()
  const reopened = new DurableAgentMuxMessageQueue(f.queue.path)
  expect(await reopened.pendingNotificationPosition('recipient', sessionSemanticResumeSourceRuns(current))).toBe(0)
  expect(await reopened.readJournal()).toEqual(before)
  const read = new DatabaseSync(f.queue.path, { readOnly: true })
  expect(read.prepare('SELECT incarnation FROM metadata').get()!.incarnation).toEqual(incarnation); read.close()
  f.idle(); await f.notifications.restore(); await f.settled(); expect(f.native).not.toHaveBeenCalled()
  await f.append('old-version-independent'); await f.notifications.restore(); await f.settled()
  expect(f.native).toHaveBeenCalledTimes(1); expect(f.native.mock.calls[0]![0]).not.toContain('msg-id="old-version-unknown"')
  expect(await reopened.readNotification(notice.notificationId)).toEqual({ ...notice, state: 'unconfirmed', resultRecordedAt: expect.any(Number) })
})

it('indexes the first notification in an original legacy journal before any automatic selection', async () => {
  const f = await fixture(); await f.append('legacy-first'); const current = await f.resume()
  const notice = (await f.queue.prepareNotification({ notificationId: 'legacy-first-manual', agentSessionId: 'recipient', condition: agentPromptCondition(current), messageIds: ['legacy-first'] }))!
  await f.queue.recordNotificationResult(notice.notificationId, 'unconfirmed')
  const records = await f.queue.readJournal(), path = join(f.root, 'original-legacy.ndjson')
  await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const imported = new DurableAgentMuxMessageQueue(path)
  expect(await imported.readJournal()).toEqual(records)
  expect(await imported.pendingNotificationPosition('recipient', sessionSemanticResumeSourceRuns(current))).toBe(0)
  expect(await imported.prepareNotification({ notificationId: 'must-not-replay', agentSessionId: 'recipient', condition: agentPromptCondition(current),
    idle: { nativeEvidence: { sourceId: 'source', id: 'idle' }, inputByte: 0 }, sourceRuns: sessionSemanticResumeSourceRuns(current) })).toBeNull()
})

it('reads a missing operation without prepare, submit, message body read or journal append for users and managed callers', async () => {
  const f = await fixture(), before = await f.queue.readJournal()
  const prepare = vi.spyOn(f.queue, 'prepareNotification'), body = vi.spyOn(f.queue, 'readByMessageId')
  const result = await f.rpc.call('message.notify.inspect', { hostId: 'local', operationId: 'not-recorded' })
  expect(result).toEqual({ hostId: 'local', notification: null, inputOrigin: null, input: null })
  expect(await f.queue.readJournal()).toEqual(before); expect(prepare).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
  await expect(f.managed.call('message.notify.inspect', { hostId: 'local', operationId: 'not-recorded' })).resolves.toEqual({ hostId: 'local', notification: null, inputOrigin: null, input: null })
  await expect(f.rpc.call('message.notify.inspect', { hostId: 'another-host', operationId: 'not-recorded' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
})

it('keeps a second unknown manual operation assigned when the earlier operation is confirmed wholly not applied', async () => {
  const f = await fixture(); await f.append('two-unknowns'); const current = await f.resume()
  const condition = agentPromptCondition(current)
  const first = (await f.queue.prepareNotification({ notificationId: 'first-manual', agentSessionId: 'recipient', condition, messageIds: ['two-unknowns'] }))!
  await f.queue.recordNotificationResult(first.notificationId, 'unconfirmed')
  const second = (await f.queue.prepareNotification({ notificationId: 'second-manual', agentSessionId: 'recipient', condition, messageIds: ['two-unknowns'] }))!
  await f.queue.recordNotificationResult(second.notificationId, 'unconfirmed')
  await f.queue.recordNotificationResult(first.notificationId, 'not-applied')
  expect((await f.queue.readByMessageId('two-unknowns'))?.notification?.notificationId).toBe(second.notificationId)
  f.idle(); await f.notifications.restore(); await f.settled(); expect(f.native).not.toHaveBeenCalled()
  await f.queue.recordNotificationResult(second.notificationId, 'not-applied')
  expect((await f.queue.readByMessageId('two-unknowns'))?.notification).toEqual({ state: 'pending' })
  await f.append('new-opportunity'); await f.notifications.restore(); await f.settled()
  expect(f.native).toHaveBeenCalledTimes(1); expect(f.native.mock.calls[0]![0]).toContain('msg-id="two-unknowns"')
})

it('promotes a producer-qualified input ACK in a read-only notice copy without writing the original journal', async () => {
  const f = await fixture(); await f.append('ack-copy'); await f.resume()
  const failure = vi.spyOn(f.queue, 'recordNotificationResult').mockRejectedValue(new Error('Receipt persistence unavailable'))
  await expect(f.client.notifyMessages({ operationId: 'ack-copy-op', messageIds: ['ack-copy'] })).rejects.toThrow()
  failure.mockRestore()
  await f.queue.recordNotificationResult('ack-copy-op', 'unconfirmed', 'Receipt reconciliation has not been recorded')
  const retained = (await f.queue.readNotification('ack-copy-op'))!, before = await f.queue.readJournal()
  expect(retained.state).toBe('unconfirmed'); expect(retained.resultRecordedAt).toEqual(expect.any(Number))
  const result = await f.rpc.call('message.notify.inspect', { hostId: 'local', operationId: 'ack-copy-op' })
  expect(result.notification?.state).toBe('submitted'); expect(await f.queue.readNotification('ack-copy-op')).toEqual(retained)
  expect(result.notification).not.toHaveProperty('resultRecordedAt')
  expect(await f.queue.readJournal()).toEqual(before)
  const altered = structuredClone(result.input!)
  if (!altered.admission?.intent) throw new Error('Missing the original notification input intent')
  altered.admission.intent.message = { userContent: 'Ordinary prompt with the same operation name' }
  vi.spyOn(f.client, 'inspectAgentPromptSubmission').mockResolvedValue(altered)
  const inspected = await f.client.inspectMessageNotification({ operationId: 'ack-copy-op' }).then(value => ({ value }), error => ({ error }))
  expect(inspected).toHaveProperty('error.code', 'AGENT_PROMPT_OPERATION_CONFLICT')
})

it('reads a pending original notice without entering the Input owner or preparing another operation', async () => {
  const f = await fixture(); await f.append('pending-read'); const current = await f.resume()
  const notice = (await f.queue.prepareNotification({ notificationId: 'pending-original', agentSessionId: 'recipient', condition: agentPromptCondition(current), messageIds: ['pending-read'] }))!
  const before = await f.queue.readJournal()
  const result = await f.client.inspectMessageNotification({ operationId: notice.notificationId })
  expect(result.notification).toEqual(notice); expect(result.input).toBeNull()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(await f.queue.readJournal()).toEqual(before)
})

it('reads whole-input native not-applied as a copy while keeping the original persisted notice unchanged', async () => {
  const f = await fixture(); await f.append('refused-read'); await f.resume(); f.idle(); f.refuseNative()
  const failure = vi.spyOn(f.queue, 'recordNotificationResult').mockRejectedValue(new Error('Saving refusal unavailable'))
  const retirement = vi.spyOn(f.queue, 'retireNotificationBeforeInput').mockResolvedValue(false)
  await f.notifications.restore(); await f.settled(); failure.mockRestore(); retirement.mockRestore()
  const notice = (await f.queue.readNotification((await f.queue.readByMessageId('refused-read'))!.notification!.notificationId!))!
  const before = await f.queue.readJournal()
  expect(notice.state).toBe('pending')
  expect((await f.client.inspectMessageNotification({ operationId: notice.notificationId })).notification?.state).toBe('not-applied')
  expect(await f.queue.readNotification(notice.notificationId)).toEqual(notice); expect(await f.queue.readJournal()).toEqual(before)
})

it('validates the public read receipt Host, operation and platform producer rather than accepting a same-name ordinary ACK', async () => {
  const f = await fixture(); await f.append('codec'); await f.resume()
  await f.rpc.call('message.notify', { hostId: 'local', operationId: 'codec-op', messageIds: ['codec'] })
  const result = await f.rpc.call('message.notify.inspect', { hostId: 'local', operationId: 'codec-op' })
  const input = { hostId: 'local', operationId: 'codec-op' }
  expect(() => parseRpcNativeResult('message.notify.inspect', result, input)).not.toThrow()
  for (const changed of [{ ...result, hostId: 'elsewhere' }, { ...result, notification: { ...result.notification, notificationId: 'another-op' } },
    { ...result, notification: null }, { ...result, inputOrigin: undefined }, { ...result, inputOrigin: { queueId: 'original', incarnation: 'original', sequence: -1 } }]) expect(() => parseRpcNativeResult('message.notify.inspect', changed, input)).toThrow()
  const ordinary = structuredClone(result.input!)
  if (!ordinary.admission?.intent) throw new Error('Missing the original notification input intent')
  ordinary.admission.intent.message = { userContent: 'ordinary' }
  expect(() => parseRpcNativeResult('message.notify.inspect', { ...result, input: ordinary }, input)).toThrow()
})

it('forwards the same read-only notification operation through a selected remote Host without moving its original key', async () => {
  const f = await fixture(); await f.append('forward'); await f.resume()
  const original = await f.rpc.call('message.notify', { hostId: 'local', operationId: 'forward-op', messageIds: ['forward'] })
  const forward = vi.fn(async (_method, params) => ({ ...await f.rpc.call('message.notify.inspect', params), hostId: 'local' }))
  const remote = { ...f.client, forwardRpc: forward } as any
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'remote-original', client: remote }] })
  const result = await service.call('message.notify.inspect', { hostId: 'remote-original', operationId: 'forward-op' }, { principal: { kind: 'user', id: 'trusted' } })
  expect(result).toMatchObject({ hostId: 'remote-original', notification: { key: original.notification.key } })
  expect(forward).toHaveBeenCalledWith('message.notify.inspect', { hostId: 'local', operationId: 'forward-op' }, expect.anything())
})

it('exposes the original read through the actual Hosted SDK and owner dispatcher without Runtime recovery', async () => {
  const f = await fixture(); await f.append('hosted-read'); await f.resume()
  const original = await f.client.notifyMessages({ operationId: 'hosted-original', messageIds: ['hosted-read'] })
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client))
  const sdk = await connectHostedAgentMux({ rpc: {
    call: async (method, params, options) => await service.call(method, structuredClone(params), { ...options, principal: { kind: 'user', id: 'private-user' } }) as never,
    subscribe: async (method: string, params: unknown, handlers: {
      onInitial(value: unknown): void; onEvent(value: unknown): void
    }) => {
      const subscription = await service.subscribe(method, structuredClone(params), value => { handlers.onEvent(structuredClone(value)) }, { principal: { kind: 'user', id: 'private-user' } })
      handlers.onInitial(structuredClone(subscription.initial)); await subscription.start?.()
      return { dispose: () => subscription.dispose() }
    }
  } })
  cleanup.push(async () => { await sdk.dispose(); await service.dispose() })
  const connect = vi.spyOn(f.client, 'connect'), before = await f.queue.readJournal()
  const result = await sdk.inspectMessageNotification({ operationId: 'hosted-original' })
  expect(result.notification).toEqual(original.notification); expect(result.input).toBeTruthy()
  expect(connect).not.toHaveBeenCalled(); expect(await f.queue.readJournal()).toEqual(before)
})

it('reports the excluded original recovery scope once and preserves current qualified work when that observation fails', async () => {
  const f = await fixture(); await f.append('unconfirmed-history'); await f.resume()
  const stored = (await f.store.readMetadata('recipient'))!, missing = { ...stored, updatedAt: stored.updatedAt + 1 }
  delete missing.continuity; delete missing.continuityOperations
  await f.store.compareAndSwapMetadata(stored, missing); await f.inner.registry.load('local')
  f.idle(); await f.notifications.restore(); await f.settled()
  const gaps = () => f.events.filter(event => event.type === 'agent-error' && event.code === 'A2A_NOTIFICATION_UNCONFIRMED')
  expect(gaps()).toHaveLength(1); expect(gaps()[0]).toMatchObject({ agentSessionId: 'recipient', message: expect.stringContaining('semantic recovery relationship') })
  f.notifications.changed('recipient'); await f.settled(); expect(gaps()).toHaveLength(1)
  const query = vi.spyOn(f.queue, 'excludedNotificationPosition').mockRejectedValue(new Error('Private scope observation unavailable'))
  await f.append('qualified-current'); f.notifications.changed('recipient'); await f.settled()
  expect(f.native).toHaveBeenCalledTimes(1); expect(f.native.mock.calls[0]![0]).toContain('msg-id="qualified-current"')
  expect(f.native.mock.calls[0]![0]).not.toContain('msg-id="unconfirmed-history"')
  expect(gaps().some(event => event.type === 'agent-error' && event.message.includes('Private scope observation unavailable'))).toBe(true)
  expect((await f.queue.readByMessageId('unconfirmed-history'))?.notification).toEqual({ state: 'pending' }); query.mockRestore()
})

it('uses recipient and exact MID indexes for eligible, excluded and bounded selection queries independently of unrelated Sessions', async () => {
  const f = await fixture(); await f.append('indexed-original'); const current = await f.resume()
  const captured: Array<{ sql: string; params: unknown[] }> = [], prepare = DatabaseSync.prototype.prepare
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
    const statement = prepare.call(this, sql)
    if (sql.includes('FROM a2a_message_notifications') && /run_id (?:NOT )?IN/u.test(sql)) {
      for (const method of ['get', 'all'] as const) {
        const execute = statement[method].bind(statement)
        vi.spyOn(statement, method).mockImplementation(((...params: any[]) => { captured.push({ sql, params }); return execute(...params) }) as any)
      }
    }
    return statement
  })
  try {
    const sourceRuns = sessionSemanticResumeSourceRuns(current)
    await f.queue.pendingNotificationPosition('recipient', sourceRuns)
    await f.queue.excludedNotificationPosition('recipient', sourceRuns)
    await f.queue.prepareNotification({ notificationId: 'index-query-only', agentSessionId: 'recipient', condition: agentPromptCondition(current),
      idle: { nativeEvidence: { sourceId: 'private-native-source', id: 'idle' }, inputByte: 0 }, sourceRuns })
  } finally { spy.mockRestore() }
  expect(captured).toHaveLength(3)
  const db = new DatabaseSync(f.queue.path, { readOnly: true })
  try {
    for (const { sql, params } of captured) {
      const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params as any[]).map(row => String(row.detail))
      expect(plan.some(detail => detail.includes('SEARCH a2a_message_notifications') && detail.includes('recipient_id=?'))).toBe(true)
      expect(plan.some(detail => detail.includes('SEARCH refs USING PRIMARY KEY (message_id=?)'))).toBe(true)
      expect(plan.some(detail => /^SCAN (?:a2a_message_notifications|refs)/u.test(detail))).toBe(false)
    }
  } finally { db.close() }
})
