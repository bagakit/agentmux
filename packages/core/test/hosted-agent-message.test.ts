import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import type { AgentMuxHostedClient, AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-hosted-message-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'recipient', providerId: 'traex',
    executorId: 'traex', hostId: 'local', workspacePath: root, run: { runId: 'recipient-run' }, retiredRuns: [],
    hookBindingId: 'private-binding', hookToken: 'private-hook', createdAt: 1, updatedAt: 1 })
  const core = new AgentMuxClient({ store })
  const inner = core as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> };
    kernel: Record<string, unknown> }
  await inner.registry.load('local'); inner.connected = true
  let acceptedInputBytes = 0
  const run = () => ({ runId: 'recipient-run', lifecycleOperationId: null, program: upstreamFixturePath("private-worker"), args: [],
    workspacePath: root, pid: 421, state: { type: 'running' as const }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes })
  const input = vi.fn(async (_id: string, operation: { expectedByte: number; data: string }) => {
    acceptedInputBytes = operation.expectedByte + Buffer.byteLength(operation.data)
    return { run: run(), appliedByteRange: { startByte: operation.expectedByte, endByte: acceptedInputBytes } }
  })
  const stop = vi.fn()
  Object.assign(inner.kernel, { isConnected: () => true,
    identity: () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 18, buildIdentity: 'private-worker' }),
    status: async () => run(), list: async () => [run()], input, stop })
  vi.spyOn(core, 'connect').mockResolvedValue()
  // Track the original method; its authority, durable queue and prompt submission remain real.
  const submit = vi.spyOn(core, 'submitAgentMessage')
  const service = new AgentMuxHostedRuntimeService(core, store.path)
  const port = {
    call: async (method: string, params: unknown, options?: { signal?: AbortSignal }) =>
      JSON.parse(JSON.stringify(await service.call(method, JSON.parse(JSON.stringify(params)), options))),
    subscribe: async (method: string, params: unknown, handlers: {
      onInitial(value: unknown): void; onEvent(value: unknown): void; signal?: AbortSignal
    }) => {
      const stream = await service.subscribe(method, params, event => handlers.onEvent(JSON.parse(JSON.stringify(event))),
        handlers.signal ? { signal: handlers.signal } : {})
      handlers.onInitial(JSON.parse(JSON.stringify(stream.initial)))
      return { dispose: async () => await stream.dispose() }
    }
  } as unknown as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc: port })
  const message: Parameters<AgentMuxHostedClient['submitAgentMessage']>[0] = {
    agentSessionId: 'recipient', condition: agentPromptCondition(core.agentSession('recipient')),
    envelope: { schema: 'agentmux.a2a.v1', messageId: 'original-message', operationId: 'original-operation', createdAt: 100,
      sender: { kind: 'human', principal: 'local-cli' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
      senderSessionId: null, senderRunId: null, recipientSessionId: 'recipient', recipientRunId: 'recipient-run',
      threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null,
      body: 'Original human body\nSecond line' }
  }
  const queue = new DurableAgentMuxMessageQueue(join(root, 'messages.ndjson'))
  return { core, client, store, submit, input, stop, message, queue, dispose: async () => {
    await client.dispose(); await service.dispose(); await core.dispose()
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true })
  } }
}

describe('Hosted original message submission', () => {
  it('delegates the exact message and prompt intent to the original durable owner once, preserving its delivered receipt', async () => {
    const f = await fixture()
    try {
      expect(f.client.submitAgentMessage).toEqual(expect.any(Function))
      await f.client.submitAgentMessage(f.message)
      expect(f.submit).toHaveBeenCalledExactlyOnceWith(f.message)
      const retained = await loadAgentSessions(f.store)
      expect(retained).toHaveLength(1)
      const admission = retained[0]!.promptCompletionAdmission
      expect(admission).toMatchObject({ submissionId: 'original-message', operationId: expect.any(String),
        intent: { run: { runId: 'recipient-run' }, ownerInstanceId: 'private-daemon' }, acknowledged: true })
      expect(f.input.mock.calls).toEqual([['recipient-run', expect.objectContaining({
        operationId: admission!.operationId, ownerInstanceId: 'private-daemon', expectedByte: 0,
        data: '[Message from unverified local process]\nOriginal human body\nSecond line\r'
      })]])
      expect(await f.queue.listAfter()).toEqual([expect.objectContaining({ envelope: f.message.envelope,
        promptCondition: { expectedRun: { runId: 'recipient-run' }, afterSubmissionId: null },
        delivery: { state: 'delivered', at: expect.any(Number) } })])
      await f.client.submitAgentMessage(f.message)
      expect(f.submit).toHaveBeenCalledTimes(2); expect(f.input).toHaveBeenCalledTimes(1)
      expect(f.core.agentSession('recipient').run).toEqual({ runId: 'recipient-run' })
      expect(f.stop.mock.calls).toEqual([])
    } finally { await f.dispose() }
  })

  it('preserves the original managed author rejection before queue or Input instead of trusting serialized caller facts', async () => {
    const f = await fixture()
    try {
      expect(f.client.submitAgentMessage).toEqual(expect.any(Function))
      const forged: Parameters<AgentMuxHostedClient['submitAgentMessage']>[0] = { ...f.message,
        envelope: { ...f.message.envelope, sender: { kind: 'agent-session', agentSessionId: 'forged-sender' },
          senderSessionId: 'forged-sender', senderRunId: 'forged-run' } }
      await expect(f.client.submitAgentMessage(forged)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      expect(f.submit).toHaveBeenCalledExactlyOnceWith(forged)
      expect(await f.queue.listAfter()).toEqual([]); expect(f.input.mock.calls).toEqual([])
      expect(f.core.agentSession('recipient').run).toEqual({ runId: 'recipient-run' })
      expect(f.stop.mock.calls).toEqual([])
    } finally { await f.dispose() }
  })
})
