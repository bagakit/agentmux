import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { agentTurnEndEvidence } from '../src/agent-session-identity.js'
import type { AgentHookServer } from '../src/hook-server.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(providerId: 'cursor' | 'pi' = 'cursor') {
  const id = providerId + '-response', nativeSessionId = '019ff166-9788-4ace-b9eb-9a71a42f0af9'
  const f = await rpcOwnerFixture([id], undefined, () => ({ providerId, executorId: providerId }))
  const run = { runId: 'run-' + id }, nativeHandle = { kind: 'provider' as const, providerId, sessionId: nativeSessionId }
  const original = (await f.store.readMetadata(id))!
  await f.store.compareAndSwapMetadata(original, { ...original, nativeHandle,
    nativeBinding: { source: 'process-witness', run, observedAt: original.updatedAt + 1 }, updatedAt: original.updatedAt + 1 })
  await f.inner.registry.load('local')
  // The original native process identity is a controlled port. HTTP ingress, Provider semantics,
  // Core activity/completion, durable metadata/timeline and public reading are actual owners.
  Reflect.get(f.client, 'hookNativeWitnesses').set(run.runId, { candidate: JSON.stringify(nativeSessionId), handle: nativeHandle })
  const hooks = Reflect.get(f.client, 'hookServer') as AgentHookServer
  Object.defineProperty(hooks, 'port', { value: 0 }); await hooks.start()
  const binding = hooks.createBinding(id, providerId); await binding.bindRun(run.runId)
  const rpc = new AgentMuxRpcService({ coreClients: f.coreClients })
  const send = async (eventName: string, receiptId: string, payload: Record<string, unknown> = {}) => {
    const response = await fetch(binding.endpoint.url, { method: 'POST', headers: {
      authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId, eventName, payload: { hook_event_name: eventName,
        ...(providerId === 'cursor' ? { conversation_id: nativeSessionId, generation_id: 'original-generation' } : { session_id: nativeSessionId }),
        cwd: f.root, ...payload } }) })
    expect(response.status).toBe(204)
  }
  const stored = () => new AgentMuxFileAgentSessionStore(f.store.path).readMetadata(id)
  const inspect = async () => (await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: id } })).session
  return { ...f, id, run, send, stored, inspect, close: async () => { await rpc.dispose(); await f.close() } }
}

it('keeps the original successful stop after a late Cursor response while retaining its receipt and body', async () => {
  const f = await fixture()
  try {
    await f.send('beforeSubmitPrompt', 'original-user', { prompt: 'Original task' })
    await f.send('stop', 'original-stop', { status: 'completed' })
    const stopped = (await f.stored())!, completion = agentTurnEndEvidence(stopped)
    expect(stopped.semanticStatus?.state).toBe('done')
    expect(completion).toBeDefined()
    await f.send('afterAgentResponse', 'late-response', { text: 'Original assistant body after stop' })
    const current = (await f.stored())!
    expect(current.hookReceipt?.id).toBe('late-response')
    expect(current.semanticStatus).toEqual(stopped.semanticStatus)
    expect(current.terminalPromptReadiness).toEqual(stopped.terminalPromptReadiness)
    expect(agentTurnEndEvidence(current)).toEqual(completion)
    expect((await f.inspect())?.semanticStatus?.state).toBe('done')
    const timeline = await f.store.loadTimeline(f.id)
    expect(timeline.items.some(item => item.kind === 'assistant_message' && item.content === 'Original assistant body after stop')).toBe(true)
  } finally { await f.close() }
})

it('keeps an in-progress response neutral, stops normally, and accepts the next real user and tools', async () => {
  const f = await fixture()
  try {
    await f.send('beforeSubmitPrompt', 'original-user', { prompt: 'Original task' })
    const working = (await f.stored())!.semanticStatus
    expect(working?.state).toBe('working')
    await f.send('afterAgentResponse', 'early-response', { text: 'Original in-turn answer' })
    expect((await f.stored())!.semanticStatus).toEqual(working)
    await f.send('stop', 'original-stop', { status: 'completed' })
    expect((await f.inspect())?.semanticStatus?.state).toBe('done')
    await f.send('beforeSubmitPrompt', 'next-user', { prompt: 'Next task', generation_id: 'next-generation' })
    expect((await f.inspect())?.semanticStatus?.state).toBe('working')
    await f.send('preToolUse', 'next-tool', { tool_name: 'Shell', tool_input: { command: 'true' }, tool_use_id: 'next-tool-call', generation_id: 'next-generation' })
    expect((await f.stored())!.semanticStatus?.state).toBe('working')
    const timeline = await f.store.loadTimeline(f.id)
    expect(timeline.items.some(item => item.kind === 'tool_call')).toBe(true)
  } finally { await f.close() }
})

it('keeps another native protocol working and completion semantics at its own declared boundary', async () => {
  const f = await fixture('pi')
  try {
    await f.send('agent_start', 'original-start')
    expect((await f.inspect())?.semanticStatus?.state).toBe('working')
    await f.send('tool_call', 'original-tool', { tool_name: 'read', tool_input: { path: 'original-file' } })
    expect((await f.stored())!.semanticStatus?.state).toBe('working')
    await f.send('message_end', 'original-response')
    expect((await f.inspect())?.semanticStatus?.state).toBe('working')
    await f.send('agent_settled', 'original-stop', { stopReason: 'stop' })
    expect((await f.inspect())?.semanticStatus?.state).toBe('done')
  } finally { await f.close() }
})
