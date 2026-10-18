import { describe, expect, it, vi } from 'vitest'
import { parseBrowserControl, parseBrowserTargetsResult } from '../../../packages/core/src/control-browser-targets.js'
import { browserAgentAuthority, parseBrowserControlHandoff } from '../src/main/browser-agent-authority.js'
import { browserColdDescriptor, coldBrowserTargets } from '../src/main/browser-cold-descriptor.js'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'

const identity = { hostId: 'core-host', agentSessionId: 'core-agent' }
const control = { owner: 'human', activeOperationId: null, revision: 0, inputIsolation: 'inactive' }

describe('Browser exact Agent facts at Core and cold resource boundaries', () => {
  it('retains exact, none and absent facts and refuses malformed or secret-bearing Agent associations', () => {
    expect(parseBrowserControl({ ...control, agent: identity })).toEqual({ ...control, agent: identity })
    expect(parseBrowserControl({ ...control, agent: null })).toEqual({ ...control, agent: null })
    expect(parseBrowserControl(control)).not.toHaveProperty('agent')
    for (const agent of ['', [], false, {}, { ...identity, hostId: '' }, { ...identity, agentSessionId: '' }, { ...identity, capability: 'secret' }]) {
      expect(() => parseBrowserControl({ ...control, agent })).toThrow()
    }
  })

  it('uses original Core retained identities for one exact subject and preserves unknown on missing or ambiguous authority', async () => {
    const first = { agentSession: vi.fn(id => { if (id !== identity.agentSessionId) throw new Error('Unknown Session'); return { agentSessionId: id } }) }
    const second = { agentSession: vi.fn(() => { throw new Error('Other Host has no such Session') }) }
    const agentCreation = vi.fn(async (hostId, agentSessionId) => ({ kind: 'agent', hostId, agentSessionId, run: { runId: 'exact-run' } }))
    const runtime = { rpcClients: () => [{ hostId: identity.hostId, client: first }, { hostId: 'other-host', client: second }], agentCreation }
    const authority = browserAgentAuthority(runtime as never)
    expect(authority.resolve(identity.agentSessionId)).toEqual(identity)
    expect(authority.resolve('missing')).toBeUndefined()
    expect(await authority.inspect(identity)).toMatchObject({ ...identity, run: { runId: 'exact-run' } })
    expect(agentCreation).toHaveBeenCalledExactlyOnceWith(identity.hostId, identity.agentSessionId)
    second.agentSession.mockImplementation(() => ({ agentSessionId: identity.agentSessionId }) as never)
    expect(authority.resolve(identity.agentSessionId)).toBeUndefined()
    expect(first.agentSession.mock.calls.every(([id]) => id === identity.agentSessionId || id === 'missing')).toBe(true)
  })

  it('strictly parses the exact handoff with original Run without a client approval field', () => {
    const input = { agent: { kind: 'agent', ...identity, run: { runId: 'exact-run' } }, navigationId: 'exact-navigation', expectedRevision: 3 }
    expect(parseBrowserControlHandoff(input)).toEqual(input)
    for (const extra of [{ ...input, authorHuman: true }, { ...input, agent: { ...input.agent, capability: 'secret' } },
      { ...input, agent: { ...input.agent, run: { runId: 'exact-run', pid: 3 } } }, { ...input, expectedRevision: -1 }]) {
      expect(() => parseBrowserControlHandoff(extra)).toThrow('exact Browser')
    }
  })

  it('preserves durable association without restoring permission and keeps a malformed optional association nonblocking', () => {
    const graph = { regions: [{ kind: 'browser', browserId: 'browser', regionId: 'region', tabId: 'tab' }],
      tabs: [{ tabId: 'tab', regionIds: ['region'] }], resources: { 'region:region': { browserId: 'browser', workspaceId: 'workspace', url: 'https://example.invalid/', title: 'Saved', agent: identity } } } as unknown as AgentMuxSpatialGraph
    expect(browserColdDescriptor(graph, 'browser').agent).toEqual(identity)
    const [target] = coldBrowserTargets(graph, [])
    expect(target?.control).toEqual({ owner: 'unknown', activeOperationId: null, revision: 0, inputIsolation: 'unconfirmed', agent: identity })
    expect(parseBrowserTargetsResult({ targets: [target], coverage: 'complete' }).targets[0]?.control?.agent).toEqual(identity)
    const data = graph.resources['region:region'] as Record<string, any>
    delete data.agent
    expect(browserColdDescriptor(graph, 'browser')).not.toHaveProperty('agent')
    data.agent = { ...identity, capability: 'must-not-be-persisted' }
    const invalid = browserColdDescriptor(graph, 'browser')
    expect(invalid).toMatchObject({ id: 'browser', url: data.url, warning: expect.stringContaining('association is unconfirmed') })
    expect(invalid).not.toHaveProperty('agent')
    expect(coldBrowserTargets(graph, [])[0]?.warning).toContain('association is unconfirmed')
  })
})
