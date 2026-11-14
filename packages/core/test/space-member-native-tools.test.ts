import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { createSpaceSessionsFixture } from './helpers/space-session-fixture.js'
import { createHostRouteInventoryFixture } from './helpers/host-route-inventory-fixture.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { parseSpaceMemberParams } from '../src/space-member-codec.js'
import { readSpaceSnapshot } from '../src/space-authority-stream.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it.each([false, true])('the original member Skills use their native owner with Native unavailable (foreign: %s)', async foreign => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'amx-member-tools-')); cleanup.push(() => rm(workspacePath, { recursive: true, force: true }))
  const f = await createSpaceSessionsFixture(cleanup, workspacePath), owner = foreign ? f.d : f.b, sid = 'same-native-tools-sid'
  const skillRoot = 'private-skills-' + owner.owner.runtimeId
  const skillPath = join(workspacePath, skillRoot, 'original-skill', 'SKILL.md')
  await mkdir(join(workspacePath, skillRoot, 'original-skill'), { recursive: true })
  await writeFile(skillPath, '---\nname: Original exact skill\ndescription: Read from original private workspace\nmetadata:\n  version: "2.4.1"\n---\nOriginal body\n')
  const provider = new AgentProviderRegistry().get('codex')
  owner.core.providers.register({ ...provider, catalog: { ...provider.catalog, composer: { commands: provider.catalog.composer?.commands ?? [], skillRoots: [skillRoot] } } })
  const session = await owner.put(sid, 1, 'original-native-tools-run', workspacePath)
  if (foreign) {
    f.b.core.providers.register({ ...provider, catalog: { ...provider.catalog,
      composer: { commands: provider.catalog.composer?.commands ?? [], skillRoots: [] } } })
    await f.b.put(sid)
  }
  const admitted = await f.admit(foreign ? 'D-in-B' : 'local', owner.owner.runtimeId, sid, 'native-tools-original-C', undefined, workspacePath)
  const native = vi.spyOn(owner.core, 'runtimeSubject').mockRejectedValue(Error('Native is unknown, not a Skills permission'))
  const target = { kind: 'conversation' as const, reference: f.reference, regionId: admitted.address.regionId,
    runtimeId: owner.owner.runtimeId, agentSessionId: sid, expectedAdmission: { kind: 'creation' as const, operationId: admitted.requestId } }
  const result = await f.b.rpc.call('space.member.call', { target, call: { method: 'skill.ls', params: { hostId: 'local', agentSessionId: sid } } },
    { runtimeFence: { runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId } })
  expect(result).toMatchObject({ hostId: 'local', agentSessionId: sid, workspacePath,
    skills: [{ name: 'Original exact skill', path: skillPath, source: 'project', version: '2.4.1' }] })
  owner.coreClients.mockClear()
  expect(await owner.rpc.call('skill.ls', { hostId: 'local', agentSessionId: sid })).toEqual(result)
  expect(owner.coreClients.mock.calls.map(([hostId]) => hostId)).toEqual(['local'])
  const readOwner = vi.spyOn(owner.core, 'readAgentSession')
  for (const [runtimeFence, code] of [[{ runtimeId: 'another-execution-Runtime', ownerInstanceId: owner.owner.ownerInstanceId }, 'RUNTIME_OWNER_MISMATCH'],
    [{ runtimeId: owner.owner.runtimeId, ownerInstanceId: 'another-execution-instance' }, 'RUNTIME_OWNER_CHANGED']] as const) {
    await expect(owner.rpc.call('skill.ls', { hostId: 'local', agentSessionId: sid }, { runtimeFence })).rejects.toMatchObject({ code })
  }
  expect(readOwner).not.toHaveBeenCalled()
  if (foreign) {
    const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.b.server.path, 'space', 'member', 'call', '--input', '-'],
      objectCliEnvironment(f.b.root), JSON.stringify({ target, call: { method: 'skill.ls', params: { hostId: 'local', agentSessionId: sid } } }))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result.skills).toEqual([{ name: 'Original exact skill', description: 'Read from original private workspace',
      path: skillPath, source: 'project', version: '2.4.1' }])
  }
  expect(native).not.toHaveBeenCalled()
  expect(await owner.core.readAgentSession(sid)).toMatchObject({ run: session.run })
})

it('the current viewer reaches original Native Skills through A to B to D and needs the D receiver grant', async () => {
  const source = await createSpaceSessionsFixture(cleanup)
  source.b.owner.runtimeId = 'runtime-B'
  const h = await createHostRouteInventoryFixture(cleanup as Array<() => Promise<void>>, { spatialState: source.b.spatial,
    hostedRuntime: () => source.b.hosted, coreClients: () => [{ hostId: 'local', client: source.b.core }] })
  const sid = 'recipient', provider = h.original.client.providers.get('codex'), root = 'private-native-skills'
  h.original.client.providers.replace({ ...provider, catalog: { ...provider.catalog, composer: { commands: provider.catalog.composer?.commands ?? [], skillRoots: [root] } } })
  await mkdir(join(h.original.root, root, 'original'), { recursive: true })
  await writeFile(join(h.original.root, root, 'original', 'SKILL.md'), '---\nname: Routed original skill\n---\nPrivate skill\n')
  const admitted = await source.admit('collision', h.d.identity.runtimeId, sid, 'routed-native-tools-C', h.route, h.original.root)
  const reference = { ...source.reference, runtimeId: h.b.identity.runtimeId }
  const target = { kind: 'conversation' as const, reference, regionId: admitted.address.regionId,
    runtimeId: h.d.identity.runtimeId, agentSessionId: sid, expectedAdmission: { kind: 'creation' as const, operationId: admitted.requestId } }
  const input = { target, call: { method: 'skill.ls' as const, params: { hostId: 'local', agentSessionId: sid } } }
  await h.configure(h.b, [{ id: 'collision', route: h.route }], [h.grant('A-member-read', h.a.identity, h.b.identity, ['space.member.call'])])
  const scopes = ['runtime.owner.identity', 'skill.ls']
  await h.configure(h.c, [], [h.grant('B-native-read', h.b.identity, h.d.identity, scopes)])
  await h.configure(h.d, [], [h.grant('C-native-read', h.c.identity, h.d.identity, scopes)])
  const read = await h.rpc.call('space.member.call', input)
  expect(read).toMatchObject({ agentSessionId: sid, workspacePath: h.original.root, skills: [{ name: 'Routed original skill' }] })
  expect(h.arrivals.at(-1)).toEqual({ method: 'skill.ls', actor: h.actor })
  await h.configure(h.d, [], [])
  await expect(h.rpc.call('space.member.call', input)).rejects.toMatchObject({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  const localProvider = new AgentProviderRegistry().get('codex')
  source.b.core.providers.register({ ...localProvider, catalog: { ...localProvider.catalog, composer: { commands: localProvider.catalog.composer?.commands ?? [], skillRoots: [] } } })
  await source.b.put(sid, 1, 'same-source-original-run', '/b/project')
  const localAdmission = await source.admit('local', h.b.identity.runtimeId, sid, 'same-source-native-tools-C')
  const sameSource = { ...target, runtimeId: h.b.identity.runtimeId, regionId: localAdmission.address.regionId,
    expectedAdmission: { kind: 'creation' as const, operationId: localAdmission.requestId } }
  const localRead = await h.rpc.call('space.member.call', { ...input, target: sameSource })
  expect(localRead).toMatchObject({ agentSessionId: sid, workspacePath: '/b/project', skills: [] })
  expect(h.arrivals.at(-1)).toEqual({ method: 'skill.ls', actor: h.actor })
})

it('original Native Skills reject other Hosts, Sessions and arbitrary native methods before the original owner', () => {
  const target = { kind: 'conversation' as const, reference: { runtimeId: 'B', spaceId: 'original' }, regionId: 'original-region',
    runtimeId: 'D', agentSessionId: 'same-sid', expectedAdmission: { kind: 'creation' as const, operationId: 'original-C' } }
  for (const params of [{ hostId: 'observer', agentSessionId: target.agentSessionId }, { hostId: 'local', agentSessionId: 'another-agent' },
    { hostId: 'local', agentSessionId: target.agentSessionId, command: 'not-an-original-selector' }])
    expect(() => parseSpaceMemberParams('space.member.call', { target, call: { method: 'skill.ls', params } })).toThrow()
  expect(() => parseSpaceMemberParams('space.member.call', { target, call: { method: 'agent.inspect', params: { target: { agentSessionId: target.agentSessionId } } } })).toThrow()
})

it('an original Native Skills read cannot publish after its exact admission was removed while awaiting the owner', async () => {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'late-original-native-tools'
  const provider = new AgentProviderRegistry().get('codex')
  f.d.core.providers.register({ ...provider, catalog: { ...provider.catalog, composer: { commands: provider.catalog.composer?.commands ?? [], skillRoots: [] } } })
  const session = await f.d.put(sid), admitted = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'late-native-tools-C')
  const target = { kind: 'conversation' as const, reference: f.reference, regionId: admitted.address.regionId,
    runtimeId: f.d.owner.runtimeId, agentSessionId: sid, expectedAdmission: { kind: 'creation' as const, operationId: admitted.requestId } }
  let captured!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { captured = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  cleanup.push(() => release())
  const read = f.d.core.readAgentSession.bind(f.d.core)
  vi.spyOn(f.d.core, 'readAgentSession').mockImplementation(async id => { const result = await read(id); if (id === sid) { captured(); await gate } return result })
  const pending = f.b.rpc.call('space.member.call', { target, call: { method: 'skill.ls', params: { hostId: 'local', agentSessionId: sid } } })
    .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  await started
  try {
    const snapshot = await readSpaceSnapshot(f.b.rpc, f.reference)
    await f.b.rpc.call('space.apply', { reference: f.reference, expectedRevision: snapshot.revision, changes: {
      remove: { tabs: [admitted.address.tabId], regions: [target.regionId] }
    } })
  } finally { release() }
  const result = await pending
  expect(result.value).toBeUndefined()
  expect(result.error).toMatchObject({ code: 'SPACE_MEMBER_ADMISSION_UNCONFIRMED' })
  expect(await read(sid)).toMatchObject({ run: session.run })
})
