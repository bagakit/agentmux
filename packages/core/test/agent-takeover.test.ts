import { createTakeoverOwnerFixture } from './helpers/takeover-owner.js'
import { afterEach, expect, it, vi } from 'vitest'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fixtureIso } from '../../../test/fixture-values.mjs'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { creationInputOwner } from './helpers/creation-input-owner.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { AgentMuxError } from '../src/errors.js'
import { parseAgentTakeoverProvenance, agentTakeoverNature } from '../src/agent-takeover.js'
import { runSourceObjectCli as originalSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
const sourceLoader = new URL('./fixtures/agent-takeover-source-loader.mjs', import.meta.url)
const takeoverEnvironment = (root: string) => objectCliEnvironment(root, Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENTMUX_TEST_TAKEOVER_'))))
const runSourceObjectCli: typeof originalSourceObjectCli = (args, env, stdin, timeout) => originalSourceObjectCli(args, env, stdin, timeout, sourceLoader)
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const fixture = () => createTakeoverOwnerFixture(cleanup)

it('actual public SDK reaches the original Host creator with an explicit display/group and freezes new identity without touching the source', async () => {
  const f = await fixture(), before = (await f.spatial.read())!.graph
  const input = { operationId: 'original-takeover-intent', content: { kind: 'takeover-agent' as const, executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, expectedRun: f.source.run, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } },
    destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, displayWorkspaceId: 'project-a', groupId: 'original-group', newTab: true }, focus: false }
  const result = await f.rpc.call('agent.open', input)
  expect(result.outcome, JSON.stringify(result)).toBe('opened'); expect(f.started).toHaveLength(1)
  expect(result.agent!.agentSessionId).not.toBe(f.source.agentSessionId); expect(result.agent!.takeover).toMatchObject({ nature: 'transfer', source: { agentSessionId: f.source.agentSessionId, runtimeId: f.owner.runtimeId }, destination: { address: result.to } })
  expect(f.started[0].cwd).toBe(f.directory)
  const after = (await f.spatial.read())!.graph
  expect(after.tabs.find(t => t.tabId === 'original-tab')).toEqual(before.tabs[0]); expect(after.regions.find(r => r.regionId === 'original-region')).toEqual(before.regions[0]); expect(after.resources['region:original-region']).toEqual(before.resources['region:original-region'])
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
  const created = await f.client.readAgentSession(result.agent!.agentSessionId)
  expect(created!.creation!.takeover).toEqual(result.agent!.takeover); expect(created!.creation!.createdBy).toBeUndefined(); expect(created!.forkedFrom).toBeUndefined()
  expect((await f.rpc.call('agent.open', input)).agent!.agentSessionId).toBe(created!.agentSessionId); expect(f.started).toHaveLength(1)
  await expect(f.rpc.call('agent.open', { ...input, destination: { ...input.destination, zoneId: f.a.zoneId } })).rejects.toMatchObject({ code: 'SPACE_REQUEST_CONFLICT' })
})
it('the actual CLI parser supplies the same typed source and cannot submit a nature or authored takeover prompt', async () => {
  const f = await fixture(), source = { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } }
  const path = join(f.root, 'source.json'); await writeFile(path, JSON.stringify(source))
  const parsed = await parseAgentMuxCliInvocation(['agent', 'open', '--executor', 'codex', '--takeover-source', path, '--operation-id', 'cli-takeover-intent', '--space', f.b.spaceId, '--zone', f.b.zoneId, '--new-tab', '--display-workspace', 'project-a', '--group', 'original-group'])
  expect(parsed.params.content).toMatchObject({ kind: 'takeover-agent', source })
  const result = await f.rpc.call('agent.open', parsed.params as never); expect(result.agent!.takeover!.nature).toBe('transfer')
  expect(parseAgentTakeoverProvenance(result.agent!.takeover)).toEqual(result.agent!.takeover)
  expect(agentTakeoverNature(null, null)).toBeNull()
})
it.each(['zone', 'region'] as const)('disabled Promotion cannot be bypassed through an exact %s target without a caller Space ID', async mode => {
  const f = await fixture(), state = (await f.spatial.read())!, graph = state.graph
  Object.assign(graph.spaces.find(space => space.spaceId === f.b.spaceId)!, { kind: 'mote', topicId: 'original-target-club', projectId: null })
  if (mode === 'region') {
    graph.tabs.push({ tabId: 'empty-target-tab', workspaceId: 'project-b', zoneId: f.b.zoneId, name: null, regionIds: ['empty-target-region'] })
    graph.regions.push({ tabId: 'empty-target-tab', regionId: 'empty-target-region', kind: 'launcher', agentSessionId: null, runId: null, execution: null })
    graph.tabLayouts['empty-target-tab'] = { root: { type: 'leaf', regionId: 'empty-target-region' }, activeRegionId: 'empty-target-region' }
    graph.resources['tab:empty-target-tab'] = { titleRegionId: 'empty-target-region' }; graph.resources['region:empty-target-region'] = { draft: 'Do not send this.' }
    graph.layouts['project-a']!.groups[0]!.tabOrder.push('empty-target-tab')
  }
  await f.spatial.commit({ expectedRevision: state.revision, graph }); await writeFile(f.configurationPath, JSON.stringify({ promotion: { enabled: false } }))
  const destination = mode === 'zone' ? { zoneId: f.b.zoneId, displayWorkspaceId: 'project-a', groupId: 'original-group', newTab: true }
    : { tabId: 'empty-target-tab', regionId: 'empty-target-region', displayWorkspaceId: 'project-a', groupId: 'original-group' }
  await expect(f.rpc.call('agent.open', { operationId: 'disabled-target-' + mode, content: { kind: 'takeover-agent', executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } }, destination, focus: false })).rejects.toMatchObject({ code: 'PROMOTION_DISABLED' })
  expect(f.started).toHaveLength(0); expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
  expect((await f.spatial.read())!.graph.resources['core:agent-open']).toBeUndefined()
})
it('a category display selector cannot hide the actual Club membership of its promoted Topic Zone', async () => {
  const f = await fixture(), state = (await f.spatial.read())!, graph = state.graph
  const club = graph.spaces.find(space => space.spaceId === f.b.spaceId)!
  Object.assign(club, { kind: 'mote', topicId: 'original-club', projectId: null })
  const { topicId: _topic, ...container } = club
  graph.spaces.push({ ...container, spaceId: 'original-category', kind: 'container' })
  graph.bindings.push({ spaceId: 'original-category', zoneId: f.b.zoneId })
  await f.spatial.commit({ expectedRevision: state.revision, graph }); await writeFile(f.configurationPath, JSON.stringify({ promotion: { enabled: false } }))
  const input = { operationId: 'category-alias', content: { kind: 'takeover-agent' as const, executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } }, destination: { spaceId: 'original-category', zoneId: f.b.zoneId, newTab: true }, focus: false }
  await expect(f.rpc.call('agent.open', input)).rejects.toMatchObject({ code: 'PROMOTION_DISABLED' })
  expect(f.started).toHaveLength(0)
  await writeFile(f.configurationPath, JSON.stringify({ promotion: { enabled: true } }))
  const result = await f.rpc.call('agent.open', input)
  expect(result.outcome, JSON.stringify(result)).toBe('opened')
  expect(result.to!.spaceId).toBe('original-category')
  expect(result.agent!.takeover).toMatchObject({ nature: 'promotion', destination: { organization: { kind: 'mote', reference: { spaceId: f.b.spaceId } } } })
  expect(await f.spatial.readSpaceAgentMembership({ spaceId: f.b.spaceId, hostId: 'local', agentSessionId: result.agent!.agentSessionId })).toMatchObject({ member: true })
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})
it.each(['organization', 'membership', 'title', 'policy'] as const)('the final admission rechecks exact %s facts after asynchronous Executor observation', async change => {
  const f = await fixture(), read = f.client.listHostExecutors.bind(f.client)
  if (change === 'policy') { const state = (await f.spatial.read())!, graph = state.graph; Object.assign(graph.spaces.find(space => space.spaceId === f.b.spaceId)!, { kind: 'mote', topicId: 'original-club', projectId: null }); await f.spatial.commit({ expectedRevision: state.revision, graph }) }
  vi.spyOn(f.client, 'listHostExecutors').mockImplementationOnce(async input => {
    const inventory = await read(input), state = (await f.spatial.read())!, graph = state.graph
    if (change === 'organization') Object.assign(graph.spaces.find(space => space.spaceId === f.b.spaceId)!, { kind: 'mote', topicId: 'late-club', projectId: null })
    if (change === 'membership') graph.bindings = graph.bindings.filter(binding => binding.spaceId !== f.a.spaceId)
    if (change === 'title') { graph.spaces.find(space => space.spaceId === f.a.spaceId)!.name = 'Renamed source'; graph.spaces.find(space => space.spaceId === f.b.spaceId)!.name = 'Renamed destination' }
    if (change === 'policy') await writeFile(f.configurationPath, JSON.stringify({ promotion: { enabled: false } }))
    else await f.spatial.commit({ expectedRevision: state.revision, graph })
    return inventory
  })
  const invoke = () => f.rpc.call('agent.open', { operationId: 'final-' + change, content: { kind: 'takeover-agent', executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } }, destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, newTab: true }, focus: false })
  if (change === 'title') { expect((await invoke()).outcome).toBe('opened'); expect(f.started).toHaveLength(1) }
  else { await expect(invoke()).rejects.toMatchObject({ code: change === 'membership' ? 'AGENT_TAKEOVER_SOURCE_CHANGED' : change === 'policy' ? 'PROMOTION_DISABLED' : 'SPACE_TARGET_CHANGED' }); expect(f.started).toHaveLength(0) }
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})
it('public execution and direct/Hosted creation cannot assert a structured Core-confirmed Takeover fact', async () => {
  const f = await fixture()
  const fake = { source: { hostId: 'local', runtimeId: f.owner.runtimeId, agentSessionId: 'unrelated-source', run: null, organization: null },
    destination: { owner: { runtimeId: f.owner.runtimeId }, address: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, workspaceId: 'project-b', displayWorkspaceId: 'project-a', groupId: 'original-group', tabId: 'forged-tab', regionId: 'forged-region' }, organization: null }, nature: null }
  expect(parseAgentTakeoverProvenance(fake)).toEqual(fake)
  const agent = { agentSessionId: 'forged-child', createOperationId: 'forged-operation', executorId: 'codex', executorRevision: (await f.client.listHostExecutors({ refresh: false, executorId: 'codex' })).executors[0]!.configRevision, workspacePath: f.directory, takeover: fake }
  const packet = { bindingId: 'forged-binding', agentHostId: 'local', agentRuntimeId: f.owner.runtimeId, resourceHostId: 'local', resourceRuntimeId: f.owner.runtimeId, resourceWorkspacePath: f.directory, resourceGrant: { scope: 'host-user' as const, bindingId: 'forged-binding' }, agent }
  await expect(f.rpc.call('agent.execution.admit', packet as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.rpc.call('agent.execution.create', packet as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.client.createHostAgentWithDelivery(agent as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const { hostedTestClient } = await import('./helpers/hosted-runtime-port.js'), hosted = await hostedTestClient(f.client); cleanup.push(() => hosted.dispose())
  await expect(hosted.sdk.createHostAgentWithDelivery(agent as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.started).toHaveLength(0)
})
it('a caller cannot select an unrelated real Project as its original source organization', async () => {
  const f = await fixture()
  await expect(f.rpc.call('agent.open', { operationId: 'wrong-source-membership', content: { kind: 'takeover-agent', executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.b.spaceId } } }, destination: { spaceId: f.a.spaceId, zoneId: f.a.zoneId, newTab: true }, focus: false })).rejects.toMatchObject({ code: 'AGENT_TAKEOVER_SOURCE_CHANGED' })
  expect(f.started).toHaveLength(0); expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})
it('an exact source Runtime pin rejects a different real Core even when both contain the same SID and Run', async () => {
  const f = await fixture(), other = await creationInputOwner(); cleanup.push(() => other.close())
  other.inner.creationAuthority = new AgentMuxCreationAuthority({ stateDirectory: join(other.root, 'creation-authority'), runtimeId: 'other-source-core' })
  f.extraClients.push({ hostId: 'selected-source-route', client: other.client })
  const source = (await other.client.readAgentSession('source'))!
  expect(source.agentSessionId).toBe(f.source.agentSessionId); expect(source.run).toEqual(f.source.run)
  const read = vi.spyOn(other.client, 'readAgentSession')
  await expect(f.rpc.call('agent.open', { operationId: 'fenced-source', content: { kind: 'takeover-agent', executorId: 'codex', source: { hostId: 'selected-source-route', expectedRuntimeId: f.owner.runtimeId, agentSessionId: 'source', expectedRun: f.source.run, organization: null } }, destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, newTab: true }, focus: false })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(read).not.toHaveBeenCalled(); expect(f.started).toHaveLength(0); expect(other.started).toHaveLength(0)
  expect(await f.client.readAgentSession('source')).toEqual(f.source); expect(await other.client.readAgentSession('source')).toEqual(source)
})
it('an unavailable original organization route preserves a qualified source and the new Agent with a persistent visible diagnosis', async () => {
  const f = await fixture(), before = (await f.spatial.read())!.graph
  const input = { operationId: 'unknown-source-organization', content: { kind: 'takeover-agent' as const, executorId: 'codex', source: { hostId: 'local', expectedRuntimeId: f.owner.runtimeId, agentSessionId: 'source', organization: { runtimeId: 'original-organization-core', spaceId: 'original-organization' } } }, destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, newTab: true }, focus: false }
  const result = await f.rpc.call('agent.open', input)
  expect(result.outcome).toBe('partial'); expect(result.agent!.takeover).toMatchObject({ nature: null, source: { runtimeId: f.owner.runtimeId, agentSessionId: 'source', organization: null, organizationIssue: expect.stringContaining('no available qualified read route') } })
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'AGENT_TAKEOVER_ORGANIZATION_UNCONFIRMED', step: 'observation' }))
  expect((await f.client.readAgentSession(result.agent!.agentSessionId))!.creation!.takeover).toEqual(result.agent!.takeover)
  const inspected = await f.rpc.call('space.inspect', { target: { operationId: input.operationId } })
  expect(inspected.request!.report!.issues).toContainEqual(expect.objectContaining({ code: 'AGENT_TAKEOVER_ORGANIZATION_UNCONFIRMED' }))
  const page = await f.rpc.call('agent.takeover.ls', { expectedRuntimeId: f.owner.runtimeId, direction: 'outgoing', subject: { runtimeId: f.owner.runtimeId, agentSessionId: 'source' } })
  expect(page.records).toMatchObject([{ phase: 'active', issue: result.agent!.takeover!.source.organizationIssue }])
  expect((await f.spatial.read())!.graph.regions.find(region => region.regionId === 'original-region')).toEqual(before.regions[0]); expect(await f.client.readAgentSession('source')).toEqual(f.source); expect(f.started).toHaveLength(1)
})
it('a remote source organization is qualified through its original public Space snapshot, and a confirmed nonmember is refused', async () => {
  const f = await fixture(), origin = await createTakeoverOwnerFixture(cleanup, { authoritySocketPath: f.endpointPath }), runtimeId = 'remote-source-core'
  origin.owner.runtimeId = runtimeId
  origin.inner.creationAuthority = new AgentMuxCreationAuthority({ stateDirectory: join(origin.root, 'remote-creation-authority'), runtimeId })
  const state = (await origin.spatial.read())!, graph = state.graph
  graph.regions.find(region => region.regionId === 'original-region')!.execution!.runtimeId = runtimeId
  await origin.spatial.commit({ expectedRevision: state.revision, graph })
  // This existing configured Core port carries the actual public subscription;
  // no local graph or another same-SID Session supplies the remote membership.
  Object.assign(origin.client, { subscribeRpc: origin.rpc.subscribe.bind(origin.rpc) })
  f.extraClients.push({ hostId: 'original-source-core', client: origin.client })
  const content = { kind: 'takeover-agent' as const, executorId: 'codex', source: { hostId: 'original-source-core', expectedRuntimeId: runtimeId, agentSessionId: 'source', organization: { runtimeId, spaceId: origin.a.spaceId } } }
  const destination = { spaceId: f.b.spaceId, zoneId: f.b.zoneId, newTab: true }
  const result = await f.rpc.call('agent.open', { operationId: 'remote-qualified-source', content, destination, focus: false })
  expect(result.outcome, JSON.stringify(result)).toBe('opened'); expect(result.agent!.takeover).toMatchObject({ nature: 'transfer', source: { runtimeId, agentSessionId: 'source', organization: { reference: content.source.organization } } })
  await expect(f.rpc.call('agent.open', { operationId: 'remote-known-nonmember', content: { ...content, source: { ...content.source, organization: { runtimeId, spaceId: origin.b.spaceId } } }, destination, focus: false })).rejects.toMatchObject({ code: 'AGENT_TAKEOVER_SOURCE_CHANGED' })
  expect(origin.started).toHaveLength(0); expect(f.started).toHaveLength(1); expect(await origin.client.readAgentSession('source')).toEqual(origin.source)
})
it('actual CLI opens into an explicit display/group and reads both original relation directions without another launch or input', async () => {
  const f = await fixture(), source = { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } }
  const path = join(f.root, 'cli-source.json'); await writeFile(path, JSON.stringify(source))
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.endpointPath, 'agent', 'open', '--executor', 'codex', '--takeover-source', path,
    '--operation-id', 'cli-original-intent', '--space', f.b.spaceId, '--zone', f.b.zoneId, '--new-tab', '--display-workspace', 'project-a', '--group', 'original-group'], takeoverEnvironment(f.root))
  expect(cli.code, cli.stderr + cli.stdout).toBe(0)
  const created = JSON.parse(cli.stdout).result.agent
  const starts = f.started.length, submissions = f.submit.mock.calls.length
  const input = { expectedRuntimeId: f.owner.runtimeId, direction: 'outgoing' as const, subject: { runtimeId: f.owner.runtimeId, agentSessionId: f.source.agentSessionId }, limit: 1 }
  const page = await f.rpc.call('agent.takeover.ls', input)
  expect(page).toMatchObject({ direction: 'outgoing', subject: input.subject, nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-takeovers' }, records: [{ requestId: 'cli-original-intent', phase: 'active', agent: { runtimeId: f.owner.runtimeId, agentSessionId: created.agentSessionId }, takeover: created.takeover }] })
  const read = await runSourceObjectCli(['--endpoint', 'unix:' + f.endpointPath, 'agent', 'takeover', 'ls', '--input', '-'], takeoverEnvironment(f.root), JSON.stringify({ ...input, direction: 'incoming', subject: { runtimeId: f.owner.runtimeId, agentSessionId: created.agentSessionId } }))
  expect(read.code, read.stderr + read.stdout).toBe(0)
  expect(JSON.parse(read.stdout).result.records[0].takeover).toEqual(created.takeover)
  expect(f.started).toHaveLength(starts); expect(f.submit).toHaveBeenCalledTimes(submissions)
})
it('relation pages pin the exact owner and subject, isolate unrelated Sessions and keep a resumable bounded cursor', async () => {
  const f = await fixture()
  for (const operationId of ['relation-a', 'relation-b']) await f.rpc.call('agent.open', { operationId, content: { kind: 'takeover-agent', executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: null } }, destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, newTab: true }, focus: false })
  const read = vi.spyOn(f.client, 'readAgentSession'), input = { expectedRuntimeId: f.owner.runtimeId, direction: 'outgoing' as const, subject: { runtimeId: f.owner.runtimeId, agentSessionId: f.source.agentSessionId }, limit: 1 }
  const first = await f.rpc.call('agent.takeover.ls', input)
  expect(first.records.map(row => row.requestId)).toEqual(['relation-a']); expect(first.nextCursor).toBeTypeOf('string')
  const second = await f.rpc.call('agent.takeover.ls', { ...input, cursor: first.nextCursor! })
  expect(second.records.map(row => row.requestId)).toEqual(['relation-b']); expect(second.nextCursor).toBeNull()
  expect(read.mock.calls.map(args => args[0])).toEqual([first.records[0]!.agent.agentSessionId, second.records[0]!.agent.agentSessionId])
  await expect(f.rpc.call('agent.takeover.ls', { ...input, expectedRuntimeId: 'another-core' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await expect(f.rpc.call('agent.takeover.ls', { ...input, subject: { ...input.subject, agentSessionId: 'neighbor' }, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect((await f.rpc.call('agent.takeover.ls', { ...input, direction: 'incoming' })).records).toEqual([])
  expect(f.started).toHaveLength(2)
})
it('a separate execution Core consumes the original binding through Hosted, while incoming provenance stays at the original admission Core', async () => {
  const f = await fixture(), d = await creationInputOwner(); cleanup.push(() => d.close())
  const executionRuntime = 'original-runtime'
  d.inner.creationAuthority = new AgentMuxCreationAuthority({ stateDirectory: join(d.root, 'creation-authority'), runtimeId: executionRuntime })
  const executors = new AgentMuxHostExecutorOwner({ path: join(d.root, 'executors.json'), runtimeId: executionRuntime, catalog: () => d.client.catalog() })
  await executors.configure({ executorId: 'codex', config: { label: 'Execution executor', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } }); d.inner.hostExecutorOwner = executors
  // Only the Native helper transport is a leaf. The remote Hosted codec, configured
  // creation, File Session store, first-input owner and original C remain real.
  d.inner.prepareToolExecutionLaunch = async (_provider: unknown, plan: unknown) => plan
  const { hostedTestClient } = await import('./helpers/hosted-runtime-port.js'), remote = await hostedTestClient(d.client); cleanup.push(() => remote.dispose())
  expect('createSpatialHostAgentWithDelivery' in remote.sdk).toBe(false)
  f.extraClients.push({ hostId: 'execution-in-source', client: remote.sdk })
  let frozen: import('../src/agent-execution-coordinator.js').AgentExecutionOpenInput | undefined, pending = true, created = false
  const reference = () => ({ bindingId: frozen!.bindingId, agentSessionId: frozen!.agent.agentSessionId, createOperationId: frozen!.agent.createOperationId })
  const bindings = {
    admit: vi.fn(async (input: import('../src/agent-execution-coordinator.js').AgentExecutionOpenInput) => { frozen = structuredClone(input); return reference() }),
    inspect: vi.fn(async (_id: string, view?: string) => !frozen ? null : { bindingId: frozen.bindingId, agentHostId: frozen.agentHostId, resourceHostId: frozen.resourceHostId, agentSessionId: frozen.agent.agentSessionId, resourceWorkspacePath: frozen.resourceWorkspacePath,
      continuation: reference(), state: created ? 'connected' : 'unavailable', ...(view === 'association' ? { association: { state: 'confirmed', reference: reference(), agentRuntimeId: frozen.agentRuntimeId, resourceRuntimeId: frozen.resourceRuntimeId, resourceWorkspacePath: frozen.resourceWorkspacePath, sourceRequestDigest: frozen.sourceRequestDigest,
        agent: { executorId: frozen.agent.executorId, executorRevision: frozen.agent.executorRevision, workspacePath: frozen.agent.workspacePath } } } : {}) }),
    continueOriginal: vi.fn(async () => {
      if (pending) { pending = false; throw new AgentMuxError('The original Native helper is not yet confirmed.', 'EXECUTION_HELPER_UNAVAILABLE') }
      await remote.sdk.createHostAgentWithDelivery({ ...frozen!.agent, toolExecution: { bindingId: frozen!.bindingId, resourceHostId: frozen!.resourceHostId, resourceRuntimeId: frozen!.resourceRuntimeId, workspacePath: frozen!.resourceWorkspacePath } }); created = true
    })
  }
  Object.assign(f.runtime, { executionHost: async () => ({ runtimeId: executionRuntime, client: remote.sdk }), executionBindings: bindings })
  const input = { operationId: 'hosted-takeover', content: { kind: 'takeover-agent' as const, executorId: 'codex', agentTarget: { hostId: 'execution-in-source', runtimeId: executionRuntime }, source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } }, destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, displayWorkspaceId: 'project-a', groupId: 'original-group', newTab: true }, focus: false }
  const initial = await f.rpc.call('agent.open', input)
  expect(initial.outcome).toBe('unknown'); expect(d.started).toHaveLength(0)
  const originalPrompt = frozen!.agent.prompt
  expect(originalPrompt).toContain('not been confirmed in this new Agent’s Core namespace')
  expect(originalPrompt).not.toContain('agent context --host \'local\'')
  // Continuing an accepted C neither re-reads source identity nor today's inventory.
  const sourceRead = vi.spyOn(f.client, 'readAgentSession').mockRejectedValue(Error('Source is temporarily unavailable.'))
  const inventory = vi.spyOn(d.client, 'listHostExecutors').mockRejectedValue(Error('Current inventory cannot replace an admitted target.'))
  const result = await f.rpc.call('agent.open', input)
  expect(result.outcome, JSON.stringify(result)).toBe('opened'); expect(result.agent!.takeover!.nature).toBe('transfer')
  expect(sourceRead).not.toHaveBeenCalled(); expect(inventory).not.toHaveBeenCalled(); expect(f.started).toHaveLength(0); expect(d.started).toHaveLength(1)
  const sid = result.agent!.agentSessionId, child = await d.client.readAgentSession(sid)
  expect(child!.creation!.takeover).toBeUndefined(); expect(child!.toolExecution!.resourceRuntimeId).toBe(f.owner.runtimeId)
  expect(bindings.admit).toHaveBeenCalledTimes(1); expect(frozen!.agent.prompt).toBe(originalPrompt)
  const incoming = await f.rpc.call('agent.takeover.ls', { expectedRuntimeId: f.owner.runtimeId, direction: 'incoming', subject: { runtimeId: executionRuntime, agentSessionId: sid } })
  expect(incoming.records).toMatchObject([{ phase: 'active', agent: { runtimeId: executionRuntime, agentSessionId: sid }, takeover: result.agent!.takeover }])
  expect(incoming.coverage.scope).toBe('selected-owner'); expect(d.started).toHaveLength(1)
})
it('native-only saved sources retain their exact original locator without inventing a managed SID or organization', async () => {
  const f = await fixture(), home = join(f.root, 'native-provider'), directory = join(home, 'sessions')
  await mkdir(directory, { recursive: true })
  const nativeId = '19d557c3-7a9c-4e1f-a566-913c06753520'
  await writeFile(join(directory, 'rollout-original.jsonl'), JSON.stringify({ type: 'session_meta', timestamp: fixtureIso(0), payload: { id: nativeId, cwd: f.root, source: 'cli', timestamp: fixtureIso(0) } }) + '\n')
  await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ id: nativeId, thread_name: 'Original saved work' }) + '\n')
  await f.inner.hostExecutorOwner.configure({ executorId: 'codex', expectedRevision: (await f.client.listHostExecutors({ refresh: false, executorId: 'codex' })).executors[0]!.configRevision, config: { label: 'Native source owner', providerId: 'codex', command: 'codex', args: [], env: { CODEX_HOME: home }, injectAgentMuxGuide: false } })
  const native = await f.client.listHostNativeAgentSessions({ executorId: 'codex', workspacePath: f.root })
  expect(native.sessions).toHaveLength(1)
  const original = native.sessions[0]!.source
  const result = await f.rpc.call('agent.open', { operationId: 'native-only-takeover', content: { kind: 'takeover-agent', executorId: 'codex', source: { hostId: 'local', nativeSource: original, executorId: 'codex', organization: null } }, destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, newTab: true }, focus: false })
  expect(result.outcome, JSON.stringify(result)).toBe('opened')
  expect(result.agent!.takeover).toMatchObject({ source: { agentSessionId: null, run: null, organization: null, nativeSource: original, executorId: 'codex' }, nature: null })
  expect(f.started).toHaveLength(1); expect(await f.client.readAgentSession('source')).toEqual(f.source)
  const inspected = await f.rpc.call('space.inspect', { target: { operationId: 'native-only-takeover' } })
  expect(inspected.request!.report!.agent!.takeover).toEqual(result.agent!.takeover)
  expect((await f.rpc.call('agent.takeover.ls', { expectedRuntimeId: f.owner.runtimeId, direction: 'incoming', subject: { runtimeId: f.owner.runtimeId, agentSessionId: result.agent!.agentSessionId } })).records[0]!.takeover.source.agentSessionId).toBeNull()
})
it.each(['takeover', 'handson', 'transfer'] as const)('original Mote identity computes %s without granting a Main role or requiring Project promotion', async nature => {
  const f = await fixture(), state = (await f.spatial.read())!, graph = state.graph
  Object.assign(graph.spaces.find(space => space.spaceId === f.a.spaceId)!, { kind: 'mote', topicId: 'source-club', projectId: null })
  if (nature === 'transfer') Object.assign(graph.spaces.find(space => space.spaceId === f.b.spaceId)!, { kind: 'mote', topicId: 'destination-club', projectId: null })
  await f.spatial.commit({ expectedRevision: state.revision, graph }); await writeFile(f.configurationPath, JSON.stringify({ promotion: { enabled: false } }))
  const target = nature === 'takeover' ? f.a : f.b
  const result = await f.rpc.call('agent.open', { operationId: 'mote-' + nature, content: { kind: 'takeover-agent', executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } }, destination: { spaceId: target.spaceId, zoneId: target.zoneId, newTab: true }, focus: false })
  expect(result.outcome, JSON.stringify(result)).toBe('opened'); expect(result.agent!.takeover!.nature).toBe(nature)
  expect((await f.client.readAgentSession(result.agent!.agentSessionId))!.creation!.createdBy).toBeUndefined()
  expect(await f.client.readAgentSession('source')).toEqual(f.source)
})
it('an exact unbound local Zone remains available with nullable Space and unknown organization', async () => {
  const f = await fixture(), state = (await f.spatial.read())!, graph = state.graph
  graph.bindings = graph.bindings.filter(binding => binding.zoneId !== f.b.zoneId)
  await f.spatial.commit({ expectedRevision: state.revision, graph })
  const result = await f.rpc.call('agent.open', { operationId: 'unbound-zone', content: { kind: 'takeover-agent', executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: null } }, destination: { zoneId: f.b.zoneId, displayWorkspaceId: 'project-a', groupId: 'original-group', newTab: true }, focus: false })
  expect(result.outcome, JSON.stringify(result)).toBe('opened')
  expect(result.to!.spaceId).toBeNull(); expect(result.agent!.takeover).toMatchObject({ nature: null, destination: { address: result.to, organization: null } })
  expect(await f.client.readAgentSession('source')).toEqual(f.source)
})
it('disabled Promotion still permits an ordinary Project transfer, and original outgoing facts survive retirement and owner observation failure', async () => {
  const f = await fixture(); await writeFile(f.configurationPath, JSON.stringify({ promotion: { enabled: false } }))
  const result = await f.rpc.call('agent.open', { operationId: 'ordinary-transfer', content: { kind: 'takeover-agent', executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } }, destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, newTab: true }, focus: false })
  expect(result.outcome).toBe('opened'); expect(result.agent!.takeover!.nature).toBe('transfer')
  f.inner.kernel.prepareStop = async (runId: string, operationKey: string) => ({ daemonInstance: 'fixture-runtime', operationKey, runId }); f.inner.kernel.remove = async () => {}
  await f.client.stopAgent(result.agent!.agentSessionId, { runId: result.agent!.runId! }, { operationId: 'retire-takeover-child' })
  const input = { expectedRuntimeId: f.owner.runtimeId, direction: 'outgoing' as const, subject: { runtimeId: f.owner.runtimeId, agentSessionId: f.source.agentSessionId } }
  const retired = await f.rpc.call('agent.takeover.ls', input)
  expect(retired.records).toMatchObject([{ phase: 'retired', agent: { agentSessionId: result.agent!.agentSessionId, run: null }, takeover: result.agent!.takeover }])
  vi.spyOn(f.client, 'readAgentSession').mockRejectedValueOnce(Error('Temporary execution owner observation gap.'))
  const unknown = await f.rpc.call('agent.takeover.ls', input)
  expect(unknown.records).toMatchObject([{ phase: 'unconfirmed', issue: 'Temporary execution owner observation gap.', takeover: result.agent!.takeover }])
  expect(f.started).toHaveLength(1); expect(await f.client.readAgentSession('source')).toEqual(f.source)
})
it('independent reader processes restore the same original C, creation, source workface and relation pages without launch, input or replay', async () => {
  const f = await fixture(), operationId = 'durable-takeover'
  const created = await f.rpc.call('agent.open', { operationId, content: { kind: 'takeover-agent', executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } }, destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, displayWorkspaceId: 'project-a', groupId: 'original-group', newTab: true }, focus: false })
  const graph = await readFile(f.spatial.path, 'utf8'), starts = f.started.length, submissions = f.submit.mock.calls.length
  const read = async () => {
    const registration = `import { register } from 'node:module'; register(${JSON.stringify(sourceLoader.href)}, ${JSON.stringify(import.meta.url)});`
    const worker = new URL('./fixtures/agent-takeover-reader.mjs', import.meta.url)
    return await new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(registration), worker.pathname, f.root, f.owner.runtimeId, created.agent!.agentSessionId, operationId], { env: takeoverEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Private Takeover reader exceeded its deadline.')) }, 15000)
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
      child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('close', code => { clearTimeout(timer); if (code !== 0) reject(Error(stderr + stdout)); else try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } })
    })
  }
  const first = await read(), restarted = await read()
  expect(first.pid).not.toBe(restarted.pid)
  for (const value of [first, restarted]) {
    expect(value.creation.takeover).toEqual(created.agent!.takeover)
    expect(value.incoming.records).toMatchObject([{ phase: 'active', agent: { agentSessionId: created.agent!.agentSessionId, run: { runId: created.agent!.runId } }, takeover: created.agent!.takeover }])
    expect(value.outgoing.records[0].takeover).toEqual(created.agent!.takeover)
    expect(value.known.report.agent.takeover).toEqual(created.agent!.takeover); expect(value.unknown).toMatchObject({ known: false, report: null })
    expect(value.controls).toBe(0); expect(value.graphUnchanged).toBe(true)
  }
  expect(await readFile(f.spatial.path, 'utf8')).toBe(graph); expect(f.started).toHaveLength(starts); expect(f.submit).toHaveBeenCalledTimes(submissions)
  expect(await f.client.readAgentSession('source')).toEqual(f.source)
})
