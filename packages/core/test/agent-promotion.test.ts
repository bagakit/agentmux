import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { associatePromotedAgent, parseAgentPromotionParams, parseAgentPromotionResult,
  type AgentPromotionApply, type AgentPromotionReceipt, type AgentPromotionPort, type PromotedAgentAssociation } from '../src/agent-promotion.js'
import { createWorkbenchViewLayout, createWorkspaceLayout } from '../src/spatial-layout.js'
import { parseAgentMuxSpatialGraph, spatialCatalog, type AgentMuxSpatialGraph } from '../src/spatial-graph.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const closes: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
const target = { hostId: 'local', agentSessionId: 'original' }
const source = { hostId: 'local', sessionId: 'original', displayWorkspaceId: 'project', groupId: 'source-group', tabId: 'source-tab', regionId: 'source-region' }
const conversation = { ...source, displayWorkspaceId: 'scratch', groupId: 'scratch-group', tabId: 'mote-tab', regionId: 'mote-region' }
const input: AgentPromotionApply = { target, source, title: 'A lasting collaborator', operationId: 'promotion-original', destination: { kind: 'new-club' } }
const receipt = (): AgentPromotionReceipt => ({ ...input, topicId: 'promoted-topic', moteSpaceId: 'mote', zoneId: 'mote-home',
  directoryPath: '/data/motes/collaborator', conversation, state: 'complete', stage: 'complete', diskDurability: 'confirmed', unavailable: [] })
const discovery = { pending: [], clubs: [], memberships: [], nextCursor: null, issue: null }
const association: PromotedAgentAssociation = { source, conversation, spaceId: 'mote', zoneId: 'mote-home', workspaceId: 'scratch', hostId: 'local',
  directoryPath: '/data/motes/collaborator', title: input.title, topicId: 'promoted-topic', session: { agentSessionId: 'original', runId: 'healthy-run', hostId: 'local', runtimeId: 'original-runtime', cwd: '/project' } }
function graph(): AgentMuxSpatialGraph {
  return { spaces: [
    { spaceId: 'project', kind: 'folder', name: 'Project', hostId: 'local', directoryPath: '/project', projectId: 'project' },
    { spaceId: 'mote', kind: 'mote', name: input.title, topicId: 'promoted-topic', hostId: 'local', directoryPath: association.directoryPath, projectId: null }
  ], zones: [
    { zoneId: 'project-zone', workspaceId: 'project', kind: 'directory', hostId: 'local', directoryPath: '/project', branch: null },
    { zoneId: 'mote-home', workspaceId: 'scratch', kind: 'home', hostId: 'local', directoryPath: association.directoryPath, branch: null }
  ], bindings: [{ spaceId: 'project', zoneId: 'project-zone' }, { spaceId: 'mote', zoneId: 'mote-home' }],
    tabs: [{ tabId: 'source-tab', workspaceId: 'project', zoneId: 'project-zone', name: 'Original', regionIds: ['source-region'] },
      { tabId: 'neighbor-tab', workspaceId: 'project', zoneId: 'project-zone', name: 'Neighbor', regionIds: ['neighbor-region'] },
      { tabId: 'scratch-tab', workspaceId: 'scratch', zoneId: null, name: 'Current work', regionIds: ['scratch-region'] }],
    regions: [{ tabId: 'source-tab', regionId: 'source-region', kind: 'agent', agentSessionId: 'original', runId: 'healthy-run', execution: { hostId: 'local', cwd: '/project', runtimeId: 'original-runtime' } },
      { tabId: 'neighbor-tab', regionId: 'neighbor-region', kind: 'agent', agentSessionId: 'neighbor', runId: 'neighbor-run', execution: { hostId: 'local', cwd: '/project', runtimeId: 'original-runtime' } },
      { tabId: 'scratch-tab', regionId: 'scratch-region', kind: 'launcher', agentSessionId: null, runId: null, execution: null }],
    layouts: { project: createWorkspaceLayout('source-group', ['source-tab', 'neighbor-tab']), scratch: createWorkspaceLayout('scratch-group', ['scratch-tab']) },
    tabLayouts: { 'source-tab': createWorkbenchViewLayout('source-region'), 'neighbor-tab': createWorkbenchViewLayout('neighbor-region'), 'scratch-tab': createWorkbenchViewLayout('scratch-region') },
    resources: { 'tab:source-tab': { titleRegionId: 'source-region' }, 'tab:neighbor-tab': { titleRegionId: 'neighbor-region' },
      'region:source-region': { workspaceId: 'project', phase: 'attached', pendingDraft: 'Do not copy this', agentPresentation: { sessionId: 'original', agentSessionId: 'original', hostId: 'local' } } } }
}

it('adds only the original Session to its independent Mote home, retaining original workfaces and current focus', () => {
  const before = graph(), after = associatePromotedAgent(before, association)
  expect(parseAgentMuxSpatialGraph(after)).toEqual(after)
  expect(before.regions).toHaveLength(3)
  expect(after.regions.slice(0, 3)).toEqual(before.regions)
  expect(after.tabs.slice(0, 3)).toEqual(before.tabs)
  expect(after.bindings).toEqual(before.bindings)
  expect(after.layouts.project).toEqual(before.layouts.project)
  expect(after.layouts.scratch!.groups[0]!.activeTabId).toBe('scratch-tab')
  expect(after.layouts.scratch!.groups[0]!.recentTabIds).toEqual(['scratch-tab'])
  expect(after.layouts.scratch!.groups[0]!.tabOrder).toEqual(['scratch-tab', 'mote-tab'])
  const mote = spatialCatalog(after, { spaceId: 'mote' })
  expect(mote.regions.map(region => region.agentSessionId)).toEqual(['original'])
  expect(mote.regions[0]!.execution).toEqual({ hostId: 'local', cwd: '/project', runtimeId: 'original-runtime' })
  expect(mote.regions[0]!.runId).toBe('healthy-run')
  expect(after.resources['region:mote-region']).not.toHaveProperty('pendingDraft')
  expect(associatePromotedAgent(after, association)).toEqual(after)
})

it('refuses only the changed source or destination and never adopts an entire Topic or Mote', () => {
  const organized = graph(); organized.spaces[0]!.kind = 'topic'
  expect(() => associatePromotedAgent(organized, association)).toThrow(expect.objectContaining({ code: 'AGENT_PROMOTION_ORGANIZED_SOURCE' }))
  const wrong = graph(); wrong.regions[0]!.agentSessionId = 'another'
  expect(() => associatePromotedAgent(wrong, association)).toThrow(expect.objectContaining({ code: 'AGENT_PROMOTION_SOURCE_UNCONFIRMED' }))
  const attached = associatePromotedAgent(graph(), association)
  attached.regions.at(-1)!.agentSessionId = 'replacement'
  expect(() => associatePromotedAgent(attached, association)).toThrow(expect.objectContaining({ code: 'AGENT_PROMOTION_TARGET_CHANGED' }))
  expect(attached.regions[0]!.agentSessionId).toBe('original')
})

it('keeps the original execution Runtime through a local or remote promotion and refuses a changed or missing remote identity', () => {
  const changed = graph(); changed.regions[0]!.execution!.runtimeId = 'another-runtime'
  expect(() => associatePromotedAgent(changed, association)).toThrow(expect.objectContaining({ code: 'AGENT_PROMOTION_SOURCE_UNCONFIRMED' }))
  const legacy = graph(); delete legacy.regions[0]!.execution!.runtimeId
  expect(associatePromotedAgent(legacy, association).regions.at(-1)!.execution!.runtimeId).toBe('original-runtime')
  const remote = graph(); remote.regions[0]!.execution!.hostId = 'remote-host'
  const input = { ...association, source: { ...source, hostId: 'remote-host' }, conversation: { ...conversation, hostId: 'remote-host' },
    session: { ...association.session, hostId: 'remote-host' } }
  expect(associatePromotedAgent(remote, input).regions.at(-1)!.execution).toEqual({ hostId: 'remote-host', cwd: '/project', runtimeId: 'original-runtime' })
  delete remote.regions[0]!.execution!.runtimeId
  expect(() => associatePromotedAgent(remote, input)).toThrow(expect.objectContaining({ code: 'AGENT_PROMOTION_SOURCE_UNCONFIRMED' }))
})

it('binds codecs to the same exact source, operation, principal target and complete receipt facts', () => {
  expect(parseAgentPromotionParams('agent.promote.apply', input)).toEqual(input)
  expect(() => parseAgentPromotionParams('agent.promote.apply', { ...input, source: { ...source, sessionId: 'foreign' } })).toThrow()
  expect(() => parseAgentPromotionParams('agent.promote.inspect', { target, actor: { kind: 'user' } })).toThrow()
  expect(parseAgentPromotionResult('agent.promote.apply', { promotion: receipt() }, input)).toEqual({ promotion: receipt() })
  const foreign = receipt(); foreign.target = { ...target, hostId: 'foreign' }; foreign.source = { ...source, hostId: 'foreign' }; foreign.conversation = { ...conversation, hostId: 'foreign' }
  expect(() => parseAgentPromotionResult('agent.promote.inspect', { promotion: foreign, discovery: null }, { target, operationId: input.operationId })).toThrow()
  expect(() => parseAgentPromotionResult('agent.promote.apply', { promotion: { ...receipt(), diskDurability: 'unconfirmed' } }, input)).toThrow()
  expect(() => parseAgentPromotionResult('agent.promote.apply', { promotion: null }, input)).toThrow()
  expect(parseAgentPromotionResult('agent.promote.inspect', { promotion: null, discovery }, { target })).toEqual({ promotion: null, discovery })
})

it('requires an explicit typed destination and separates exact history from bounded discovery', () => {
  const home = { spaceId: 'mote', zoneId: 'mote-home', expectedResource: { hostId: 'local', workspaceId: 'scratch', workspacePath: '/data' } }
  const joined = { ...input, destination: { kind: 'existing-club' as const, target: home } }
  expect(parseAgentPromotionParams('agent.promote.apply', joined)).toEqual(joined)
  const { destination: _destination, ...missing } = input
  for (const invalid of [missing, { ...input, destination: { kind: 'new-club', target: home } }, { ...input, destination: { kind: 'existing-club' } }])
    expect(() => parseAgentPromotionParams('agent.promote.apply', invalid)).toThrow()
  expect(() => parseAgentPromotionParams('agent.promote.inspect', { target, operationId: input.operationId, cursor: 'cursor' })).toThrow()
  expect(() => parseAgentPromotionResult('agent.promote.inspect', { promotion: receipt(), discovery: null }, { target })).toThrow()
  expect(() => parseAgentPromotionResult('agent.promote.inspect', { promotion: null, discovery }, { target, operationId: input.operationId })).toThrow()
  const choice = { title: 'Same title', directoryPath: '/data/club', target: home }
  const partial = { ...receipt(), state: 'partial', stage: 'spatial' }
  const found = { pending: [partial], clubs: [choice], memberships: [{ ...choice, main: null }], nextCursor: 'cursor', issue: 'Original Main unavailable.\nMembership remains readable.' }
  expect(parseAgentPromotionResult('agent.promote.inspect', { promotion: null, discovery: found }, { target })).toEqual({ promotion: null, discovery: found })
  expect(() => parseAgentPromotionResult('agent.promote.inspect', { promotion: null, discovery: { ...found, pending: [receipt()] } }, { target })).toThrow()
  expect(() => parseAgentPromotionResult('agent.promote.inspect', { promotion: null, discovery: { ...found, memberships: [{ ...choice, main: 'unknown' }] } }, { target })).toThrow()
  expect(() => parseAgentPromotionResult('agent.promote.apply', { promotion: { ...receipt(), destination: joined.destination } }, input)).toThrow()
  expect(() => parseAgentPromotionResult('agent.promote.apply', { promotion: { ...receipt(), destination: joined.destination, stage: 'main' } }, joined)).toThrow()
})

it('the actual Unix SDK and CLI parser use the narrow promotion owner and retain the original trusted actor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-promotion-core-')); closes.push(() => rm(root, { recursive: true, force: true }))
  const calls = vi.fn(async (..._args: unknown[]) => ({ promotion: receipt() }))
  const forward = vi.fn(async () => ({ promotion: receipt() }))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), coreClients: () => [],
    agentPromotions: { call: calls } as AgentPromotionPort, forwardControl: forward as never })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'rpc.sock') } }); closes.push(() => rpc.dispose())
  const path = join(root, 'input.json'); await writeFile(path, JSON.stringify(input))
  const parsed = await parseAgentMuxCliInvocation(['agent', 'promote', 'apply', '--input', path])
  expect(parsed.command.method).toBe('agent.promote.apply'); expect(parsed.params).toEqual(input)
  expect(await rpc.call('agent.promote.apply', input)).toEqual({ promotion: receipt() })
  expect(calls).toHaveBeenCalledTimes(1); expect(forward).not.toHaveBeenCalled()
  expect(calls.mock.calls[0]![2]).toEqual(expect.objectContaining({ principal: expect.objectContaining({ kind: 'user' }) }))
})

it('only the person/device can establish a Mote role; authenticated Agents can inspect only their own retained operation', async () => {
  const fixture = await rpcOwnerFixture(['original', 'neighbor']); closes.push(() => fixture.close())
  const calls = vi.fn(async (..._args: unknown[]) => ({ promotion: receipt(), discovery: null }))
  const owner = new AgentMuxRpcService({ coreClients: fixture.coreClients, agentPromotions: { call: calls } as AgentPromotionPort })
  await expect(owner.call('agent.promote.apply', input, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const context = { caller: fixture.credentials, principal: { kind: 'user' as const, id: 'claimed-user' } }
  await expect(owner.call('agent.promote.apply', input, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(await owner.call('agent.promote.inspect', { target, operationId: input.operationId }, context)).toEqual({ promotion: receipt(), discovery: null })
  await expect(owner.call('agent.promote.inspect', { target: { ...target, agentSessionId: 'neighbor' } }, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(calls).toHaveBeenCalledTimes(1)
})
