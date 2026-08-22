import { describe, expect, it } from 'vitest'
import { AgentMuxPluginRegistry, createDefaultAgentMuxPluginRegistry } from '../src/agent-plugin.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'

describe('AgentMux plugin boundary', () => {
  it('discovers built-ins and activates provider, Skill, and command contributions through one registry', () => {
    const codex = new AgentProviderRegistry().get('codex')
    const reviewProvider = {
      ...codex,
      id: 'example-review',
      catalog: { ...codex.catalog, id: 'example-review' }
    }
    const registry = createDefaultAgentMuxPluginRegistry([{
      id: 'example.review',
      version: '2.1.0',
      providers: [reviewProvider],
      skills: [{ id: 'review', name: 'Review', description: 'Review a change' }],
      commands: [{ id: 'review.open', description: 'Open a review task' }]
    }])
    // This test deliberately uses a fresh provider id below; built-in duplicate validation is a separate guard.
    expect(registry.list().map((plugin) => plugin.id)).toEqual(['agentmux.builtins', 'example.review'])
    expect(registry.skillsList()).toEqual([{ id: 'review', name: 'Review', description: 'Review a change' }])
    expect(registry.commandsList()).toEqual([{ id: 'review.open', description: 'Open a review task' }])
    expect(registry.catalog().map((provider) => provider.id)).toEqual(expect.arrayContaining(['codex', 'example-review']))
  })

  it('rejects duplicate plugin ids and provider ids before mutating the registry', () => {
    const registry = createDefaultAgentMuxPluginRegistry()
    expect(() => registry.register({ id: 'agentmux.builtins', version: '1.0.0' })).toThrow('already registered')
    const before = registry.list()
    expect(() => registry.register({
      id: 'example.duplicate-provider',
      version: '1.0.0',
      providers: [new AgentProviderRegistry().get('codex')]
    })).toThrow('already registered')
    expect(registry.list()).toEqual(before)
  })

  it('rejects duplicate contribution ids instead of silently replacing host actions', () => {
    const registry = new AgentMuxPluginRegistry()
    expect(() => registry.register({
      id: 'example.invalid',
      version: '1.0.0',
      skills: [
        { id: 'same', name: 'One', description: 'One' },
        { id: 'same', name: 'Two', description: 'Two' }
      ]
    })).toThrow('Duplicate plugin Skill id')
  })
})
