import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { messageApprovalCandidate, messagePacketDigest, parseSignedMessage } from '../src/agent-message-federation.js'
import type { AgentMuxMessageEnvelope } from '../src/agent-message-envelope.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxClient } from '../src/client.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc, type AgentMuxRpcClient } from '../src/public-rpc-client.js'
import type { AgentMuxRpcMethod, AgentMuxRpcParams } from '../src/public-rpc.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-message-authority-')); roots.push(root)
  const source = new AgentMuxCreationAuthority({ stateDirectory: join(root, 'a'), runtimeId: 'runtime-a' })
  const target = new AgentMuxCreationAuthority({ stateDirectory: join(root, 'b'), runtimeId: 'runtime-b' })
  const a = await source.identity(), b = await target.identity()
  const approval = { sourceRuntimeId: a.runtimeId, publicKey: a.publicKey, targetRuntimeId: b.runtimeId, targetKeyFingerprint: b.fingerprint }
  const participant = { runtimeId: b.runtimeId, agentSessionId: 'same-session', runId: 'same-run' }
  const envelope: AgentMuxMessageEnvelope = { schema: 'agentmux.a2a.v1', messageId: 'message-id', operationId: 'operation-id', createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: 'same-session' }, recipient: { kind: 'agent-session', agentSessionId: 'same-session' },
    senderSessionId: 'same-session', senderRunId: 'same-run', senderRuntimeId: a.runtimeId,
    recipientSessionId: 'same-session', recipientRunId: 'same-run', recipientRuntimeId: b.runtimeId,
    threadId: 'thread-id', correlationId: 'message-id', replyTo: null, workspaceId: null, body: 'Exact original body\n',
    application: { schema: 'test.application.v1', data: { criterion: ['a', 'b'] } } }
  const payload = { envelope, execution: 'default' as const, sourceChannel: 'cli' as const }
  const provenance = await source.attestMessage({ agentSessionId: 'same-session', runId: 'same-run' }, participant, messagePacketDigest(payload), b.fingerprint)
  return { root, source, target, approval, packet: { ...payload, provenance }, a, b }
}

it('keeps creation approval separate and authenticates the exact message purpose and target', async () => {
  const f = await fixture()
  await f.target.trust(f.approval, { kind: 'user', id: 'person' })
  await expect(f.target.verifyMessageProof(f.packet.provenance)).rejects.toMatchObject({ code: 'AGENT_MESSAGE_SOURCE_UNTRUSTED' })
  const pin = await f.target.trustMessageSource(f.approval, { kind: 'user', id: 'person' })
  expect(pin).toMatchObject({ purpose: 'agent-message', sourceRuntimeId: f.a.runtimeId, targetRuntimeId: f.b.runtimeId })
  expect(await f.target.verifyMessageProof(f.packet.provenance)).toEqual(pin)
  await expect(f.target.verifyMessageProof({ ...f.packet.provenance, target: { ...f.packet.provenance.target, runtimeId: 'other-runtime' } })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_TARGET_MISMATCH' })
  await expect(f.target.verifyMessageProof({ ...f.packet.provenance, source: { ...f.packet.provenance.source, runId: 'different-run' } })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_AUTHORITY_INVALID' })
  await expect(f.target.verifyMessageProof({ ...f.packet.provenance, targetKeyFingerprint: '0'.repeat(64) })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_TARGET_MISMATCH' })
  await expect(f.target.verifyMessageProof({ ...f.packet.provenance, sourceKeyFingerprint: '0'.repeat(64) })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_AUTHORITY_INVALID' })
  await expect(f.source.verifyMessageProof(f.packet.provenance)).rejects.toMatchObject({ code: 'AGENT_MESSAGE_TARGET_MISMATCH' })
})

it('binds body, application, exact Runtime identities and execution while rejecting forged approval', async () => {
  const f = await fixture()
  expect(parseSignedMessage(f.packet)).toEqual(f.packet)
  for (const envelope of [{ ...f.packet.envelope, body: 'changed' },
    { ...f.packet.envelope, senderRuntimeId: 'runtime-b' },
    { ...f.packet.envelope, application: { schema: 'test.application.v1', data: { criterion: ['b'] } } }]) {
    expect(() => parseSignedMessage({ ...f.packet, envelope })).toThrowError()
  }
  expect(() => parseSignedMessage({ ...f.packet, execution: 'immediate' })).toThrowError()
  await expect(f.target.trustMessageSource(f.approval, { kind: 'agent', id: 'same-session' } as never)).rejects.toMatchObject({ code: 'AGENT_MESSAGE_TRUST_PERMISSION_REQUIRED' })
  await expect(f.target.trustMessageSource({ ...f.approval, targetKeyFingerprint: '0'.repeat(64) }, { kind: 'user', id: 'person' })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_TARGET_MISMATCH' })
  expect(await f.target.listTrustedMessageSources()).toEqual([])
})

it('exports only a separately signed exact thread read under message-purpose trust', async () => {
  const f = await fixture()
  await f.target.trustMessageSource(f.approval, { kind: 'user', id: 'person' })
  const read = await f.source.attestMessageRead({ agentSessionId: 'same-session', runId: 'same-run' }, f.b.runtimeId, 'message-id', f.packet.provenance.intentDigest, { kind: 'agent', agentSessionId: 'same-session', runId: 'same-run' }, f.b.fingerprint)
  expect(await f.target.verifyMessageProof(read)).toMatchObject({ purpose: 'agent-message' })
  await expect(f.target.verifyMessageProof({ ...read, sourceMessageId: 'another-message' })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_AUTHORITY_INVALID' })
  await expect(f.target.verifyMessageProof({ ...read, reader: { kind: 'host' } })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_AUTHORITY_INVALID' })
  await expect(f.target.verifyMessageProof({ ...read, purpose: 'agent-creation' } as never)).rejects.toMatchObject({ code: 'AGENT_MESSAGE_AUTHORITY_INVALID' })
})

it('keeps foreign outbox intents out of the native consumer and qualifies discovery before pagination', async () => {
  const f = await fixture(), queue = new DurableAgentMuxMessageQueue(join(f.root, 'a', 'messages.ndjson'))
  const outbox = await queue.append({ ...f.packet.envelope, execution: 'default', sourceChannel: 'cli' }, { deliveryMode: 'outbox', provenance: f.packet.provenance })
  await expect(queue.append({ ...f.packet.envelope, execution: 'default', sourceChannel: 'cli' },
    { deliveryMode: 'outbox', provenance: { ...f.packet.provenance, signature: 'B'.repeat(86) } })).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
  expect(outbox.transport).toEqual({ state: 'outbox', targetRuntimeId: f.b.runtimeId })
  expect((await queue.check({ consumerId: 'same-session', readerRun: { runId: 'same-run' }, limit: 10 }, async () => {})).messages).toEqual([])
  await queue.openDispatch({ callerAgentSessionId: 'same-session', sourceMessageId: f.packet.envelope.messageId }, async () => {})
  const reply = { ...f.packet.envelope, messageId: 'reply-message', operationId: 'reply-operation', senderRuntimeId: f.b.runtimeId,
    recipientRuntimeId: f.a.runtimeId, replyTo: f.packet.envelope.messageId, body: 'Actual worker reply', application: { schema: 'test.report.v1', data: null } }
  const replyProof = await f.target.attestMessage({ agentSessionId: 'same-session', runId: 'same-run' },
    { runtimeId: f.a.runtimeId, agentSessionId: 'same-session', runId: 'same-run' }, messagePacketDigest({ envelope: reply, execution: 'default', sourceChannel: 'cli' }), f.a.fingerprint)
  await queue.append({ ...reply, execution: 'default', sourceChannel: 'cli' }, { deliveryMode: 'reference', provenance: replyProof })
  const foreign = new AgentMuxCreationAuthority({ stateDirectory: join(f.root, 'c'), runtimeId: 'runtime-c' })
  const outsider = { ...reply, messageId: 'outsider-message', operationId: 'outsider-operation', senderRuntimeId: 'runtime-c',
    recipient: { kind: 'agent-session' as const, agentSessionId: 'other-recipient' }, recipientSessionId: 'other-recipient', body: 'Not this local participant' }
  const outsiderProof = await foreign.attestMessage({ agentSessionId: 'same-session', runId: 'same-run' },
    { runtimeId: f.a.runtimeId, agentSessionId: 'other-recipient', runId: 'same-run' }, messagePacketDigest({ envelope: outsider, execution: 'default', sourceChannel: 'cli' }), f.a.fingerprint)
  await queue.append({ ...outsider, execution: 'default', sourceChannel: 'cli' }, { deliveryMode: 'reference', provenance: outsiderProof })
  const observation = await queue.readDispatch({ sourceMessageId: f.packet.envelope.messageId, callerAgentSessionId: 'same-session' }, async () => [])
  expect(observation.replies.map(message => message.envelope.messageId)).toEqual(['reply-message'])
  expect((await queue.check({ consumerId: 'same-session', readerRun: { runId: 'same-run' }, limit: 10 }, async () => {})).messages.map(message => message.envelope.messageId)).toEqual(['reply-message'])
  expect((await queue.listMessages({ participantSessionId: 'same-session', direction: 'outgoing', limit: 1 }, async () => {}, f.a.runtimeId)).messages.map(message => message.envelope.messageId)).toEqual(['message-id'])
  const events = await queue.listMessageEvents({ participantSessionId: 'same-session', limit: 100 }, async () => {}, f.a.runtimeId)
  expect(events.events.flatMap(event => event.messages.map(message => message.messageId))).not.toContain('outsider-message')
  expect((await queue.listDispatches({ participantSessionId: 'same-session', limit: 1 }, async () => {}, f.a.runtimeId)).dispatches).toHaveLength(1)
})

it('persists only the exact target Core signed inbox proof without changing outbox or granting reverse source trust', async () => {
  const f = await fixture(), path = join(f.root, 'a', 'receipts.ndjson'), queue = new DurableAgentMuxMessageQueue(path)
  await queue.append({ ...f.packet.envelope, execution: 'default', sourceChannel: 'cli' }, { deliveryMode: 'outbox', provenance: f.packet.provenance })
  const boundary = await queue.messageChanges()
  await queue.listMessageEvents({ participantSessionId: 'same-session' }, async () => {}, f.a.runtimeId)
  const receipt = await f.target.attestMessageInboxReceipt({ kind: 'recipient-inbox', messageId: f.packet.envelope.messageId,
    operationId: f.packet.envelope.operationId, intentDigest: f.packet.provenance.intentDigest, sequence: 17, deliveryMode: 'reference', diskDurability: 'confirmed' })
  await expect(queue.recordPeerInbox({ ...receipt, signature: 'A'.repeat(86) })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_RECEIPT_INVALID' })
  expect((await queue.readByMessageId(f.packet.envelope.messageId))?.peerInbox).toBeUndefined()
  const wrongTarget = await f.source.attestMessageInboxReceipt({ kind: 'recipient-inbox', messageId: receipt.messageId, operationId: receipt.operationId,
    intentDigest: receipt.intentDigest, sequence: 17, deliveryMode: 'reference', diskDurability: 'confirmed' })
  await expect(queue.recordPeerInbox(wrongTarget)).rejects.toMatchObject({ code: 'AGENT_MESSAGE_AUTHORITY_INVALID' })
  await queue.recordPeerInbox(receipt); await queue.recordPeerInbox(receipt)
  const saved = await new DurableAgentMuxMessageQueue(path).readByMessageId(receipt.messageId)
  expect(saved).toMatchObject({ peerInbox: receipt, deliveryMode: 'outbox', delivery: { state: 'queued' }, transport: { state: 'outbox' } })
  expect((await queue.readJournal()).filter(record => record.kind === 'message-peer-inbox')).toHaveLength(1)
  expect((await queue.messageChanges(boundary.cut)).changes.map(change => change.recordKind)).toContain('message-peer-inbox')
  expect((await queue.listMessageEvents({ participantSessionId: 'same-session' }, async () => {}, f.a.runtimeId)).events.map(event => event.kind)).toContain('message-peer-inbox')
  expect(await f.source.listTrustedMessageSources()).toEqual([])
})

it('uses one reviewed outbox packet through the public CLI and target Inbox without creating message-source trust', async () => {
  const authority = (root: string, runtimeId: string) => new AgentMuxCreationAuthority({ stateDirectory: join(root, 'authority'), runtimeId })
  const from = await rpcOwnerFixture(['sender', 'other-source'], undefined, undefined, root => ({ creationAuthority: authority(root, 'runtime-a') }))
  const to = await rpcOwnerFixture(['recipient', 'sender'], undefined, undefined, root => ({ creationAuthority: authority(root, 'runtime-b') }))
  const sourceIdentity = await from.client.agentMessageAuthority()
  const targetIdentity = await to.client.agentMessageAuthority()
  const target = { runtimeId: targetIdentity.runtimeId, agentSessionId: 'recipient', runId: 'run-recipient' }
  const prepare = (messageId: string) => from.client.prepareFederatedMessage({ caller: from.credentials,
    target, targetKeyFingerprint: targetIdentity.fingerprint, operationId: 'op-' + messageId, messageId,
    text: 'Original Unicode 正文\n', sourceChannel: 'cli' })
  let remoteRpc: AgentMuxRpcClient
  const remoteClient = Object.assign(Object.create(to.client) as typeof to.client, {
    runtimeOwnerIdentity: () => ({ runtimeId: target.runtimeId, ownerInstanceId: 'recipient-owner', availability: 'connected' as const,
      protocolVersion: 2, processId: process.pid, ctxmux: null }),
    forwardRpc: <M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>) => remoteRpc.call<M>(method, params)
  })
  const sourceServer = new AgentMuxControlServer({ socketPath: join(from.root, 'outbox.sock'),
    coreClients: () => [...from.coreClients(), { hostId: 'exact-remote', client: remoteClient }] })
  const targetServer = new AgentMuxControlServer({ socketPath: join(to.root, 'inbox.sock'), coreClients: to.coreClients })
  const socket = (server: AgentMuxControlServer) => ({ transport: 'unix' as const, path: server.path })
  const cli = (server: AgentMuxControlServer, root: string, args: string[], input = '', env: NodeJS.ProcessEnv = {}) =>
    runSourceObjectCli(['--endpoint', 'unix://' + server.path, 'message', 'federation', ...args], objectCliEnvironment(root, { NODE_NO_WARNINGS: '1', ...env }), input)
  try {
    await sourceServer.start(); await targetServer.start()
    const targetRpc = await connectAgentMuxRpc({ endpoint: socket(targetServer) })
    remoteRpc = targetRpc
    const sourceRpc = await connectAgentMuxRpc({ endpoint: socket(sourceServer) })
    try {
      const selector = { messageId: 'reviewed-message', operationId: 'op-reviewed-message' }
      const text = 'Original Unicode 正文\n'
      // The actual ingress freezes and signs before the first target refusal.
      await expect(sourceRpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: target.agentSessionId, hostId: 'exact-remote' },
        expectedRecipientRuntimeId: target.runtimeId, expectedRun: { runId: target.runId }, text, ...selector, sourceChannel: 'cli' }, { credentials: from.credentials })
      ).rejects.toMatchObject({ code: 'AGENT_MESSAGE_SOURCE_UNTRUSTED' })
      const { packet: next } = await prepare('different-message')
      const read = await cli(sourceServer, from.root, ['outbox', '--message-id', selector.messageId, '--operation-id', selector.operationId], '', {
        AGENTMUX_AGENT_SESSION_ID: from.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: from.credentials.capability })
      expect(read.code, read.stderr).toBe(0)
      const { packet, ...renderedApproval } = JSON.parse(read.stdout).result as import('../src/agent-message-federation.js').AgentMuxMessageApprovalCandidate
      const candidate = messageApprovalCandidate(packet, sourceIdentity.publicKey)
      expect({ packet, ...renderedApproval }).toEqual(candidate)
      expect(packet).toMatchObject({ envelope: { ...selector, body: text }, provenance: { source: { runtimeId: sourceIdentity.runtimeId,
        agentSessionId: from.credentials.agentSessionId, runId: 'run-sender' }, target } })
      await expect(sourceRpc.call('message.federation.outbox', { ...selector, operationId: 'different-operation' })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
      await expect(sourceRpc.call('message.federation.outbox', selector, { credentials: { ...from.credentials, agentSessionId: 'other-source' } })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
      await expect(targetRpc.call('message.federation.approve', candidate, { credentials: to.credentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      await expect(sourceRpc.call('message.federation.approve', candidate)).rejects.toMatchObject({ code: 'AGENT_MESSAGE_TARGET_MISMATCH' })
      await expect(targetRpc.call('message.federation.approve', { ...candidate, packet: next })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_APPROVAL_MISMATCH' })
      const wrongKey = messageApprovalCandidate(packet, targetIdentity.publicKey)
      await expect(targetRpc.call('message.federation.approve', wrongKey)).rejects.toMatchObject({ code: 'AGENT_MESSAGE_AUTHORITY_INVALID' })
      const forgery = messageApprovalCandidate({ ...packet, provenance: { ...packet.provenance, signature: 'A'.repeat(86) } }, sourceIdentity.publicKey)
      await expect(targetRpc.call('message.federation.approve', forgery)).rejects.toMatchObject({ code: 'AGENT_MESSAGE_AUTHORITY_INVALID' })

      const help = await cli(targetServer, to.root, ['approve', '--help'])
      expect(help.code, help.stderr).toBe(0)
      expect(help.stdout).toContain('--approve-digest SHA256')
      const changed = await cli(targetServer, to.root, ['approve', '--input', '-', '--approve-digest', '0'.repeat(64)], JSON.stringify(candidate))
      expect(changed.code).toBe(1)
      expect(JSON.parse(changed.stderr)).toMatchObject({ error: { code: 'AGENT_MESSAGE_APPROVAL_MISMATCH' } })
      const applied = await cli(targetServer, to.root, ['approve', '--input', '-', '--approve-digest', candidate.packetDigest], JSON.stringify(candidate))
      expect(applied.code, applied.stderr).toBe(0)
      const receipt = JSON.parse(applied.stdout).result
      expect(receipt).toMatchObject({ envelope: packet.envelope, provenance: packet.provenance, deliveryMode: 'reference', notification: { state: 'inbox-only' },
        recipientInbox: { runtimeId: target.runtimeId, keyFingerprint: targetIdentity.fingerprint, ...selector, intentDigest: packet.provenance.intentDigest, diskDurability: 'confirmed' } })
      await expect(targetRpc.call('message.federation.intake', { packet: next })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_SOURCE_UNTRUSTED' })
      expect(await to.client.listTrustedMessageSources()).toEqual([])
      const one = new DurableAgentMuxMessageQueue(to.client.agentMessageQueuePath())
      const custodyRecords = (await one.readJournal()).filter(record => record.kind === 'message')
      expect(custodyRecords).toHaveLength(1)
      const importPath = join(to.root, 'historical-input.ndjson')
      await writeFile(importPath, JSON.stringify(custodyRecords[0]) + '\n')
      const imported = new DurableAgentMuxMessageQueue(importPath)
      expect((await imported.readByMessageId(selector.messageId))?.notification).toEqual({ state: 'inbox-only' })
      expect(await imported.pendingNotificationRecipients()).toEqual([])
      expect(await targetRpc.call('message.read', { hostId: 'local', messageId: selector.messageId })).toMatchObject({ message: { envelope: packet.envelope, notification: { state: 'inbox-only' } } })
      await expect(targetRpc.call('message.notify', { hostId: 'local', operationId: 'notify-custody', messageIds: [selector.messageId] }))
        .rejects.toMatchObject({ code: 'A2A_MESSAGE_INBOX_ONLY' })
      await expect(targetRpc.call('message.notify', { hostId: 'local', operationId: 'notify-as-colliding-sender', messageIds: [selector.messageId] },
        { credentials: { ...to.credentials, agentSessionId: 'sender' } })).rejects.toMatchObject({ code: 'A2A_MESSAGE_INBOX_ONLY' })
      const signedRead = await from.client.prepareFederatedRead({ caller: from.credentials, sourceMessageId: selector.messageId })
      await expect(targetRpc.call('message.federation.export', { authority: signedRead })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_SOURCE_UNTRUSTED' })
      expect(to.inner.kernel.input).not.toHaveBeenCalled()

      const before = (await to.store.readMetadata(target.agentSessionId))!
      const replacement = { ...before, run: { runId: 'replacement-run' }, retiredRuns: [before.run] }
      await to.store.compareAndSwapMetadata(before, replacement)
      await to.inner.registry.load('local')
      await expect(targetRpc.call('message.federation.approve', messageApprovalCandidate(next, sourceIdentity.publicKey))).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_STALE_RUN' })
      await targetRpc.dispose(); await targetServer.stop(); await to.client.dispose()
      const reopened = new AgentMuxClient({ store: to.store, creationAuthority: authority(to.root, 'runtime-b') })
      const reopenedServer = new AgentMuxControlServer({ socketPath: targetServer.path, coreClients: () => [{ hostId: 'local', client: reopened }] })
      try {
        await reopenedServer.start(); const reread = await connectAgentMuxRpc({ endpoint: socket(reopenedServer) })
        try {
          expect((await reread.call('message.federation.approve', candidate)).recipientInbox).toEqual(receipt.recipientInbox)
          const journal = new DurableAgentMuxMessageQueue(reopened.agentMessageQueuePath())
          // The automatic producer considers a legitimate successor's original Run lineage.
          expect(await journal.prepareNotification({ notificationId: 'successor-turn-end', agentSessionId: target.agentSessionId,
            condition: agentPromptCondition(replacement), sourceRuns: [replacement.run.runId, target.runId],
            turnEnd: { nativeTurnId: 'first-turn-end', hookReceiptId: 'original-hook-receipt' } })).toBeNull()
          expect(await journal.pendingNotificationRecipients()).toEqual([])
          expect((await journal.readJournal()).filter(record => record.kind === 'message')).toHaveLength(1)
          await reopened.trustMessageSource({ sourceRuntimeId: sourceIdentity.runtimeId, publicKey: sourceIdentity.publicKey,
            targetRuntimeId: targetIdentity.runtimeId, targetKeyFingerprint: targetIdentity.fingerprint }, { kind: 'user', id: 'isolated-target-user' })
          const { packet: normal } = await from.client.prepareFederatedMessage({ caller: from.credentials,
            target: { ...target, runId: replacement.run.runId }, targetKeyFingerprint: targetIdentity.fingerprint,
            operationId: 'trusted-original-op', messageId: 'trusted-original-mid', text: 'Ordinary pinned message', sourceChannel: 'cli' })
          const normallyReceived = await reread.call('message.federation.intake', { packet: normal })
          expect(normallyReceived.notification).toMatchObject({ state: 'pending' })
          const approvedAfterReceipt = await reread.call('message.federation.approve', messageApprovalCandidate(normal, sourceIdentity.publicKey))
          expect(approvedAfterReceipt).toEqual(normallyReceived)
        } finally { await reread.dispose() }
      } finally { await reopenedServer.stop(); await reopened.dispose() }
    } finally { await targetRpc.dispose(); await sourceRpc.dispose() }
  } finally { await targetServer.stop(); await sourceServer.stop(); await to.close(); await from.close() }
}, 30_000)
