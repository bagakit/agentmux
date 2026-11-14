import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../src/hook-server.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { consumeConversationWindowPage, projectConversationWindow, parseConversationReadPageForWindow,
  type AgentConversationReadPage, type ConversationTimelineReadInput, type ConversationWindowAssembly } from '../src/conversation.js'
import { claudeNativeActivitySource } from '../src/providers/claude-plugin.js'
import { CLAUDE_ASKED_TOOL_END_EVENT } from '@agentmux/providers/claude/native-activity'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { withInteractionOperation } from './fixtures/interaction-client.js'
import type { AgentMuxInteractionRequest, AgentTimelineItem } from '../src/types.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(providerId: 'claude' | 'codex') {
  const id = `tool-fields-${providerId}`, nativeSessionId = `native-${id}`
  const h = await rpcOwnerFixture([id], undefined, () => ({ providerId, executorId: providerId }))
  const transcriptPath = join(h.root, 'native-transcript.jsonl'); await writeFile(transcriptPath, '')
  const nativeHandle = { kind: 'provider' as const, providerId, sessionId: nativeSessionId, transcriptPath }
  // Only the Runtime and process-native witness are controlled ports. All Hook,
  // Provider, Client, FileStore, RPC, CLI and permission callback owners are real.
  h.client.providers.get(providerId).discoverNativeSession = async () => ({ handle: nativeHandle, assertCurrent: async () => {} })
  Reflect.get(h.client, 'hookNativeWitnesses').set(`run-${id}`, { candidate: JSON.stringify(nativeSessionId), handle: nativeHandle })
  const hooks = Reflect.get(h.client, 'hookServer') as AgentHookServer
  Object.defineProperty(hooks, 'port', { value: 0 }); await hooks.start()
  const binding = hooks.createBinding(id, providerId); await binding.bindRun(`run-${id}`)
  const post = (receiptId: string, eventName: string, payload: Record<string, unknown>, decision = false, token = binding.endpoint.token) => fetch(binding.endpoint.url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId, eventName, ...(decision ? { decision: true } : {}), payload: {
      hook_event_name: eventName, session_id: nativeSessionId, transcript_path: transcriptPath, cwd: h.root,
      turn_id: 'original-turn', prompt_id: 'original-prompt', ...payload
    } })
  })
  const drain = async () => {
    const bindings = Reflect.get(hooks, 'bindings') as Map<string, { tail: Promise<void> }>
    await bindings.get(binding.endpoint.token)!.tail
  }
  const request = () => h.client.agentSession(id).pendingInteraction?.request
  const open = async (receiptId: string, payload: Record<string, unknown>) => {
    const pending = post(receiptId, 'PermissionRequest', payload, true)
    await expect.poll(() => request()?.evidence.hookReceiptId).toBe(receiptId); await drain()
    expect(hooks.hasPermissionCallback(id, `run-${id}`, receiptId)).toBe(true)
    return { pending }
  }
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const env = { ...process.env }; delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
  const loader = process.env.AGENTMUX_TEST_TOOL_FIELDS_CLI_LOADER ? pathToFileURL(process.env.AGENTMUX_TEST_TOOL_FIELDS_CLI_LOADER)
    : new URL('./fixtures/hook-delivery/source-loader.mjs', import.meta.url)
  const cli = async (args: string[], value: unknown) => {
    const fields = value as { target?: { agentSessionId: string }; agentSessionId?: string; operationId?: string }
    const command = args.join('.')
    const options = command === 'agent.inspect' ? ['--session', fields.target!.agentSessionId]
      : command === 'agent.interaction.inspect' ? ['--session', fields.agentSessionId!, '--operation-id', fields.operationId!]
      : ['--input', '-']
    const result = await runSourceObjectCli(['--endpoint', `unix:${server.path}`, ...args, ...options], env, JSON.stringify(value), 15_000, loader)
    expect(result.code, result.stderr).toBe(0)
    const response = JSON.parse(result.stdout); expect(response.ok).toBe(true)
    return response.result
  }
  const reference = { hostId: 'local', agentSessionId: id, limit: 100, maxBytes: 1024 * 1024 }
  const fresh = () => new AgentMuxFileAgentSessionStore(h.store.path)
  const assertRequestReaders = async (expected: AgentMuxInteractionRequest) => {
    expect((await fresh().readMetadata(id))!.pendingInteraction!.request).toEqual(expected)
    const target = { kind: 'agent-session' as const, agentSessionId: id }
    expect((await rpc.call('agent.inspect', { target })).session.pendingInteraction!.request).toEqual(expected)
    expect((await cli(['agent','inspect'], { target })).session.pendingInteraction.request).toEqual(expected)
    expect(h.client.agentSession(id)).toMatchObject({ agentSessionId: id, run: { runId: `run-${id}` }, nativeHandle })
  }
  const respond = async (receiptId: string) => {
    const input = withInteractionOperation(h.client, { agentSessionId: id, expectedRun: { runId: `run-${id}` },
      response: { kind: 'permission' as const, requestId: receiptId, decision: { outcome: 'selected' as const, optionId: 'allow-once' } } })
    await rpc.call('agent.interaction.respond', input)
    await expect.poll(() => { const current = request(); return current?.kind === 'permission' && current.permissionHook?.closed }).toBe('decision-returned')
    const { receipt: operation } = await rpc.call('agent.interaction.inspect', { agentSessionId: id, operationId: input.operationId })
    expect(operation).toMatchObject({ operationId: input.operationId })
    const cliOperation = await cli(['agent','interaction','inspect'], { agentSessionId: id, operationId: input.operationId })
    expect(cliOperation.receipt).toEqual(operation)
    expect((await fresh().readMetadata(id))!.interactionOperations?.[input.operationId]).toEqual(operation)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
    return operation
  }
  return { ...h, id, nativeSessionId, nativeHandle, transcriptPath, hooks, binding, post, drain, request, open, rpc, cli, reference, fresh, assertRequestReaders, respond,
    close: async () => { await binding.close(); await rpc.dispose(); await server.stop(); await h.close() } }
}

async function captured(read: (input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>, input: ConversationTimelineReadInput) {
  let pending: ConversationWindowAssembly | undefined, cursor = input.cursor
  for (let i = 0; i < 20; i++) {
    const page = await read({ ...input, ...(cursor ? { cursor } : {}) })
    expect(page).toMatchObject({ hostId: 'local', sourceHostId: 'local', agentSessionId: input.agentSessionId })
    const result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'complete') {
      const projection = projectConversationWindow(result.snapshot)
      expect(projection.captured.items.length, 'nonempty original captured records').toBeGreaterThan(0)
      return projection.captured.items
    }
    pending = result.pending; cursor = page.nextCursor!; expect(cursor).toBeTruthy()
  }
  throw Error('The original captured conversation did not complete')
}

async function assertToolReaders(h: Awaited<ReturnType<typeof fixture>>, expected: AgentTimelineItem) {
  const same = (items: readonly AgentTimelineItem[]) => expect(items.find(item => item.id === expected.id), 'same original tool item at public readers').toEqual(expected)
  same((await h.fresh().readCapturedHistory(h.id)).records.flatMap(record => record.item ? [record.item] : []))
  same(await captured(input => h.client.readAgentConversation(input), h.reference))
  same(await captured(input => h.rpc.call('agent.conversation.inspect', input), h.reference))
  same(await captured(async input => parseConversationReadPageForWindow(await h.cli(['agent','conversation','inspect'], input), input), h.reference))
}

describe('Provider tool fields through original HTTP, FileStore and public consumers', () => {
  it('foreign-id-does-not-authorize-http-request', async () => {
    const h = await fixture('claude')
    try {
      const payload = { tool_name: 'Bash', tool_input: { command: 'original command' }, call_id: 'foreign-call',
        extra: { tool_use_id: 'foreign-extra-call', tool_name: 'AskUserQuestion', tool_input: { questions: [] }, session_id: 'foreign-session' } }
      expect((await h.post('not-authorized', 'PreToolUse', payload, false, 'wrong-token')).status).toBe(403)
      expect((await h.client.sessionTimeline(h.id)).items).toHaveLength(0)
      expect((await h.post('foreign-pre', 'PreToolUse', payload)).status).toBe(204)
      const { pending } = await h.open('foreign-permission', payload)
      expect(h.request(), 'foreign-id-does-not-authorize-http-request').not.toHaveProperty('nativeToolCallId')
      expect(h.request()).toMatchObject({ kind: 'permission', toolName: 'Bash', toolInput: JSON.stringify(payload.tool_input), permissionHook: { receiptId: 'foreign-permission' } })
      await h.assertRequestReaders(h.request()!)
      const tools = (await h.client.sessionTimeline(h.id)).items.filter(item => item.kind === 'tool_call')
      expect(tools).toHaveLength(2)
      expect(tools.every(item => !item.id.includes('foreign-call') && !item.id.includes('foreign-extra-call'))).toBe(true)
      expect(tools.every(item => !item.conversation?.invocations?.length)).toBe(true)
      await assertToolReaders(h, tools[0]!)
      await h.respond('foreign-permission')
      expect(await (await pending).json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it.each([{ label: 'empty', value: '' }, { label: 'whitespace', value: '  ' }, { label: 'multiline', value: 'first\nsecond' },
    { label: 'null', value: null }, { label: 'absent', value: undefined }])('preserves $label permission input through fresh Store, RPC and actual CLI', async row => {
    const h = await fixture('claude')
    try {
      const { pending } = await h.open('input-' + row.label, { tool_name: 'Bash', ...(row.value === undefined ? {} : { tool_input: row.value }), toolInput: 'foreign-alias-input' })
      const request = h.request()!
      const expected = row.value === null ? 'null' : row.value
      expect(Object.hasOwn(request, 'toolInput')).toBe(row.value !== undefined)
      if (request.kind !== 'permission') throw Error('Expected the original permission request')
      expect(request.toolInput).toBe(expected)
      await h.assertRequestReaders(request)
      // Equal-object checks above preserve field presence; assert it independently
      // for the mandatory empty-string path, including the raw CLI JSON object.
      const target = { kind: 'agent-session' as const, agentSessionId: h.id }
      for (const read of [(await h.fresh().readMetadata(h.id))!.pendingInteraction!.request,
        (await h.rpc.call('agent.inspect', { target })).session.pendingInteraction!.request,
        (await h.cli(['agent','inspect'], { target })).session.pendingInteraction.request]) {
        expect(Object.hasOwn(read, 'toolInput')).toBe(row.value !== undefined)
        expect(read.toolInput).toBe(expected)
      }
      await h.respond('input-' + row.label)
      expect(await (await pending).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
    } finally { await h.close() }
  })

  it('Codex terminal observer retains its strict adjacent Pre resolution', async () => {
    const h = await fixture('codex'), tool_input = { command: 'original command', description: 'original description' }
    try {
      expect((await h.post('terminal-pre', 'PreToolUse', { tool_name: 'Bash', tool_input, tool_use_id: 'original-codex-call' })).status).toBe(204)
      expect((await h.post('terminal-permission', 'PermissionRequest', { tool_name: 'Bash', tool_input })).status).toBe(204)
      expect(h.request()).toMatchObject({ id: 'terminal-permission', nativeToolCallId: 'original-codex-call' })
      expect(h.request()).not.toHaveProperty('permissionHook')
      await h.assertRequestReaders(h.request()!)
      expect((await h.post('terminal-post', 'PostToolUse', { tool_name: 'Bash', tool_input, tool_use_id: 'original-codex-call', tool_response: 'original output' })).status).toBe(204)
      expect(h.request()).toBeUndefined()
      const tools = (await h.client.sessionTimeline(h.id)).items.filter(item => item.kind === 'tool_call')
      const original = tools.find(item => item.status === 'complete')!
      expect(original).toMatchObject({ toolInput: JSON.stringify(tool_input), toolOutput: 'original output' })
      expect(original.conversation?.invocations?.some(invocation => invocation.invocation.callId === 'original-codex-call')).toBe(true)
      await assertToolReaders(h, original)
    } finally { await h.close() }
  })

  it('codex-native-callback-never-borrows-pre', async () => {
    const h = await fixture('codex'), tool_input = { command: 'original command', description: 'original description' }
    try {
      expect((await h.post('callback-pre', 'PreToolUse', { tool_name: 'Bash', tool_input, tool_use_id: 'original-codex-call' })).status).toBe(204)
      const { pending } = await h.open('callback-permission', { tool_name: 'Bash', tool_input,
        tool_use_id: 'not-in-permission-protocol', call_id: 'foreign-call', extra: { tool_use_id: 'foreign-extra-call' } })
      expect(h.request(), 'codex-native-callback-never-borrows-pre').not.toHaveProperty('nativeToolCallId')
      await h.assertRequestReaders(h.request()!)
      expect((await h.post('callback-previous-post', 'PostToolUse', { tool_name: 'Bash', tool_input, tool_use_id: 'original-codex-call', tool_response: 'original output' })).status).toBe(204)
      expect(h.request()).toMatchObject({ id: 'callback-permission', permissionHook: { receiptId: 'callback-permission' } })
      expect(h.request()).not.toHaveProperty('nativeCompleted')
      expect(h.hooks.hasPermissionCallback(h.id, `run-${h.id}`, 'callback-permission')).toBe(true)
      await h.respond('callback-permission')
      expect(await (await pending).json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('Claude question retains its own ID through HTTP and only its own asked-end closes it', async () => {
    const h = await fixture('claude')
    const tool_input = { questions: [{ question: 'Choose?', header: 'Choice', options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }], multiSelect: false }] }
    try {
      expect((await h.post('question-pre', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input, tool_use_id: 'original-question' })).status).toBe(204)
      expect((await h.post('question-permission', 'PermissionRequest', { tool_name: 'AskUserQuestion', tool_input })).status).toBe(204)
      expect(h.request()).toMatchObject({ kind: 'question', id: 'question-pre', nativeToolCallId: 'original-question' })
      expect(h.client.agentSession(h.id).pendingInteraction!.additionalRequests).toBeUndefined()
      await h.assertRequestReaders(h.request()!)
      expect((await h.post('foreign-question-end', CLAUDE_ASKED_TOOL_END_EVENT, { tool_name: 'AskUserQuestion', tool_use_id: 'foreign-question' })).status).toBe(204)
      expect(h.request()?.id).toBe('question-pre')
      expect((await h.post('question-end', CLAUDE_ASKED_TOOL_END_EVENT, { tool_name: 'AskUserQuestion', tool_use_id: 'original-question' })).status).toBe(204)
      expect(h.request()).toBeUndefined(); expect((await h.fresh().readMetadata(h.id))!.pendingInteraction).toBeUndefined()
      expect(h.inner.kernel.input).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('Claude real native plugin reports the unique asked call into the original Bash callback', async () => {
    const h = await fixture('claude'), tool_input = { command: 'original command', description: 'original description' }
    type Handler = (api: unknown, event: Record<string, unknown>, next: (event: Record<string, unknown>) => unknown) => Promise<unknown>
    const handlers = new Map<string, Handler>(), deliveries: Promise<unknown>[] = []
    try {
      const path = join(h.root, 'native-activity.mjs'); await writeFile(path, claudeNativeActivitySource())
      const module = await import(/* @vite-ignore */ pathToFileURL(path).href)
      module.register((name: string, handler: Handler) => { handlers.set(name, handler); return { catch() {} } })
      const api = { env: { get: async () => '1' }, session: { id: async () => h.nativeSessionId },
        process: { run: (_argv: string[], init: { stdin: string }) => {
          const body = JSON.parse(init.stdin)
          const delivery = h.post('plugin-' + deliveries.length, body.hook_event_name, body).then(async response => { expect(response.status).toBe(204); return { exitCode: 0, stdout: '{}\n', stderr: '' } })
          deliveries.push(delivery); return delivery
        } }, ui: { log: async () => {} } }
      await handlers.get('session.start')!(api, {}, event => event)
      const call = handlers.get('tool.call')!(api, { tool: 'Bash', tool_use_id: 'original-plugin-call' }, async () => {
        expect((await h.post('plugin-pre', 'PreToolUse', { tool_name: 'Bash', tool_input, tool_use_id: 'original-plugin-call' })).status).toBe(204)
        const verdict = { decision: 'ask' }
        expect(await handlers.get('tool.check')!(api, { tool: 'Bash', input: tool_input, tool_use_id: 'original-plugin-call' }, async () => verdict)).toBe(verdict)
        return await handlers.get('classic.PermissionRequest')!(api, { tool_name: 'Bash', tool_input }, async event => {
          expect(event.tool_use_id).toBe('original-plugin-call')
          return await (await h.post('plugin-permission', 'PermissionRequest', event, true)).json()
        })
      })
      await expect.poll(() => h.request()?.id).toBe('plugin-permission'); await h.drain()
      expect(h.request()).toMatchObject({ kind: 'permission', nativeToolCallId: 'original-plugin-call', permissionHook: { receiptId: 'plugin-permission' } })
      await h.assertRequestReaders(h.request()!)
      await h.respond('plugin-permission')
      expect(await call).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
      await Promise.all(deliveries)
      expect(h.inner.kernel.input).not.toHaveBeenCalled()
    } finally { await Promise.allSettled(deliveries); await h.close() }
  })
})
