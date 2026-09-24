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

  it('keeps existing contributions after a rejected Provider batch and accepts the corrected plugin', () => {
    const builtins = new AgentProviderRegistry()
    const pi = builtins.get('pi'), codex = builtins.get('codex'), claude = builtins.get('claude')
    const registry = new AgentMuxPluginRegistry([{
      id: 'existing', version: '1.0.0', providers: [pi],
      skills: [{ id: 'existing.skill', name: 'Existing', description: 'Existing skill' }],
      commands: [{ id: 'existing.command', description: 'Existing command' }],
      pmoCapabilities: [{ id: 'existing.observe', version: '1.0.0', effect: 'observe', inputSchema: {}, outputSchema: {}, requiredAuthority: 'observe' }]
    }])
    const snapshot = () => ({
      catalog: registry.catalog(), plugins: registry.list(), skills: registry.skillsList(),
      commands: registry.commandsList(), pmo: registry.pmoCapabilitiesList()
    })
    const before = snapshot()
    expect(before.catalog.map(provider => provider.id)).toEqual(['pi'])
    expect(before.plugins.map(plugin => plugin.id)).toEqual(['existing'])
    expect(before.skills.map(skill => skill.id)).toEqual(['existing.skill'])
    expect(before.commands.map(command => command.id)).toEqual(['existing.command'])
    expect(before.pmo.map(capability => capability.id)).toEqual(['existing.observe'])
    const candidate = {
      id: 'candidate', version: '1.0.0', providers: [codex, claude],
      skills: [{ id: 'candidate.skill', name: 'Candidate', description: 'Candidate skill' }],
      commands: [{ id: 'candidate.command', description: 'Candidate command' }],
      pmoCapabilities: [{ id: 'candidate.observe', version: '1.0.0', effect: 'observe' as const, inputSchema: {}, outputSchema: {}, requiredAuthority: 'observe' }]
    }
    const incompleteClaude = { ...claude }
    delete incompleteClaude.planManagedHooks
    expect(() => registry.register({ ...candidate, providers: [codex, incompleteClaude] }))
      .toThrow(expect.objectContaining({ code: 'INVALID_AGENT_PROVIDER' }))
    expect(snapshot()).toEqual(before)
    expect(registry.providers.get('pi')).toBe(pi)
    expect(() => registry.providers.get('codex')).toThrow('Unknown agent provider')

    registry.register(candidate)
    expect(registry.catalog().map(provider => provider.id)).toEqual(['pi', 'codex', 'claude'])
    expect(registry.list().map(plugin => plugin.id)).toEqual(['existing', 'candidate'])
    expect(registry.skillsList().map(skill => skill.id)).toEqual(['existing.skill', 'candidate.skill'])
    expect(registry.commandsList().map(command => command.id)).toEqual(['existing.command', 'candidate.command'])
    expect(registry.pmoCapabilitiesList().map(capability => capability.id)).toEqual(['existing.observe', 'candidate.observe'])
    expect(registry.providers.get('pi')).toBe(pi)
    expect(registry.providers.get('codex')).toBe(codex)
    expect(registry.providers.get('claude')).toBe(claude)
    registry.unregister('candidate')
    expect(snapshot()).toEqual(before)
    expect(registry.providers.get('pi')).toBe(pi)
  })

  it('rejects existing and within-batch duplicate Providers before admitting any new object', () => {
    const builtins = new AgentProviderRegistry()
    const pi = builtins.get('pi'), codex = builtins.get('codex')
    const registry = new AgentMuxPluginRegistry([{ id: 'existing', version: '1.0.0', providers: [pi] }])
    const before = registry.catalog()
    expect(before.map(provider => provider.id)).toEqual(['pi'])
    for (const providers of [[codex, pi], [codex, codex]]) {
      expect(() => registry.register({ id: 'candidate', version: '1.0.0', providers }))
        .toThrow(expect.objectContaining({ code: 'DUPLICATE_PROVIDER' }))
      expect(registry.catalog()).toEqual(before)
      expect(registry.providers.get('pi')).toBe(pi)
      expect(registry.list().map(plugin => plugin.id)).toEqual(['existing'])
    }
    registry.register({ id: 'candidate', version: '1.0.0', providers: [codex] })
    expect(registry.providers.get('codex')).toBe(codex)
    expect(registry.catalog().map(provider => provider.id)).toEqual(['pi', 'codex'])
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
