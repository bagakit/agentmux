import './agent-information-loader.mjs'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [root] = process.argv.slice(2), candidate = process.env.AMX_INFORMATION_CANDIDATE
if (!root || !candidate) throw new Error('The native product test requires its exact candidate and private directory.')
const load = name => import(pathToFileURL(join(candidate, 'core/dist', name + '.js')).href)
const { AgentMuxClient } = await load('client'), { AgentMuxFileAgentSessionStore } = await load('agent-session-store')
const { AgentMuxControlServer } = await load('public-rpc-server')
const { nativeProcessTcpListeners } = await load('agent-native-process')
const { connectCodexNativeActor } = await import('@agentmux/providers/codex/native-rpc')
const command = process.env.AGENTMUX_TEST_CODEX_BINARY ?? 'codex'
const version = execFileSync(command, ['--version'], { encoding: 'utf8' }).trim()
const home = join(root, 'native-home'); await mkdir(home)
const network = [], connections = new Set()
const offline = createServer((request, response) => {
  network.push({ method: request.method, url: request.url })
  response.setHeader('content-type', 'application/json'); response.end('{"data":[]}')
})
offline.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)) })
await new Promise(resolve => offline.listen(0, '127.0.0.1', resolve))
const offlineAddress = offline.address()
const configPath = join(home, 'config.toml')
await writeFile(configPath, 'model_provider="information_fixture"\n[model_providers.information_fixture]\nname="Private information protocol"\n' +
  `base_url="http://127.0.0.1:${offlineAddress.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`)
const originalConfig = await readFile(configPath, 'utf8'), token = randomBytes(32).toString('hex')
const native = spawn(command, ['app-server', '--listen', 'ws://127.0.0.1:0', '--ws-auth', 'capability-token',
  '--ws-token-sha256', createHash('sha256').update(token).digest('hex')], {
  cwd: root, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, LANG: 'C' },
  detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
let diagnostics = '', exited = false
native.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4096) })
const closed = new Promise(resolve => native.once('close', code => { exited = true; resolve(code) }))
let control, client, original
const lifetime = AbortSignal.timeout(40000), nativeMethods = [], nativeNotifications = []
let runtimeWrites = 0, closing = false
const close = async () => {
  if (closing) return
  closing = true
  try {
    await control?.stop(); await client?.dispose(); original?.dispose()
    if (!exited) { native.kill('SIGTERM'); await closed }
    for (const socket of connections) socket.destroy()
    await new Promise(resolve => offline.close(resolve))
  } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1 }
}
try {
  let listener
  for (let attempt = 0; attempt < 100; attempt++) {
    if (exited) throw new Error('Private native actor exited: ' + diagnostics)
    const listeners = await nativeProcessTcpListeners(native.pid, lifetime)
    if (listeners.length === 1) { listener = listeners[0]; break }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (!listener) throw new Error('The private original native listener is unavailable: ' + diagnostics)
  original = await connectCodexNativeActor(listener.endpoint, token, lifetime, 'agentmux_native_input', {
    onNotification: (method, params) => nativeNotifications.push({ method, params }) })
  const call = async (method, params) => { nativeMethods.push(method); return await original.request(method, params) }
  const catalog = await call('model/list', { modelProvider: 'information_fixture', limit: 100, includeHidden: false })
  const choices = catalog.data.filter(model => !model.hidden)
  assert.ok(choices.length >= 2, 'The actual native catalog must offer two different selectable models.')
  const initialModel = choices[0].model, selectedModel = choices[1].model
  const started = await call('thread/start', { cwd: root, modelProvider: 'information_fixture', model: initialModel,
    sandbox: 'read-only', approvalPolicy: 'never' })
  const nativeId = started.thread.id
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const id = 'codex-information-original', runId = 'codex-information-original-run'
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: root, run: { runId }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-information-binding', hookToken: 'private-information-hook-token',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeId },
    nativeActor: { protocolId: 'codex-app-server-v2-0.163', actorId: 'private-information-actor', lifecycleOperationId: 'private-information-lifecycle',
      token, launch: { command, args: [] } } })
  client = new AgentMuxClient({ store }); await client.registry.load('local'); client.connected = true
  client.kernel.isConnected = () => true
  client.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'private-information-runtime', instanceId: 'private-information-instance', buildIdentity: 'private-fixture', protocolVersion: 1 })
  const run = { runId, lifecycleOperationId: null, program: command, args: [], workspacePath: root, pid: native.pid,
    state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null }
  client.kernel.status = async requested => { assert.equal(requested, runId); return structuredClone(run) }
  client.kernel.list = async () => [structuredClone(run)]
  for (const method of ['input', 'openInput', 'start', 'stop']) client.kernel[method] = async () => {
    runtimeWrites++; throw new Error('Native information cannot write Runtime input or lifecycle: ' + method)
  }
  control = new AgentMuxControlServer({ socketPath: join(root, 'native-information.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await control.start()
  process.send?.({ type: 'ready', endpoint: control.path, input: { hostId: 'local', agentSessionId: id, expectedRun: { runId } },
    nativeId, nativePid: native.pid, initialModel, selectedModel, version })
  process.on('message', async message => {
    try {
      if (message?.type === 'stats') {
        // An untouched empty native thread is not materialized; includeTurns is deliberately
        // unavailable before its first user message. Read only the original loaded settings.
        const value = await call('thread/read', { threadId: nativeId, includeTurns: false })
        process.send?.({ type: 'stats', thread: value.thread, runtimeWrites, network, nativeMethods,
          turnEvents: nativeNotifications.filter(event => ['turn/started', 'turn/completed'].includes(event.method)).length,
          configUnchanged: await readFile(configPath, 'utf8') === originalConfig, exited })
      } else if (message?.type === 'close') { await close(); process.exit(process.exitCode ?? 0) }
    } catch (error) { process.stderr.write(String(error) + '\n'); await close(); process.exit(1) }
  })
} catch (error) { process.stderr.write(String(error) + '\n'); await close(); process.exit(1) }
