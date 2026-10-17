import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { composeAgentLaunchPrompt } from '../src/agent-outbound-message.js'
import { agentMuxCliModuleCatalog, agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { connectAgentMuxRpc, type AgentMuxRpcClient } from '../src/public-rpc-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import type { AgentMuxRpcMethod, AgentMuxRpcParams } from '../src/public-rpc.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { AGENTMUX_DISPLAY_LABEL_RESOURCE, displayLabel } from '../src/display-label.js'
import { AgentMuxError } from '../src/errors.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  vi.restoreAllMocks()
  if (failures.length) throw new AggregateError(failures, 'Private naming fixture cleanup failed')
})

const ownSid = 'task-owner-original'
const ownTarget = { kind: 'agent-session', id: ownSid } as const
async function fixture() {
  const h = await rpcOwnerFixture([ownSid, 'unrelated-session'])
  cleanup.push(async () => {
    try {
      for (const name of ['attach', 'detach', 'stop', 'input']) expect(h.inner.kernel[name]).not.toHaveBeenCalled()
    } finally { await h.close() }
  })
  const spatial = new AgentMuxSpatialStateStore(join(h.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], bindings: [], layouts: {},
    tabs: [{ tabId: 'original-tab', workspaceId: 'original-workspace', zoneId: null, name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: ownSid,
      runId: 'run-' + ownSid, execution: { hostId: 'local', cwd: h.root } }],
    tabLayouts: { 'original-tab': { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } },
    resources: { 'original-draft': 'Keep the unfinished user request.' } } })
  const server = new AgentMuxControlServer({ spatialState: spatial, coreClients: h.coreClients, socketPath: join(h.root, 'naming.sock') })
  await server.start(); cleanup.push(() => server.stop())
  const endpoint = { transport: 'unix' as const, path: server.path }
  const rpc = await connectAgentMuxRpc({ endpoint, credentials: h.credentials }); cleanup.push(() => rpc.dispose())
  return { ...h, spatial, endpoint, rpc }
}

// Exercise the current argument parser and source RPC client; this is not the compiled CLI.
async function invoke<M extends AgentMuxRpcMethod>(rpc: AgentMuxRpcClient, method: M, args: string[]) {
  const parsed = await parseAgentMuxCliInvocation(args)
  expect(parsed.command.method).toBe(method)
  return rpc.call(method, parsed.params as AgentMuxRpcParams<M>)
}
const inspect = (rpc: AgentMuxRpcClient) => invoke(rpc, 'agent.inspect', ['agent', 'inspect', '--session', ownSid])
const rename = (rpc: AgentMuxRpcClient, revision: number, name: string, operationId: string, derived = true) =>
  invoke(rpc, 'agent.rename', ['agent', 'rename', '--session', ownSid, '--name', name,
    '--name-revision', String(revision), '--operation-id', operationId, ...(derived ? ['--derived'] : [])])

it('launch bootstrap reveals early self-naming without swallowing the original user request or loading its handbook', () => {
  const request = '  Understand <A2A> & keep </amux> in my original request.\r\n'
  const launch = composeAgentLaunchPrompt(request, true)
  expect(launch.systemContext).toMatch(/early.*conversation/iu)
  expect(launch.systemContext).toMatch(/understand.*task.*role/iu)
  expect(launch.systemContext).toContain('name --skill')
  expect(launch.systemContext!.split('name --skill')).toHaveLength(2)
  expect(launch.systemContext).toMatch(/own Session.*derived task name/u)
  expect(launch.systemContext).toMatch(/continue the task if naming is unavailable/u)
  expect(launch.systemContext).not.toContain(agentMuxModuleSkill('name')!)
  expect(launch.systemContext).not.toContain('--name-revision')
  expect(launch.text.endsWith('</amux>\n\n' + request)).toBe(true)
  expect(launch.systemContext).not.toContain(request)
  expect(composeAgentLaunchPrompt(request, false)).toEqual({ text: request })
  expect(composeAgentLaunchPrompt(undefined, true).systemContext).toContain('No request yet. Wait for the user.')
})

it('name discovery owns early task guidance and points to the actual existing derived naming arguments', async () => {
  const entry = agentMuxCliModuleCatalog().find(item => item.root === 'name')!
  expect(entry).toBeDefined()
  expect(entry.readCommand).toBe('amux name --skill')
  for (const field of [entry.summary, entry.roles, entry.when]) expect(field).toMatch(/task|self.nam/iu)
  const skill = agentMuxModuleSkill('name')!.replace(/\s+/gu, ' ')
  for (const marker of ['whoami', 'agent inspect', 'displayName', 'nameRevision', 'agent rename --help', '--derived',
    'manual', 'clear', 'launch', 'retained', 'name confirm']) expect(skill).toContain(marker)
  expect(skill).toMatch(/complete.*Session ID|full.*Session ID/iu)
  expect(skill).toMatch(/unavailable|unknown/iu)
  expect(skill).toMatch(/(?:do not|never) guess (?:revision )?(?:0|zero)/iu)
  expect(skill).toMatch(/once|one initial/iu)
  expect(skill).toMatch(/task.*(?:change|transition)|(?:change|transition).*task/iu)
  expect(skill).toMatch(/(?:do not|never).*Tab/iu)
  expect(skill).toMatch(/continue.*task/iu)
  expect(skill).toMatch(/same operation|original operation/iu)
  const parsed = await parseAgentMuxCliInvocation(['agent', 'rename', '--session', ownSid, '--name', 'Inspect A2A',
    '--name-revision', '3', '--derived', '--operation-id', 'original-naming-operation'])
  expect(parsed.command.method).toBe('agent.rename')
  expect(parsed.params).toEqual({ agentSessionId: ownSid, name: 'Inspect A2A', expectedNameRevision: 3,
    nameSource: 'derived', operationId: 'original-naming-operation' })
  expect(agentMuxCommandHelp('agent.rename')).toContain('--derived')
})

it('current parser and real Unix RPC derive the exact self name at the original durable owner without changing work', async () => {
  const h = await fixture(), before = (await h.spatial.readForLayout())!, sessions = await h.store.load()
  const self = await invoke(h.rpc, 'whoami', ['whoami'])
  expect(self.session.agentSessionId).toBe(ownSid)
  const initial = await inspect(h.rpc)
  expect(initial.displayName).toEqual({ override: null, source: null, nameRevision: 0, availability: 'observed' })
  const first = await rename(h.rpc, initial.displayName.nameRevision!, 'Inspect A2A', 'first-task-name')
  expect(first).toMatchObject({ override: 'Inspect A2A', outcome: 'renamed', nameRevision: 1, save: { diskDurability: 'confirmed' },
    record: { context: { actor: { kind: 'agent', id: ownSid, verified: true }, source: 'derived',
      location: { callerSessionId: ownSid, targetId: ownSid, targetRunId: self.session.run.runId } } } })
  const observed = await inspect(h.rpc)
  expect(observed.displayName).toEqual({ override: 'Inspect A2A', source: 'derived', nameRevision: 1, availability: 'observed' })
  await rename(h.rpc, observed.displayName.nameRevision!, 'Implement A2A', 'changed-task-name')
  const reopened = new AgentMuxSpatialStateStore(h.spatial.path), after = (await reopened.readForLayout())!
  expect(displayLabel(after.graph, ownTarget)).toMatchObject({ value: 'Implement A2A', source: 'derived', nameRevision: 2 })
  expect(displayLabel(after.graph, { kind: 'agent-session', id: 'unrelated-session' })).toBeNull()
  const { [AGENTMUX_DISPLAY_LABEL_RESOURCE]: labels, ...resources } = after.graph.resources
  expect(labels).toBeDefined()
  expect({ ...after.graph, resources }).toEqual(before.graph)
  expect(await h.store.load()).toEqual(sessions)
  expect((await h.client.statusAgent(ownSid)).run).toMatchObject({ runId: self.session.run.runId, acceptedInputBytes: 0 })
  await rename(h.rpc, 2, 'Keep my original title', 'explicit-name', false)
  const protectedName = (await inspect(h.rpc)).displayName
  expect(await rename(h.rpc, protectedName.nameRevision!, 'Automatic replacement', 'protected-name'))
    .toMatchObject({ changed: false, outcome: 'partial', record: { reason: expect.stringContaining('protected') } })
  expect((await inspect(h.rpc)).displayName).toEqual(protectedName)
})

it('unavailable name facts retain unknown revision and cannot silently become revision zero', async () => {
  const h = await fixture(), before = await h.spatial.readForLayout()
  const read = vi.spyOn(h.spatial, 'readForLayout').mockRejectedValue(new AgentMuxError('Name owner read unconfirmed', 'CONTROL_UNAVAILABLE'))
  const observed = await inspect(h.rpc)
  expect(observed.displayName).toEqual({ override: null, source: null, nameRevision: null, availability: 'unavailable' })
  expect(observed.unavailable).toContainEqual(expect.objectContaining({ code: 'CONTROL_UNAVAILABLE' }))
  await expect(parseAgentMuxCliInvocation(['agent', 'rename', '--session', ownSid, '--name', 'Unknown task', '--derived']))
    .rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  await expect(h.rpc.call('agent.rename', { agentSessionId: ownSid, name: 'Unknown task', nameSource: 'derived',
    expectedNameRevision: observed.displayName.nameRevision as unknown as number, operationId: 'unknown-revision' }))
    .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  read.mockRestore()
  expect(await h.spatial.readForLayout()).toEqual(before)
  expect((await h.client.statusAgent(ownSid)).run.state).toBe('running')
})

it('invalid caller credentials reject only that name request and leave healthy self-naming available', async () => {
  const h = await fixture(), before = await h.spatial.readForLayout()
  const bad = await connectAgentMuxRpc({ endpoint: h.endpoint, credentials: { ...h.credentials, capability: 'invalid-capability' } })
  cleanup.push(() => bad.dispose())
  await expect(rename(bad, 0, 'Untrusted name', 'invalid-caller')).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(await h.spatial.readForLayout()).toEqual(before)
  expect((await rename(h.rpc, 0, 'Authorized task', 'valid-caller')).outcome).toBe('renamed')
})

it('public naming cannot turn caller-supplied actor or source declarations into authenticated human intent', async () => {
  const h = await fixture(), before = await h.spatial.readForLayout()
  const request = { agentSessionId: ownSid, name: 'Forged name', expectedNameRevision: 0, operationId: 'forged-name' }
  for (const extra of [{ actor: { kind: 'user', id: 'claimed-person', verified: true } }, { nameSource: 'manual' }, { nameSource: 'launch' }]) {
    await expect(h.rpc.call('agent.rename', { ...request, ...extra } as AgentMuxRpcParams<'agent.rename'>))
      .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  }
  expect(await h.spatial.readForLayout()).toEqual(before)
  const result = await rename(h.rpc, 0, 'Original Agent task', 'agent-name')
  expect(result.record.context.actor).toEqual({ kind: 'agent', id: ownSid, verified: true })
})
