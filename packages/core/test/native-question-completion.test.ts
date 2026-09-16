import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentHookServer } from '../src/hook-server.js'
import { AgentProviderRegistry, defineAgentProvider, type AgentProvider } from '../src/agent-provider.js'
import { createNumberedTerminalInteractionProtocol } from '../src/agent-interaction.js'
import { releaseSubagentRoster } from '../src/hook-normalizer.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession, NativeHookEnvelope } from '../src/types.js'

const agentSessionId = 'native-question-agent', runId = 'native-question-run'
const providers = ['codex', 'claude'] as const
const exec = promisify(execFile)
type Admission = {
  registry: { load(hostId: string): Promise<void> }
  kernel: Record<string, unknown>
  connected: boolean
  acceptHookEvent(event: NativeHookEnvelope, signal: AbortSignal): Promise<void>
}
const questionInput = { questions: [{ question: 'Synthetic choice?', options: [{ label: 'First' }, { label: 'Second' }] }] }

function seed(providerId: string): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId, providerId, executorId: providerId, hostId: 'local',
    workspacePath: '/synthetic', run: { runId }, retiredRuns: [],
    hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43),  createdAt: 1, updatedAt: 1 }
}

async function harness(providerId: string, provider?: AgentProvider) {
  const root = await mkdtemp(join(tmpdir(), 'amux-question-'))
  const path = join(root, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(path)
  await store.compareAndSwap(null, seed(providerId))
  const client = new AgentMuxClient({ store, ...(provider ? { providers: [provider] } : {}) })
  const owner = client as unknown as Admission
  await owner.registry.load('local')
  owner.connected = true
  owner.kernel.isConnected = () => true
  let cursor = 0
  const run = () => ({ runId, lifecycleOperationId: null, program: 'synthetic', args: [], workspacePath: '/synthetic',
    pid: 1, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor })
  owner.kernel.status = async () => run()
  owner.kernel.identity = () => ({ daemonInstanceId: 'synthetic-daemon', protocolVersion: 17, buildIdentity: 'synthetic' })
  const writes: string[] = []
  let beforeAck = async () => {}
  owner.kernel.input = async (_runId: string, operation: { expectedByte: number; data: string }) => {
    writes.push(operation.data)
    const startByte = cursor
    cursor += Buffer.byteLength(operation.data)
    await beforeAck()
    return { run: run(), appliedByteRange: { startByte, endByte: cursor } }
  }
  const events: AgentMuxClientEvent[] = []
  client.onEvent(event => events.push(event))
  // Actual public authenticated HTTP ingress with an isolated listener, feeding the same Client
  // owner callback that its production Hook server invokes. No native Agent or Runtime socket.
  const server = new AgentHookServer((event, signal) => owner.acceptHookEvent(event, signal), 0)
  await server.start()
  const binding = server.createBinding(agentSessionId, providerId, 'b'.repeat(43), 't'.repeat(43))
  await binding.bindRun(runId)
  let receipts = 0
  const feed = async (eventName: string, payload: Record<string, unknown> = {}, options?: { staleRun?: boolean; badToken?: boolean }) => {
    const target = options?.staleRun ? server.createBinding(agentSessionId, providerId) : binding
    if (options?.staleRun) await target.bindRun('stale-run')
    const response = await fetch(target.endpoint.url, {
      method: 'POST', headers: { authorization: `Bearer ${options?.badToken ? 'wrong' : target.endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: `receipt-${++receipts}`, eventName,
        payload: { tool_name: providerId === 'claude' ? 'AskUserQuestion' : providerId === 'codex' ? 'request_user_input' : 'ask_generic',
          tool_use_id: 'call-1', tool_input: questionInput, session_id: 'synthetic-native', ...payload } })
    })
    if (options?.staleRun) await target.close()
    return response.status
  }
  const stored = async () => {
    const sessions = await new AgentMuxFileAgentSessionStore(path).load() as readonly AgentMuxStoredAgentSession[]
    expect(sessions).toHaveLength(1)
    return sessions[0]!
  }
  return { client, owner, store, path, events, writes, feed, stored,
    pauseAck: (wait: () => Promise<void>) => { beforeAck = wait },
    close: async () => { await server.stop(); releaseSubagentRoster(runId); await client.dispose(); await rm(root, { recursive: true, force: true }) } }
}

describe('native successful question completion owns only an exact unclaimed question', () => {
  it.each(providers)('%s authenticated ingress persists correlation, publishes settlement and adopts the next question without input', async providerId => {
    const h = await harness(providerId)
    try {
      expect(await h.feed('PreToolUse', {}, { badToken: true })).toBe(403)
      expect((await h.stored()).pendingInteraction).toBeUndefined()
      expect(await h.feed('PreToolUse')).toBe(204)
      const question = (await h.stored()).pendingInteraction!.request
      expect(question).toMatchObject({ kind: 'question', id: 'receipt-2', nativeToolCallId: 'call-1' })
      expect(await h.feed('PostToolUse', { tool_response: { answers: { 'Synthetic choice?': 'First' } } })).toBe(204)
      expect((await h.stored()).pendingInteraction).toBeUndefined()
      const sessionEvents = h.events.filter(event => event.type === 'agent-session')
      expect(sessionEvents).toHaveLength(2)
      expect(sessionEvents[1]!.session.pendingInteraction).toBeUndefined()
      expect(await h.feed('PreToolUse', { tool_use_id: 'call-2' })).toBe(204)
      expect((await h.stored()).pendingInteraction?.request).toMatchObject({ id: 'receipt-4', nativeToolCallId: 'call-2' })
      expect(await h.feed('PostToolUse', { tool_use_id: 'call-1' })).toBe(204)
      expect((await h.stored()).pendingInteraction?.request.id).toBe('receipt-4')
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it.each([
    ['wrong call', 'PostToolUse', { tool_use_id: 'other' }, false],
    ['missing call', 'PostToolUse', { tool_use_id: undefined }, false],
    ['wrong tool', 'PostToolUse', { tool_name: 'shell' }, false],
    ['child subject', 'PostToolUse', { agent_id: 'child' }, false],
    ['failure is not declared', 'PostToolUseFailure', {}, false],
    ['mere working', 'UserPromptSubmit', {}, false],
    ['Stop is not completion', 'Stop', {}, false],
    ['stale Run', 'PostToolUse', {}, true]
  ] as const)('%s cannot clear the exact question', async (_label, event, payload, staleRun) => {
    const h = await harness('codex')
    try {
      expect(await h.feed('PreToolUse')).toBe(204)
      expect(await h.feed(event, payload, { staleRun })).toBe(204)
      expect((await h.stored()).pendingInteraction?.request).toMatchObject({ id: 'receipt-1', nativeToolCallId: 'call-1' })
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it('a permission stays pending even when a question-tool Post uses its call ID', async () => {
    const h = await harness('codex')
    try {
      expect(await h.feed('PermissionRequest', { tool_name: 'shell' })).toBe(204)
      expect(await h.feed('PostToolUse')).toBe(204)
      expect((await h.stored()).pendingInteraction?.request).toMatchObject({ kind: 'permission', id: 'receipt-1' })
      await expect(h.client.writeAgent(agentSessionId, '1')).rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it('a no-ID question remains unconfirmed', async () => {
    const h = await harness('codex')
    try {
      expect(await h.feed('PreToolUse', { tool_use_id: undefined })).toBe(204)
      expect(await h.feed('PostToolUse')).toBe(204)
      expect((await h.stored()).pendingInteraction?.request).toMatchObject({ kind: 'question', id: 'receipt-1' })
      expect((await h.stored()).pendingInteraction?.request).not.toHaveProperty('nativeToolCallId')
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it.each([false, true])('a stale cache retries against durable request identity (replaced=%s)', async replaced => {
    const h = await harness('codex')
    try {
      expect(await h.feed('PreToolUse')).toBe(204)
      const original = await h.stored()
      const replacementId = replaced ? 'durable-replacement' : 'receipt-1'
      const request = original.pendingInteraction!.request
      await new AgentMuxFileAgentSessionStore(h.path).compareAndSwap(original, {
        ...original, updatedAt: original.updatedAt + 1,
        pendingInteraction: { request: { ...request, id: replacementId,
          evidence: { ...request.evidence, hookReceiptId: replacementId } } }
      })
      expect(await h.feed('PostToolUse')).toBe(204)
      if (replaced) expect((await h.stored()).pendingInteraction?.request.id).toBe('durable-replacement')
      else expect((await h.stored()).pendingInteraction).toBeUndefined()
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it.each(['run', 'receipt', 'session', 'source', 'kind', 'id-missing', 'id-empty', 'id-whitespace'] as const)('malformed Provider completion %s is refused before settlement', async field => {
    const base = new AgentProviderRegistry().get('codex')
    const provider: AgentProvider = { ...base, normalizeHook: envelope => {
      const event = base.normalizeHook(envelope)
      const completion = event.interactionCompletion
      if (!completion) return event
      return { ...event, interactionCompletion: { ...completion,
        ...(field === 'kind' ? { kind: 'permission' as unknown as 'question' } : {}),
        ...(field === 'id-missing' ? { nativeToolCallId: undefined as unknown as string } : {}),
        ...(field === 'id-empty' ? { nativeToolCallId: '' } : {}),
        ...(field === 'id-whitespace' ? { nativeToolCallId: ' \t ' } : {}),
        ...(field === 'session' ? { agentSessionId: 'other-session' } : {}),
        evidence: { ...completion.evidence,
          ...(field === 'run' ? { run: { runId: 'other-run' } } : {}),
          ...(field === 'receipt' ? { hookReceiptId: 'other-receipt' } : {}),
          ...(field === 'source' ? { source: 'user' as const } : {})
        } } }
    } }
    const h = await harness('codex', provider)
    try {
      expect(await h.feed('PreToolUse', field === 'id-missing' ? { tool_use_id: undefined } : {})).toBe(204)
      expect(await h.feed('PostToolUse')).toBe(503)
      expect((await h.stored()).pendingInteraction?.request.id).toBe('receipt-1')
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it('native completion cannot settle an ACP-owned question with the same correlation', async () => {
    const h = await harness('codex')
    try {
      expect(await h.feed('PreToolUse')).toBe(204)
      const original = await h.stored()
      await h.store.compareAndSwap(original, { ...original, pendingInteraction: {
        request: { ...original.pendingInteraction!.request,
          evidence: { source: 'acp', observedAt: original.updatedAt, run: { runId }, acpAdapterId: 'synthetic-adapter', acpSessionId: 'synthetic-acp' } }
      } })
      await h.owner.registry.load('local')
      expect(await h.feed('PostToolUse')).toBe(204)
      expect((await h.stored()).pendingInteraction?.request).toMatchObject({ id: 'receipt-1', evidence: { source: 'acp' } })
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it('a claimed response survives native completion; original ACK settles once, then the next question adopts', async () => {
    const h = await harness('codex')
    let releaseAck!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { releaseAck = resolve })
    const admitted = new Promise<void>(resolve => { entered = resolve })
    h.pauseAck(async () => { entered(); await waiting })
    try {
      expect(await h.feed('PreToolUse')).toBe(204)
      const answering = h.client.respondAgentInteraction({ agentSessionId, expectedRun: { runId }, response: {
        kind: 'question', requestId: 'receipt-1', outcome: 'answered', answers: [{ questionId: 'question-1', optionId: 'option-1' }]
      } })
      await admitted
      const original = (await h.stored()).pendingInteraction
      expect(original!.response).toMatchObject({ acknowledged: false, inputByteRange: { startByte: 0, endByte: 1 } })
      expect(await h.feed('PostToolUse')).toBe(204)
      expect((await h.stored()).pendingInteraction).toEqual(original)
      expect(await h.feed('PreToolUse', { tool_use_id: 'call-2' })).toBe(503)
      expect((await h.stored()).pendingInteraction).toEqual(original)
      releaseAck()
      await expect(answering).resolves.toBeUndefined()
      expect((await h.stored()).pendingInteraction).toBeUndefined()
      expect(h.writes).toEqual(['1'])
      expect(await h.feed('PreToolUse', { tool_use_id: 'call-2' })).toBe(204)
      expect((await h.stored()).pendingInteraction?.request).toMatchObject({ nativeToolCallId: 'call-2' })
    } finally { releaseAck(); await h.close() }
  })

  it('a custom declarative Provider uses its own successful event and shared default child keys', async () => {
    const base = new AgentProviderRegistry().get('codex')
    const provider = defineAgentProvider({
      catalog: { ...base.catalog, id: 'generic-question', executable: 'synthetic' },
      buildArgs: (_prompt, args) => [...args],
      hook: { rules: [{ events: ['before_question'], state: 'waiting', toolNames: ['ask_generic'] }, { events: ['after_question'], state: 'working' }],
        subagentTracking: { startEvents: ['child_start'], stopEvents: ['child_stop'], mainStopEvents: ['main_stop'] } },
      interaction: createNumberedTerminalInteractionProtocol({ questionEvents: ['before_question'], questionTools: ['ask_generic'],
        questionCompletionEvents: ['after_question'], permissionOptions: [
          { id: 'allow', label: 'Allow', kind: 'allow-once', input: '1' }, { id: 'deny', label: 'Deny', kind: 'reject-once', input: '\x1b' }
        ] })
    })
    const h = await harness('generic-question', provider)
    try {
      expect(await h.feed('before_question')).toBe(204)
      expect(await h.feed('after_question', { subagent_id: 'child' })).toBe(204)
      expect((await h.stored()).pendingInteraction?.request.id).toBe('receipt-1')
      expect(await h.feed('PostToolUse')).toBe(204)
      expect((await h.stored()).pendingInteraction?.request.id).toBe('receipt-1')
      expect(await h.feed('after_question')).toBe(204)
      expect((await h.stored()).pendingInteraction).toBeUndefined()
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it('two real Node processes reopen the persisted question and settle through authenticated ingress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-question-process-'))
    const path = join(root, 'agent-sessions.json')
    const publicCore = pathToFileURL(resolve('dist/index.js')).href
    const hookModule = pathToFileURL(resolve('dist/hook-server.js')).href
    const script = `
      import {AgentMuxClient,AgentMuxFileAgentSessionStore} from ${JSON.stringify(publicCore)};
      import {AgentHookServer} from ${JSON.stringify(hookModule)};
      const [path,phase]=process.argv.slice(1),store=new AgentMuxFileAgentSessionStore(path);
      if(phase==='pre')await store.compareAndSwap(null,${JSON.stringify(seed('codex'))});
      const client=new AgentMuxClient({store});await client.registry.load('local');
      let writes=0;client.kernel.input=async()=>{writes++;throw Error('Native completion must not input')};
      const server=new AgentHookServer((event,signal)=>client.acceptHookEvent(event,signal),0);
      try {await server.start();const binding=server.createBinding(${JSON.stringify(agentSessionId)},'codex');await binding.bindRun(${JSON.stringify(runId)});
        const response=await fetch(binding.endpoint.url,{method:'POST',headers:{authorization:'Bearer '+binding.endpoint.token,'content-type':'application/json'},body:JSON.stringify({receiptId:phase==='pre'?'process-pre':'process-post',eventName:phase==='pre'?'PreToolUse':'PostToolUse',payload:{tool_name:'request_user_input',tool_use_id:'process-call',tool_input:${JSON.stringify(questionInput)}}})});
        if(response.status!==204)throw Error('Hook status '+response.status);
        const sessions=await store.load();if(sessions.length!==1)throw Error('Expected one canonical Session');
        console.log(JSON.stringify({pid:process.pid,pending:sessions[0].pendingInteraction?.request??null,writes}));
      }finally{await server.stop();await client.dispose()}`
    try {
      const first = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', script, path, 'pre'], { timeout: 8000 })).stdout)
      expect(first.pending).toMatchObject({ id: 'process-pre', nativeToolCallId: 'process-call' })
      const second = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', script, path, 'post'], { timeout: 8000 })).stdout)
      expect(first.pid).not.toBe(second.pid)
      expect(second.pending).toBeNull()
      expect([first.writes, second.writes]).toEqual([0, 0])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
