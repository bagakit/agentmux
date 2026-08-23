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
      , pmoCapabilities: [{ id: 'review.observe', version: '1.0.0', effect: 'observe', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, requiredAuthority: 'pmo.read' }]
    }])
    // This test deliberately uses a fresh provider id below; built-in duplicate validation is a separate guard.
    expect(registry.list().map((plugin) => plugin.id)).toEqual(['agentmux.builtins', 'example.review'])
    expect(registry.skillsList()).toEqual([{ id: 'review', name: 'Review', description: 'Review a change' }])
    expect(registry.commandsList()).toEqual([{ id: 'review.open', description: 'Open a review task' }])
    expect(registry.pmoCapabilitiesList()).toEqual([{ id: 'review.observe', version: '1.0.0', effect: 'observe', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, requiredAuthority: 'pmo.read' }])
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

  it('unregisters every contribution so a candidate plugin can be rolled back', () => {
    const registry = new AgentMuxPluginRegistry()
    registry.register({ id: 'candidate', version: '1.0.0', skills: [{ id: 'candidate.skill', name: 'Candidate', description: 'Candidate' }], pmoCapabilities: [{ id: 'candidate.observe', version: '1.0.0', effect: 'observe', inputSchema: {}, outputSchema: {}, requiredAuthority: 'pmo.read' }] })
    registry.unregister('candidate')
    expect(registry.list()).toEqual([])
    expect(registry.skillsList()).toEqual([])
    expect(registry.pmoCapabilitiesList()).toEqual([])
  })

  it('emits a bounded, evaluator-aware PMO receipt for an active capability', () => {
    const registry = new AgentMuxPluginRegistry([{ id: 'candidate', version: '1.0.0', pmoCapabilities: [{ id: 'candidate.observe', version: '1.0.0', effect: 'observe', inputSchema: {}, outputSchema: {}, requiredAuthority: 'pmo.read' }] }])
    expect(registry.pmoReceipt({ pluginId: 'candidate', capabilityId: 'candidate.observe', requestId: 'req-1', operationId: 'op-1', phase: 'observe', durationMs: 4, inputSummary: { count: 1 }, outputSummary: { count: 1 }, evaluator: { status: 'passed', detail: 'bounded' }, rollbackTarget: 'candidate@0.9.0' })).toMatchObject({ schemaVersion: 'agentmux.pmo-receipt.v1', version: '1.0.0', rollbackTarget: 'candidate@0.9.0' })
  })
})
