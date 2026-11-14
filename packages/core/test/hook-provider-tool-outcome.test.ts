import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentTimelineItem } from '../src/types.js'

const providers = new AgentProviderRegistry()
// These are result fixtures, not claims of a live installed CLI run. Event/result
// shapes follow the corresponding producer; name/identity handling is unchanged.
const cases = [
  { provider: 'claude', event: 'PostToolUse', payload: { tool_response: 'claude-native' }, output: 'claude-native' },
  { provider: 'codex', event: 'PostToolUse', payload: { tool_response: 'codex-native exit 1 error' }, output: 'codex-native exit 1 error' },
  { provider: 'cursor', event: 'postToolUse', payload: { tool_output: 'cursor-native' }, output: 'cursor-native' },
  { provider: 'hermes', event: 'post_tool_call', payload: { extra: { result: 'hermes-native', status: 'ok' } }, output: 'hermes-native' },
  { provider: 'pi', event: 'tool_execution_end', payload: {}, output: undefined },
  { provider: 'grok', event: 'post_tool_use', payload: { toolResult: { type: 'Bash', output_for_prompt: 'grok-native', exit_code: 0 } }, output: 'grok-native' },
  { provider: 'gemini', event: 'AfterTool', payload: { tool_response: { llmContent: [{ text: 'gemini-native' }] } }, output: 'gemini-native' },
  { provider: 'antigravity', event: 'PostToolUse', payload: {}, output: undefined },
  { provider: 'droid', event: 'PostToolUse', payload: { tool_response: 'droid-native' }, output: 'droid-native' },
  { provider: 'kimi', event: 'PostToolUse', payload: { tool_output: 'kimi-native failed error exit 1' }, output: 'kimi-native failed error exit 1' },
  { provider: 'copilot', event: 'postToolUse', payload: { toolResult: { textResultForLlm: 'copilot-native', resultType: 'success' } }, output: 'copilot-native' }
] as const

function result(provider: string, eventName: string, values: Record<string, unknown>): AgentTimelineItem {
  const normalized = providers.get(provider).normalizeHook({
    receiptId: `outcome-${provider}-${eventName}`, agentSessionId: 'outcome-session', runId: `outcome-run-${provider}`,
    providerId: provider, eventName,
    payload: { hook_event_name: eventName, hookEventName: eventName, session_id: 'native-outcome', sessionId: 'native-outcome',
      tool_name: provider === 'grok' ? 'run_terminal_command' : 'Read', toolName: provider === 'grok' ? 'run_terminal_command' : 'Read', tool_input: { path: 'source' }, toolCall: { name: 'Read', args: { path: 'source' } }, ...values }
  }, provider === 'codex' ? { processNativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-outcome' } } : {})
  expect(normalized.lifecycleEvent, provider).toBe('tool-use-end')
  expect(normalized.semanticState, 'a tool result never closes the Agent').not.toBe('error')
  const mutations = normalized.timeline.filter(m => m.type !== 'update' && m.item.kind === 'tool_call')
  expect(mutations, provider).toHaveLength(1)
  const mutation = mutations[0]!
  if (mutation.type === 'update') throw Error('Expected a complete original tool item')
  return mutation.item
}

describe('Provider-owned native tool outcomes', () => {
  it('executes every current native canonical-end Provider and excludes absent producers', () => {
    expect(cases.map(c => c.provider).sort()).toEqual(['antigravity','claude','codex','copilot','cursor','droid','gemini','grok','hermes','kimi','pi'])
    const declared = providers.list().filter(p => Object.values(p.hook.lifecycle ?? {}).includes('tool-use-end')).map(p => p.catalog.id).sort()
    expect(declared).toEqual(cases.map(c => c.provider).sort())
  })

  it.each(cases)('$provider retains its original result without deriving failure from content', row => {
    const item = result(row.provider, row.event, row.payload)
    expect(item.status).toBe('complete')
    expect(item.toolOutput).toBe(row.output)
    expect(Object.hasOwn(item, 'toolOutput')).toBe(row.output !== undefined)
  })

  it.each(cases)('$provider ignores foreign top-level failure/status keys beside a real result', row => {
    const item = result(row.provider, row.event, { status: 'error', resultType: 'failure', code: 9, exit_code: 9, is_error: true, ...row.payload })
    expect(item.status).toBe('complete')
    expect(item.toolOutput).toBe(row.output)
  })

  it.each(cases)('$provider does not borrow other Providers result aliases when its result is missing', row => {
    const foreign: Record<string, unknown> = { tool_response: 'foreign-response', tool_output: 'foreign-output',
      toolResult: { textResultForLlm: 'foreign-result', resultType: 'failure' }, result: 'foreign-result', output: 'foreign-output',
      status: 'error', resultType: 'failure', code: 9, is_error: true }
    const own: Record<string, string[]> = { claude: ['tool_response'], codex: ['tool_response'], cursor: ['tool_output'],
      grok: ['toolResult','tool_response'], gemini: ['tool_response'], droid: ['tool_response'], kimi: ['tool_output'], copilot: ['toolResult'] }
    for (const key of own[row.provider] ?? []) delete foreign[key]
    expect(result(row.provider, row.event, foreign)).toMatchObject({ status: 'complete' })
    expect(result(row.provider, row.event, foreign).toolOutput).toBeUndefined()
  })

  it.each(cases.filter(c => c.provider !== 'hermes'))('$provider never promotes extra results into its own outcome', row => {
    const item = result(row.provider, row.event, { extra: {
      tool_response: { llmContent: 'foreign-extra-body', error: { message: 'foreign-extra-failure' } },
      tool_output: 'foreign-extra-body', toolResult: { textResultForLlm: 'foreign-extra-body', resultType: 'failure' },
      result: 'foreign-extra-body', status: 'error', error: 'foreign-extra-failure', error_message: 'foreign-extra-failure'
    } })
    expect(item.toolOutput, 'foreign-extra-output-is-absent').toBeUndefined()
    expect(item.status, 'foreign-extra-failure-is-not-owned').toBe('complete')
  })

  it.each([
    ['claude', 'PostToolUseFailure', { error: 'claude-error' }, 'claude-error'],
    ['cursor', 'postToolUseFailure', { error_message: 'cursor-error', failure_type: 'tool_error' }, 'cursor-error'],
    ['hermes', 'post_tool_call', { extra: { status: 'error', error_message: 'hermes-error' } }, 'hermes-error'],
    ['grok', 'post_tool_use_failure', { error: 'grok-error' }, 'grok-error'],
    ['gemini', 'AfterTool', { tool_response: { error: { message: 'gemini-error', type: 'EXECUTION_FAILED' } } }, 'gemini-error'],
    ['antigravity', 'PostToolUse', { error: 'antigravity-error' }, 'antigravity-error'],
    ['kimi', 'PostToolUseFailure', { error: { code: 'execution_error', message: 'kimi-error', retryable: false } }, 'kimi-error'],
    ['copilot', 'postToolUseFailure', { error: 'copilot-error' }, 'copilot-error']
  ] as const)('%s retains its original explicit failure and body', (provider, event, payload, output) => {
    expect(result(provider, event, payload)).toMatchObject({ status: 'failed', toolOutput: output })
  })

  it.each(['failure','rejected','denied','timeout'] as const)('Copilot owns resultType=%s on its original result object', resultType => {
    expect(result('copilot', 'postToolUse', { toolResult: { textResultForLlm: 'copilot-result', resultType } }))
      .toMatchObject({ status: 'failed', toolOutput: 'copilot-result' })
  })

  it.each(['error','blocked'])('Hermes consumes its own extra.status=%s without reparsing body JSON', status => {
    expect(result('hermes', 'post_tool_call', { extra: { status, result: 'hermes-body', error_message: 'error-detail' } }))
      .toMatchObject({ status: 'failed', toolOutput: 'hermes-body' })
    expect(result('hermes', 'post_tool_call', { extra: { status: 'ok', result: { status: 'error', code: 1 } } }))
      .toMatchObject({ status: 'complete', toolOutput: '{"status":"error","code":1}' })
  })

  it('Grok only interprets the evidenced Bash exit code, preserving its own alias and opaque JSON', () => {
    expect(result('grok', 'post_tool_use', { toolResult: { type: 'Bash', output_for_prompt: 'bash-error', exit_code: 2 } }))
      .toMatchObject({ status: 'failed', toolOutput: 'bash-error' })
    expect(result('grok', 'post_tool_use', { tool_response: 'original-same-value-alias' }).toolOutput).toBe('original-same-value-alias')
    expect(result('grok', 'post_tool_use', { toolResult: { type: 'mcp', code: 9, status: 'error' } }).status).toBe('complete')
    const opaque = { type: 'Bash', output_for_prompt: 'foreign-MCP-data', exit_code: 7 }
    for (const toolName of ['fixture__run_terminal_command', 'Read', 'Bash']) {
      expect(result('grok', 'post_tool_use', { toolName, tool_name: toolName, toolResult: opaque }))
        .toMatchObject({ status: 'complete', toolOutput: JSON.stringify(opaque) })
    }
    expect(result('grok', 'post_tool_use', { toolResult: { type: 'Bash', output_for_prompt: 'ordinary', pre_formatted: 'original-preformatted', exit_code: 0 } }).toolOutput).toBe('original-preformatted')
  })

  it.each(['gemini','kimi'] as const)('%s preserves empty native text and treats absent result separately', provider => {
    const event = provider === 'gemini' ? 'AfterTool' : 'PostToolUse'
    expect(result(provider, event, provider === 'gemini' ? { tool_response: { llmContent: '' } } : { tool_output: '' }))
      .toMatchObject({ status: 'complete' })
    expect(result(provider, event, provider === 'gemini' ? { tool_response: { llmContent: '' } } : { tool_output: '' }).toolOutput).toBeUndefined()
    expect(result(provider, event, {}).toolOutput).toBeUndefined()
    const failed = result(provider, provider === 'gemini' ? 'AfterTool' : 'PostToolUseFailure',
      provider === 'gemini' ? { tool_response: { error: { message: '' } } } : { error: { code: 'empty', message: '', retryable: false } })
    expect(failed).toMatchObject({ status: 'failed' })
    expect(failed.toolOutput).toBeUndefined()
  })

  it('opaque tool JSON is displayed without interpreting arbitrary nested semantic keys', () => {
    const opaque = { status: 'error', code: 1, error: { message: 'data' }, stdout: 'also data' }
    for (const provider of ['claude','codex','droid']) {
      expect(result(provider, 'PostToolUse', { tool_response: opaque })).toMatchObject({ status: 'complete', toolOutput: JSON.stringify(opaque) })
    }
    expect(result('gemini', 'AfterTool', { tool_response: { llmContent: 'failed error exit 1', returnDisplay: { error: 'display text' } }, error: { message: 'foreign-top-error' } }))
      .toMatchObject({ status: 'complete', toolOutput: 'failed error exit 1' })
    expect(result('kimi', 'PostToolUse', { tool_output: 'failed error exit 1', error: { message: 'foreign-top-error' } }))
      .toMatchObject({ status: 'complete', toolOutput: 'failed error exit 1' })
  })
})
