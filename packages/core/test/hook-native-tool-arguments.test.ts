import { expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'

it('keeps native camelCase tool arguments in the real Provider timeline', () => {
  const result = new AgentProviderRegistry().get('copilot').normalizeHook({
    receiptId: 'native-args', providerId: 'copilot', agentSessionId: 'agent', runId: 'healthy',
    eventName: 'preToolUse', payload: { toolName: 'bash', toolArgs: { command: 'check', cwd: '/workspace' } }
  })
  expect(result.timeline).toHaveLength(1)
  expect(result.timeline[0]).toMatchObject({ type: 'append', item: {
    kind: 'tool_call', toolName: 'bash', toolInput: '{"command":"check","cwd":"/workspace"}'
  } })
})
