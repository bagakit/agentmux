import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { CLAUDE_ASKED_TOOL_END_EVENT, claudeNativeActivitySource } from '../src/providers/claude-native-activity.js'
import { fixturePath } from './helpers/fixture-values.js'
import type { AgentMuxStoredAgentSession, NativeHookEnvelope } from '../src/types.js'

/**
 * Claude's own Hook protocol, in the order and shape Claude Code 2.1.318 actually delivers it
 * (captured payload keys; private values replaced). One call is announced by PreToolUse with
 * `tool_use_id`, then asked by PermissionRequest **without** it; AgentMux's native observer
 * attaches the asked call's id to that ask. Answered calls end with PostToolUse; declined calls
 * end with no classic Hook, only the native observer's exact end.
 *
 * Real: Provider normalization, Client Hook owner, CAS and Store. Synthetic: Runtime status/input.
 */
const agentSessionId = 'claude-request-lifecycle', runId = 'claude-request-lifecycle-run'
const nativeSessionId = 'native-claude-main', transcriptPath = fixturePath('claude/native-claude-main.jsonl')
const promptId = 'native-prompt-1'
const question = { questions: [{ question: 'Pick a color?', header: 'Color', options: [
  { label: 'Red', description: 'Choose red' }, { label: 'Blue', description: 'Choose blue' }], multiSelect: false }] }
const command = { command: 'mkdir -p build/probe', description: 'Create probe directory' }

async function harness() {
  const store = new AgentMuxMemoryAgentSessionStore()
  const seed: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId, providerId: 'claude', executorId: 'claude', hostId: 'local',
    workspacePath: fixturePath('claude'), run: { runId }, retiredRuns: [], hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43),
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: nativeSessionId, transcriptPath }, createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, seed)
  const client = new AgentMuxClient({ store })
  const owner = client as unknown as { registry: { load(hostId: string): Promise<void> }; connected: boolean
    kernel: Record<string, unknown>; acceptHookEvent(event: NativeHookEnvelope, signal: AbortSignal): Promise<void> }
  await owner.registry.load('local')
  owner.connected = true
  const writes: string[] = []
  owner.kernel.isConnected = () => true
  owner.kernel.identity = () => ({ daemonInstanceId: 'claude-lifecycle-daemon', protocolVersion: 17, buildIdentity: 'synthetic' })
  owner.kernel.status = async () => ({ nativeService: null, runId, lifecycleOperationId: null, program: 'claude', args: [],
    workspacePath: fixturePath('claude'), pid: 1, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 })
  owner.kernel.input = async (_runId: string, operation: { data: string }) => { writes.push(operation.data); throw new Error('No input is expected') }
  let receipts = 0
  const hook = async (eventName: string, payload: Record<string, unknown>, permissionCallback = false) => {
    await owner.acceptHookEvent({ receiptId: `receipt-${++receipts}`, agentSessionId, runId, providerId: 'claude',
      ...(permissionCallback ? { permissionCallback: true } : {}),
      payload: { session_id: nativeSessionId, transcript_path: transcriptPath, cwd: fixturePath('claude'), permission_mode: 'default',
        prompt_id: promptId, hook_event_name: eventName, ...payload } }, new AbortController().signal)
  }
  const askedEnd = async (toolUseId: string, toolName: string, extra: Record<string, unknown> = {}) => {
    await owner.acceptHookEvent({ receiptId: `receipt-${++receipts}`, agentSessionId, runId, providerId: 'claude',
      payload: { hook_event_name: CLAUDE_ASKED_TOOL_END_EVENT, session_id: nativeSessionId, tool_use_id: toolUseId, tool_name: toolName, ...extra } },
      new AbortController().signal)
  }
  const pending = () => client.agentSession(agentSessionId).pendingInteraction
  const stored = async () => (await store.load())[0]!.pendingInteraction
  const recovery = async () => (await store.load())[0]!.recoveryActivity
  return { client, hook, askedEnd, pending, stored, recovery, writes,
    close: async () => {  await client.dispose() } }
}

describe('Claude native request lifecycle follows the actual Hook protocol', () => {
  it('settles an addressable callback only through its own Provider-reported invocation', async () => {
    const h = await harness()
    try {
      await h.hook('PreToolUse', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_original' })
      await h.hook('PermissionRequest', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_original' }, true)
      expect(h.pending()?.request).toMatchObject({ kind: 'permission', nativeToolCallId: 'toolu_original', permissionHook: { receiptId: 'receipt-2' } })
      await h.askedEnd('toolu_foreign', 'Bash')
      expect(h.pending()?.request.id).toBe('receipt-2')
      await h.askedEnd('toolu_original', 'Bash')
      expect(h.pending()).toBeUndefined()
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it('does not borrow a previous invocation identity for an addressable callback that omits it', async () => {
    const h = await harness()
    try {
      await h.hook('PreToolUse', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_previous' })
      await h.hook('PermissionRequest', { tool_name: 'Bash', tool_input: command }, true)
      expect(h.pending()?.request).toHaveProperty('permissionHook')
      expect(h.pending()?.request).not.toHaveProperty('nativeToolCallId')
      await h.askedEnd('toolu_previous', 'Bash')
      expect(h.pending()?.request.id).toBe('receipt-2')
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it.each(['result', 'deny', 'throw'] as const)('settles a permission through the generated observer when its nested native call returns %s', async outcome => {
    const h = await harness()
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-nested-permission-'))
    type Handler = (api: unknown, event: Record<string, unknown>, next: (event: Record<string, unknown>) => unknown) => Promise<unknown>
    const handlers = new Map<string, Handler>()
    const deliveries: Promise<unknown>[] = []
    const api = { env: { get: async () => '1' }, session: { id: async () => nativeSessionId },
      process: { run: (_argv: string[], init: { stdin: string }) => {
        const body = JSON.parse(init.stdin) as Record<string, unknown>
        const delivery = h.hook(String(body.hook_event_name), body).then(() => ({ exitCode: 0, stdout: '{}\n', stderr: '' }))
        deliveries.push(delivery)
        return delivery
      } }, ui: { log: async () => {} } }
    try {
      const path = join(directory, 'register.mjs')
      await writeFile(path, claudeNativeActivitySource())
      const mod = await import(/* @vite-ignore */ pathToFileURL(path).href)
      mod.register((name: string, handler: Handler) => { handlers.set(name, handler); return { catch() {} } })
      await handlers.get('session.start')!(api, {}, event => event)
      const result = outcome === 'deny' ? { deny: 'native rejection' } : { ref: 1, result: 'native result' }
      const failure = new Error('native failure')
      // Claude's native tool.call wraps PreToolUse, tool.check, the actual ask and the tool.
      const call = handlers.get('tool.call')!(api, { tool: 'Bash', tool_use_id: 'toolu_nested' }, async () => {
        await h.hook('PreToolUse', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_nested' })
        const verdict = { decision: 'ask' }
        expect(await handlers.get('tool.check')!(api, { tool: 'Bash', input: command, tool_use_id: 'toolu_nested' }, async () => verdict)).toBe(verdict)
        await handlers.get('classic.PermissionRequest')!(api, { tool_name: 'Bash', tool_input: command }, async event => {
          await h.hook('PermissionRequest', event)
          return {}
        })
        expect(h.pending()?.request).toMatchObject({ kind: 'permission', nativeToolCallId: 'toolu_nested' })
        if (outcome === 'throw') throw failure
        return result
      })
      if (outcome === 'throw') await expect(call).rejects.toBe(failure)
      else expect(await call).toBe(result)
      // The passive end is asynchronous; wait only for this observer's original delivery.
      await expect.poll(() => h.pending()).toBeUndefined()
      await Promise.all(deliveries)
      expect(await h.stored()).toBeUndefined()
      expect(h.client.agentSession(agentSessionId).semanticStatus?.state).toBe('working')
      expect(h.writes).toEqual([])
    } finally { await Promise.allSettled(deliveries); await h.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('a question announced then asked is one request, settled by its own completion', async () => {
    const h = await harness()
    try {
      await h.hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: question, tool_use_id: 'toolu_question' })
      await h.hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: question, permission_suggestions: [] })
      const open = h.pending()!
      expect(open.request).toMatchObject({ kind: 'question', id: 'receipt-1', nativeToolCallId: 'toolu_question' })
      expect(open.additionalRequests).toBeUndefined()
      await h.hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: question, tool_use_id: 'toolu_question',
        tool_response: { questions: question.questions, answers: { 'Pick a color?': 'Red' } }, duration_ms: 1 })
      expect(h.pending()).toBeUndefined()
      expect(await h.stored()).toBeUndefined()
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it('a question declined in the terminal is settled by the native end of that exact call', async () => {
    const h = await harness()
    try {
      await h.hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: question, tool_use_id: 'toolu_question' })
      await h.hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: question, permission_suggestions: [] })
      await h.askedEnd('toolu_other', 'AskUserQuestion')
      expect(h.pending()?.request).toMatchObject({ id: 'receipt-1', nativeToolCallId: 'toolu_question' })
      await h.askedEnd('toolu_question', 'AskUserQuestion')
      expect(h.pending()).toBeUndefined()
      expect(await h.stored()).toBeUndefined()
      expect(h.client.agentSession(agentSessionId).hookReceipt?.eventName).toBe(CLAUDE_ASKED_TOOL_END_EVENT)
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it('a permission whose ask carries the exact call identity ends with that call', async () => {
    const h = await harness()
    try {
      await h.hook('PreToolUse', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_bash' })
      // The native observer attaches the asked call's tool_use_id to Claude's classic ask.
      await h.hook('PermissionRequest', { tool_name: 'Bash', tool_input: command, permission_suggestions: [], tool_use_id: 'toolu_bash' })
      expect(h.pending()?.request).toMatchObject({ kind: 'permission', id: 'receipt-2', nativeToolCallId: 'toolu_bash', toolName: 'Bash' })
      await h.hook('PostToolUse', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_bash', tool_response: { stdout: '' }, duration_ms: 1 })
      expect(h.pending()).toBeUndefined()
      expect(await h.stored()).toBeUndefined()
    } finally { await h.close() }
  })

  it('a permission declined in the terminal ends with its call’s native end', async () => {
    const h = await harness()
    try {
      await h.hook('PreToolUse', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_bash' })
      await h.hook('PermissionRequest', { tool_name: 'Bash', tool_input: command, permission_suggestions: [], tool_use_id: 'toolu_bash' })
      await h.askedEnd('toolu_bash', 'Bash')
      expect(h.pending()).toBeUndefined()
      expect(await h.stored()).toBeUndefined()
      expect(h.writes).toEqual([])
    } finally { await h.close() }
  })

  it('an ask without a call identity is not given one by Core, even after a matching start', async () => {
    const h = await harness()
    try {
      await h.hook('PreToolUse', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_bash' })
      await h.hook('PermissionRequest', { tool_name: 'Bash', tool_input: command, permission_suggestions: [] })
      const request = h.pending()!.request
      expect(request).toMatchObject({ kind: 'permission', id: 'receipt-2' })
      expect(request).not.toHaveProperty('nativeToolCallId')
      await h.askedEnd('toolu_bash', 'Bash')
      expect(h.pending()?.request.id).toBe('receipt-2')
    } finally { await h.close() }
  })

  it('an end for another asked call leaves this permission open', async () => {
    const h = await harness()
    try {
      await h.hook('PreToolUse', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_bash' })
      await h.hook('PermissionRequest', { tool_name: 'Bash', tool_input: command, permission_suggestions: [], tool_use_id: 'toolu_bash' })
      await h.askedEnd('toolu_other', 'Bash')
      await h.hook('PostToolUse', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_other', tool_response: {} })
      expect(h.pending()?.request).toMatchObject({ id: 'receipt-2', nativeToolCallId: 'toolu_bash' })
    } finally { await h.close() }
  })

  it('serial asks each settle by their own call, with child-Agent hooks in between', async () => {
    const h = await harness()
    try {
      await h.hook('PreToolUse', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_bash' })
      await h.hook('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_use_id: 'toolu_child', agent_id: 'child-agent' })
      await h.hook('PermissionRequest', { tool_name: 'Bash', tool_input: command, permission_suggestions: [], tool_use_id: 'toolu_bash' })
      expect(h.pending()?.request).toMatchObject({ kind: 'permission', nativeToolCallId: 'toolu_bash' })
      await h.hook('PostToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_use_id: 'toolu_child', agent_id: 'child-agent', tool_response: {} })
      expect(h.pending()?.request.id).toBe('receipt-3')
      await h.hook('PostToolUse', { tool_name: 'Bash', tool_input: command, tool_use_id: 'toolu_bash', tool_response: {} })
      expect(h.pending()).toBeUndefined()
      const next = { command: 'touch build/next', description: 'Create next file' }
      await h.hook('PreToolUse', { tool_name: 'Bash', tool_input: next, tool_use_id: 'toolu_next' })
      await h.hook('PermissionRequest', { tool_name: 'Bash', tool_input: next, permission_suggestions: [], tool_use_id: 'toolu_next' })
      expect(h.pending()?.request).toMatchObject({ kind: 'permission', nativeToolCallId: 'toolu_next' })
      await h.askedEnd('toolu_next', 'Bash')
      expect(h.pending()).toBeUndefined()
    } finally { await h.close() }
  })

  it('a permission from another native transcript is not this Session’s request', async () => {
    const h = await harness()
    try {
      await h.hook('PermissionRequest', { tool_name: 'Bash', tool_input: command, permission_suggestions: [], tool_use_id: 'toolu_bash',
        transcript_path: fixturePath('claude/other.jsonl') })
      expect(h.pending()).toBeUndefined()
    } finally { await h.close() }
  })

  it('after a terminal decline the Agent is no longer awaiting the person, and a late end cannot reopen an ended turn', async () => {
    const h = await harness()
    try {
      await h.hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: question, tool_use_id: 'toolu_question' })
      await h.hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: question, permission_suggestions: [], tool_use_id: 'toolu_question' })
      expect(h.client.agentSession(agentSessionId).semanticStatus?.state).toBe('waiting')
      await h.askedEnd('toolu_question', 'AskUserQuestion')
      expect(h.pending()).toBeUndefined()
      expect(h.client.agentSession(agentSessionId).semanticStatus?.state).toBe('working')
      await h.hook('StopFailure', { error: 'native failure' })
      expect(h.client.agentSession(agentSessionId).semanticStatus?.state).toBe('error')
      await h.askedEnd('toolu_question', 'AskUserQuestion')
      expect(h.client.agentSession(agentSessionId).semanticStatus?.state).toBe('error')
    } finally { await h.close() }
  })

  it.each(['answer', 'aborted'] as const)('an asked end after a %s turn end settles the card without inventing overall idle', async reason => {
    const h = await harness()
    try {
      const native = (sequence: number, extra: Record<string, unknown> = {}) => ({ sourceId: 'native-source', sequence, turnId: 'turn-A', ...extra })
      await h.hook('turn.start', native(1))
      await h.hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: question, tool_use_id: 'toolu_q' })
      await h.hook('turn.complete', native(2, { reason, isAborted: reason === 'aborted' }))
      expect(h.pending()?.request).toMatchObject({ kind: 'question', nativeToolCallId: 'toolu_q' })
      expect(h.client.agentSession(agentSessionId).currentActivity).toMatchObject({ state: 'unknown', mainState: 'idle', nativeTurnId: 'turn-A' })
      // The runner ended, but this event supplied no background-work proof. Ending
      // its exact request preserves both facts instead of manufacturing overall idle.
      await h.askedEnd('toolu_q', 'AskUserQuestion')
      expect(h.pending()).toBeUndefined()
      expect(await h.stored()).toBeUndefined()
      expect(h.client.agentSession(agentSessionId).currentActivity).toMatchObject({ state: 'unknown', mainState: 'idle', sequence: 2 })
      expect((await h.recovery())?.state).toBe('unknown')
      // Only the ordered native start identifies the new main turn; an unscoped
      // classic tool Hook cannot replace the earlier native turn's fact.
      await h.hook('turn.start', native(3, { turnId: 'turn-B' }))
      expect(h.client.agentSession(agentSessionId).currentActivity).toMatchObject({ state: 'active', mainState: 'active', nativeTurnId: 'turn-B', sequence: 3 })
    } finally { await h.close() }
  })

  it('a native end from a child Agent or another native session cannot end the main request', async () => {
    const h = await harness()
    try {
      await h.hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: question, tool_use_id: 'toolu_question' })
      await h.askedEnd('toolu_question', 'AskUserQuestion', { agent_id: 'child-agent' })
      expect(h.pending()?.request.id).toBe('receipt-1')
      await h.askedEnd('toolu_question', 'AskUserQuestion', { session_id: 'native-other' })
      expect(h.pending()?.request.id).toBe('receipt-1')
    } finally { await h.close() }
  })
})
