import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { AgentMuxFileAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

it('public message and Dispatch reads retain the original Runtime identity without loading damaged signing material', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-read-signing-'))
  const authority = new AgentMuxCreationAuthority({ stateDirectory: directory, runtimeId: 'original-runtime' })
  class Client extends AgentMuxClient {
    constructor(options: { store: AgentMuxAgentSessionStore }) { super({ ...options, creationAuthority: authority }) }
  }
  const h = await rpcOwnerFixture(['caller', 'recipient'], { AgentMuxClient: Client, AgentMuxFileAgentSessionStore })
  const queue = new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'read.sock'), coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: h.credentials })
  try {
    await queue.append({ messageId: 'local-message', operationId: 'local-operation', createdAt: 1,
      sender: { kind: 'agent-session', agentSessionId: 'caller' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
      senderSessionId: 'caller', senderRunId: 'run-caller', recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
      threadId: 'local-thread', correlationId: 'local-message', replyTo: null, workspaceId: null, body: 'Original local work.' })
    await h.client.openDispatch({ capability: h.capability, callerAgentSessionId: 'caller', sourceMessageId: 'local-message' })
    const target = { runtimeId: 'remote-runtime', agentSessionId: 'recipient', runId: 'remote-run' }
    await h.client.prepareFederatedMessage({ caller: h.credentials, target, targetKeyFingerprint: 'f'.repeat(64),
      text: 'Retained remote work.', operationId: 'remote-operation', messageId: 'remote-message' })
    await h.client.openDispatch({ capability: h.capability, callerAgentSessionId: 'caller', sourceMessageId: 'remote-message' })
    const identityFile = join(directory, 'agent-creation-identity.json')
    await writeFile(identityFile, 'damaged original signing material')
    const keyReads = vi.spyOn(authority, 'identity')
    const listing = await rpc.call('message.ls', { direction: 'outgoing' }).catch(error => ({ messages: [], readIssue: String(error) }))
    expect(listing.messages.map(message => message.envelope.messageId)).toEqual(['remote-message', 'local-message'])
    expect((await rpc.call('message.read', { messageId: 'remote-message' })).message?.envelope.senderRuntimeId).toBe('original-runtime')
    expect((await rpc.call('message.events', {})).events.length).toBeGreaterThan(0)
    expect((await rpc.call('message.dispatch.ls', {})).dispatches).toHaveLength(2)
    expect((await rpc.call('message.dispatch.read', { sourceMessageId: 'local-message' })).dispatch.sourceMessageId).toBe('local-message')
    expect(keyReads).not.toHaveBeenCalled()
    await expect(h.client.prepareFederatedMessage({ caller: h.credentials, target, targetKeyFingerprint: 'f'.repeat(64),
      text: 'A new signed operation.', operationId: 'new-remote-operation', messageId: 'new-remote-message' })).rejects.toThrow(/identity|authority/i)
    expect(await readFile(identityFile, 'utf8')).toBe('damaged original signing material')
    const unknown = new AgentMuxClient({ store: h.store })
    await (unknown as unknown as { registry: { load(hostId: string): Promise<void> } }).registry.load('local')
    const unknownServer = new AgentMuxControlServer({ socketPath: join(h.root, 'unknown-runtime.sock'), coreClients: () => [{ hostId: 'local', client: unknown }] })
    await unknownServer.start()
    const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: unknownServer.path }, credentials: h.credentials })
    const trusted = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: unknownServer.path } })
    try {
      expect((await managed.call('message.ls', { direction: 'outgoing' })).messages.map(message => message.envelope.messageId)).toEqual(['local-message'])
      expect((await managed.call('message.dispatch.ls', {})).dispatches).toHaveLength(1)
      expect((await trusted.call('message.ls', { hostId: 'local', participantSessionId: 'caller', direction: 'outgoing' })).messages).toHaveLength(2)
      const retained = await trusted.call('message.dispatch.read', { sourceMessageId: 'remote-message', hostId: 'local' })
      expect(retained.dispatch?.sourceMessageId).toBe('remote-message')
      expect(retained.identityDiagnostics.some(issue => issue.code === 'DISPATCH_IDENTITY_UNAVAILABLE')).toBe(true)
    } finally { await managed.dispose(); await trusted.dispose(); await unknownServer.stop(); await unknown.dispose() }
    expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await rpc.dispose(); await server.stop(); await h.close(); await rm(directory, { recursive: true, force: true }) }
})
