import { AgentMuxError } from '@agentmux/core'
import { expect, it } from 'vitest'
import { humanizePromptDeliveryError } from '../src/main/prompt-readiness-diagnostics'

it.each([new TypeError('offline'), 'failure', null, undefined, new AgentMuxError('invalid', 'INVALID_AGENT_PROMPT')])('preserves unknown failures by identity', (error) => {
  expect(humanizePromptDeliveryError(error)).toBe(error)
})
it.each([
  ['AGENT_PROMPT_SUBMISSION_BUSY', 'Another message is still being delivered'],
  ['AGENT_PROMPT_READINESS_CONFLICT', 'The Session changed during delivery']
])('explains %s with a reachable recovery action and preserves diagnostic detail', (code, text) => {
  const error = new AgentMuxError('internal', code!, '  runId=run-1  ')
  const result = humanizePromptDeliveryError(error) as AgentMuxError
  expect(result).not.toBe(error)
  expect(result.message).toContain(text)
  expect(result.message).toContain('Diagnostic: runId=run-1')
  expect(result.detail).toBe('  runId=run-1  ')
  expect(result.code).toBe(code)
  expect(result.message).not.toMatch(/stop|restart|readiness epoch/i)
})
it.each([undefined, '   '])('omits absent diagnostic details', (detail) => {
  const result = humanizePromptDeliveryError(new AgentMuxError('internal', 'AGENT_PROMPT_SUBMISSION_BUSY', detail)) as AgentMuxError
  expect(result.message).toContain('Another message')
  expect(result.message).not.toContain('Diagnostic:')
})
it('reports an authoritative ended Run instead of promising that an in-flight delivery will complete', () => {
  const result = humanizePromptDeliveryError(new AgentMuxError('internal', 'AGENT_PROMPT_SUBMISSION_BUSY'), { runState: 'ended' }) as AgentMuxError
  expect(result.message).toContain('Run has ended')
  expect(result.message).toContain('resume the Agent')
})
