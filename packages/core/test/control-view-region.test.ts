import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxControlServer, parseAgentMuxControlReceipt,
  parseAgentMuxControlRequest, requestAgentMuxControl, resolveAgentMuxRegion,
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
  const root = await mkdtemp('/tmp/agentmux-view-control-'); roots.push(root)
  return join(root, 'control.sock')
}

describe('public Control views through the real owner endpoint', () => {
  it('carries a nonempty mixed Tab and separately inspects/focuses a view without hiding its adjacent Agent', async () => {
    const path = await endpoint(), seen: string[] = []
    const server = new AgentMuxControlServer({ async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request.operation)
      if (request.operation === 'inspect.tab') return { operation: request.operation, tab: { tabId: view.tabId, workspaceId: view.workspaceId, regions: [inspectedView, inspectedAgent] } }
      if (request.operation === 'inspect.region') return { operation: request.operation, region: inspectedView }
      if (request.operation === 'focus') return { operation: request.operation, tabId: view.tabId, regionId: view.regionId }
      if (request.operation === 'send') return { operation: request.operation, agentSessionId: agent.agentSessionId }
      throw new Error('Unexpected private operation')
    } }, path)
    await server.start()
    try {
      await expect(requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'inspect-mixed-tab', operation: 'inspect.tab', target: { kind: 'tab', tabId: view.tabId } }, path)).resolves.toEqual({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'inspect-mixed-tab', ok: true, operation: 'inspect.tab', result: { tab: { tabId: view.tabId, workspaceId: view.workspaceId, regions: [inspectedView, inspectedAgent] } }
      })
      await expect(requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'inspect-view', operation: 'inspect.region', target: { kind: 'region', regionId: view.regionId } }, path)).resolves.toMatchObject({ operation: 'inspect.region', result: { region: inspectedView } })
      await expect(requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'focus-view', operation: 'focus', target: { kind: 'region', regionId: view.regionId } }, path)).resolves.toMatchObject({ operation: 'focus', result: { tabId: view.tabId, regionId: view.regionId } })
      await expect(requestAgentMuxControl({ promptCondition: { expectedRun: { runId: 'control-run' }, afterSubmissionId: null },  schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'send-adjacent-agent', operation: 'send', target: { kind: 'agent-session', agentSessionId: agent.agentSessionId }, text: 'Continue' }, path)).resolves.toMatchObject({ operation: 'send', result: { agentSessionId: agent.agentSessionId } })
      expect(seen).toEqual(['inspect.tab', 'inspect.region', 'focus', 'send'])
      expect(resolveAgentMuxRegion([view, agent], { kind: 'region', regionId: view.regionId })).toEqual(view)
      expect(resolveAgentMuxRegion([view, agent], { kind: 'agent-session', agentSessionId: agent.agentSessionId })).toEqual(agent)
      expect(() => resolveAgentMuxRegion([view, agent], { kind: 'region', regionId: 'missing' })).toThrow('not currently open')
    } finally { await server.stop() }
  })

  it('rejects actual malformed view replies while preserving shared identity, bounds and neighbor validation', async () => {
    const path = await endpoint()
    let reply: unknown = inspectedView
    const server = new AgentMuxControlServer({ async execute(request): Promise<AgentMuxControlResult> {
      return { operation: request.operation, region: reply } as AgentMuxControlResult
    } }, path)
    await server.start()
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
        await expect(requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: `malformed-${index}`, operation: 'inspect.region', target: { kind: 'region', regionId: view.regionId } }, path)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      }
      reply = inspectedView
      await expect(requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'view-still-valid', operation: 'inspect.region', target: { kind: 'region', regionId: view.regionId } }, path)).resolves.toMatchObject({ result: { region: inspectedView } })
    } finally { await server.stop() }
  })

  it('returns only the generic public view shape and does not add domain fields or new open/send operations', () => {
    const receipt = parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'generic-view', ok: true, operation: 'inspect.region', result: { region: { ...inspectedView, path: '/domain-owned-path', comparison: { domain: 'private-host-data' }, runId: 'not-a-runtime-view' } } })
    expect(receipt).toEqual({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'generic-view', ok: true, operation: 'inspect.region', result: { region: inspectedView } })
    expect(() => parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'no-open-view', operation: 'open.view', destination: { kind: 'tab', workspaceId: 'workspace' } })).toThrow()
    expect(() => parseAgentMuxControlRequest({ promptCondition: { expectedRun: { runId: 'control-run' }, afterSubmissionId: null },  schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'no-view-target', operation: 'send', target: { kind: 'view', regionId: view.regionId }, text: 'Unsupported target' })).toThrow()
    expect(() => parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'no-agent-view', ok: true, operation: 'open.agent', result: { region: view } })).toThrow()
  })
})
