import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { parseMotePreferencesSaveParams, parseMotePreferencesSaveResult, parseMotePreferencesReadResult,
  type MoteQuickPreferencesSaveParams, type MoteQuickPreferencesPort } from '../src/mote/preferences.js'
import { parseContinuousProgressGuidanceAdoption, type ContinuousProgressGuidanceAdoption } from '../src/continuous-progress-definition.js'
import { parseScheduleRecord, parseScheduleRpcParams, validateScheduleRpcResult } from '../src/public-rpc-schedules.js'
import { AgentMuxControlServer, type AgentMuxControlServerOptions } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { parseSpaceControlSuccessReceipt } from '../src/space-control-parser.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'

const clean: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const target = { spaceId: 'original-mote', zoneId: 'original-home', expectedResource: { hostId: 'local', workspaceId: 'scratch', workspacePath: '/private/mote-guidance-codec' } }
const resource = { ...target.expectedResource, zoneId: target.zoneId, zonePath: target.expectedResource.workspacePath + '/mote', path: 'mote/MOTE.md' }
const content = 'Original Main and settings.\n'
const document = { path: resource.path, content, revision: 'sha256:' + createHash('sha256').update(content).digest('hex') }
const reference = { hostId: 'local', sessionId: 'origin', displayWorkspaceId: 'display', groupId: 'group', tabId: 'original-tab', regionId: 'original-region' }
const defaults = { conversation: reference, conversationRevision: 'role-original' }
const baseline = { resource, document, defaults }
const oldDefinition = { intentId: 'original-intent', operationId: 'original-creation' }
const newDefinition = { intentId: 'adopted-intent', operationId: 'adopted-definition', baseIntentId: oldDefinition.intentId, guidanceRevision: 'guidance-A' }
const action = { kind: 'adopt-current-guidance' as const, expectedSchedule: { loopId: 'original-loop', revision: 3 },
  expectedMain: { roleRevision: 'role-original', reference }, expectedDefinition: oldDefinition, guidanceRevision: 'guidance-A' }
const input = (): MoteQuickPreferencesSaveParams => structuredClone({ kind: 'quick', target, baseline, values: defaults, action, operationId: 'original-adoption' })
const receipt = (): ContinuousProgressGuidanceAdoption => ({ operationId: 'original-adoption', requestDigest: 'a'.repeat(64), actor: { kind: 'user', id: 'original-user' },
  expectedRevision: 3, oldDefinition, newDefinition, guidance: 'Original guidance A.\nSecond line.', preparedAt: 10, state: 'adopted', publishedAt: 11, issue: null })
const saved = (request = input()) => ({ kind: 'quick' as const, target, operationId: request.operationId, status: 'unchanged' as const,
  source: baseline, message: null, maintenanceAdoption: { ...receipt(), operationId: request.operationId, loopId: 'original-loop' } })
const schedule = () => ({ loopId: 'original-loop', hostId: 'local', agentSessionId: 'origin', providerId: 'controlled', workspacePath: target.expectedResource.workspacePath,
  revision: 3, creationOperationId: oldDefinition.operationId, futureIntentId: newDefinition.intentId, everyMs: 60000, intervalMs: 60000, prompt: 'Original saved body',
  nextCheckAt: 90000, status: 'paused' as const, pause: { reason: 'manual' as const }, currentDefinition: { ...newDefinition }, guidanceAdoptions: [receipt()] })

it('the shared action codec keeps exact originals and rejects another action, incomplete Main or destination', () => {
  expect(parseMotePreferencesSaveParams(input())).toEqual(input())
  for (const mutate of [
    (p: any) => p.action.kind = 'resume', (p: any) => delete p.action.expectedMain.reference.regionId,
    (p: any) => p.action.expectedSchedule.revision = 0, (p: any) => p.action.prompt = 'caller supplied replacement',
    (p: any) => p.destination = { kind: 'empty', displayWorkspaceId: 'display', groupId: 'group' }
  ]) { const p = input(); mutate(p); expect(() => parseMotePreferencesSaveParams(p)).toThrow() }
  expect(() => parseScheduleRpcParams('schedule.update', { scheduleId: 'original-loop', expectedRevision: 3, operationId: 'update', everyMs: 60000, prompt: 'new body' })).toThrow()
})

it('an unchanged File is separate from adoption and the receipt must retain its original request', () => {
  expect(parseMotePreferencesSaveResult(saved(), input()).maintenanceAdoption?.state).toBe('adopted')
  for (const mutate of [
    (p: any) => delete p.maintenanceAdoption, (p: any) => p.status = 'saved',
    (p: any) => p.source.document.content = 'Different contents', (p: any) => p.maintenanceAdoption.operationId = 'neighbor',
    (p: any) => p.maintenanceAdoption.loopId = 'neighbor', (p: any) => p.maintenanceAdoption.expectedRevision = 2,
    (p: any) => p.maintenanceAdoption.oldDefinition.intentId = 'neighbor', (p: any) => p.maintenanceAdoption.newDefinition.guidanceRevision = 'guidance-B'
  ]) { const p = structuredClone(saved()); mutate(p); expect(() => parseMotePreferencesSaveResult(p, input())).toThrow() }
})

it('the original Control receipt retains the separate adoption instead of dropping it at its boundary', () => {
  const { operationId, ...body } = saved()
  const decode = () => parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: operationId, ok: true,
    operation: 'space.mote.preferences.save', result: { ...body, requestId: operationId } })
  expect(decode).not.toThrow()
  const parsed = decode()
  expect(parsed.operation).toBe('space.mote.preferences.save')
  expect(parsed.result).toMatchObject({ maintenanceAdoption: { loopId: 'original-loop', state: 'adopted' } })
  expect(() => parseMotePreferencesSaveResult({ ...saved(), status: 'saved' })).toThrow()
})

it('schedule and maintenance public decoders preserve stages, legacy definition facts and unknown activation', () => {
  expect(parseScheduleRecord(schedule()).guidanceAdoptions).toEqual([receipt()])
  // Wall-clock rollback cannot undo an authoritative published stage.
  expect(parseContinuousProgressGuidanceAdoption({ ...receipt(), publishedAt: 9 }).state).toBe('adopted')
  const decode = () => validateScheduleRpcResult('schedule.inspect', { schedule: schedule(), executionScope: 'connected-host' }, { operationId: receipt().operationId })
  expect(decode).not.toThrow()
  expect(decode().schedule).toEqual(schedule())
  expect(() => validateScheduleRpcResult('schedule.inspect', { schedule: schedule(), executionScope: 'connected-host' }, { operationId: 'foreign-action' })).toThrow()
  const read = { kind: 'quick', target, status: 'ready', source: { resource, result: { status: 'read', document } }, defaults,
    choices: { executors: [], conversations: [], destinations: [] }, main: false, issue: null, maintenance: { status: 'paused', schedule: schedule(), issue: null,
      guidance: { availableRevision: 'guidance-B', currentDefinition: oldDefinition, adoptedRevision: null, adoptions: [receipt()] } } }
  expect(parseMotePreferencesReadResult(read).kind).toBe('quick')
  for (const published of [false, true]) {
    const r: any = { ...receipt(), state: 'unconfirmed', issue: 'Original activation is unknown' }; if (!published) delete r.publishedAt
    expect(parseContinuousProgressGuidanceAdoption(r)).toEqual(r)
  }
  for (const mutate of [
    (s: any) => s.currentDefinition.unreviewed = true,
    (s: any) => s.guidanceAdoptions[0].actor.kind = 'agent',
    (s: any) => delete s.guidanceAdoptions[0].publishedAt,
    (s: any) => s.guidanceAdoptions[0].newDefinition.intentId = oldDefinition.intentId,
    (s: any) => s.guidanceAdoptions.push(s.guidanceAdoptions[0]),
    (s: any) => s.guidanceAdoptions[0].state = 'prepared'
  ]) { const s = structuredClone(schedule()); mutate(s); expect(() => parseScheduleRecord(s)).toThrow() }
})

async function endpoint(owner: MoteQuickPreferencesPort | undefined, core: Awaited<ReturnType<typeof rpcOwnerFixture>>, extra: AgentMuxControlServerOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'amx-guidance-codec-'))
  clean.push(() => rm(root, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ coreClients: core.coreClients, spatialState: new AgentMuxSpatialStateStore(join(root, 'spatial.json')),
    ...(owner ? { moteQuickPreferences: owner } : {}), ...extra, socketPath: join(root, 'rpc.sock') })
  await server.start(); clean.push(() => server.stop())
  return { server, endpoint: { transport: 'unix' as const, path: join(root, 'rpc.sock') } }
}
function owner() {
  return { read: vi.fn<MoteQuickPreferencesPort['read']>(), save: vi.fn<MoteQuickPreferencesPort['save']>(async (request, context) => {
    expect(context?.actor.kind).not.toBe('agent'); await context?.assertCurrent?.(); return saved(request)
  }) }
}
it('the actual Unix SDK dispatches the separate adoption receipt to its original person-owned port', async () => {
  const core = await rpcOwnerFixture(['origin']); clean.push(core.close)
  const port = owner(), h = await endpoint(port, core), rpc = await connectAgentMuxRpc({ endpoint: h.endpoint }); clean.push(() => rpc.dispose())
  const result = await rpc.call('space.mote.preferences.save', input())
  expect(result.maintenanceAdoption).toMatchObject({ state: 'adopted', loopId: 'original-loop', newDefinition })
  expect(port.save).toHaveBeenCalledTimes(1); expect(port.save.mock.calls[0]![1]?.actor.kind).toBe('user')
  expect(core.rawInput).not.toHaveBeenCalled(); expect(core.inner.kernel.stop).not.toHaveBeenCalled()
})
it('the actual device SDK retains its transport identity for the same explicit action', async () => {
  const core = await rpcOwnerFixture(['origin']); clean.push(core.close)
  const port = owner(), h = await endpoint(port, core, { http: { host: '127.0.0.1', port: 0,
    authorize: () => ({ principal: { kind: 'device', id: 'original-device' } }) } })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${h.server.httpAddress!.port}/`, token: 'private-transport' } }); clean.push(() => rpc.dispose())
  expect((await rpc.call('space.mote.preferences.save', input())).maintenanceAdoption?.state).toBe('adopted')
  expect(port.save.mock.calls[0]![1]?.actor).toEqual({ kind: 'device', id: 'original-device' })
  expect(core.rawInput).not.toHaveBeenCalled()
})
it('the original source CLI explains explicit adoption and its separate receipt', async () => {
  const help = await runSourceObjectCli(['space', 'mote', 'preferences', 'save', '--help'], process.env)
  expect(help.code, help.stderr).toBe(0)
  expect(help.stdout).toContain('adopt-current-guidance')
  expect(help.stdout).toContain('maintenanceAdoption')
  expect(help.stdout).toContain('pending/unknown input retains its original bytes')
})
it('a real managed Core capability cannot adopt through either owner dispatch or forwarding', async () => {
  const core = await rpcOwnerFixture(['origin']); clean.push(core.close)
  for (const useOwner of [true, false]) {
    const port = owner(), forward = vi.fn(async () => saved()), h = await endpoint(useOwner ? port : undefined, core, { forwardControl: forward as any })
    const rpc = await connectAgentMuxRpc({ endpoint: h.endpoint, credentials: core.credentials }); clean.push(() => rpc.dispose())
    await expect(rpc.call('space.mote.preferences.save', input())).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(port.save).not.toHaveBeenCalled(); expect(forward).not.toHaveBeenCalled()
  }
  expect(core.rawInput).not.toHaveBeenCalled(); expect(core.inner.kernel.stop).not.toHaveBeenCalled()
})
