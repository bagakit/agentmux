import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry, defineAgentProvider, type AgentProviderDefinition } from '../src/agent-provider.js'

function definition(): AgentProviderDefinition {
  return {
    catalog: { id: 'contract-fixture', label: 'Contract fixture', executable: 'node', expectedProcess: 'node',
      readySignal: { kind: 'foreground-process', expectedProcess: 'node' }, promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
      composer: { skillRoots: ['.agent/skills'], commands: [{ text: '/help', description: 'Help' }] },
      capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: false,
        replyCorrelation: 'none', promptExecution: { immediate: 'terminal-submit' } } },
    hook: { rules: [] }, buildArgs: (prompt, args) => [...args, prompt]
  }
}

describe('Provider contribution contract', () => {
  it('rejects a missing native resume implementation before registration', () => {
    const invalid = definition()
    invalid.catalog.capabilities.providerResume = true
    invalid.catalog.resumeStrategy = { kind: 'provider-native', locator: 'session-id' }
    expect(() => defineAgentProvider(invalid)).toThrow(/resume capability and its launch contribution/)
    expect(() => defineAgentProvider({ ...definition(), buildResumeArgs: () => [] })).toThrow(/resume capability/)
  })

  it('rejects inconsistent capability and contributions atomically on registerAll and replace', () => {
    const original = defineAgentProvider(definition()), registry = new AgentProviderRegistry([original])
    const invalid = { ...original, id: 'invalid', catalog: { ...original.catalog, id: 'invalid',
      capabilities: { ...original.catalog.capabilities, providerResume: true } } }
    const second = { ...original, id: 'second', catalog: { ...original.catalog, id: 'second' } }
    expect(() => registry.registerAll([second, invalid])).toThrow(/resume capability and strategy/)
    expect(registry.list()).toEqual([original])
    expect(() => registry.replace({ ...invalid, id: original.id, catalog: { ...invalid.catalog, id: original.id } })).toThrow()
    expect(registry.get(original.id)).toBe(original)
    expect(original.buildLaunch({ workspacePath: '.', prompt: 'still usable', args: [], env: {} }).args).toEqual(['still usable'])
  })

  it('rejects orphan history and native response claims without inspecting a Run', () => {
    expect(() => defineAgentProvider({ ...definition(), readConversationChanges: async () => { throw new Error('not invoked') } })).toThrow(/original page reader/)
    const invalid = definition(); invalid.catalog.capabilities.permission = 'respond'
    expect(() => defineAgentProvider(invalid)).toThrow(/response contribution/)
    invalid.catalog.capabilities.permission = 'none'; invalid.catalog.capabilities.nativeConversationInput = { managedRuns: true }
    expect(() => defineAgentProvider(invalid)).toThrow(/exact input contribution/)
  })

  it('isolates catalog and probe nested data from the registered launch contract', async () => {
    const seed = definition(), provider = defineAgentProvider(seed), registry = new AgentProviderRegistry([provider])
    seed.catalog.composer!.skillRoots.push('seed-mutation')
    const first = registry.catalog()[0]!
    first.composer!.skillRoots.push('projection-mutation'); first.composer!.commands[0]!.text = '/mutated'
    first.capabilities.promptExecution!.immediate = 'interrupt-before-input'
    const probed = await provider.probeCapabilities({ hasExecutable: async () => true })
    probed.capabilities.promptExecution!.immediate = 'interrupt-before-input'
    expect(registry.catalog()[0]!.composer).toEqual({ skillRoots: ['.agent/skills'], commands: [{ text: '/help', description: 'Help' }] })
    expect(provider.planPromptInput('hello', { execution: 'immediate' })).toEqual({ kind: 'single-phase', data: 'hello\r' })
  })

})
