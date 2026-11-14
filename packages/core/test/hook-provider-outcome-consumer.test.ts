import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../src/hook-server.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { consumeConversationWindowPage, projectConversationWindow, parseConversationReadPageForWindow,
  type AgentConversationReadPage, type ConversationTimelineReadInput, type ConversationWindowAssembly } from '../src/conversation.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import type { AgentTimelineItem } from '../src/types.js'

type Provider = 'gemini' | 'kimi'
async function fixture(providerId: Provider) {
  const id = `outcome-${providerId}`, nativeSessionId = `native-${id}`
  const h = await rpcOwnerFixture([id], undefined, () => ({ providerId, executorId: providerId }))
  // Runtime/native process identity is a deterministic witness. HTTP auth,
  // Provider, Client, FileStore, captured journal, RPC and CLI are actual owners.
  const transcriptPath = join(h.root, 'native-transcript.jsonl'); await writeFile(transcriptPath, '')
  const nativeHandle = { kind: 'provider' as const, providerId, sessionId: nativeSessionId, ...(providerId === 'gemini' ? { transcriptPath } : {}) }
  Reflect.get(h.client, 'hookNativeWitnesses').set(`run-${id}`, { candidate: JSON.stringify(nativeSessionId), handle: nativeHandle })
  vi.stubEnv('KIMI_CODE_HOME', join(h.root, 'kimi-home'))
  const hooks = Reflect.get(h.client, 'hookServer') as AgentHookServer
  Object.defineProperty(hooks, 'port', { value: 0 }); await hooks.start()
  const binding = hooks.createBinding(id, providerId); await binding.bindRun(`run-${id}`)
  const post = async (receiptId: string, eventName: string, payload: Record<string, unknown>, token = binding.endpoint.token) => {
    return await fetch(binding.endpoint.url, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json'
    }, body: JSON.stringify({ receiptId, eventName, payload: {
      hook_event_name: eventName, session_id: nativeSessionId, transcript_path: transcriptPath, cwd: h.root,
      tool_name: 'read_file', tool_input: { path: 'original-source' }, ...payload
    } }) })
  }
  return { ...h, id, nativeHandle, post, reference: { hostId: 'local', agentSessionId: id, limit: 100, maxBytes: 1024 * 1024 } }
}

async function captured(read: (input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>, input: ConversationTimelineReadInput) {
  let pending: ConversationWindowAssembly | undefined, cursor = input.cursor
  for (let i = 0; i < 20; i++) {
    const page = await read({ ...input, ...(cursor ? { cursor } : {}) })
    expect(page).toMatchObject({ hostId: 'local', sourceHostId: 'local', agentSessionId: input.agentSessionId })
    const result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'complete') {
      const projection = projectConversationWindow(result.snapshot)
      expect(projection.captured.items.length, 'nonempty captured original records').toBeGreaterThan(0)
      expect(projection.records.some(r => r.original.kind === 'captured')).toBe(true)
      return projection.captured.items.filter(item => item.kind === 'tool_call')
    }
    pending = result.pending; cursor = page.nextCursor!; expect(cursor).toBeTruthy()
  }
  throw Error('The exact captured conversation frame did not finish')
}

async function assertPublic(h: Awaited<ReturnType<typeof fixture>>, expected: AgentTimelineItem) {
  const same = (items: readonly AgentTimelineItem[]) => {
    const item = items.find(item => item.id === expected.id)
    expect(item, 'the same persisted tool record reaches each public consumer').toEqual(expected)
  }
  const fresh = new AgentMuxFileAgentSessionStore(h.store.path)
  const persisted = await fresh.readCapturedHistory(h.id)
  expect(persisted.records.length).toBeGreaterThan(0)
  same(persisted.records.flatMap(record => record.item ? [record.item] : []))
  const sdk = await captured(input => h.client.readAgentConversation(input), h.reference); same(sdk)
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    same(await captured(input => rpc.call('agent.conversation.inspect', input), h.reference))
    const env = { ...process.env }; delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
    const loader = new URL('./fixtures/hook-delivery/source-loader.mjs', import.meta.url)
    same(await captured(async input => {
      const cli = await runSourceObjectCli(['--endpoint', `unix:${server.path}`, 'agent', 'conversation', 'inspect', '--input', '-'], env, JSON.stringify(input), 15_000, loader)
      expect(cli.code, cli.stderr).toBe(0)
      const response = JSON.parse(cli.stdout)
      expect(response).toMatchObject({ ok: true, operation: 'agent.conversation.inspect' })
      return parseConversationReadPageForWindow(response.result, input)
    }, h.reference))
    expect(h.client.agentSession(h.id)).toMatchObject({ agentSessionId: h.id, providerId: h.nativeHandle.providerId,
      run: { runId: `run-${h.id}` }, nativeHandle: h.nativeHandle })
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await rpc.dispose(); await server.stop() }
}

describe('Provider results through authenticated Hook HTTP and original public readers', () => {
  it('Gemini native structured error remains failed through captured RPC and actual source CLI', async () => {
    const h = await fixture('gemini')
    try {
      expect((await h.post('gemini-failure', 'AfterTool', { tool_response: {
        llmContent: [{ text: 'native-result' }], error: { message: 'original-gemini-error', type: 'EXECUTION_FAILED' }
      } })).status).toBe(204)
      const tools = (await h.client.sessionTimeline(h.id)).items.filter(item => item.kind === 'tool_call')
      expect(tools).toHaveLength(1)
      expect(tools[0]!.status, 'gemini-native-error-is-failed').toBe('failed')
      expect(tools[0]!.toolOutput).toBe('original-gemini-error')
      // No original call ID is provided by Gemini's AfterTool producer: append.
      expect(tools[0]!.id).toContain('gemini-failure')
      await assertPublic(h, tools[0]!)
    } finally { await h.close() }
  })

  it('Gemini foreign extra never becomes a native result through captured RPC and actual source CLI', async () => {
    const h = await fixture('gemini')
    try {
      expect((await h.post('gemini-foreign', 'AfterTool', { extra: { tool_response: {
        llmContent: [{ text: 'foreign-extra-output' }], error: { message: 'foreign-extra-error' }
      } } })).status).toBe(204)
      const tools = (await h.client.sessionTimeline(h.id)).items.filter(item => item.kind === 'tool_call')
      expect(tools).toHaveLength(1)
      expect(tools[0]!.toolOutput, 'foreign-extra-output-is-absent').toBeUndefined()
      expect(tools[0]!.status, 'foreign-extra-failure-is-not-owned').toBe('complete')
      await assertPublic(h, tools[0]!)
    } finally { await h.close() }
  })

  it('Gemini native success body remains content and rejects an unauthenticated receipt', async () => {
    const h = await fixture('gemini')
    try {
      const payload = { tool_response: { llmContent: [{ text: 'failed error exit 1 is content' }] }, error: { message: 'foreign-error' }, status: 'error' }
      expect((await h.post('unauthorized', 'AfterTool', payload, 'wrong-token')).status).toBe(403)
      expect((await h.client.sessionTimeline(h.id)).items).toHaveLength(0)
      expect((await h.post('gemini-success', 'AfterTool', payload)).status).toBe(204)
      const item = (await h.client.sessionTimeline(h.id)).items.find(item => item.kind === 'tool_call')!
      expect(item).toMatchObject({ status: 'complete', toolOutput: 'failed error exit 1 is content' })
      await assertPublic(h, item)
    } finally { await h.close() }
  })

  it.each(['success','failure'] as const)('Kimi native %s upserts its original call through captured RPC and actual source CLI', async outcome => {
    const h = await fixture('kimi'), call = 'original-kimi-call'
    try {
      expect((await h.post('kimi-pre', 'PreToolUse', { tool_call_id: call })).status).toBe(204)
      const pre = (await h.client.sessionTimeline(h.id)).items.filter(item => item.kind === 'tool_call')
      expect(pre).toHaveLength(1); expect(pre[0]!.status).toBe('streaming')
      const output = outcome === 'success' ? 'kimi result contains failed error exit 1' : 'original-kimi-error'
      const payload = outcome === 'success' ? { tool_output: output, error: { message: 'foreign-error' } }
        : { error: { code: 'execution_error', message: output, retryable: false } }
      expect((await h.post('kimi-post', outcome === 'success' ? 'PostToolUse' : 'PostToolUseFailure', { tool_call_id: call, ...payload })).status).toBe(204)
      const post = (await h.client.sessionTimeline(h.id)).items.filter(item => item.kind === 'tool_call')
      expect(post).toHaveLength(1)
      expect(post[0]).toMatchObject({ id: pre[0]!.id, toolOutput: output, status: outcome === 'success' ? 'complete' : 'failed' })
      expect(post[0]!.conversation?.invocations).toEqual(expect.arrayContaining([expect.objectContaining({
        selector: { kind: 'captured-field', field: 'toolOutput' }, invocation: expect.objectContaining({
          source: { providerId: 'kimi', nativeSessionId: h.nativeHandle.sessionId }, subject: 'main', callId: call
        })
      })]))
      await assertPublic(h, post[0]!)
    } finally { await h.close() }
  })
})
