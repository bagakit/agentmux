import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { projectNativeHookToolFields, type AgentNativeHookToolFields } from '../src/hook-normalizer.js'
import { normalizeStoredAgentSession } from '../src/agent-session-store.js'
import { permission, storedSession } from './fixtures/interaction-client.js'
import type { AgentHookReceipt } from '../src/types.js'
import { fixturePath } from './helpers/fixture-values.js'

const providers = new AgentProviderRegistry()
const input = { command: 'original command', nested: { call_id: 'content-only' } }
// Raw producer shapes, rather than an alias-rich synthetic union. No installed
// upstream Agent is launched by these protocol fixtures.
const cases: { provider: string; event: string; raw: Record<string, unknown>; fields: AgentNativeHookToolFields }[] = [
  { provider: 'claude', event: 'PreToolUse', raw: { tool_name: 'Bash', tool_input: input, tool_use_id: 'claude-call' }, fields: { toolName: 'Bash', toolInput: input, reportedToolCallId: 'claude-call' } },
  { provider: 'codex', event: 'PreToolUse', raw: { tool_name: 'Bash', tool_input: input, tool_use_id: 'codex-call' }, fields: { toolName: 'Bash', toolInput: input, reportedToolCallId: 'codex-call' } },
  { provider: 'cursor', event: 'preToolUse', raw: { tool_name: 'Read', tool_input: input, tool_use_id: 'cursor-call' }, fields: { toolName: 'Read', toolInput: input, reportedToolCallId: 'cursor-call' } },
  { provider: 'hermes', event: 'pre_tool_call', raw: { tool_name: 'read_file', tool_input: input, extra: { tool_call_id: 'hermes-call' } }, fields: { toolName: 'read_file', toolInput: input, reportedToolCallId: 'hermes-call' } },
  { provider: 'pi', event: 'tool_call', raw: { tool_name: 'read', tool_input: input }, fields: { toolName: 'read', toolInput: input } },
  { provider: 'grok', event: 'pre_tool_use', raw: { toolName: 'run_terminal_command', toolInput: input, toolUseId: 'grok-call' }, fields: { toolName: 'run_terminal_command', toolInput: input, reportedToolCallId: 'grok-call' } },
  { provider: 'gemini', event: 'BeforeTool', raw: { tool_name: 'read_file', tool_input: input }, fields: { toolName: 'read_file', toolInput: input } },
  { provider: 'antigravity', event: 'PreToolUse', raw: { toolCall: { name: 'read_file', args: input } }, fields: { toolName: 'read_file', toolInput: input } },
  { provider: 'droid', event: 'PreToolUse', raw: { tool_name: 'Read', tool_input: input }, fields: { toolName: 'Read', toolInput: input } },
  { provider: 'kimi', event: 'PreToolUse', raw: { tool_name: 'read_file', tool_input: input, tool_call_id: 'kimi-call' }, fields: { toolName: 'read_file', toolInput: input, reportedToolCallId: 'kimi-call' } },
  { provider: 'copilot', event: 'preToolUse', raw: { toolName: 'read_file', toolArgs: input }, fields: { toolName: 'read_file', toolInput: input } },
  { provider: 'opencode', event: 'message.part.updated', raw: { part: { type: 'tool', tool: 'read', callID: 'opencode-call', state: { status: 'running', input } } }, fields: { toolName: 'read', toolInput: input, reportedToolCallId: 'opencode-call' } }
]

describe('Provider-owned raw tool fields', () => {
  it('covers every current Hook contribution and no absent producer', () => {
    expect(cases.map(row => row.provider).sort()).toEqual(['antigravity','claude','codex','copilot','cursor','droid','gemini','grok','hermes','kimi','opencode','pi'])
    expect(providers.list().filter(provider => provider.hook.toolFields).map(provider => provider.catalog.id).sort()).toEqual(cases.map(row => row.provider).sort())
    expect(projectNativeHookToolFields({ rules: [] }, 'PreToolUse', { tool_name: 'Bash', call_id: 'foreign' })).toEqual({})
  })

  it.each(cases)('$provider selects only its own event fields', row => {
    const fields = projectNativeHookToolFields(providers.get(row.provider).hook, row.event, row.raw)
    expect(fields).toEqual(row.fields)
    expect(fields.toolInput).toBe(input)
    const foreign = { name: 'foreign-name', input: { text: 'foreign-input' }, call_id: 'foreign-call',
      toolCallId: 'foreign-camel-call', toolId: 'foreign-tool-id',
      extra: { tool_name: 'foreign-name', tool_input: { text: 'foreign-input' }, tool_use_id: 'foreign-extra-call', session_id: 'foreign-main' }, ...row.raw }
    expect(projectNativeHookToolFields(providers.get(row.provider).hook, row.event, foreign)).toEqual(row.fields)
    // Neither another event nor another Provider's aliases acquire ownership.
    expect(projectNativeHookToolFields(providers.get(row.provider).hook, 'foreign-event', foreign)).toEqual({})
  })

  it.each(cases)('$provider preserves selected null, empty, multiline and large input without a fallback', row => {
    for (const value of [null, '', '  ', 'first\nsecond', { text: 'x'.repeat(5000) }]) {
      const raw = structuredClone(row.raw)
      if (row.provider === 'antigravity') (raw.toolCall as Record<string, unknown>).args = value
      else if (row.provider === 'opencode') ((raw.part as Record<string, unknown>).state as Record<string, unknown>).input = value
      else raw[row.provider === 'grok' ? 'toolInput' : row.provider === 'copilot' ? 'toolArgs' : 'tool_input'] = value
      const fields = projectNativeHookToolFields(providers.get(row.provider).hook, row.event, raw)
      expect(Object.hasOwn(fields, 'toolInput'), row.provider).toBe(true)
      expect(fields.toolInput).toBe(value)
    }
  })

  it('keeps event-specific absences, including Codex PermissionRequest and Cursor shell name/input', () => {
    const poison = { tool_name: 'Bash', tool_input: input, tool_use_id: 'foreign-id', call_id: 'foreign-id', tool_call_id: 'foreign-id', extra: { tool_use_id: 'foreign-id' } }
    expect(projectNativeHookToolFields(providers.get('codex').hook, 'PermissionRequest', poison)).toEqual({ toolName: 'Bash', toolInput: input })
    expect(projectNativeHookToolFields(providers.get('claude').hook, 'PermissionRequest', { tool_name: 'Bash', tool_input: input })).toEqual({ toolName: 'Bash', toolInput: input })
    expect(projectNativeHookToolFields(providers.get('cursor').hook, 'beforeShellExecution', { command: 'original', cwd: 'workspace', tool_use_id: 'cursor-shell' })).toEqual({ reportedToolCallId: 'cursor-shell' })
    for (const provider of ['pi','gemini','antigravity','droid','copilot']) {
      const row = cases.find(row => row.provider === provider)!
      const fields = projectNativeHookToolFields(providers.get(provider).hook, row.event, { ...poison, ...row.raw })
      expect(fields).not.toHaveProperty('reportedToolCallId')
    }
    expect(projectNativeHookToolFields(providers.get('hermes').hook, 'pre_tool_call', { tool_name: 'read_file', tool_input: null, tool_call_id: 'foreign-flat' }))
      .toEqual({ toolName: 'read_file', toolInput: null })
  })

  it('Grok gives its original camel fields precedence and never fills a present invalid field from an alias', () => {
    const grok = providers.get('grok').hook
    expect(projectNativeHookToolFields(grok, 'pre_tool_use', { toolName: 'original', tool_name: 'foreign', toolInput: '', tool_input: input, toolUseId: 'original-id', tool_use_id: 'foreign-id' }))
      .toEqual({ toolName: 'original', toolInput: '', reportedToolCallId: 'original-id' })
    expect(projectNativeHookToolFields(grok, 'pre_tool_use', { tool_name: 'original', tool_input: input, tool_use_id: 'original-id' }))
      .toEqual({ toolName: 'original', toolInput: input, reportedToolCallId: 'original-id' })
    expect(projectNativeHookToolFields(grok, 'pre_tool_use', { toolName: null, tool_name: 'foreign', toolInput: null, tool_input: input, toolUseId: '', tool_use_id: 'foreign-id' }))
      .toEqual({ toolInput: null })
  })

  it('Codex resolved correlation requires every original adjacent Pre fence', () => {
    const codex = providers.get('codex')
    const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'native-correlation', transcriptPath: fixturePath('codex/correlation.jsonl') }
    const base = { providerId: 'codex', agentSessionId: 'correlation-session', runId: 'correlation-run' }
    const payload = { session_id: nativeHandle.sessionId, transcript_path: nativeHandle.transcriptPath, turn_id: 'correlation-turn', tool_name: 'Bash', tool_input: { command: 'original command', description: 'original description' } }
    const start = codex.normalizeHook({ ...base, receiptId: 'correlation-pre', eventName: 'PreToolUse', payload: { ...payload, tool_use_id: 'correlation-call' } }, { nativeHandle, processNativeHandle: nativeHandle })
    expect(start.toolInvocation).toMatchObject({ nativeToolCallId: 'correlation-call', nativeTurnId: payload.turn_id })
    const receipt: AgentHookReceipt = { id: 'correlation-pre', providerId: 'codex', agentSessionId: base.agentSessionId, run: { runId: base.runId }, eventName: 'PreToolUse', lifecycleEvent: 'tool-use-start', nativeTurnId: payload.turn_id, toolInvocation: start.toolInvocation!, observedAt: 1 }
    const resolve = (previous: AgentHookReceipt | undefined, raw = payload, native = nativeHandle) => codex.normalizeHook({ ...base, receiptId: 'correlation-permission', eventName: 'PermissionRequest', payload: raw }, { nativeHandle: native, processNativeHandle: native, ...(previous ? { previousHookReceipt: previous } : {}) }).interaction?.nativeToolCallId
    expect(resolve(receipt)).toBe('correlation-call')
    for (const previous of [undefined, { ...receipt, agentSessionId: 'foreign-session' }, { ...receipt, providerId: 'claude' },
      { ...receipt, run: { runId: 'foreign-run' } }, { ...receipt, eventName: 'PostToolUse' },
      { ...receipt, lifecycleEvent: 'tool-use-end' as const }, { ...receipt, nativeTurnId: '' },
      { ...receipt, toolInvocation: { ...start.toolInvocation!, ambiguous: true as const } }]) expect(resolve(previous)).toBeUndefined()
    for (const raw of [{ ...payload, turn_id: '' }, { ...payload, turn_id: 'foreign-turn' },
      { ...payload, session_id: 'foreign-native' }, { ...payload, transcript_path: 'relative-path' },
      { ...payload, tool_name: 'Read' }, { ...payload, tool_input: { command: 'changed command', description: 'original description' } },
      { ...payload, tool_input: { command: 'original command', description: 'changed description' } },
      { ...payload, tool_input: { command: 'original command', description: 'original description', extra: true } }]) expect(resolve(receipt, raw as typeof payload)).toBeUndefined()
    expect(resolve(receipt, payload, { ...nativeHandle, sessionId: 'changed-native' })).toBeUndefined()
    expect(resolve(receipt, payload, { ...nativeHandle, transcriptPath: fixturePath('codex/changed-transcript.jsonl') })).toBeUndefined()
    const competing = codex.normalizeHook({ ...base, receiptId: 'competing-pre', eventName: 'PreToolUse', payload: { ...payload, tool_use_id: 'competing-call' } }, { nativeHandle, processNativeHandle: nativeHandle, previousHookReceipt: receipt })
    expect(competing.toolInvocation?.ambiguous).toBe(true)
    expect(resolve({ ...receipt, id: 'competing-pre', toolInvocation: competing.toolInvocation! })).toBeUndefined()
  })

  it('Hermes retains its own nested status, child scope and assistant body without a generic overlay', () => {
    const hermes = providers.get('hermes')
    const normalize = (eventName: string, payload: Record<string, unknown>) => hermes.normalizeHook({ providerId: 'hermes', agentSessionId: 'hermes-fields', runId: 'hermes-fields-run', receiptId: 'hermes-' + eventName, eventName, payload }, {})
    expect(hermes.hook.nativeHandle).toBeUndefined(); expect(hermes.hook.subagentTracking).toBeUndefined()
    expect(normalize('on_session_end', { extra: { completed: true } })).toMatchObject({ semanticState: 'done', lifecycleEvent: 'turn-end' })
    expect(normalize('on_session_end', { extra: { failed: true } })).toMatchObject({ semanticState: 'error', lifecycleEvent: 'turn-end' })
    expect(normalize('on_session_end', { extra: { interrupted: true, completed: true } }).semanticState).toBe('unknown')
    expect(normalize('on_session_end', { completed: true }).semanticState).toBe('unknown')
    expect(normalize('pre_tool_call', { tool_name: 'clarify', tool_input: input }).semanticState).toBe('waiting')
    expect(normalize('pre_tool_call', { tool_name: 'read_file', tool_input: input, extra: { tool_name: 'clarify' } }).semanticState).toBe('working')
    expect(normalize('pre_tool_call', { tool_name: 'read_file', extra: { platform: 'subagent' } }).mainSubject).toBe(false)
    const body = normalize('post_llm_call', { extra: { assistant_response: 'original Hermes body', status: 'data' } })
    expect(body.timeline.some(mutation => mutation.type !== 'update' && mutation.item.kind === 'assistant_message' && mutation.item.content === 'original Hermes body')).toBe(true)
    expect(body.nativeHandle).toBeUndefined()
  })

  it('does not lift foreign extra into Codex subject, turn, readiness or native source', () => {
    const codex = providers.get('codex'), native = { kind: 'provider' as const, providerId: 'codex', sessionId: 'confirmed-main' }
    const envelope = { providerId: 'codex', agentSessionId: 'raw-subject', runId: 'raw-subject-run', receiptId: 'raw-subject-pre', eventName: 'PreToolUse' }
    const payload = { tool_name: 'Bash', tool_input: input, extra: { session_id: native.sessionId, turn_id: 'foreign-turn', transcript_path: 'foreign-path', tool_use_id: 'foreign-call', source: 'resume', agent_id: 'foreign-child' } }
    const result = codex.normalizeHook({ ...envelope, payload }, { nativeHandle: native, processNativeHandle: native })
    expect(result.mainSubject).toBe(false)
    expect(result.nativeHandle).toBeUndefined(); expect(result.nativeTurnId).toBeUndefined()
    expect(result.interaction).toBeUndefined(); expect(result.toolInvocation).toBeUndefined()
    expect(result.continuity).toBeUndefined()
  })
})

describe('pending permission input retains its original Store field contract', () => {
  function saved(value: unknown, present = true) {
    const request = permission('input-field')
    delete request.toolInput
    return { ...storedSession(), pendingInteraction: { request: { ...request, ...(present ? { toolInput: value } : {}) } } }
  }
  it.each(['', '  ', 'first\nsecond', 'x'.repeat(16 * 1024)])('preserves valid original content without trimming', value => {
    const normalized = normalizeStoredAgentSession(saved(value))
    expect(Object.hasOwn(normalized.pendingInteraction!.request, 'toolInput')).toBe(true)
    expect(normalized.pendingInteraction!.request).toHaveProperty('toolInput', value)
  })
  it('keeps absence distinct and rejects over-capacity, NUL and non-string input', () => {
    expect(normalizeStoredAgentSession(saved(undefined, false)).pendingInteraction!.request).not.toHaveProperty('toolInput')
    for (const invalid of ['x'.repeat(16 * 1024 + 1), 'a\u0000b', null, 1, {}]) expect(() => normalizeStoredAgentSession(saved(invalid))).toThrow()
    const invalidIdentity = saved('')
    invalidIdentity.agentSessionId = ''
    expect(() => normalizeStoredAgentSession(invalidIdentity)).toThrow()
  })
})
