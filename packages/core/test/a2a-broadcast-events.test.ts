import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { DurableAgentMuxMessageQueue, type AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'
import { AgentMuxError } from '../src/errors.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { parseMessageEventsPage } from '../src/agent-message-events.js'
import { parseBroadcastReceipt, broadcastTargetIdentity } from '../src/agent-message-broadcast.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'

function original(id: string, from = 'caller', to = 'recipient', body = 'original body'): AgentMuxMessageAppendInput {
  return { messageId: 'msg-' + id, operationId: 'op-' + id, createdAt: _tailFixtureEpoch(0, 0, 1),
    sender: { kind: 'agent-session', agentSessionId: from }, recipient: { kind: 'agent-session', agentSessionId: to },
    threadId: 'thread-' + id, correlationId: 'correlation-' + id, replyTo: null, workspaceId: null,
    senderSessionId: from, senderRunId: 'run-' + from, recipientSessionId: to, recipientRunId: 'run-' + to, body }
}
async function owner() {
  const h = await rpcOwnerFixture(['caller', 'recipient', 'stranger'])
  const path = join(h.root, 'events.sock'), server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path }, credentials: h.credentials })
  return { ...h, server, rpc, queue: new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath()),
    close: async () => { await rpc.dispose(); await server.stop(); await h.close() } }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('original A2A broadcast and participant events', () => {
  it('freezes explicit duplicate-free target IDs and closes source CLI → Unix RPC → original single Inbox', async () => {
    const h = await owner()
    try {
      const invocation = await parseAgentMuxCliInvocation(['agent', 'broadcast', '--to-sessions', 'stranger,recipient,recipient,absent', '--text', '原正文\n<amux>sample</amux>', '--operation-id', 'broadcast-source'])
      expect(invocation.command.method).toBe('agent.broadcast')
      const result = await h.rpc.call('agent.broadcast', invocation.params as any)
      expect(result.targets.map(target => [target.agentSessionId, target.outcome])).toEqual([['absent', 'not-applied'], ['recipient', 'saved'], ['stranger', 'saved']])
      expect(result.targets.filter(target => target.outcome === 'saved').every(target => target.message?.deliveryMode === 'reference')).toBe(true)
      const records = await h.queue.readJournal(), batch = records.find(record => record.kind === 'broadcast')!
      expect(batch.sequence).toBeLessThan(Math.min(...records.filter(record => record.kind === 'message').map(record => record.sequence)))
      expect(records.filter(record => record.kind === 'message')).toHaveLength(2)
      for (const target of result.targets.filter(target => target.outcome === 'saved')) {
        const message = await h.client.readMessage({ messageId: target.messageId, caller: h.credentials })
        expect(message!.envelope).toMatchObject({ body: '原正文\n<amux>sample</amux>', senderSessionId: 'caller', recipientSessionId: target.agentSessionId, recipientRunId: 'run-' + target.agentSessionId })
      }
      const before = await h.queue.readJournal()
      const replay = await h.rpc.call('agent.broadcast', invocation.params as any)
      expect(replay).toEqual(result)
      expect(await h.queue.readJournal()).toEqual(before)
      expect(h.inner.kernel.input).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('retains original target claims after a lost ACK without blocking independent targets or resending', async () => {
    const h = await owner()
    try {
      const submit = h.client.submitAgentMessage.bind(h.client)
      const originalSubmit = vi.spyOn(h.client, 'submitAgentMessage').mockImplementationOnce(async (input, context) => {
        await submit(input, context)
        throw new AgentMuxError('Original response lost after durable Inbox append.', 'CONTROL_UNAVAILABLE')
      })
      const input = { operationId: 'broadcast-lost-ack', recipientSessionIds: ['recipient', 'stranger'], text: 'Keep this exact input' }
      const first = await h.rpc.call('agent.broadcast', input)
      expect(first.targets.map(target => target.outcome)).toEqual(['saved', 'saved'])
      expect(first.targets[0]!.issue).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
      const actual = await h.queue.readJournal(), calls = originalSubmit.mock.calls.length
      expect(actual.filter(record => record.kind === 'broadcast-result')).toContainEqual(expect.objectContaining({ outcome: 'unconfirmed', agentSessionId: 'recipient' }))
      expect(await h.rpc.call('agent.broadcast', input)).toEqual(first)
      expect(originalSubmit).toHaveBeenCalledTimes(calls)
      const reopened = new DurableAgentMuxMessageQueue(h.queue.path)
      expect(await reopened.inspectBroadcast(input.operationId, async () => {})).toEqual(first)
      expect(await h.queue.readJournal()).toEqual(actual)
      await expect(h.rpc.call('agent.broadcast', { ...input, text: 'changed' })).rejects.toMatchObject({ code: 'BROADCAST_INTENT_CONFLICT' })
      await expect(h.rpc.call('agent.broadcast', { ...input, recipientSessionIds: ['recipient'] })).rejects.toMatchObject({ code: 'BROADCAST_INTENT_CONFLICT' })
    } finally { await h.close() }
  })

  it('keeps a crash-time claimed unknown target observation-only while another saved target progresses', async () => {
    const h = await owner()
    try {
      const { broadcastTargetIdentity } = await import('../src/agent-message-broadcast.js')
      const operationId = 'broadcast-crash'
      await h.queue.claimBroadcast({ operationId, body: 'Original batch', createdAt: _tailFixtureEpoch(0, 0, 1), sourceChannel: 'api',
        author: { hostId: 'local', agentSessionId: 'caller', runId: 'run-caller' }, targets: ['recipient', 'stranger'].map(agentSessionId => ({
          agentSessionId, hostId: 'local', runId: 'run-' + agentSessionId, ...broadcastTargetIdentity(operationId, agentSessionId) })) }, async () => {})
      await h.queue.claimBroadcastTarget(operationId, 'recipient', async () => {})
      const result = await h.client.broadcastMessages({ operationId, text: 'Original batch', recipientSessionIds: ['stranger', 'recipient'], capability: h.capability, callerAgentSessionId: 'caller' })
      expect(result.targets.map(target => target.outcome)).toEqual(['unconfirmed', 'saved'])
      expect((await h.queue.readJournal()).filter(record => record.kind === 'message')).toHaveLength(1)
      expect((await h.rpc.call('agent.broadcast.inspect', { operationId })).broadcast).toEqual(result)
      const parse = JSON.parse, bodyReads: string[] = []
      const bodySpy = vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: any) => { if (text.includes('Original batch')) bodyReads.push(text); return parse(text, reviver) })
      await expect(h.client.inspectMessageBroadcast({ operationId, caller: { agentSessionId: 'stranger', capability: h.capability } })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
      bodySpy.mockRestore(); expect(bodyReads).toEqual([])
    } finally { await h.close() }
  })

  it('joins concurrent SDK/RPC batch writers without duplicate target effects and fences foreign single-message identities', async () => {
    const h = await owner()
    try {
      const request = { operationId: 'broadcast-concurrent', recipientSessionIds: ['stranger', 'recipient'], text: 'Exactly once per target' }
      await Promise.all([h.rpc.call('agent.broadcast', request), h.client.broadcastMessages({ ...request, capability: h.capability, callerAgentSessionId: 'caller' })])
      const batch = (await h.rpc.call('agent.broadcast.inspect', { operationId: request.operationId })).broadcast!
      expect(batch.targets.every(target => target.outcome === 'saved')).toBe(true)
      expect((await h.queue.readJournal()).filter(record => record.kind === 'message')).toHaveLength(2)
      expect(batch.targets.every(target => target.claimSequence !== null && target.resultSequence !== null)).toBe(true)
      const page = await h.rpc.call('message.events', {})
      expect(page.events.filter(event => event.kind === 'message').every(event => event.messages[0]!.broadcast?.operationId === request.operationId && event.messages[0]!.broadcast?.sequence === batch.sequence)).toBe(true)
      const scoped = await h.rpc.call('message.events', { broadcastOperationId: request.operationId, limit: 1 })
      expect(scoped.events).toHaveLength(1); expect(scoped.nextAfterSequence).not.toBeNull()
      const rest = await h.rpc.call('message.events', { broadcastOperationId: request.operationId, afterSequence: scoped.nextAfterSequence!, throughSequence: scoped.throughSequence, incarnation: scoped.incarnation })
      expect(rest.events).toHaveLength(1)
      expect(rest.events[0]!.messages[0]!.broadcast?.operationId).toBe(request.operationId)
      const single = await h.rpc.call('message.events', { messageId: batch.targets[0]!.messageId })
      expect(single.events).toHaveLength(1); expect(single.events[0]!.messages[0]!.messageId).toBe(batch.targets[0]!.messageId)
      expect(() => parseMessageEventsPage(single, { participantSessionId: 'caller', messageId: 'another' })).toThrow()
      await expect(h.rpc.call('message.events', { messageId: batch.targets[0]!.messageId, broadcastOperationId: request.operationId })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })

      const identity = broadcastTargetIdentity('namespace-batch', 'recipient')
      await h.queue.append({ ...original('foreign'), ...identity })
      await expect(h.rpc.call('agent.broadcast', { operationId: 'namespace-batch', recipientSessionIds: ['recipient'], text: 'Different intent' })).rejects.toMatchObject({ code: 'BROADCAST_TARGET_ID_CONFLICT' })
      expect(await h.queue.readBroadcastIntent('namespace-batch', async () => {})).toBeNull()
      expect(() => parseBroadcastReceipt({ ...batch, bodySHA256: '0'.repeat(64) }, request.operationId, 'caller', request.text)).toThrow()
      expect(() => parseBroadcastReceipt({ ...batch, targets: [{ ...batch.targets[0], claimSequence: batch.sequence }] }, request.operationId, 'caller')).toThrow()
    } finally { await h.close() }
  })

  it('point-reads exact broadcast targets without enumerating unrelated Session metadata or accepting prefixes', async () => {
    const h = await owner()
    try {
      const base = (await h.store.readMetadata('stranger'))!
      for (let index = 0; index < 15; index++) await h.store.compareAndSwap(null, { ...base, agentSessionId: 'unrelated-' + index, run: { runId: 'run-unrelated-' + index } })
      await h.inner.registry.load('local')
      const inventories = vi.spyOn(h.client, 'readAgentSessions'), cachedInventories = vi.spyOn(h.client, 'agentSessions')
      const reads = vi.spyOn(h.client, 'readAgentSession')
      const result = await h.rpc.call('agent.broadcast', { operationId: 'broadcast-point-reads', recipientSessionIds: ['recipient', 'stranger', 'recip'], text: 'Only exact IDs' })
      expect(result.targets.map(target => [target.agentSessionId, target.outcome])).toEqual([['recip', 'not-applied'], ['recipient', 'saved'], ['stranger', 'saved']])
      expect(inventories).not.toHaveBeenCalled(); expect(cachedInventories).not.toHaveBeenCalled()
      expect(reads.mock.calls.every(([id]) => ['recipient', 'stranger', 'recip'].includes(id))).toBe(true)
      expect(h.inner.kernel.input).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('preserves ordinary send prefixes but never guesses past exact metadata failure or ambiguous Host identity', async () => {
    const h = await owner()
    try {
      const inventory = vi.spyOn(h.client, 'readAgentSessions')
      const sent = await h.rpc.call('agent.send', { operationId: 'ordinary-prefix', target: { kind: 'agent-session', agentSessionId: 'recip' }, text: 'Original prefix send' })
      expect(sent.envelope.recipientSessionId).toBe('recipient'); expect(inventory).toHaveBeenCalled()
      inventory.mockClear()
      vi.spyOn(h.client, 'readAgentSession').mockRejectedValueOnce(new AgentMuxError('Exact metadata temporarily unavailable', 'AGENT_SESSION_STORE_READ_UNCONFIRMED'))
      await expect(h.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'recipient' } })).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_READ_UNCONFIRMED' })
      expect(inventory).not.toHaveBeenCalled()
      vi.spyOn(h.client, 'agentSession').mockImplementationOnce(() => { throw new AgentMuxError('Cache observation unavailable', 'RUNTIME_UNAVAILABLE') })
      const healthy = await h.rpc.call('agent.send', { operationId: 'healthy-exact-after-cache-failure', target: { kind: 'agent-session', agentSessionId: 'recipient' }, text: 'Durable identity still authorizes this Inbox' })
      expect(healthy.envelope.recipientSessionId).toBe('recipient'); expect(inventory).not.toHaveBeenCalled()
      const remote = new Proxy(h.client, { get(target, key) {
        if (key === 'forwardRpc') return async () => { throw new Error('Ambiguous identity cannot be forwarded') }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const path = join(h.root, 'ambiguous-owner.sock'), server = new AgentMuxControlServer({ socketPath: path,
        coreClients: () => [{ hostId: 'local', client: h.client }, { hostId: 'other', client: remote }] })
      await server.start()
      const reader = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
      try {
        await expect(reader.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'recipient' } })).rejects.toMatchObject({ code: 'AMBIGUOUS_AGENT_SESSION' })
        expect(inventory).not.toHaveBeenCalled()
      } finally { await reader.dispose(); await server.stop() }
      const failedRemote = new Proxy(h.client, { get(target, key) {
        if (key === 'forwardRpc') return async () => { throw new Error('No forwarding is needed for the confirmed local exact target') }
        if (key === 'agentSession') return () => { throw new AgentMuxError('No cached remote identity', 'UNKNOWN_AGENT_SESSION') }
        if (key === 'readAgentSession') return async () => { throw new AgentMuxError('Unrelated remote metadata is unavailable', 'RUNTIME_UNAVAILABLE') }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const partial = new AgentMuxControlServer({ socketPath: join(h.root, 'partial-owner.sock'),
        coreClients: () => [{ hostId: 'local', client: h.client }, { hostId: 'other', client: failedRemote }] })
      await partial.start()
      const partialReader = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: partial.path } })
      try {
        vi.spyOn(h.client, 'agentSession').mockImplementationOnce(() => { throw new AgentMuxError('Cold cache', 'UNKNOWN_AGENT_SESSION') })
        const observed = await partialReader.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'recipient' } })
        expect(observed.routeHostId).toBe('local'); expect(observed.session.agentSessionId).toBe('recipient')
        expect(observed.unavailable).toContainEqual(expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }))
        expect(inventory).not.toHaveBeenCalled()
      } finally { await partialReader.dispose(); await partial.stop() }
    } finally { await h.close() }
  })

  it('retains a frozen recipient Run after replacement without redirecting that target or blocking a healthy peer', async () => {
    const h = await owner()
    try {
      const operationId = 'broadcast-run-fence'
      await h.queue.claimBroadcast({ operationId, body: 'Frozen target', createdAt: _tailFixtureEpoch(0, 0, 1), sourceChannel: 'api',
        author: { hostId: 'local', agentSessionId: 'caller', runId: 'run-caller' }, targets: ['recipient', 'stranger'].map(agentSessionId => ({
          agentSessionId, hostId: 'local', runId: 'run-' + agentSessionId, ...broadcastTargetIdentity(operationId, agentSessionId) })) }, async () => {})
      const previous = (await h.store.readMetadata('recipient'))!
      await h.store.compareAndSwap(previous, { ...previous, run: { runId: 'replacement-run' }, retiredRuns: [previous.run], updatedAt: previous.updatedAt + 1 })
      const batch = await h.rpc.call('agent.broadcast', { operationId, recipientSessionIds: ['recipient', 'stranger'], text: 'Frozen target' })
      expect(batch.targets.map(target => target.outcome)).toEqual(['unconfirmed', 'saved'])
      expect(batch.targets[0]!.runId).toBe('run-recipient')
      expect(await h.queue.readByMessageId(batch.targets[0]!.messageId)).toBeNull()
      expect((await h.queue.readJournal()).filter(record => record.kind === 'message')).toHaveLength(1)
    } finally { await h.close() }
  })

  it('uses the same Hosted SDK method namespace for batch execution, original inspection and participant events', async () => {
    const h = await rpcOwnerFixture(['caller', 'recipient'])
    const authority = { runtimeId: 'broadcast-host', ownerInstanceId: 'broadcast-owner', protocolVersion: 2 as const, processId: process.pid,
      ctxmux: h.client.runtimeIdentity(), availability: 'connected' as const }
    const host = new AgentMuxHostedRuntimeService(h.client, join(h.root, 'sessions.json'), () => authority)
    const path = join(h.root, 'hosted-events.sock'), server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients, hostedRuntime: () => host })
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
    const runtime = vi.spyOn(h.client, 'connectRuntime')
    const hosted = await connectHostedAgentMux({ rpc })
    // The original Hosted opening separately observes the Runtime projection. Finish that
    // unrelated observation before measuring the three offline message operations.
    await vi.waitFor(() => expect(runtime).toHaveBeenCalledOnce())
    await runtime.mock.results[0]!.value
    runtime.mockClear().mockRejectedValue(new Error('Inbox and read-only history need no Runtime connection'))
    h.inner.connected = false; h.inner.kernel.isConnected = () => false
    const connect = vi.spyOn(h.client, 'connect').mockRejectedValue(new Error('Unrelated global recovery must not run'))
    try {
      const batch = await hosted.broadcastMessages({ operationId: 'hosted-batch', recipientSessionIds: ['recipient'], text: 'Hosted original body', capability: h.capability, callerAgentSessionId: 'caller' })
      expect(batch.targets[0]!.outcome).toBe('saved')
      expect(await hosted.inspectMessageBroadcast({ operationId: batch.operationId, caller: h.credentials })).toEqual(batch)
      expect((await hosted.listMessageEvents({ participantSessionId: 'recipient' })).events[0]!.messages[0]!.broadcast).toEqual({ operationId: batch.operationId, sequence: batch.sequence })
      const sourceDevice = { hostId: 'original-host', deviceId: 'original-device', name: 'Original device' }
      const input = { operationId: 'hosted-source', recipientSessionIds: ['recipient'], text: 'Attributed original body', capability: h.capability, callerAgentSessionId: 'caller' }
      const recordDeviceOperation = vi.fn(async (..._args: unknown[]) => {})
      const invoke = (value: typeof input, context = {}) => host.call('runtime.invoke', { consumerId: 'original-broadcast-device',
        fence: { runtimeId: authority.runtimeId, ownerInstanceId: authority.ownerInstanceId }, invocation: { method: 'broadcastMessages', args: [value] } }, context)
      await invoke(input, { sourceDevice, recordDeviceOperation })
      const attributed = await h.client.inspectMessageBroadcast({ operationId: input.operationId })
      expect((await h.client.readMessage({ messageId: attributed!.targets[0]!.messageId }))!.sourceDevice).toEqual(sourceDevice)
      expect(recordDeviceOperation.mock.calls.map(call => [call[1], call[3], call[4]])).toEqual([
        ['broadcastMessages', 'unknown', input.operationId], ['broadcastMessages', 'confirmed', input.operationId]])
      await expect(invoke({ ...input, sourceDevice } as typeof input, { sourceDevice })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      let revoked = false
      const submit = h.client.submitAgentMessage.bind(h.client)
      vi.spyOn(h.client, 'submitAgentMessage').mockImplementationOnce(async (value, context) => { revoked = true; return submit(value, context) })
      const interrupted = { ...input, operationId: 'hosted-revoked' }
      await expect(invoke(interrupted, { assertCurrent: () => { if (revoked) throw new AgentMuxError('Original device authority changed.', 'CONTROL_CANCELLED') } })).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
      const retained = await h.client.inspectMessageBroadcast({ operationId: interrupted.operationId })
      expect(retained!.targets[0]!.outcome).toBe('unconfirmed')
      expect(retained!.targets[0]!.issue?.code).toBe('CONTROL_CANCELLED')
      expect(await h.client.readMessage({ messageId: retained!.targets[0]!.messageId })).toBeNull()
      expect(h.inner.kernel.input).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled()
    } finally { await hosted.dispose(); await rpc.dispose(); await server.stop(); await host.dispose(); await h.close() }
  })

  it('reads the same original message and delivery events from both sides through public Unix RPC', async () => {
    const h = await owner()
    try {
      const saved = await h.queue.append(original('both'))
      await h.queue.recordDeliveryIssue(saved.messageId, 'lost receipt', 2)
      await h.queue.recordDelivery(saved.messageId, 'delivered', 3)
      const before = await h.queue.readJournal()
      const sender = await h.rpc.call('message.events', {})
      const recipient = await h.client.listMessageEvents({ participantSessionId: 'recipient' })
      expect(sender.events).toEqual(recipient.events)
      expect(sender.events.map(event => [event.sequence, event.kind])).toEqual([[1, 'message'], [2, 'delivery-issue'], [3, 'delivery']])
      expect(sender.events[0]!.messages).toEqual([{ messageId: saved.messageId, senderSessionId: 'caller', recipientSessionId: 'recipient', threadId: 'thread-both', replyTo: null }])
      expect(sender.events.at(-1)).toMatchObject({ state: 'delivered', at: _tailFixtureEpoch(0, 0, 3) })
      expect(sender.nextAfterSequence).toBeNull()
      expect(await h.queue.readJournal()).toEqual(before)
      expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('keeps a frozen original sequence boundary across pagination, reopen and new appends', async () => {
    const h = await owner()
    try {
      await h.queue.append(original('one')); await h.queue.append(original('two'))
      const first = await h.rpc.call('message.events', { limit: 1 })
      expect(first.events.map(event => event.sequence)).toEqual([1]); expect(first.nextAfterSequence).toBe(1)
      await h.queue.append(original('three'))
      const reopened = new DurableAgentMuxMessageQueue(h.queue.path)
      const second = await reopened.listMessageEvents({ participantSessionId: 'caller', afterSequence: first.nextAfterSequence!, throughSequence: first.throughSequence, incarnation: first.incarnation, limit: 1 }, async () => {})
      expect(second.events.map(event => event.sequence)).toEqual([2]); expect(second.nextAfterSequence).toBeNull()
      expect((await h.rpc.call('message.events', { afterSequence: first.throughSequence })).events.map(event => event.sequence)).toEqual([3])
      expect((await h.client.listMessageEvents({ participantSessionId: 'stranger' })).events).toEqual([])
      await expect(h.rpc.call('message.events', { throughSequence: first.throughSequence, incarnation: 'different-journal' })).rejects.toMatchObject({ code: 'MESSAGE_EVENT_SOURCE_CHANGED' })
      await expect(h.rpc.call('message.events', { throughSequence: first.throughSequence })).rejects.toMatchObject({ code: 'MESSAGE_EVENT_SOURCE_CHANGED' })
    } finally { await h.close() }
  })

  it('preserves one multi-MID notification event and only references the viewer participation', async () => {
    const h = await owner()
    try {
      await h.queue.append({ ...original('own'), execution: 'default' }, { deliveryMode: 'reference' })
      await h.queue.append({ ...original('other', 'stranger'), execution: 'default' }, { deliveryMode: 'reference' })
      const notice = await h.queue.prepareNotification({ notificationId: 'notice', agentSessionId: 'recipient',
        condition: { expectedRun: { runId: 'run-recipient' }, afterSubmissionId: null } })
      expect(notice).not.toBeNull()
      await h.queue.recordNotificationResult('notice', 'unconfirmed', 'original ACK unknown')
      const incoming = await h.client.listMessageEvents({ participantSessionId: 'recipient' })
      const outgoing = await h.rpc.call('message.events', {})
      const receiverNotice = incoming.events.find(event => event.kind === 'a2a-notification')!
      const senderNotice = outgoing.events.find(event => event.kind === 'a2a-notification')!
      expect(receiverNotice.messages.map(ref => ref.messageId).sort()).toEqual(['msg-other', 'msg-own'])
      expect(senderNotice.messages.map(ref => ref.messageId)).toEqual(['msg-own'])
      expect(receiverNotice.sequence).toBe(senderNotice.sequence)
      expect(outgoing.events.at(-1)).toMatchObject({ kind: 'a2a-notification-result', notificationId: 'notice', state: 'unconfirmed', at: expect.any(Number) })
      expect(JSON.stringify(outgoing)).not.toContain('original body')
    } finally { await h.close() }
  })

  it('does not decode bodies or expand unrelated recipient notifications while reading the selected participant page', async () => {
    const h = await owner()
    try {
      const secret = 'must-not-decode-body-' + 'x'.repeat(1200)
      await h.queue.append(original('indexed', 'caller', 'recipient', secret))
      await h.queue.append(original('unrelated', 'stranger', 'recipient', secret))
      await h.client.listMessageEvents({ participantSessionId: 'caller' })
      // B receives unrelated C traffic after the index is initialized. A's one-message
      // query must remain a direct participant range, not expand B's notification history.
      for (let index = 0; index < 12; index++) await h.queue.append({ ...original('noise-' + index, 'stranger', 'recipient', secret), execution: 'default' }, { deliveryMode: 'reference' })
      await h.queue.prepareNotification({ notificationId: 'unrelated-notice', agentSessionId: 'recipient', condition: { expectedRun: { runId: 'run-recipient' }, afterSubmissionId: null } })
      const queries: string[] = [], prepare = DatabaseSync.prototype.prepare
      const sqlSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql.startsWith('WITH selected AS (')) queries.push(sql)
        return prepare.call(this, sql)
      })
      const parse = JSON.parse, decoded: string[] = []
      const spy = vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: any) => { if (text.includes(secret)) decoded.push(text); return parse(text, reviver) })
      const page = await h.client.listMessageEvents({ participantSessionId: 'caller' })
      spy.mockRestore(); sqlSpy.mockRestore()
      expect(queries).toHaveLength(1)
      expect(decoded).toEqual([]); expect(page.events).toHaveLength(1)
      const db = new DatabaseSync(h.queue.path, { readOnly: true })
      try {
        const plan = db.prepare('EXPLAIN QUERY PLAN ' + queries[0]!)
          .all('caller', 0, page.throughSequence, 2, 'caller').map(row => String(row.detail)).join('\n')
        expect(plan).toContain('SEARCH message_event_positions USING PRIMARY KEY (participant_id=? AND event_sequence>? AND event_sequence<?)')
        expect(plan).not.toMatch(/SCAN (?:original|notice|records)\b/u)
        expect(plan).toContain('SEARCH original USING INTEGER PRIMARY KEY')
        expect(db.prepare('SELECT COUNT(*) AS n FROM message_event_positions WHERE participant_id=?').get('caller')!.n).toBe(1)
      } finally { db.close() }
    } finally { await h.close() }
  })

  it('enforces exact participant/Host authority and rejects malformed event identities', async () => {
    const h = await owner()
    try {
      await h.queue.append(original('auth'))
      await expect(h.rpc.call('message.events', { participantSessionId: 'stranger' })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
      await expect(h.rpc.call('message.events', { hostId: 'other' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      const page = await h.client.listMessageEvents({ participantSessionId: 'caller' })
      expect(() => parseMessageEventsPage({ ...page, events: [{ ...page.events[0], sequence: 0 }] }, { participantSessionId: 'caller' })).toThrow()
      expect(() => parseMessageEventsPage({ ...page, events: [{ ...page.events[0], at: Number.POSITIVE_INFINITY }] }, { participantSessionId: 'caller' })).toThrow()
      expect(() => parseMessageEventsPage({ ...page, events: [{ ...page.events[0], at: Number.NaN }] }, { participantSessionId: 'caller' })).toThrow()
      expect(() => parseMessageEventsPage(page, { participantSessionId: 'stranger' })).toThrow()
      expect(() => parseMessageEventsPage({ ...page, events: [{ ...page.events[0], messages: [{ ...page.events[0]!.messages[0], senderSessionId: 'stranger', recipientSessionId: 'someone-else' }] }] }, { participantSessionId: 'caller' })).toThrow()
      expect(() => parseMessageEventsPage({ ...page, events: [{ ...page.events[0], messages: [{ ...page.events[0]!.messages[0], body: 'forged' }] }] }, { participantSessionId: 'caller' })).toThrow()
      await expect(h.rpc.call('message.events', { afterSequence: 9, throughSequence: 8 })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    } finally { await h.close() }
  })
})
