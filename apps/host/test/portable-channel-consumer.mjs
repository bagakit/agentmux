// Real portable/default Host, Core, Provider and ctxmux; controlled CLI and SDK network leaves.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire, registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'

const host = resolve(process.argv[2]), report = resolve(process.argv[3])
const entry = resolve(process.argv[4] ?? join(host, 'dist/index.js'))
const corePath = await realpath(join(host, 'node_modules/@agentmux/core'))
const core = await import(pathToFileURL(join(corePath, 'dist/index.js')).href)
const discordFixture = resolve(process.argv[5] ?? join(import.meta.dirname, '../../../packages/connectors/test/fixtures/discord.ts'))
const connectors = join(host, 'node_modules/@agentmux/connectors/package.json')
const require = createRequire(existsSync(connectors) ? connectors : join(host, 'package.json'))
const resolution = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'ws' && context.parentURL === pathToFileURL(discordFixture).href) return { url: pathToFileURL(join(dirname(require.resolve('ws')), 'wrapper.mjs')).href, shortCircuit: true }
  return next(specifier, context)
} })
const { discordTransport, discordConfig, discordRoomId } = await import(pathToFileURL(discordFixture).href)
resolution.deregister()
let wire
const root = await realpath(await mkdtemp(join(process.env.HOST_CHANNEL_WORK_DIRECTORY ?? tmpdir(), 'channel-proof-')))
const runtime = join(root, 'r'), state = join(root, 's'), nativeDirectory = join(root, 'native'), witness = join(root, 'witness.jsonl')
await mkdir(runtime, { mode: 0o700 }); await mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 }); await mkdir(join(root, 'home'), { mode: 0o700 })
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
const env = { ...clean, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
  AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'),
  AGENTMUX_SPATIAL_STATE_STORE: join(root, 'spatial.json'), AGENTMUX_CONNECTOR_DIRECTORY: join(root, 'connections'),
  AGENTMUX_MOBILE_BUILD_DIRECTORY: join(root, 'absent-mobile'), HOST_CHANNEL_PACKAGE_ROOT: host }
const facts = { schema: 'agentmux.portable-channel-consumer.v1', passed: false, platform: process.platform, arch: process.arch,
  node: process.versions.node, boundary: 'Controlled executable CLI and official SDK network leaves; real original default Host/Core/Provider/ctxmux. Local feasibility is separate from Linux SSH qualification.', steps: [] }
facts.inputs = []
for (const path of [entry, join(corePath, 'dist/index.js'), join(corePath, 'dist/agentmux.js'), join(corePath, 'dist/client.js'), join(corePath, 'dist/providers/claude.js'),
  join(corePath, 'vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd'), discordFixture,
  resolve(import.meta.dirname, 'portable-channel-consumer.mjs'), resolve(import.meta.dirname, 'fixtures/portable-channel-native-cli.mjs'), resolve(import.meta.dirname, 'fixtures/portable-channel-network.mjs')]) {
  facts.inputs.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
}
const manifest = join(resolve(host, '../../..'), 'portable-host.json')
if (existsSync(manifest)) {
  const bytes = await readFile(manifest), value = JSON.parse(bytes)
  facts.artifact = { path: manifest, sha256: createHash('sha256').update(bytes).digest('hex'), digest: value.digest, runtime: value.runtime }
}
const children = [], clients = []
const control = process.env.HOST_CHANNEL_REMOTE_CONTROL === '1' ? createInterface({ input: process.stdin }) : undefined
const commands = control?.[Symbol.asyncIterator]()
let session, hosted, owner
function child(command, args, stdio) {
  const process = spawn(command, args, { env, stdio }), result = { process, stderr: '', stdout: '', exit: undefined }
  process.stderr?.on('data', data => { result.stderr += data })
  process.stdout?.on('data', data => { result.stdout += data })
  result.exit = new Promise(done => {
    process.once('exit', (code, signal) => done({ code, signal }))
    process.once('error', error => { result.stderr += error.message; done({ error: error.message }) })
  })
  children.push(result); return result
}
async function until(read, accept, label) {
  const end = Date.now() + 30_000
  for (;;) { const value = await read(); if (accept(value)) return value
    if (value?.run?.state === 'exited') throw Error('Original native CLI exited before ' + label)
    if (Date.now() > end) throw Error('Native seam did not confirm ' + label)
    await new Promise(done => setTimeout(done, 50)) }
}
const witnessRows = async () => (await readFile(witness, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
async function startOwner() {
  owner = child(process.execPath, ['--import', resolve(import.meta.dirname, 'fixtures/portable-channel-network.mjs'), entry, '--store', env.AGENTMUX_AGENT_SESSION_STORE], ['ignore', 'pipe', 'pipe'])
  await Promise.race([until(() => owner.stdout, text => text.split('\n').some(line => { try { return JSON.parse(line).protocol === 'jsonrpc-2.0' } catch { return false } }), 'default Host receipt'),
    owner.exit.then(value => { throw Error('Default Host early exit ' + JSON.stringify(value) + ': ' + owner.stderr) })])
  return owner.stdout.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.protocol === 'jsonrpc-2.0')
}
async function connect() {
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } }); clients.push(rpc)
  hosted = await core.connectHostedAgentMux({ rpc }); clients.push(hosted); await hosted.connect()
  return rpc
}
async function disconnect() { for (const client of clients.splice(0).reverse()) await client.dispose(); hosted = undefined }
async function checkpoint(stage, identity) {
  if (!commands) return
  const check = { stage, owner: identity.owner, socketPath: join(runtime, 'control.sock'), agentSessionId: session.agentSessionId,
    runId: session.run.runId, native: facts.steps[0].nativeHandle, managementClients: clients.length,
    artifact: facts.artifact, cli: facts.inputs.find(value => value.path === join(corePath, 'dist/agentmux.js')) }
  process.stdout.write(JSON.stringify({ checkpoint: check }) + '\n')
  const line = await commands.next()
  assert.equal(line.done, false, 'SSH test controller must retain the original checkpoint')
  const response = JSON.parse(line.value)
  assert.equal(response.stage, stage)
  assert.equal(response.runtimeId, identity.owner.runtimeId)
  assert.equal(response.runId, session.run.runId)
  assert.equal(response.clientsDisposed, true)
  facts.steps.push({ step: 'ssh-controller-released', ...response })
}
const copies = text => wire.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages' && call.body.includes(text)).length
async function independentInput(id, text, count) {
  assert.equal(clients.length, 0, 'Every management client is disconnected before native ingress')
  wire.message(id, text)
  const rows = await until(witnessRows, values => values.filter(value => value.kind === 'input').length === count, 'new original CLI input without clients')
  assert.ok(rows.every(row => row.pid === facts.steps[0].pid && row.nativeId === facts.steps[0].nativeHandle.sessionId), 'Every input belongs to the original native process and conversation')
  const input = rows.filter(value => value.kind === 'input').at(-1)
  assert.ok(input.text.includes(text))
  const reply = 'Controlled reply: ' + createHash('sha256').update(input.text).digest('hex')
  await until(() => copies(reply), value => value === 1, 'new native public reply without clients')
  facts.steps.push({ step: 'disconnected-native-input', messageId: id, managementClients: clients.length, inputCount: count, publicReplyCopies: copies(reply), samePid: rows.every(row => row.pid === facts.steps[0].pid), reply })
  return reply
}
try {
  wire = await discordTransport(); env.HOST_CHANNEL_PLATFORM_ORIGIN = wire.origin
  const daemon = child(join(corePath, 'bin/ctxmuxd'), ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], ['ignore', 'ignore', 'pipe', 'pipe'])
  await Promise.race([once(daemon.process.stdio[3], 'data'), daemon.exit.then(value => { throw Error('Native early exit ' + JSON.stringify(value) + daemon.stderr) })])
  daemon.process.stdio[3].destroy()
  const first = await startOwner()
  let rpc = await connect()
  const executable = join(root, 'native-cli.mjs')
  await writeFile(executable, '#!' + process.execPath + '\nawait import(' + JSON.stringify(pathToFileURL(resolve(import.meta.dirname, 'fixtures/portable-channel-native-cli.mjs')).href) + ');\n', { mode: 0o700 })
  session = await hosted.createAgent({ providerId: 'claude', executorId: 'claude', workspacePath: root, createOperationId: 'original-channel-native',
    commandOverride: executable, injectAgentMuxGuide: false, env: { HOST_CHANNEL_NATIVE_DIRECTORY: nativeDirectory, HOST_CHANNEL_NATIVE_WITNESS: witness } })
  const original = await until(() => hosted.statusAgent(session.agentSessionId), value => value.session.nativeHandle?.providerId === 'claude' && value.session.currentActivity?.state === 'idle', 'original native identity and idle activity')
  facts.steps.push({ step: 'original-native-ready', sessionId: session.agentSessionId, runId: session.run.runId, pid: original.run.pid, nativeHandle: original.session.nativeHandle })
  // The compiled CLI must consume stdin without placing the synthetic credential in argv.
  const credentialProcess = spawn(process.execPath, [join(corePath, 'dist/agentmux.js'), '--endpoint', 'unix:' + join(runtime, 'control.sock'), 'connection', 'credential', 'store', '--operation-id', 'original-credential', '--secret-stdin'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; credentialProcess.stdout.on('data', value => { stdout += value }); credentialProcess.stderr.on('data', value => { stderr += value })
  credentialProcess.stdin.end('synthetic-discord-token')
  assert.equal((await once(credentialProcess, 'exit'))[0], 0, stderr)
  const credential = JSON.parse(stdout).result
  const config = { ...discordConfig, credentialRef: credential.credentialRef }
  await rpc.call('connection.configure', { operationId: 'original-configure', expectedRevision: null, connection: config })
  const binding = await rpc.call('connection.bind', { operationId: 'original-bind', bindingId: 'original-binding', connectionId: config.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: session.agentSessionId, externalConversationId: discordRoomId,
    expectedSource: { providerId: 'claude', nativeSessionId: original.session.nativeHandle.sessionId }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
  assert.equal(binding.state, 'applied')
  await rpc.call('connection.grant', { operationId: 'original-grant', grantId: 'original-member', bindingId: binding.binding.bindingId,
    expectedBindingRevision: 1, expectedRevision: null, actor: { application: config.application, idType: 'snowflake', userId: '400' }, capabilities: ['input'], state: 'active' })
  await disconnect()
  await until(() => wire.sessions.length, value => value === 1, 'original official Gateway')
  await checkpoint('configured', first)
  const firstReply = await independentInput('701', 'New input while every management client is disconnected', 1)
  rpc = await connect()
  const before = await rpc.call('connection.ingress.ls', { connectionId: config.connectionId })
  const originalIngress = before.ingresses[0]
  const inspect = await rpc.call('connection.ingress.inspect', { ingressId: originalIngress.ingressId })
  assert.equal(inspect.inputReceipt.status, 'terminal-confirmed')
  const originalDeliveries = await until(() => rpc.call('connection.delivery.ls', { connectionId: config.connectionId, bindingId: 'original-binding', bindingRevision: 1 }),
    page => page.deliveries.some(value => value.reference.source.kind === 'native' && value.state === 'confirmed'), 'original native publication receipt')
  facts.steps.push({ step: 'original-receipts', ingress: inspect, deliveries: originalDeliveries })
  await disconnect(); owner.process.kill('SIGTERM'); await owner.exit
  const reopened = await startOwner(); rpc = await connect()
  assert.equal(reopened.owner.runtimeId, first.owner.runtimeId); assert.notEqual(reopened.owner.ownerInstanceId, first.owner.ownerInstanceId)
  const retained = await hosted.statusAgent(session.agentSessionId)
  assert.equal(retained.run.runId, original.run.runId); assert.equal(retained.run.pid, original.run.pid)
  const after = await rpc.call('connection.ingress.ls', { connectionId: config.connectionId })
  assert.deepEqual(after.ingresses.map(value => [value.ingressId, value.input]), before.ingresses.map(value => [value.ingressId, value.input]))
  const retainedDeliveries = await rpc.call('connection.delivery.ls', { connectionId: config.connectionId, bindingId: 'original-binding', bindingRevision: 1 })
  for (const delivery of originalDeliveries.deliveries) assert.deepEqual(retainedDeliveries.deliveries.find(value => value.operationId === delivery.operationId), delivery)
  await disconnect(); await until(() => wire.sessions.length, value => value === 2, 'reopened official Gateway')
  await checkpoint('reopened', reopened)
  wire.message('701', 'New input while every management client is disconnected')
  await independentInput('702', 'New input after original Host namespace reopens', 2)
  assert.equal(copies(firstReply), 1)
  assert.equal(copies('Original private transcript before sharing'), 0)
  facts.steps.push({ step: 'same-owner-namespace-reopen', original: first.owner, reopened: reopened.owner, sameRunId: original.run.runId, originalIngressId: originalIngress.ingressId, originalInput: originalIngress.input, sameDatabase: join(env.AGENTMUX_CONNECTOR_DIRECTORY, 'connections.sqlite') })
  facts.passed = true
} catch (error) {
  facts.failure = { name: error.name, code: error.code, message: error.message, stack: error.stack }; process.exitCode = 1
  facts.witness = await witnessRows()
  if (session && !hosted && owner?.process.exitCode === null) await connect().catch(value => { facts.diagnosticFailure = value.message })
  if (session && hosted) {
    facts.status = await hosted.statusAgent(session.agentSessionId).catch(value => ({ error: value.message }))
    facts.replay = await hosted.readRunReplay(session.run).catch(value => ({ error: value.message }))
  }
}
finally {
  if (session && !hosted && owner?.process.exitCode === null) await connect().catch(() => {})
  if (session && hosted) await hosted.stopAgent(session.agentSessionId, session.run).catch(error => { facts.cleanupFailure = error.message; facts.passed = false; process.exitCode = 1 })
  for (const client of clients.reverse()) await client.dispose().catch(() => {})
  facts.processes = children.map(value => ({ stdout: value.stdout, stderr: value.stderr }))
  for (const value of children.reverse()) if (value.process.exitCode === null && value.process.signalCode === null) { value.process.kill('SIGTERM'); await value.exit }
  if (wire) { facts.nativeTransport = { calls: wire.calls, gatewaySessions: wire.sessions.length }; await wire.close() }
  control?.close()
  await rm(root, { recursive: true, force: true })
  await writeFile(report, JSON.stringify(facts, null, 2) + '\n')
}
