import { describe, expect, it } from 'vitest'
import { AgentMuxPluginRegistry } from '../src/agent-plugin.js'

describe('PMO plugin capability manifest', () => {
  it('discovers effect, authority, and schemas', () => {
    const registry = new AgentMuxPluginRegistry([{ id: 'pmo', version: '1.0.0', pmoCapabilities: [{ id: 'pmo.observe', version: '1.0.0', effect: 'observe', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, requiredAuthority: 'pmo.read' }] }])
    expect(registry.pmoCapabilitiesList()[0]).toMatchObject({ id: 'pmo.observe', effect: 'observe', requiredAuthority: 'pmo.read' })
  })
})
