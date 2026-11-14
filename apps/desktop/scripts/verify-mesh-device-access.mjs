import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mobileWebFixture } from '../../host/test/helpers/mobile-web-fixture.ts'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.ts'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.ts'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state.ts'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.ts'
import { loadMobileSnapshot } from '../../host/src/mobile-assets.ts'

const root = resolve(import.meta.dirname, '../../..')
const mobile = join(root, 'apps/mobile')
const mobileRequire = createRequire(join(mobile, 'package.json'))
const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'))
const vite = mobileRequire.resolve('vite/package.json')
const build = createRequire(vite)('esbuild').build
const work = await mkdtemp(join(tmpdir(), 'mesh-device-'))
const cleanups = []
let failed
try {
  const builder = spawn(process.execPath, [join(dirname(vite), 'bin/vite.js'), 'build', '--outDir', join(work, 'mobile')], { cwd: mobile, stdio: 'inherit' })
  assert.equal((await once(builder, 'exit'))[0], 0, 'Actual device client build')
  const snapshot = await loadMobileSnapshot(join(work, 'mobile'))
  assert(!snapshot.files.has('device.html'), 'The private local document stays outside Web service')
  await build({ entryPoints: [join(root, 'apps/desktop/src/main/mesh-device-window.ts')], bundle: true, platform: 'node', format: 'esm',
    external: ['electron'], outfile: join(work, 'window.mjs') })

  const device = await mobileWebFixture({ nativeRecord: true })
  cleanups.push(device.close)
  const gateway = await headlessFixture({ cli: true })
  cleanups.push(gateway.cleanup)
  const source = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: device.native.socketPath } })
  const ingress = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: gateway.socketPath } })
  cleanups.push(() => source.dispose(), () => ingress.dispose())
  const workspace = device.native.root
  const spatial = new AgentMuxSpatialStateStore(join(device.native.env.AGENTMUX_STATE_DIRECTORY, 'spatial-state.json'))
  const spaceId = JSON.stringify(['local', workspace])
  const graph = {
    spaces: [{ spaceId, kind: 'folder', name: 'Original project', hostId: 'local', directoryPath: workspace, projectId: spaceId }],
    zones: [{ zoneId: 'device-zone', workspaceId: 'device-workspace', kind: 'directory', hostId: 'local', directoryPath: workspace, branch: null }],
    tabs: [{ tabId: 'device-tab', zoneId: 'device-zone', workspaceId: 'device-workspace', name: 'Original work', regionIds: ['device-region'] }],
    regions: [{ tabId: 'device-tab', regionId: 'device-region', kind: 'agent', agentSessionId: device.session.agentSessionId,
      runId: device.session.run.runId, execution: { hostId: 'local', cwd: workspace } }],
    bindings: [{ spaceId, zoneId: 'device-zone' }],
    layouts: { 'device-workspace': createWorkspaceLayout('device-group', ['device-tab']) },
    tabLayouts: { 'device-tab': createWorkbenchViewLayout('device-region') }, resources: {},
  }
  await spatial.commit({ expectedRevision: 0, graph })
  await spatial.mutateDisplayLabel({ target: { kind: 'agent-session', id: device.session.agentSessionId }, operationId: 'device-label',
    expectedNameRevision: 0, value: 'Original device agent', source: 'manual' },
    { actor: { kind: 'user', id: 'fixture-owner', verified: true }, source: 'explicit-edit', entryPoint: 'fixture', transport: 'unix', location: {} })
  const [hostSettings, gatewaySettings] = await Promise.all([source, ingress].map(client => until(
    () => client.call('settings.mesh.inspect', {}), value => !!value.identity, 'Core identity')))
  const members = [hostSettings, gatewaySettings].map(({ identity }) => ({ peerId: identity.peerId, publicKey: identity.publicKey }))
  async function configure(client, settings, changes, operationId) {
    return (await client.call('settings.mesh.configure', { expectedRevision: settings.revision, operationId,
      configuration: { ...settings.configuration, ...changes } })).settings
  }
  const network = { networkId: 'mesh-device-test', members }
  const listening = await configure(ingress, gatewaySettings, { ...network, role: 'gateway', peers: [{ peerId: hostSettings.identity.peerId, endpoints: [] }],
    listen: { host: '127.0.0.1', port: 0 } }, 'listen')
  const gatewayState = await until(() => ingress.call('mesh.inspect', {}), value => value.gateway.state === 'listening', 'Private gateway listener')
  const address = { endpoint: '127.0.0.1:' + gatewayState.gateway.listener.port, useTls: false }
  await configure(ingress, listening, { advertisedIngress: [address] }, 'advertise')
  const joined = await configure(source, hostSettings, { ...network, role: 'participant', peers: [{ peerId: gatewaySettings.identity.peerId, endpoints: [address] }],
    endpointAccess: { allowedClientKeys: [] } }, 'join')
  const original = (await until(() => source.call('mesh.inspect', {}), value => value.endpoint.state === 'available', 'Target endpoint')).endpoint.offer
  await until(() => ingress.call('mesh.inspect', {}), value => value.network?.routes.some(route => route.serverId === original.serverId), 'Gateway route')
  const { url, observation } = await ingress.call('mesh.link', { offer: original })
  assert(observation.route.hops > 0, 'The gateway must forward to the original device')
  const policy = await source.call('settings.node.inspect', {})
  await source.call('settings.node.configure', { operationId: 'publish-location', expectedRevision: policy.policyRevision, policy: { ...policy.policy,
    mapLocation: { label: 'Private office', coordinates: '0, 0', estimatePublicEgress: false } } })
  const recording = join(device.native.env.HOME, '.codex/sessions', 'rollout-' + device.session.agentSessionId + '.jsonl')
  await until(() => readFile(recording, 'utf8'), bytes => bytes.includes('task_complete'), 'Original Provider finished its initial turn')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const probe = spawn(desktopRequire(join(dirname(desktopRequire.resolve('electron/package.json')), 'index.js')), [join(root, 'apps/desktop/test/fixtures/mesh-device-workspace.cjs'), work, url],
    { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  cleanups.push(() => { if (probe.exitCode === null && probe.signalCode === null) probe.kill() })
  const exited = once(probe, 'exit')
  const approved = once(probe, 'message').then(async ([message]) => {
    assert.match(message.publicKey, /^[a-zA-Z0-9+/]{43}=$/)
    await configure(source, joined, { endpointAccess: { allowedClientKeys: [message.publicKey] } }, 'approve-original-reader')
    console.log('Original endpoint approved the device key')
    const submission = once(probe, 'message')
    probe.send({ approved: true })
    assert.equal((await submission)[0].submitted, true)
    const replay = await until(async () => (await device.client.readRunReplay(device.session.run, 0, 'raw')).replay.map(event => event.data).join(''),
      bytes => bytes.includes('codex-submit:Mesh private round trip:accepted'), 'Original PTY accepted the request')
    assert.equal(replay.split('codex-submit:Mesh private round trip:accepted').length - 1, 1)
    probe.send({ submitted: true })
  })
  await Promise.race([approved, exited.then(() => { throw Error('Device window exited before pairing') })])
  assert.equal((await exited)[0], 0, 'Device window did not finish the original task and recovery')
  console.log('Electron verified conversation, terminal and draft continuity')
  const submitted = await until(async () => (await readFile(recording, 'utf8')).trim().split('\n').map(JSON.parse).filter(row =>
    row.type === 'response_item' && row.payload.role === 'user' && row.payload.content.some(item => item.text?.includes('Mesh private round trip'))),
    rows => rows.length > 0, 'Native Provider record for the authored task')
  assert.equal(submitted.length, 1, 'Exactly one input reached the original Provider process')
  const inspection = await source.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: device.session.agentSessionId } })
  assert.equal(inspection.status.run.runId, device.session.run.runId)
  assert.equal(inspection.status.run.state, 'running')
  console.log(JSON.stringify({ paired: true, hops: observation.route.hops, originalRunId: inspection.status.run.runId,
    nativeInputs: submitted.length, draftRestored: true, terminalRead: true, sourceLocationRead: true }))
} catch (error) {
  failed = error
} finally {
  for (const close of cleanups.reverse()) {
    try { await close() } catch (error) { console.error('Private fixture cleanup:', error.message); failed ??= error }
  }
  await rm(work, { recursive: true, force: true })
}
if (failed) throw failed
