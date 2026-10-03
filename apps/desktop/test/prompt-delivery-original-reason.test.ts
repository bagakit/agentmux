import { AgentMuxError } from '@agentmux/core'
import { expect, it } from 'vitest'
import { humanizePromptDeliveryError } from '../src/main/prompt-readiness-diagnostics'

const controlFailure = { disposition: 'unknown' as const, confirmedInputBytes: 0 }
it.each(['AGENT_PROMPT_INPUT_UNCONFIRMED', 'AGENT_PROMPT_SUBMISSION_BUSY', 'AGENT_PROMPT_READINESS_CONFLICT', 'AGENT_TURN_END_UNCONFIRMED'])(
  'preserves the original refusal reason for %s', code => {
    const original = new AgentMuxError('The original input owner changed during delivery.', code, 'unknown', controlFailure)
    const translated = humanizePromptDeliveryError(original) as AgentMuxError
    expect(translated.message).toContain(original.message)
    expect(translated.code).toBe(original.code)
    expect(translated.detail).toBe(original.detail)
    expect(translated.controlFailure).toBe(original.controlFailure)
  })
it('keeps different original failures distinguishable when code and detail are identical', () => {
  const missing = new AgentMuxError('The original prompt delivery condition is missing.', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
  const replaced = new AgentMuxError('A later prompt admission has replaced this message’s original condition.', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
  const left = humanizePromptDeliveryError(missing) as AgentMuxError
  const right = humanizePromptDeliveryError(replaced) as AgentMuxError
  expect(left.message).toContain(missing.message)
  expect(right.message).toContain(replaced.message)
  expect(left.message).not.toBe(right.message)
})
it('retains the original reason when presenting an ended Run', () => {
  const original = new AgentMuxError('Original refusal before observed Run end.', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown', controlFailure)
  const translated = humanizePromptDeliveryError(original, { runState: 'ended' }) as AgentMuxError
  expect(translated.message).toContain(original.message)
  expect(translated.controlFailure).toBe(controlFailure)
})
it('keeps unmapped preparation failures unchanged', () => {
  const original = new AgentMuxError('Original preparation failure.', 'AGENT_PROMPT_PREPARATION_FAILED', 'unknown')
  expect(humanizePromptDeliveryError(original)).toBe(original)
})
