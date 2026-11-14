import { afterEach, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { SpaceMemberRoute } from "../src/space-member.js"
import { createSpaceMemberProgressFixture } from "./helpers/space-member-progress-fixture.js"
import { parseSpaceMemberParams } from '../src/space-member-codec.js'
import { readSpaceSnapshot } from '../src/space-authority-stream.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })


it.each([false, true])('the explicit original Session progress uses its durable owner across Runs (foreign: %s)', async foreign => {
  const f = await createSpaceMemberProgressFixture(cleanup), selected = await f.admit(foreign)
  const call = async (method: 'agent.progress.create' | 'agent.progress.action' | 'agent.progress.list', params: object, target = selected.target) =>
    await f.rpc.call('space.member.call', { target: target as unknown as SpaceMemberRoute, call: { method, params } } as never)
  const input = { target: selected.inputTarget, intervalMs: 60_000, prompt: 'Original explicit progress', operationId: 'original-explicit-progress' }
  const created = await call('agent.progress.create', input) as { loop: { loopId: string }; diskDurability: string }
  expect(created).toMatchObject({ diskDurability: 'confirmed', loop: { agentSessionId: 'recipient', workspacePath: selected.owner.root, status: 'active', creationOperationId: input.operationId } })
  const original = (await selected.owner.store.readMetadata('recipient'))!
  await selected.owner.store.compareAndSwap(original, { ...original, run: { runId: 'later-original-run' }, updatedAt: original.updatedAt + 1 })
  await selected.owner.inner.registry.refresh('recipient', { runId: 'later-original-run' })
  const paused = await call('agent.progress.action', { target: selected.inputTarget, loopId: created.loop.loopId, expectedLoop: created.loop, action: 'pause', operationId: 'pause-original-progress' })
  expect(paused).toMatchObject({ diskDurability: 'confirmed', loop: { status: 'paused', loopId: created.loop.loopId } })
  expect(JSON.parse(await readFile(join(selected.owner.root, 'loops.json'), 'utf8'))).toMatchObject([{ status: 'paused', loopId: created.loop.loopId }])
  expect(f.tick).not.toHaveBeenCalled()
  expect(selected.owner.inner.kernel.input).not.toHaveBeenCalled(); expect(selected.owner.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a Session purpose keeps its C/L without turning conversation or a Run route into arrangement permission', () => {
  const target = { kind: 'session' as const, reference: { runtimeId: 'B', spaceId: 'original' }, regionId: 'original-region', runtimeId: 'D', agentSessionId: 'recipient', expectedAdmission: { kind: 'creation' as const, operationId: 'original-C' } }
  const call = { method: 'agent.progress.create', params: { target: { hostId: 'local', agentSessionId: 'recipient', providerId: 'codex', workspacePath: '/original' }, intervalMs: 60_000, prompt: 'Original future input', operationId: 'original-create' } }
  expect(() => parseSpaceMemberParams('space.member.call', { target, call })).not.toThrow()
  const { expectedAdmission: _pin, ...unpinned } = target, { kind: _purpose, ...full } = target
  for (const refused of [unpinned, { ...target, kind: 'conversation' }, { ...target, expectedRun: { runId: 'invented' } }, { ...full, expectedRun: { runId: 'real-but-not-session-purpose' } }])
    expect(() => parseSpaceMemberParams('space.member.call', { target: refused, call })).toThrow()
  for (const method of ['readAgentSession', 'runtimeSubject', 'writeAgent', 'submitAgentPrompt'])
    expect(() => parseSpaceMemberParams('space.member.call', { target, call: { method: 'runtime.invoke', params: { consumerId: 'reader', fence: { runtimeId: 'D', ownerInstanceId: 'D-instance' }, invocation: { method, args: [] } } } })).toThrow()
})

it('conversation purpose, changed C, wrong original metadata and a missing receiver grant cannot create an arrangement', async () => {
  const f = await createSpaceMemberProgressFixture(cleanup), selected = await f.admit(true)
  const call = { method: 'agent.progress.create' as const, params: { target: selected.inputTarget, intervalMs: 60_000, prompt: 'Original explicit request', operationId: 'refused-original-request' } }
  await expect(f.rpc.call('space.member.call', { target: { ...selected.target, kind: 'conversation' }, call })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.rpc.call('space.member.call', { target: { ...selected.target, expectedAdmission: { kind: 'creation', operationId: 'another-C' } }, call })).rejects.toMatchObject({ code: 'SPACE_MEMBER_ADMISSION_UNCONFIRMED' })
  await expect(f.rpc.call('space.member.call', { target: selected.target, call: { ...call, params: { ...call.params, target: { ...selected.inputTarget, workspacePath: f.coreB.root } } } })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  await f.configure(f.d, [], [])
  await expect(f.rpc.call('space.member.call', { target: selected.target, call })).rejects.toMatchObject({ code: 'HOST_ROUTE_NOT_DELEGATED' })
  expect(selected.progress.list()).toEqual([])
  expect(selected.owner.inner.kernel.input).not.toHaveBeenCalled(); expect(selected.owner.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a confirmed original progress ACK survives a later Source admission change without replaying the request', async () => {
  const f = await createSpaceMemberProgressFixture(cleanup), selected = await f.admit(true)
  const originalSession = await selected.owner.client.readAgentSession('recipient')
  f.afterExecutionAck(async method => {
    if (method !== 'agent.progress.create') return
    const snapshot = await readSpaceSnapshot(f.b.rpc, selected.target.reference)
    const region = snapshot.scope.regions.find(region => region.regionId === selected.target.regionId)!
    await f.b.rpc.call('space.apply', { reference: selected.target.reference, expectedRevision: snapshot.revision,
      changes: { remove: { tabs: [region.tabId], regions: [selected.target.regionId] } } })
  })
  const result = await f.rpc.call('space.member.call', { target: selected.target, call: { method: 'agent.progress.create', params: {
    target: selected.inputTarget, intervalMs: 60_000, prompt: 'Keep this original confirmed arrangement', operationId: 'original-accepted-before-C-removed' } } })
  expect(result).toMatchObject({ diskDurability: 'confirmed', loop: { creationOperationId: 'original-accepted-before-C-removed', status: 'active' } })
  expect(selected.progress.list()).toHaveLength(1)
  expect((await selected.owner.client.readAgentSession('recipient'))!.run).toEqual(originalSession!.run)
  expect(f.tick).not.toHaveBeenCalled(); expect(selected.owner.inner.kernel.input).not.toHaveBeenCalled()
})

it('the actual public CLI retains an explicit original Session operation with its original recovered input epoch', async () => {
  const f = await createSpaceMemberProgressFixture(cleanup), selected = await f.admit(false)
  const cut = await selected.owner.store.admitRecoveryInputCut({ operationId: 'private-recovery-cut', sourceSHA256: 'a'.repeat(64) })
  expect(cut.state).toBe('admitted')
  if (cut.state !== 'admitted') throw Error('This private Source did not admit its input cut')
  await selected.owner.inner.registry.refresh('recipient', { runId: 'run-recipient' })
  const call = { method: 'agent.progress.create' as const, params: { target: selected.inputTarget, intervalMs: 60_000, prompt: 'Original CLI future input', operationId: 'original-CLI-progress' } }
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.original.root + '/B.sock', 'space', 'member', 'call', '--input', '-'],
    objectCliEnvironment(selected.owner.root), JSON.stringify({ target: selected.target, call: { ...call, params: { ...call.params, inputEpoch: cut.inputEpoch } } }))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result).toMatchObject({ diskDurability: 'confirmed', loop: { creationOperationId: call.params.operationId, inputEpoch: cut.inputEpoch } })
  expect(selected.owner.inner.kernel.input).not.toHaveBeenCalled()
})
