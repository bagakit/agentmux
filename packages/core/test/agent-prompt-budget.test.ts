import { describe, expect, it } from 'vitest'
import {
  agentLaunchContextExceedsBudget,
  AGENT_LAUNCH_CONTEXT_BUDGET_BYTES
} from '../src/agent-prompt-budget.js'

// This budget selects optional context. It never qualifies required Agent input.
describe('optional launch context selection', () => {
  it('counts UTF-8 bytes rather than characters', () => {
    const text = '一'.repeat(Math.floor(AGENT_LAUNCH_CONTEXT_BUDGET_BYTES / 3) + 1)
    expect(text.length).toBeLessThan(AGENT_LAUNCH_CONTEXT_BUDGET_BYTES)
    expect(agentLaunchContextExceedsBudget(text)).toBe(true)
  })

  it('allows optional content exactly at the soft boundary', () => {
    expect(agentLaunchContextExceedsBudget('a'.repeat(AGENT_LAUNCH_CONTEXT_BUDGET_BYTES))).toBe(false)
    expect(agentLaunchContextExceedsBudget('a'.repeat(AGENT_LAUNCH_CONTEXT_BUDGET_BYTES + 1))).toBe(true)
  })
})
