import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

it.each([false, true])('retained active=%s intents preserve identity without closing new saves across FileStore reopen', async active => {
  const root = await mkdtemp(fixturePath("tmp/agentmux-future-retention-"))
  const path = join(root, 'sessions.json')
  const intents = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`old-${index}`, {
    operationId: `original-${index}`, prompt: `Original schedule ${index}`, active,
    message: { userContent: `Original schedule ${index}` }
  }]))
  const store = new AgentMuxFileAgentSessionStore(path)
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: 1, updatedAt: 1,
    futurePromptIntents: intents })
  const client = new AgentMuxClient({ store })
  // The test owns persistence only. No user Runtime or Agent Input is operated.
  const inner = client as unknown as { registry: { load(hostId: string): Promise<void> }; connected: boolean; kernel: { isConnected(): boolean } }
  await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => true
  try {
    await expect(client.saveAgentFuturePromptIntent({ agentSessionId: 'agent', intentId: 'new', operationId: 'new-operation', prompt: 'Next schedule', active: true })).resolves.toBeUndefined()
    await client.saveAgentFuturePromptIntent({ agentSessionId: 'agent', intentId: 'old-0', operationId: 'original-0', prompt: 'Original schedule 0', active: !active })
    await expect(client.saveAgentFuturePromptIntent({ agentSessionId: 'agent', intentId: 'old-0', operationId: 'replacement', prompt: 'Changed', active: true }))
      .rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    const [reopened] = await new AgentMuxFileAgentSessionStore(path).load()
    expect(reopened).toMatchObject({ agentSessionId: 'agent', run: { runId: 'original-run' }, futurePromptIntents: {
      ...intents, 'old-0': { ...intents['old-0']!, active: !active }, new: { operationId: 'new-operation', prompt: 'Next schedule', active: true }
    } })
    expect(Object.keys((reopened as AgentMuxStoredAgentSession).futurePromptIntents!)).toHaveLength(257)
  } finally { await client.dispose(); await rm(root, { recursive: true, force: true }) }
})
