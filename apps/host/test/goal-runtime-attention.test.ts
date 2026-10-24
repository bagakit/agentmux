import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession, type AgentMuxAgentRuntimeStatus } from '@agentmux/core'
import { createGoalRuntime } from '../src/goal-runtime.js'

it('the original Goal attention cannot activate on a later Run while exact old-intent cleanup survives continuation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-attention-')), store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'original-binding', hookToken: 'original-token', createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, original)
  const client = new AgentMuxClient({ store, controlSocketPath: join(root, 'control.sock') })
  // Only the original Core metadata/persistence boundary is under test; no
  // Runtime socket, process, input or user namespace is opened.
  const inner = client as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: { isConnected(): boolean } }
  await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => true
  const status = vi.spyOn(client, 'statusAgent').mockImplementation(async () => ({ session: client.agentSession(original.agentSessionId) }) as AgentMuxAgentRuntimeStatus)
  status.mockImplementationOnce(async () => {
    const observed = client.agentSession(original.agentSessionId)
    const stored = (await store.load())[0]!
    await store.compareAndSwap(stored, { ...stored, run: { runId: 'later-run' }, retiredRuns: [original.run], updatedAt: 2 })
    await inner.registry.load('local')
    return { session: observed } as AgentMuxAgentRuntimeStatus
  })
  const runtime = createGoalRuntime({ clients: () => [{ hostId: 'local', client }], checkIn: async () => ({ known: false, reason: 'Not requested.' }) })
  const input = { hostId: 'local', supervisorAgentSessionId: original.agentSessionId, supervisorRunId: original.run.runId, intentId: 'original-attention', operationId: 'original-attention-operation', agentMuxNote: 'Original Goal responsibility.' }
  try {
    await expect(runtime.saveGoalAttention(input)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect((await store.load())[0]).toMatchObject({ agentSessionId: original.agentSessionId, run: { runId: 'later-run' } })
    expect((await store.load())[0]!.futurePromptIntents).toBeUndefined()
    await runtime.saveGoalAttention({ ...input, supervisorRunId: 'later-run', intentId: 'later-attention', operationId: 'later-attention-operation' })
    expect((await store.load())[0]!.futurePromptIntents?.['later-attention']).toMatchObject({ active: true, operationId: 'later-attention-operation' })
    const beforeContinuation = (await store.load())[0]!
    await store.compareAndSwap(beforeContinuation, { ...beforeContinuation, run: { runId: 'continued-run' }, retiredRuns: [...beforeContinuation.retiredRuns, beforeContinuation.run], updatedAt: beforeContinuation.updatedAt + 1 })
    await inner.registry.load('local')
    await runtime.disableGoalAttention({ hostId: input.hostId, supervisorAgentSessionId: input.supervisorAgentSessionId,
      intentId: 'later-attention', operationId: 'later-attention-operation', agentMuxNote: input.agentMuxNote })
    expect((await store.load())[0]).toMatchObject({ run: { runId: 'continued-run' }, futurePromptIntents: {
      'later-attention': { active: false, operationId: 'later-attention-operation' }
    } })
  } finally { status.mockRestore(); await client.dispose(); await rm(root, { recursive: true, force: true }) }
})
