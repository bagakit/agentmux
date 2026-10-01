import { fixturePath as upstreamFixturePath, fixtureDisplayPath as upstreamFixtureDisplayPath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'
import { DurableAgentMuxMessageQueue, type AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

describe('Core A2A envelope authorization', () => {
  it('rejects sender or recipient Run facts that do not match the authorized live sessions', async () => {
    const client = Object.create(AgentMuxClient.prototype) as AgentMuxClient
    const sender = { agentSessionId: 'sender', run: { runId: 'sender-run' } }
    const recipient = { agentSessionId: 'recipient', run: { runId: 'recipient-run' } }
    const runtime = client as unknown as { currentMessageReader: (id: string) => Promise<typeof sender>; resolveMessageAuthor: () => string }
    runtime.currentMessageReader = async id => id === 'sender' ? sender : recipient
    runtime.resolveMessageAuthor = () => 'sender'
    await expect(client.authorizeAgentMessage({ capability: 'cap', callerAgentSessionId: 'sender', senderAgentSessionId: 'forged-identity', senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: 'recipient', recipientRunId: 'recipient-run' })).rejects.toThrow('sender facts')
    await expect(client.authorizeAgentMessage({ capability: 'cap', callerAgentSessionId: 'sender', senderAgentSessionId: 'sender', senderSessionId: 'sender', senderRunId: 'wrong-run', recipientSessionId: 'recipient', recipientRunId: 'recipient-run' })).rejects.toThrow('sender facts')
    await expect(client.authorizeAgentMessage({ capability: 'cap', callerAgentSessionId: 'sender', senderAgentSessionId: 'sender', senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: 'recipient', recipientRunId: 'wrong-run' })).rejects.toThrow('recipient facts')
    await expect(client.authorizeAgentMessage({ capability: 'cap', callerAgentSessionId: 'sender', senderAgentSessionId: 'sender', senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: null, recipientRunId: null })).rejects.toThrow('recipient Session/Run')
    await expect(client.authorizeAgentMessage({ capability: 'cap', callerAgentSessionId: 'sender', senderAgentSessionId: 'sender', senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: 'recipient', recipientRunId: null })).rejects.toThrow('recipient Session/Run')
  })

  it('refuses a forged duplicate participant before real durable queue append on the Core send boundary', async () => {
    const root = await mkdtemp(upstreamFixtureDisplayPath("tmp/amux-source-proof-"))
    const store = new AgentMuxMemoryAgentSessionStore()
    const capability = issueAgentCapability()
    const make = (agentSessionId: string): AgentMuxStoredAgentSession => ({
      kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: upstreamFixturePath("repo"),
      run: { runId: `run-${agentSessionId}` }, retiredRuns: [], hookBindingId: `hook-${agentSessionId}`, hookToken: `token-${agentSessionId}`,
      ...(agentSessionId === 'sender' ? { capabilityHash: hashAgentCapability(capability) } : {}),
       createdAt: 1, updatedAt: 1
    })
    await store.compareAndSwap(null, make('sender'))
    await store.compareAndSwap(null, make('recipient'))
    const client = new AgentMuxClient({ store })
    await (client as unknown as { registry: { load(hostId: string): Promise<void> } }).registry.load('local')
    const queue = new DurableAgentMuxMessageQueue(join(root, 'messages.ndjson'))
    const body: AgentMuxMessageAppendInput = {
      operationId: 'request-source-proof', createdAt: 1,
      sender: { kind: 'agent-session', agentSessionId: 'different-agent' },
      recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
      threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null,
      senderSessionId: 'sender', senderRunId: 'run-sender', recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
      body: 'authored text'
    }
    // Same authorize-before-append order as the production CLI, using the actual Core capability
    // resolver and queue rather than a socket parser which has an independent duplicate-label guard.
    const send = async () => {
      await client.authorizeAgentMessage({ capability, callerAgentSessionId: 'sender', senderAgentSessionId: 'different-agent',
        senderSessionId: body.senderSessionId, senderRunId: body.senderRunId,
        recipientSessionId: body.recipientSessionId, recipientRunId: body.recipientRunId })
      return await queue.append(body)
    }
    try {
      await expect(send()).rejects.toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
      expect(await queue.listAfter(0)).toEqual([])
    } finally {
      await client.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
