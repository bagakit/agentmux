import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient as SourceClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore as SourceStore } from '../src/agent-session-store.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { previousWireCore } from './helpers/previous-core-wire.js'

// Mutation proof supplies the exact private candidate execution graph. Direct
// tests consume source; neither mode borrows the main worktree's Core dist.
const candidate = process.env.AGENTMUX_TEST_A2A_CLIENT
  ? await import(process.env.AGENTMUX_TEST_A2A_CLIENT) : { AgentMuxClient: SourceClient }
const candidateStore = process.env.AGENTMUX_TEST_A2A_CLIENT
  ? await import(new URL('./agent-session-store.js', process.env.AGENTMUX_TEST_A2A_CLIENT).href) : { AgentMuxFileAgentSessionStore: SourceStore }
let previous: Awaited<ReturnType<typeof previousWireCore>>
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => { previous = await previousWireCore() })
afterAll(async () => { await previous?.close() })
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function generations() {
  const f = await rpcOwnerFixture(['sender', 'recipient'], previous.owner, () => ({ providerId: 'traex', executorId: 'traex' }))
  cleanup.push(f.close)
  const applied = f.inner.kernel.input as (...args: unknown[]) => Promise<unknown>
  const writes: string[] = [], operations = new Map<string, { data: string; expectedByte: number }>()
  const input = async (...args: unknown[]) => {
    const operation = args[1] as { operationId: string; data: string; expectedByte: number }, key = JSON.stringify([args[0], operation.operationId])
    const original = operations.get(key)
    if (original) expect(operation).toMatchObject(original)
    const result = await applied(...args)
    if (!original) { operations.set(key, { data: operation.data, expectedByte: operation.expectedByte }); writes.push(operation.data) }
    return result
  }
  f.inner.kernel.input = async (...args: unknown[]) => { await input(...args); throw Error('Original Input ACK lost') }
  const reopen = async () => {
    const client: SourceClient = new candidate.AgentMuxClient({ store: new candidateStore.AgentMuxFileAgentSessionStore(f.store.path) })
    const inner = client as unknown as typeof f.inner
    await inner.registry.load('local'); inner.connected = true
    for (const key of ['isConnected', 'status', 'identity', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[key] = f.inner.kernel[key]
    inner.kernel.input = input
    cleanup.push(async () => { await client.dispose() })
    return { client, writes }
  }
  return { ...f, reopen }
}

describe('original Input wire survives a formatter cutover', () => {
  it('reconciles an A2A lost ACK using its original body, author, message and wire', async () => {
    const f = await generations(), expectedRun = { runId: 'run-recipient' }
    const envelope = { schema: 'agentmux.a2a.v1' as const, messageId: 'original-message', operationId: 'original-control', createdAt: _tailFixtureEpoch(0, 0, 1),
      sender: { kind: 'agent-session' as const, agentSessionId: 'sender' }, recipient: { kind: 'agent-session' as const, agentSessionId: 'recipient' },
      senderSessionId: 'sender', senderRunId: 'run-sender', recipientSessionId: 'recipient', recipientRunId: expectedRun.runId,
      threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null, body: '  Original <body> & code\n\n' }
    const input = { agentSessionId: 'recipient', envelope, condition: agentPromptCondition(f.client.agentSession('recipient')), caller: { agentSessionId: 'sender', capability: f.capability } }
    await expect(f.client.submitAgentMessage(input)).rejects.toThrow('Original Input ACK lost')
    const original = await f.store.readPromptAdmission('recipient', expectedRun, envelope.messageId)
    expect(original?.admission?.intent?.prompt).toBe('[Message from Agent sender]\n' + envelope.body)
    const upgraded = await f.reopen()
    await expect(upgraded.client.submitAgentMessage(input)).resolves.toBeUndefined()
    expect(upgraded.writes).toEqual([original!.admission!.intent!.prompt + '\r'])
    expect(await f.store.readPromptAdmission('recipient', expectedRun, envelope.messageId)).toMatchObject({ admission: { intent: original!.admission!.intent } })
    expect((await new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByMessageId(envelope.messageId))?.delivery.state).toBe('delivered')
    await expect(upgraded.client.submitAgentMessage({ ...input, envelope: { ...envelope, body: 'Changed body' } })).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
  })

  it.each([true, false])('preserves human/unknown note wire and rejects changed content (human=%s)', async human => {
    const f = await generations(), expectedRun = { runId: 'run-recipient' }, operationId = 'original-prompt'
    const input = { agentSessionId: 'recipient', ...agentPromptCondition(f.client.agentSession('recipient')), operationId,
      prompt: '  Original user body\n', agentMuxNote: 'Original platform note <literal>.', ...(human ? { authorHuman: true } : {}) }
    await expect(f.client.submitAgentPrompt(input)).rejects.toThrow('Original Input ACK lost')
    const original = await f.store.readPromptAdmission('recipient', expectedRun, operationId)
    expect(original?.admission?.intent?.prompt).toContain('<amux from="amux">')
    expect(original?.admission?.intent?.message).toMatchObject({ userContent: input.prompt, systemContext: input.agentMuxNote, ...(human ? { authorHuman: true } : {}) })
    const upgraded = await f.reopen()
    await expect(upgraded.client.submitAgentPrompt(input)).resolves.toBeUndefined()
    expect(upgraded.writes).toEqual([original!.admission!.intent!.prompt + '\r'])
    expect(await f.store.readPromptAdmission('recipient', expectedRun, operationId)).toMatchObject({ admission: { intent: original!.admission!.intent } })
    for (const changed of [{ prompt: 'Changed user body' }, { agentMuxNote: 'Changed platform note' }])
      await expect(upgraded.client.submitAgentPrompt({ ...input, ...changed })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    expect(upgraded.writes).toEqual([original!.admission!.intent!.prompt + '\r'])
  })
})
