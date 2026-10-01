import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { focusFacts } from './fixtures/desktop-focus-facts.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import {
  AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxControlServer, parseAgentMuxControlReceipt,
  parseAgentMuxControlRequest, connectAgentMuxRpc, resolveAgentMuxRegion,
  type AgentMuxAgentRegion, type AgentMuxControlResult, type AgentMuxInspectedRegion, type AgentMuxViewRegion
} from '../src/index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const view: AgentMuxViewRegion = { tabId: 'view:private-tab', regionId: 'private-view-region', workspaceId: 'workspace', kind: 'view' }
const agent: AgentMuxAgentRegion = { tabId: view.tabId, regionId: 'agent-region', workspaceId: view.workspaceId, kind: 'agent', agentSessionId: 'private-agent', providerId: 'codex', executorId: 'private-executor' }
const none = { kind: 'none' } as const
const inspectedView: AgentMuxInspectedRegion = { ...view, bounds: { x: 0, y: 0, width: .5, height: 1 }, neighbors: { left: none, right: { kind: 'region', regionId: agent.regionId }, up: none, down: none } }
const inspectedAgent: AgentMuxInspectedRegion = { ...agent, bounds: { x: .5, y: 0, width: .5, height: 1 }, neighbors: { left: { kind: 'region', regionId: view.regionId }, right: none, up: none, down: none } }
async function endpoint() {
  const root = await mkdtemp(fixturePath("tmp/agentmux-view-control-")); roots.push(root)
  return join(root, 'control.sock')
}

describe('public Control views through the real owner endpoint', () => {
  it('carries a nonempty mixed Tab and separately inspects/focuses a view without hiding its adjacent Agent', async () => {
    const core = await rpcOwnerFixture([agent.agentSessionId])
    const path = join(core.root, 'control.sock'), seen: string[] = []
    const server = new AgentMuxControlServer({ coreClients: core.coreClients, async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request.operation)
      if (request.operation === 'inspect.tab') return { operation: request.operation, tab: { tabId: view.tabId, workspaceId: view.workspaceId, regions: [inspectedView, inspectedAgent] } }
      if (request.operation === 'inspect.region') return { operation: request.operation, region: inspectedView }
      if (request.operation === 'space.inspect') return { operation: request.operation, catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] } }
      if (request.operation === 'list.active-agents') {
        const session = core.client.agentSession(agent.agentSessionId)
        return { operation: request.operation, agents: [{ agentSessionId: session.agentSessionId,
          promptCondition: { expectedRun: session.run, afterSubmissionId: null }, projectId: null, projectName: null,
          workspacePath: session.workspacePath, providerId: session.providerId, executorId: session.executorId,
          processState: 'running', status: 'active', updatedAt: session.updatedAt }] }
      }
      if (request.operation === 'focus') return focusFacts(request)
      if (request.operation === 'send') return { operation: request.operation, agentSessionId: agent.agentSessionId }
      throw new Error('Unexpected private operation')
    } }, path)
    await server.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
    try {
      await expect(client.call('space.inspect', { target: { tabId: view.tabId } })).resolves.toEqual({
        catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
        presentation: { tab: { tabId: view.tabId, workspaceId: view.workspaceId, regions: [inspectedView, inspectedAgent] }, region: null, unavailable: [] }
      })
      await expect(client.call('space.inspect', { target: { regionId: view.regionId } }))
        .resolves.toMatchObject({ presentation: { region: inspectedView, unavailable: [] } })
      await expect(client.call('space.focus', { operationId: 'focus-view', target: { kind: 'space', tabId: view.tabId, regionId: view.regionId }, inputPolicy: 'preserve' }))
        .resolves.toMatchObject({ navigation: { selection: { space: { tabId: view.tabId, regionId: view.regionId } } } })
      await expect(client.call('agent.send', { operationId: 'send-adjacent-agent', target: { kind: 'agent-session', agentSessionId: agent.agentSessionId }, text: 'Continue' }))
        .resolves.toMatchObject({ agentSessionId: agent.agentSessionId, delivery: { state: 'delivered' } })
      expect(seen).toEqual(['inspect.tab', 'space.inspect', 'inspect.region', 'space.inspect', 'focus', 'list.active-agents', 'send'])
      expect(core.inner.kernel.stop).not.toHaveBeenCalled()
      expect(resolveAgentMuxRegion([view, agent], { kind: 'region', regionId: view.regionId })).toEqual(view)
      expect(resolveAgentMuxRegion([view, agent], { kind: 'agent-session', agentSessionId: agent.agentSessionId })).toEqual(agent)
      expect(() => resolveAgentMuxRegion([view, agent], { kind: 'region', regionId: 'missing' })).toThrow('not currently open')
    } finally { await client.dispose(); await server.stop(); await core.close() }
  })

  it('rejects actual malformed view replies while preserving shared identity, bounds and neighbor validation', async () => {
    const path = await endpoint()
    let reply: unknown = inspectedView
    const server = new AgentMuxControlServer({ coreClients: () => [], async execute(request): Promise<AgentMuxControlResult> {
      if (request.operation === 'space.inspect') return { operation: request.operation, catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] } }
      return { operation: request.operation, region: reply } as AgentMuxControlResult
    } }, path)
    await server.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
    try {
      const invalid = [
        { ...inspectedView, kind: 'unknown' }, { ...inspectedView, kind: undefined },
        { ...inspectedView, tabId: '' }, { ...inspectedView, tabId: 'self' }, { ...inspectedView, regionId: 'self' },
        { ...inspectedView, regionId: 'view\nregion' }, { ...inspectedView, workspaceId: '' }, { ...inspectedView, regionId: 'x'.repeat(513) },
        { ...inspectedView, bounds: { x: 0, y: 0, width: 0, height: 1 } },
        { ...inspectedView, bounds: { x: .8, y: 0, width: .5, height: 1 } },
        { ...inspectedView, bounds: { x: Number.NaN, y: 0, width: .5, height: 1 } },
        { ...inspectedView, neighbors: undefined },
        { ...inspectedView, neighbors: { ...inspectedView.neighbors, right: { kind: 'region', regionId: 'self' } } }
      ]
      expect(invalid).toHaveLength(13)
      for (let index = 0; index < invalid.length; index += 1) {
        reply = invalid[index]
        await expect(client.call('space.inspect', { target: { regionId: view.regionId } })).resolves.toMatchObject({
          presentation: { region: null, tab: null, unavailable: [{ code: 'CONTROL_PROTOCOL_ERROR' }] }
        })
      }
      reply = inspectedView
      await expect(client.call('space.inspect', { target: { regionId: view.regionId } })).resolves.toMatchObject({ presentation: { region: inspectedView, unavailable: [] } })
    } finally { await client.dispose(); await server.stop() }
  })

  it('returns only the generic public view shape and does not add domain fields or new open/send operations', () => {
    const receipt = parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'generic-view', ok: true, operation: 'inspect.region', result: { region: { ...inspectedView, path: fixturePath("domain-owned-path"), comparison: { domain: 'private-host-data' }, runId: 'not-a-runtime-view' } } })
    expect(receipt).toEqual({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'generic-view', ok: true, operation: 'inspect.region', result: { region: inspectedView } })
    expect(() => parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'no-open-view', operation: 'open.view', destination: { kind: 'tab', workspaceId: 'workspace' } })).toThrow()
    expect(() => parseAgentMuxControlRequest({ promptCondition: { expectedRun: { runId: 'control-run' }, afterSubmissionId: null },  schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'no-view-target', operation: 'send', target: { kind: 'view', regionId: view.regionId }, text: 'Unsupported target' })).toThrow()
    const address = { spaceId: 'space', zoneId: 'zone', workspaceId: view.workspaceId, displayWorkspaceId: view.workspaceId,
      groupId: 'group', tabId: view.tabId, regionId: agent.regionId }
    const opened = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'no-agent-view', ok: true, operation: 'agent.open', result: {
      requestId: 'no-agent-view', outcome: 'opened', from: null, to: address,
      agent: { agentSessionId: agent.agentSessionId, runId: 'control-run', providerId: agent.providerId, executorId: agent.executorId,
        hostId: 'local', cwd: fixturePath("synthetic"), createOperationId: 'no-agent-view', initialPrompt: 'not-requested' },
      resource: null, save: { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null }, issues: []
    } }
    expect(parseAgentMuxControlReceipt(opened)).toEqual(opened)
    expect(() => parseAgentMuxControlReceipt({ ...opened, result: { ...opened.result, agent: view } })).toThrow('Settings resource JSON')
    const catalog = { spaces: [], zones: [], tabs: [], bindings: [], locations: [],
      regions: [{ tabId: address.tabId, regionId: address.regionId, kind: 'file', agentSessionId: null, runId: null, execution: null }] }
    const listed = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'generic-space-view', ok: true, operation: 'space.ls', result: { catalog } }
    expect(parseAgentMuxControlReceipt(listed)).toEqual(listed)
    expect(() => parseAgentMuxControlReceipt({ ...listed, result: { catalog: { ...catalog, regions: [{ ...catalog.regions[0], kind: 'view' }] } } })).toThrow('Region kind')
  })
})
