import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, connectAgentMuxRpc } from '../../../../packages/core/src/index.ts'
import { issueAgentCapability, hashAgentCapability } from '../../../../packages/core/src/agent-capability.ts'
import { startAgentMuxHost } from '../../src/host.ts'
const root = process.argv[2], store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
const capability = issueAgentCapability(), previous = await store.readMetadata('managed-agent')
await store.compareAndSwap(previous, { kind: 'agent', agentSessionId: 'managed-agent', hostId: 'local', providerId: 'codex', executorId: 'codex', workspacePath: root,
  run: { runId: 'original-managed-run' }, retiredRuns: [], hookBindingId: 'fixture-hook', hookToken: 'fixture-token', capabilityHash: hashAgentCapability(capability), createdAt: previous?.createdAt ?? 1, updatedAt: 1 })
// Control only original Runtime connectivity I/O. No Agent is created/restarted/input here.
AgentMuxClient.prototype.connect = async function () { await this.registry.load('local'); this.connected = true; this.kernel.isConnected = () => false }
let credentialCalls = 0
const host = await startAgentMuxHost({ store, socketPath: join(root, 'host.sock'), desktopSocketPath: join(root, 'absent-desktop.sock'), mobileBuildDirectory: join(root, 'absent-mobile'), connections: {
  directory: join(root, 'connections'), adapters: [{ adapterId: 'private-consumer', test: async (config, credential) => ({
    authentication: createHash('sha256').update(credential).digest('hex') === config.application.appId ? { state: 'ready' } : { state: 'unavailable', reason: 'check-failed' },
    transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' }
  }) }]
} })
const service = host.server.service, original = service.ports.connections
// Count original credential-port dispatch, preserving the actual Host target/authority/storage consumers.
service.ports.connections = new Proxy(original, { get(target, key) { if (key !== 'credential') return Reflect.get(target, key)
  return { store: async (...args) => { credentialCalls++; return await target.credential.store(...args) }, inspect: (...args) => target.credential.inspect(...args) }
} })
process.on('message', message => { void (async () => {
  try {
    let value
    if (message.operation === 'facts') { await (await host.deviceAuthority()).flush(); value = { credentialCalls, devices: await readFile(join(root, 'agentmux-devices.json'), 'utf8') } }
    else if (message.operation === 'device-store') {
      const authority = await host.deviceAuthority(), key = randomBytes(32).toString('base64'), device = await authority.authorizeKey(key), observed = authority.observe(device)
      let reply
      const frames = host.server.openAuthenticatedFrames({ authorization: { principal: { kind: 'device', id: device.deviceId }, signal: observed.signal,
        assertCurrent: () => authority.assertCurrentKey(device, key) }, send: frame => { reply = frame }, close() {} })
      try { await frames.receive({ jsonrpc: '2.0', id: 'original-device-credential', method: 'connection.credential.store', params: { ...message.input, runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } } }); await authority.flush(); value = { reply, device: authority.devices().find(current => current.deviceId === device.deviceId) } }
      finally { frames.dispose(); observed.dispose() }
    }
    else if (message.operation === 'stop') { await host.dispose(); process.send({ id: message.id, value: true }, () => process.exit(0)); return }
    else throw Error('Unknown synthetic control')
    process.send({ id: message.id, value })
  } catch (error) { process.send({ id: message.id, error: { code: error.code ?? 'FIXTURE_FAILED', message: error.message } }) }
})() })
process.once('disconnect', () => { void host.dispose().finally(() => process.exit(0)) })
const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'host.sock') } })
const { owner } = await client.call('runtime.owner.identity', {}); await client.dispose()
process.send({ kind: 'ready', pid: process.pid, owner, capability })
