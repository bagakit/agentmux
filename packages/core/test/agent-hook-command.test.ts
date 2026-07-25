import { describe, expect, it } from 'vitest'
import { hookResponseFor, resolveHookProvider } from '../src/agent-hook-command.js'

describe('agent hook command response contract', () => {
  it('gates Antigravity: PreToolUse defers with "ask", Stop clears, other events emit {}', () => {
    // Antigravity reads empty/absent stdout on the PreToolUse gate as a HARD DENY (#2426),
    // so it is the one provider that must receive an explicit decision.
    expect(hookResponseFor('antigravity', 'PreToolUse')).toBe('{"decision":"ask"}\n')
    expect(hookResponseFor('antigravity', 'Stop')).toBe('{"decision":""}\n')
    expect(hookResponseFor('antigravity', 'PreInvocation')).toBe('{}\n')
    expect(hookResponseFor('antigravity', 'PostToolUse')).toBe('{}\n')
  })

  it('never emits an Antigravity decision to a gated observer of another provider', () => {
    // Codex marks the hook run FAILED on {"decision":"ask"} / {"decision":""}; Claude only
    // tolerates it by luck. A passive observer must emit {} for every event on both.
    for (const provider of ['codex', 'claude', 'gemini', 'pi', 'hermes', 'cursor', 'grok', 'traex']) {
      for (const eventName of ['PreToolUse', 'Stop', 'PostToolUse', 'SessionStart', 'UserPromptSubmit']) {
        expect(hookResponseFor(provider, eventName)).toBe('{}\n')
      }
    }
  })

  it('falls back to {} for an unknown provider or a missing event', () => {
    expect(hookResponseFor(null, 'PreToolUse')).toBe('{}\n')
    expect(hookResponseFor('antigravity', null)).toBe('{}\n')
    expect(hookResponseFor(null, null)).toBe('{}\n')
  })

  it('resolves the provider from the baked command var, then the launch env, then the antigravity event', () => {
    expect(resolveHookProvider({ AGENTMUX_HOOK_PROVIDER: 'codex', AGENTMUX_PROVIDER_ID: 'claude' })).toBe('codex')
    expect(resolveHookProvider({ AGENTMUX_PROVIDER_ID: 'claude' })).toBe('claude')
    expect(resolveHookProvider({ AGENTMUX_ANTIGRAVITY_EVENT: 'PreToolUse' })).toBe('antigravity')
    expect(resolveHookProvider({})).toBeNull()
  })
})
