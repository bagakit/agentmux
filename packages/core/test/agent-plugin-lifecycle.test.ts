import { describe, expect, it } from 'vitest'
import { AgentMuxPluginRegistry } from '../src/agent-plugin.js'

describe('PMO plugin lifecycle', () => {
  it('removes all capability contributions on rollback', () => {
    const registry = new AgentMuxPluginRegistry([{ id: 'candidate', version: '1.0.0', pmoCapabilities: [{ id: 'candidate.act', version: '1.0.0', effect: 'act', inputSchema: {}, outputSchema: {}, requiredAuthority: 'pmo.write' }] }])
    registry.unregister('candidate')
    expect(registry.pmoCapabilitiesList()).toEqual([])
    expect(registry.list()).toEqual([])
  })
})
