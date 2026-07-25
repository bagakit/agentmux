import { describe, expect, it } from 'vitest'
import { composeAgentLaunchPrompt } from '../src/agent-launch-prompt.js'

describe('Agent launch prompt', () => {
  it('keeps the guide and original user request as two clear sections', () => {
    const prompt = 'Inspect the failing test.\nKeep the fix small.'

    expect(composeAgentLaunchPrompt(prompt, true)).toBe(`AgentMux runtime guide:
You are running inside AgentMux. For requests involving tabs, splits, directions, or other agents, run "$AGENTMUX_CLI" --skill before acting.

User request:
${prompt}`)
  })

  it('gives an idle launch an explicit wait instruction', () => {
    expect(composeAgentLaunchPrompt(undefined, true)).toContain(
      'User request:\nNo request yet. Wait for the user.'
    )
    expect(composeAgentLaunchPrompt('   ', true)).toContain(
      'User request:\nNo request yet. Wait for the user.'
    )
  })

  it('leaves the launch prompt unchanged when injection is disabled', () => {
    expect(composeAgentLaunchPrompt('Open Claude on the right.', false)).toBe(
      'Open Claude on the right.'
    )
    expect(composeAgentLaunchPrompt(undefined, false)).toBe('')
  })
})
