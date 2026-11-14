import { afterEach, expect, it, vi } from 'vitest'
import { createSpaceMemberProgressFixture } from './helpers/space-member-progress-fixture.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { messagePacketDigest } from '../src/agent-message-federation.js'
import { join } from 'node:path'
import { parseSpaceMemberParams } from '../src/space-member-codec.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it.each([false, true])('original member mail reads only its Runtime-qualified participation and local legacy (foreign: %s)', async foreign => {
  const f = await createSpaceMemberProgressFixture(cleanup), selected = await f.admit(foreign)
  const queue = new DurableAgentMuxMessageQueue(selected.owner.client.agentMessageQueuePath())
  const runtimeId = selected.target.runtimeId
  const native = vi.spyOn(selected.owner.client, 'runtimeSubject').mockRejectedValue(Error('The Native observation is unavailable, not original mail permission'))
  const input = (id: string, senderRuntimeId?: string, recipientRuntimeId?: string): AgentMuxMessageAppendInput & { messageId: string } => ({
    messageId: id, operationId: 'op-' + id, createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: 'recipient' }, recipient: { kind: 'agent-session', agentSessionId: 'caller' },
    senderSessionId: 'recipient', senderRunId: 'run-recipient', recipientSessionId: 'caller', recipientRunId: 'run-caller',
    ...(senderRuntimeId ? { senderRuntimeId } : {}), ...(recipientRuntimeId ? { recipientRuntimeId } : {}),
    threadId: id, correlationId: id, replyTo: null, workspaceId: null, body: 'Original body ' + id
  })
  const mirror = new AgentMuxCreationAuthority({ stateDirectory: join(selected.owner.root, 'mirror-authority'), runtimeId: 'namesake-runtime' })
  const recipient = new AgentMuxCreationAuthority({ stateDirectory: join(selected.owner.root, 'recipient-authority'), runtimeId: 'other-runtime' })
  const receiver = await recipient.identity()
  for (const envelope of [input('original-mail', runtimeId, receiver.runtimeId), input('namesake-mirror', mirror.runtimeId, receiver.runtimeId), input('local-legacy')]) {
    if (envelope.senderRuntimeId) {
      const signer = envelope.senderRuntimeId === runtimeId ? foreign ? f.d.authority : f.b.authority : mirror
      const packet = { envelope: { ...envelope, schema: 'agentmux.a2a.v1' as const }, execution: 'default' as const, sourceChannel: 'cli' as const }
      const provenance = await signer.attestMessage({ agentSessionId: 'recipient', runId: 'run-recipient' },
        { runtimeId: receiver.runtimeId, agentSessionId: 'caller', runId: 'run-caller' }, messagePacketDigest(packet), receiver.fingerprint)
      await queue.append({ ...packet.envelope, execution: packet.execution, sourceChannel: packet.sourceChannel }, { deliveryMode: 'outbox', provenance })
    } else await queue.append(envelope)
    await queue.openDispatch({ callerAgentSessionId: 'recipient', sourceMessageId: envelope.messageId! }, async () => {})
  }
  const target = { ...selected.target, kind: 'conversation' as const }
  const participant = { hostId: 'local', participantSessionId: 'recipient', participantRuntimeId: runtimeId }
  const call = (method: string, params: object) => f.rpc.call('space.member.call', { target, call: { method, params } } as never)
  expect((await selected.owner.client.listMessages({ participantSessionId: 'recipient', participantRuntimeId: runtimeId, direction: 'outgoing' })).messages.map(value => value.envelope.messageId)).toEqual(['local-legacy', 'original-mail'])
  const page = await call('message.ls', { ...participant, direction: 'outgoing' }) as { messages: Array<{ envelope: { messageId: string } }> }
  expect(page.messages.map(value => value.envelope.messageId)).toEqual(['local-legacy', 'original-mail'])
  for (const messageId of ['original-mail', 'local-legacy']) {
    expect(await call('message.read', { ...participant, messageId })).toMatchObject({ message: { envelope: { messageId, body: 'Original body ' + messageId } } })
    expect(await call('message.read', { ...participant, messageId, field: 'body', maxBytes: 4096 })).toMatchObject({ field: { envelope: { messageId } } })
    expect(await call('message.dispatch.read', { ...participant, sourceMessageId: messageId })).toMatchObject({ dispatch: { sourceMessageId: messageId } })
  }
  for (const selector of [{ messageId: 'namesake-mirror' }, { messageId: 'namesake-mirror', field: 'body', maxBytes: 4096 }, { operationId: 'op-namesake-mirror', field: 'channelQuote', maxBytes: 4096 }])
    {
      await expect(call('message.read', { ...participant, ...selector })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
      const { hostId: _host, ...originalParticipant } = participant
      await expect(selected.owner.client.readMessage({ ...originalParticipant, ...selector } as never)).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
    }
  await expect(call('message.dispatch.read', { ...participant, sourceMessageId: 'namesake-mirror' })).rejects.toMatchObject({ code: 'DISPATCH_PARTICIPANT_MISMATCH' })
  await expect(selected.owner.client.readDispatch({ participantSessionId: 'recipient', participantRuntimeId: runtimeId, sourceMessageId: 'namesake-mirror' })).rejects.toMatchObject({ code: 'DISPATCH_PARTICIPANT_MISMATCH' })
  const dispatches = await call('message.dispatch.ls', participant) as { dispatches: Array<{ sourceMessageId: string }> }
  expect(dispatches.dispatches.map(value => value.sourceMessageId).sort()).toEqual(['local-legacy', 'original-mail'])
  const originalRpc = foreign ? f.d.rpc : f.b.rpc
  const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.original.root + (foreign ? '/D.sock' : '/B.sock') },
    credentials: { agentSessionId: 'recipient', capability: selected.owner.capability } })
  cleanup.push(() => managed.dispose())
  expect((await managed.call('message.ls', { direction: 'outgoing' })).messages.map(value => value.envelope.messageId)).toEqual(['local-legacy', 'original-mail'])
  expect((await managed.call('message.dispatch.ls', {})).dispatches.map(value => value.sourceMessageId).sort()).toEqual(['local-legacy', 'original-mail'])
  expect((await managed.call('message.read', { messageId: 'original-mail' })).message?.envelope.messageId).toBe('original-mail')
  expect((await managed.call('message.dispatch.read', { sourceMessageId: 'original-mail' })).dispatch.sourceMessageId).toBe('original-mail')
  for (const selector of [{ participantSessionId: 'caller', participantRuntimeId: runtimeId }, { participantSessionId: 'recipient', participantRuntimeId: 'namesake-runtime' }]) {
    await expect(managed.call('message.ls', { ...selector, direction: 'outgoing' })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
    await expect(managed.call('message.read', { ...selector, messageId: 'original-mail' })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
    await expect(managed.call('message.dispatch.ls', selector)).rejects.toMatchObject({ code: selector.participantSessionId !== 'recipient' ? 'DISPATCH_PARTICIPANT_MISMATCH' : 'MESSAGE_PARTICIPANT_MISMATCH' })
    await expect(managed.call('message.dispatch.read', { ...selector, sourceMessageId: 'original-mail' })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
  }
  const journalRoute = DurableAgentMuxMessageQueue.prototype.readMessageRoute
  const routed = vi.spyOn(DurableAgentMuxMessageQueue.prototype, 'readMessageRoute').mockImplementation(function (this: DurableAgentMuxMessageQueue, operationId, messageId) {
    if (messageId === 'original-mail') throw new Error('A qualified original read must not consult another journal route')
    return journalRoute.call(this, operationId, messageId)
  })
  await expect(originalRpc.call('message.read', { ...participant, messageId: 'original-mail' })).resolves.toMatchObject({ message: { envelope: { body: 'Original body original-mail' } } })
  expect(routed).not.toHaveBeenCalled(); routed.mockRestore()
  await expect(originalRpc.call('message.ls', { ...participant, participantRuntimeId: 'namesake-runtime', direction: 'outgoing' })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
  for (const selector of [{ participantSessionId: 'recipient' }, { participantRuntimeId: runtimeId }])
    await expect(originalRpc.call('message.read', { hostId: 'local', messageId: 'local-legacy', ...selector } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect((await originalRpc.call('message.read', { hostId: 'local', messageId: 'namesake-mirror' })).message?.envelope.body).toBe('Original body namesake-mirror')
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.original.root + (foreign ? '/D.sock' : '/B.sock'), 'message', 'read',
    '--host', 'local', '--message-id', 'original-mail', '--participant', 'recipient', '--participant-runtime', runtimeId], objectCliEnvironment(selected.owner.root))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.message.envelope.messageId).toBe('original-mail')
  expect(native).not.toHaveBeenCalled()
  expect(selected.owner.inner.kernel.input).not.toHaveBeenCalled(); expect(selected.owner.inner.kernel.stop).not.toHaveBeenCalled()
  if (foreign) {
    await f.configure(f.d, [], [])
    await expect(call('message.read', { ...participant, messageId: 'original-mail' })).rejects.toMatchObject({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  }
})

it('member mail keeps the exact participant and original bounded selector before routing', () => {
  const target = { kind: 'conversation' as const, reference: { runtimeId: 'B', spaceId: 'original' }, regionId: 'region', runtimeId: 'D',
    agentSessionId: 'S', expectedAdmission: { kind: 'creation' as const, operationId: 'C' } }
  const params = { hostId: 'local', participantSessionId: 'S', participantRuntimeId: 'D', messageId: 'MID', field: 'body', maxBytes: 4096 }
  expect(() => parseSpaceMemberParams('space.member.call', { target, call: { method: 'message.read', params } })).not.toThrow()
  for (const input of [{ ...params, participantRuntimeId: 'other-D' }, { ...params, participantSessionId: 'other-S' }, { ...params, hostId: 'observer' },
    { ...params, field: 'envelope' }, { ...params, maxBytes: 10 }, { ...params, operationId: 'second-selector' }, { ...params, notificationId: 'not-field-metadata' },
    { ...params, cursor: '' }, { ...params, arbitrary: true }])
    expect(() => parseSpaceMemberParams('space.member.call', { target, call: { method: 'message.read', params: input } })).toThrow()
})
