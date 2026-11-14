import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { exportPublicKey, generateKeyPair } from '@agentmux/relay/e2ee'
import { parseConnectionOfferUrl } from '@agentmux/relay/offer'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { loadOrCreateRelayKeyPair } from '../../../packages/core/src/rpc-relay-keypair.js'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import type { MeshNetworkConfiguration, MeshNetworkSettings } from '../../../packages/core/src/mesh-network.js'
import { mobileWebFixture } from './helpers/mobile-web-fixture.js'

const cleanup: Array<() => void | Promise<void>> = []
const roots: string[] = [], processes: number[] = []
function alive(pid: number) { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } }
  const rootFacts = await Promise.all(roots.splice(0).map(async path => ({ path, absent: await access(path).then(() => false, () => true) })))
  await until(() => processes.every(pid => !alive(pid)), Boolean, 'only private Mesh process cleanup', 5000).catch(error => errors.push(error))
  const processFacts = processes.splice(0).map(pid => ({ pid, exited: !alive(pid) }))
  if (rootFacts.some(fact => !fact.absent)) errors.push(Error('A private Mesh root remains'))
  await writeFile(resolve('.local/state/mesh-network-access/core-joined-cleanup.json'), JSON.stringify({ passed: errors.length === 0, roots: rootFacts, processes: processFacts, errors: errors.map(String) }, null, 2) + '\n')
  if (errors.length) throw new AggregateError(errors, 'Private Mesh Core topology cleanup failed')
})
async function port() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Private port missing'); await new Promise<void>(resolve => server.close(() => resolve())); return address.port }

it('actual headless CLI settings publish an original Host through three Mesh participants without legacy outbound configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-mesh-joined-')); roots.push(root); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const clientHome = join(root, 'client-home'); await mkdir(clientHome)
  const key = await loadOrCreateRelayKeyPair(join(clientHome, '.agentmux', 'relay-client-keypair.json'))
  const a = await headlessFixture({ cli: true }); cleanup.push(() => a.cleanup())
  const b = await headlessFixture({ cli: true }); cleanup.push(() => b.cleanup())
  const c = await mobileWebFixture({ nativeRecord: true }); cleanup.push(() => c.close())
  roots.push(a.root, b.root, c.native.root); processes.push(a.ownerProcess.pid!, a.nativeProcessId!, b.ownerProcess.pid!, b.nativeProcessId!, c.native.ownerProcess.pid!, c.native.nativeProcessId!)
  const locals = await Promise.all([a, b, c.native].map(value => connectAgentMuxRpc({ endpoint: { transport: 'unix', path: value.socketPath } })))
  for (const rpc of locals) cleanup.push(() => rpc.dispose())
  const settings = await Promise.all(locals.map(rpc => until(() => rpc.call('settings.mesh.inspect', {}), value => value.identity !== null, 'original Core network identity')))
  const members = settings.map(value => ({ peerId: value.identity!.peerId, publicKey: value.identity!.publicKey }))
  const pa = await port(), pb = await port(), endpointA = { endpoint: `127.0.0.1:${pa}`, useTls: false }, endpointB = { endpoint: `127.0.0.1:${pb}`, useTls: false }
  const config = (self: MeshNetworkSettings, additions: Partial<MeshNetworkConfiguration>): MeshNetworkConfiguration => ({ ...self.configuration, role: 'participant', networkId: 'private-core-mesh-chain', members, ...additions })
  const configs = [
    config(settings[0]!, { role: 'gateway', listen: { host: '127.0.0.1', port: pa }, advertisedIngress: [endpointA], peers: [{ peerId: members[1]!.peerId, endpoints: [endpointB] }] }),
    config(settings[1]!, { role: 'gateway', listen: { host: '127.0.0.1', port: pb }, advertisedIngress: [endpointB], peers: [{ peerId: members[0]!.peerId, endpoints: [] }, { peerId: members[2]!.peerId, endpoints: [] }] }),
    config(settings[2]!, { peers: [{ peerId: members[1]!.peerId, endpoints: [endpointB] }], endpointAccess: { allowedClientKeys: [exportPublicKey(key.publicKey)] } }),
  ]
  const managedCredentials = { agentSessionId: c.session.agentSessionId, capability: c.managedEnv.AGENTMUX_AGENT_CAPABILITY }
  const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: c.native.socketPath }, credentials: managedCredentials }); cleanup.push(() => managed.dispose())
  expect((await managed.call('settings.mesh.inspect', {})).owner.runtimeId).toBe(c.native.owner.runtimeId)
  await expect(locals[2]!.call('settings.mesh.inspect', {}, { credentials: { ...managedCredentials, capability: 'unverified-local-caller' } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  await expect(locals[0]!.call('settings.mesh.configure', { expectedRevision: settings[0]!.revision, operationId: 'wrong-original-Core-target', configuration: configs[0]! }, { runtimeFence: { runtimeId: c.native.owner.runtimeId, ownerInstanceId: c.native.owner.ownerInstanceId } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect((await locals[0]!.call('settings.mesh.inspect', { operationId: 'wrong-original-Core-target' })).operation).toBeNull()
  const cliEnv = objectCliEnvironment(root, { HOME: clientHome })
  const cli = (endpoint: string, args: string[]) => runCompiledObjectCli(['--endpoint', endpoint, ...args], cliEnv, '', 30000)
  const paths = [a.socketPath, b.socketPath, c.native.socketPath]
  for (const [index, configuration] of configs.entries()) {
    const path = join(root, `configure-${index}.json`), operationId = `original-core-mesh-config-${index}`
    await writeFile(path, JSON.stringify({ expectedRevision: settings[index]!.revision, operationId, configuration }))
    const result = await cli('unix:' + paths[index], ['settings', 'mesh', 'configure', '--input', path])
    expect(result.code, result.stderr + result.stdout).toBe(0)
    const saved = JSON.parse(result.stdout).result
    expect(saved.diskDurability).toBe('confirmed')
    await until(() => locals[index]!.call('mesh.inspect', {}), value => value.activeRevision === saved.settings.revision, 'actual CLI save adopted by original Core')
  }
  // Semantic missing-wiring oracle: a transit-only participant cannot satisfy this assertion.
  expect((await locals[2]!.call('mesh.inspect', {})).endpoint.state).not.toBe('not-provided')
  const originalEndpoint = await until(() => locals[2]!.call('mesh.inspect', {}), value => value.endpoint.state === 'available', 'original Host automatic Mesh endpoint')
  if (originalEndpoint.endpoint.state !== 'available') throw Error('Original Host endpoint absent')
  const originalOffer = originalEndpoint.endpoint.offer
  const topology = await until(() => locals[0]!.call('mesh.inspect', {}), value => Boolean(value.network?.routes.some(route => route.serverId === originalOffer.serverId && route.hops === 2)), 'three-participant original endpoint route')
  expect(topology.owner.runtimeId).toBe(a.owner.runtimeId)
  const request = join(root, 'original-offer.json'); await writeFile(request, JSON.stringify({ offer: originalOffer }))
  const linked = await cli('unix:' + a.socketPath, ['mesh', 'link', '--input', request])
  expect(linked.code, linked.stderr + linked.stdout).toBe(0)
  const link = JSON.parse(linked.stdout).result
  expect(link.offer).toMatchObject({ serverId: originalOffer.serverId, daemonPublicKeyB64: originalOffer.daemonPublicKeyB64, relay: endpointA })
  expect(link.observation.route).toMatchObject({ path: members.map(member => member.peerId), hops: 2, serverId: originalOffer.serverId })
  const read = await cli(link.url, ['agent', 'inspect', '--session', c.session.agentSessionId])
  expect(read.code, read.stderr + read.stdout).toBe(0)
  expect(JSON.parse(read.stdout).result).toMatchObject({ session: { agentSessionId: c.session.agentSessionId, run: c.session.run } })
  const remote = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer: parseConnectionOfferUrl(link.url)! }, relayKeyPair: key }); cleanup.push(() => remote.dispose())
  expect((await remote.call('runtime.owner.identity', {})).owner).toEqual(c.native.owner)
  const priorA = await locals[0]!.call('mesh.inspect', {}), desiredA = await locals[0]!.call('settings.mesh.inspect', {})
  const unavailableListener = await locals[0]!.call('settings.mesh.configure', { expectedRevision: desiredA.revision, operationId: 'unavailable-new-A-listener', configuration: { ...configs[0]!, listen: { host: '127.0.0.1', port: pb } } })
  expect(unavailableListener.diskDurability).toBe('confirmed')
  await until(() => locals[0]!.call('mesh.inspect', {}), value => value.apply.state === 'unavailable', 'optional new listener failed without replacing active network')
  expect((await locals[0]!.call('mesh.inspect', {})).activeRevision).toBe(priorA.activeRevision)
  await expect(remote.call('runtime.owner.identity', {})).resolves.toEqual({ owner: c.native.owner })
  const beforeRun = (await c.client.statusAgent(c.session.agentSessionId)).run!; processes.push(beforeRun.pid!)
  const output: string[] = [], ends: unknown[] = []
  const subscription = await remote.subscribe('agent.output', { agentSessionId: c.session.agentSessionId, afterByte: 0, follow: true }, {
    onInitial: initial => expect(initial.run.runId).toBe(c.session.run.runId), onEvent: event => { if (event.type === 'output') output.push(Buffer.from(event.data.dataBase64, 'base64').toString('utf8')) }, onEnd: error => ends.push(error),
  }); cleanup.push(() => subscription.dispose())
  await until(() => c.client.statusAgent(c.session.agentSessionId), value => value.observation.semantic === 'idle', 'controlled Provider original idle hook')
  const input = join(root, 'original-input.json'), prompt = 'actual-three-hop-core-mesh-input', operationId = 'original-mesh-core-input'
  await writeFile(input, JSON.stringify({ prompt, expectedRun: c.session.run, afterSubmissionId: null, execution: 'immediate' }))
  const written = await cli(link.url, ['agent', 'input', 'submit', '--session', c.session.agentSessionId, '--operation-id', operationId, '--input', input])
  expect(written.code, written.stderr + written.stdout).toBe(0)
  const originalKey = JSON.parse(written.stdout).result.key
  expect(originalKey).toMatchObject({ submissionId: operationId, agentSessionId: c.session.agentSessionId, expectedRun: c.session.run })
  const nativePath = join(c.native.env.HOME!, '.codex', 'sessions', 'rollout-' + c.session.agentSessionId + '.jsonl')
  const accepted = await until(async () => (await readFile(nativePath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(value => value.type === 'response_item' && value.payload?.type === 'message' && value.payload.role === 'user').map(value => value.payload.content.map((part: { text?: string }) => part.text ?? '').join('')) as string[], value => value.filter(body => body.includes(prompt)).length === 1, 'actual Native accepted original CLI input once')
  const body = accepted.find(body => body.includes(prompt))!
  await until(() => output.join('').replaceAll('\r\n', '\n'), value => value.includes(`codex-submit:${body}:accepted`.replaceAll('\r\n', '\n')), 'independent multi-hop live output carries exact accepted Native body')
  const stranger = await connectAgentMuxRpc({ endpoint: { transport: 'relay', offer: link.offer }, relayKeyPair: generateKeyPair() }); cleanup.push(() => stranger.dispose())
  await expect(stranger.call('system.endpoint', {})).rejects.toBeDefined()
  await expect(remote.call('settings.mesh.inspect', {}, { credentials: managedCredentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(remote.call('settings.mesh.inspect', {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const current = await locals[2]!.call('settings.mesh.inspect', {})
  await locals[2]!.call('settings.mesh.configure', { expectedRevision: current.revision, operationId: 'revoke-original-device-pin', configuration: { ...configs[2]!, endpointAccess: { allowedClientKeys: [] } } })
  await until(() => ends.length, value => value > 0, 'only original revoked device reader ended')
  expect((await c.client.statusAgent(c.session.agentSessionId)).run).toMatchObject({ runId: c.session.run.runId, pid: beforeRun.pid, state: 'running' })
  expect((await locals[0]!.call('runtime.owner.identity', {})).owner).toEqual(a.owner)
  const beforeRestartOwner = c.native.owner
  const meshKeyPath = join(c.native.env.AGENTMUX_STATE_DIRECTORY!, 'mesh-network-peer.json'), retainedMeshKey = await readFile(meshKeyPath, 'utf8')
  await c.native.stopOwner(); await rm(meshKeyPath)
  await c.native.restart(); processes.push(c.native.ownerProcess.pid!)
  const restoredRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: c.native.socketPath } }); cleanup.push(() => restoredRpc.dispose())
  await until(() => restoredRpc.call('mesh.inspect', {}), value => value.apply.state === 'unavailable', 'missing original network key is unavailable without a replacement')
  await expect(readFile(meshKeyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await restoredRpc.call('system.endpoint', {})).publication?.state).toBe('available')
  const restoredClient = await c.native.client()
  expect((await restoredClient.readAgentSession(c.session.agentSessionId))?.run).toEqual(c.session.run)
  expect((await restoredClient.statusAgent(c.session.agentSessionId)).run).toMatchObject({ runId: c.session.run.runId, pid: beforeRun.pid, state: 'running' })
  expect(c.native.owner.runtimeId).toBe(beforeRestartOwner.runtimeId)
  expect(c.native.owner.ctxmux?.instanceId).toBe(beforeRestartOwner.ctxmux?.instanceId)
  expect(c.native.owner.ownerInstanceId).not.toBe(beforeRestartOwner.ownerInstanceId)
  await writeFile(meshKeyPath, retainedMeshKey, { mode: 0o600 })
  const retainedSettings = await restoredRpc.call('settings.mesh.inspect', {})
  const resumed = await restoredRpc.call('settings.mesh.configure', { expectedRevision: retainedSettings.revision, operationId: 'restore-exact-original-network-key', configuration: retainedSettings.configuration })
  const restoredMesh = await until(() => restoredRpc.call('mesh.inspect', {}), value => value.activeRevision === resumed.settings.revision && value.endpoint.state === 'available', 'same original network identity resumes after exact key restoration')
  expect(restoredMesh.identity).toMatchObject({ peerId: members[2]!.peerId, publicKey: members[2]!.publicKey, epoch: 2 })
  if (restoredMesh.endpoint.state !== 'available') throw Error('Restored original endpoint absent')
  expect(restoredMesh.endpoint.offer).toMatchObject({ serverId: originalOffer.serverId, daemonPublicKeyB64: originalOffer.daemonPublicKeyB64 })
  expect((await restoredClient.statusAgent(c.session.agentSessionId)).run).toMatchObject({ runId: c.session.run.runId, pid: beforeRun.pid, state: 'running' })
  await writeFile(resolve('.local/state/mesh-network-access/core-joined-behavior.json'), JSON.stringify({ behaviorAssertionsPassed: true, topology: { ownerPids: [a.ownerProcess.pid, b.ownerProcess.pid, c.native.ownerProcess.pid], nativePids: [a.nativeProcessId, b.nativeProcessId, c.native.nativeProcessId], runPid: beforeRun.pid }, scope: 'Actual private headless CLI/Core/Host and official Native daemons with a controlled Provider PTY. No user Session/home, CN1, Desktop install or upstream model operation.', originalSession: c.session.agentSessionId, originalRun: c.session.run, originalRuntime: c.native.owner.runtimeId, originalKey, originalPublisher: originalOffer.serverId, daemonPublicKey: originalOffer.daemonPublicKeyB64, path: link.observation.route.path, liveOutputSeen: true, nativeAcceptedCount: 1, revokedReaderEnded: true, originalRunAlive: true, missingKeyRetainedWithoutReplacement: true, originalNetworkIdentityRestored: true, restoredEpoch: restoredMesh.identity!.epoch }))
}, 150000)
