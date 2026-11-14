import { afterEach, expect, it } from 'vitest'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { connectAgentMuxRpc } from '@agentmux/core'
import type { MeshNetworkSettings, MeshNetworkInspection, MeshNetworkResults, MeshNetworkLink } from '@agentmux/core/mesh-network'
import { exportPublicKey, generateKeyPair } from '@agentmux/relay/e2ee'
import { until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { meshDesktopServiceFixture } from './helpers/mesh-desktop-service-fixture.js'

const cleanup: Array<() => void | Promise<void>> = [], roots: string[] = [], pids: number[] = [], facts: unknown[] = []
const directory = resolve(process.env.AGENTMUX_MESH_DESKTOP_EVIDENCE ?? '.local/state/mesh-settings-clarity/desktop-proof')
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
afterEach(async ({ task }) => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  const rootFacts = await Promise.all(roots.splice(0).map(async path => ({ path, absent: await access(path).then(() => false, () => true) })))
  const processes = pids.splice(0).map(pid => ({ pid, exited: !alive(pid) }))
  if (rootFacts.some(root => !root.absent) || processes.some(process => !process.exited)) errors.push(Error('Private Desktop Mesh resources remain'))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, task.name.includes('lost') ? 'lost-ack.json' : 'consumer.json'), JSON.stringify({ test: task.name, facts: facts.splice(0), cleanup: { roots: rootFacts, processes, errors: errors.map(String) } }, null, 2) + '\n')
  if (errors.length) throw new AggregateError(errors, 'Private Desktop Mesh cleanup')
})
async function fixture() {
  const f = await meshDesktopServiceFixture(); cleanup.push(f.close); roots.push(f.original.native.root)
  pids.push(f.original.native.ownerProcess.pid!, f.original.native.nativeProcessId!)
  const run = (await f.original.client.statusAgent(f.original.session.agentSessionId)).run!
  pids.push(run.pid!)
  return { ...f, get desktop() { return f.desktop }, get heldReceipt() { return f.heldReceipt }, run }
}
const result = <T>(value: { code: number | null; stdout: string; stderr: string }): T => { expect(value.code, value.stderr || value.stdout).toBe(0); return JSON.parse(value.stdout).result as T }

it('compiled CLI and fixed Main IPC cross the production Desktop Unix service into the original private Core Mesh owner', async () => {
  const f = await fixture()
  const initial = result<MeshNetworkSettings>(await f.cli(['settings', 'mesh', 'inspect']))
  expect(initial.owner).toEqual({ runtimeId: f.original.native.owner.runtimeId, ownerInstanceId: f.original.native.owner.ownerInstanceId })
  const deviceKey = generateKeyPair(), configuration = { ...initial.configuration, role: 'gateway' as const, networkId: 'desktop-original-mesh', members: [{ peerId: initial.identity!.peerId, publicKey: initial.identity!.publicKey }], listen: { host: '127.0.0.1', port: 0 }, endpointAccess: { allowedClientKeys: [exportPublicKey(deviceKey.publicKey)] } }
  const saved = result<MeshNetworkResults['settings.mesh.configure']>(await f.cli(['settings', 'mesh', 'configure', '--input', '-'], { expectedRevision: initial.revision, operationId: 'desktop-original-cli-save', configuration }))
  expect(saved.diskDurability).toBe('confirmed')
  expect((await f.originalRpc.call('settings.mesh.inspect', {})).revision).toBe(saved.settings.revision)
  const live = await until(async () => result<MeshNetworkInspection>(await f.cli(['mesh', 'inspect'])), value => value.gateway.state === 'listening' && value.endpoint.state === 'available', 'real Mesh listener through Desktop CLI')
  expect(live.owner).toEqual(initial.owner)
  if (live.gateway.state !== 'listening' || !live.gateway.listener || live.endpoint.state !== 'available') throw Error('Original Mesh live endpoint missing')
  const throughMain = await f.renderer.call('settings.mesh.inspect', {})
  expect(throughMain.revision).toBe(saved.settings.revision)
  const advertised = { ...throughMain.configuration, advertisedIngress: [{ endpoint: 'other.example', useTls: true }, { endpoint: '127.0.0.1:' + live.gateway.listener.port, useTls: false }] }
  const mainSave = await f.renderer.call('settings.mesh.configure', { expectedRevision: throughMain.revision, operationId: 'desktop-original-main-save', configuration: advertised }, { expectedOwner: initial.owner })
  expect(mainSave.diskDurability).toBe('confirmed')
  const mainCall = f.calls.find(call => call.method === 'settings.mesh.configure' && (call.params as { operationId: string }).operationId === 'desktop-original-main-save')!
  expect(mainCall.context.runtimeFence).toEqual(initial.owner)
  expect(mainCall.context.principal).toEqual({ kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` })
  await until(() => f.renderer.call('mesh.inspect', {}), value => value.activeRevision === mainSave.settings.revision, 'original Core applied the exact Main save')
  const pairing = result<{ owner: typeof initial.owner; code: string }>(await f.cli(['mesh', 'code']))
  expect(pairing.owner).toEqual(initial.owner)
  const preview = result<{ networkId: string; peerId: string; endpoints: unknown[] }>(await f.cli(['mesh', 'code', 'read', pairing.code]))
  expect(preview).toMatchObject({ networkId: advertised.networkId, peerId: initial.identity!.peerId, endpoints: advertised.advertisedIngress })
  const ingress = advertised.advertisedIngress[1]!
  const linked = result<MeshNetworkLink>(await f.cli(['mesh', 'link', '--input', '-'], { offer: live.endpoint.offer, ingress }))
  expect(linked.observation.ingress).toEqual(ingress)
  expect(linked.offer.relay).toEqual(ingress)
  const foreign = await f.cli(['mesh', 'link', '--input', '-'], { offer: live.endpoint.offer, ingress: { endpoint: 'not-advertised.example', useTls: true } })
  expect(foreign.code).not.toBe(0)
  expect(JSON.parse(foreign.stderr).error.code).toBe('MESH_LINK_UNAVAILABLE')
  expect(linked.offer.serverId).toBe(live.endpoint.offer.serverId)
  expect(linked.offer.daemonPublicKeyB64).toBe(live.endpoint.offer.daemonPublicKeyB64)
  const device = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer: linked.offer }, relayKeyPair: deviceKey }); cleanup.push(() => device.dispose())
  expect((await device.call('runtime.owner.identity', {})).owner.runtimeId).toBe(initial.owner.runtimeId)
  await expect(device.call('settings.mesh.inspect', {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(device.call('settings.mesh.configure', { expectedRevision: mainSave.settings.revision, operationId: 'device-must-not-save', configuration: advertised })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED', controlFailure: { disposition: 'not_applied' } })
  const diskPath = join(f.original.native.env.AGENTMUX_STATE_DIRECTORY!, 'mesh-network.json'), beforeStale = await readFile(diskPath)
  await expect(f.renderer.call('settings.mesh.configure', { expectedRevision: mainSave.settings.revision, operationId: 'stale-main-must-not-save', configuration: advertised }, { expectedOwner: { ...initial.owner, ownerInstanceId: 'not-the-original-instance' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  expect(await readFile(diskPath)).toEqual(beforeStale)
  const managed = result<MeshNetworkSettings>(await f.cli(['settings', 'mesh', 'inspect'], undefined, true))
  expect(managed.owner).toEqual(initial.owner)
  const managedCall = f.calls.filter(call => call.method === 'settings.mesh.inspect').find(call => call.context.caller !== undefined)!
  expect(managedCall.context.caller?.agentSessionId).toBe(f.original.session.agentSessionId)
  expect(managedCall.context.caller?.capability).toBe(f.original.managedEnv.AGENTMUX_AGENT_CAPABILITY)
  await until(() => f.original.client.statusAgent(f.original.session.agentSessionId), value => value.observation.semantic === 'idle', 'original Native input readiness')
  result(await f.cli(['agent', 'input', 'submit', '--session', f.original.session.agentSessionId, '--operation-id', 'desktop-original-still-works', '--input', '-'], { prompt: 'healthy-original-after-mesh-desktop-save', expectedRun: f.original.session.run, afterSubmissionId: null, execution: 'immediate' }))
  const nativeFile = join(f.original.native.env.HOME!, '.codex', 'sessions', 'rollout-' + f.original.session.agentSessionId + '.jsonl')
  await until(async () => (await readFile(nativeFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.type === 'response_item' && item.payload?.role === 'user' && JSON.stringify(item.payload.content).includes('healthy-original-after-mesh-desktop-save')).length, count => count === 1, 'actual original Provider accepted healthy input once')
  expect((await f.original.client.statusAgent(f.original.session.agentSessionId)).run).toMatchObject({ runId: f.run.runId, pid: f.run.pid, state: 'running' })
  facts.push({ originalOwner: initial.owner, originalSession: f.original.session.agentSessionId, originalRun: f.original.session.run, originalStateDirectory: f.original.native.env.AGENTMUX_STATE_DIRECTORY, desktopSocket: f.socketPath, compiledCliSettingsSaved: saved.settings.revision, mainSettingsSaved: mainSave.settings.revision, mainFenceRetained: true, originalCallerRetained: true, originalDeviceKey: linked.offer.daemonPublicKeyB64, deviceSettingsDenied: true, staleFenceDeniedWithoutWrite: true, nativeAcceptedOnce: true, diskSHA256: createHash('sha256').update(beforeStale).digest('hex') })
}, 90000)

it('a lost Desktop save acknowledgement retains the exact original Core operation and is inspected without replay', async () => {
  const f = await fixture(), initial = result<MeshNetworkSettings>(await f.cli(['settings', 'mesh', 'inspect']))
  const operationId = 'desktop-lost-original-save'
  f.holdReply(operationId)
  const configuration = { ...initial.configuration, role: 'participant' as const, networkId: 'desktop-unknown-original', members: [{ peerId: initial.identity!.peerId, publicKey: initial.identity!.publicKey }] }
  const lost = await f.cli(['settings', 'mesh', 'configure', '--input', '-'], { expectedRevision: initial.revision, operationId, configuration })
  expect(lost.code).not.toBe(0)
  expect(f.heldReceipt).toMatchObject({ diskDurability: 'confirmed', settings: { owner: initial.owner } })
  const failure = JSON.parse(lost.stderr)
  expect(failure).toMatchObject({ ok: false, operation: 'settings.mesh.configure', operationId, error: { code: 'CONTROL_CONNECTION_FAILED' } })
  expect(failure.error.controlFailure?.disposition).not.toBe('not_applied')
  await f.reopen()
  const restored = result<MeshNetworkSettings>(await f.cli(['settings', 'mesh', 'inspect', '--operation-id', operationId]))
  expect(restored.operation).toMatchObject({ operationId, status: 'confirmed' })
  expect(restored.owner).toEqual(initial.owner)
  expect(restored.configuration.networkId).toBe(configuration.networkId)
  expect(f.calls.filter(call => call.method === 'settings.mesh.configure')).toHaveLength(1)
  expect((await f.original.client.statusAgent(f.original.session.agentSessionId)).run).toMatchObject({ runId: f.run.runId, pid: f.run.pid, state: 'running' })
  facts.push({ operationId, originalOwner: initial.owner, actualSavedReceipt: f.heldReceipt, lostCliFailure: failure, recoveredOriginalOperation: restored.operation, configureDispatchCount: 1, originalRun: f.original.session.run })
}, 90000)
