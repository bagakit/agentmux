import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { connectAgentMuxRpc } from '../../../packages/core/dist/public-rpc-client.js'
import { connectHostedAgentMux } from '../../../packages/core/dist/hosted-client.js'
import { ensureMacosHostService, inspectMacosHostProcess, macosHostService, macosHostServiceRegistration,
  reloadReplacedMacosHost } from '../../host/dist/macos-service.js'

assert.equal(process.platform + '-' + process.arch, 'darwin-arm64')
assert.ok(process.argv.slice(2).every(arg => arg === '--foreground' || arg === '--slow-host'))
const foreground = process.argv.includes('--foreground')
const slowHost = process.argv.includes('--slow-host')
const exec = promisify(execFile)
const root = await mkdtemp(join(await realpath(tmpdir()), 'amux-reload-'))
const runtime = join(root, 'r'), state = join(root, 's'), socket = join(runtime, 'control.sock')
const store = join(state, 'sessions.json')
const app = join(root, 'AgentMux.app'), backup = join(root, 'Previous.app'), staged = join(root, 'Candidate.app')
const relativeExecutable = 'Contents/MacOS/AgentMux', relativeEntry = 'Contents/Resources/app/out/main/agentmux-host.js'
const host = pathToFileURL(resolve(import.meta.dirname, '../../host/dist/index.js')).href
const daemonPath = resolve(import.meta.dirname, '../../../packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd')
for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) delete process.env[key]
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
  AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson') })
const service = macosHostService({ executable: join(app, relativeExecutable), entrypoint: join(app, relativeEntry),
  socketPath: socket, storePath: store, mobileBuildDirectory: join(app, 'Contents/Resources/app/out/mobile') })
let daemon, previousHost, rpc, client
const delay = ms => new Promise(done => setTimeout(done, ms))
async function observe(read, matches, label) {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = await read()
    if (matches(value)) return value
    if (Date.now() >= deadline) throw new Error(label)
    await delay(40)
  }
}
const connect = async () => {
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
  client = await connectHostedAgentMux({ rpc, expectedStorePath: store })
}
const disconnect = async () => { await client?.dispose(); await rpc?.dispose(); client = rpc = undefined }
const owner = async () => (await rpc.call('runtime.owner.identity', {})).owner
try {
  await mkdir(runtime, { mode: 0o700 })
  await mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 })
  for (const bundle of [app, staged]) {
    await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true })
    const entry = join(bundle, relativeEntry)
    await mkdir(resolve(entry, '..'), { recursive: true })
    await exec('/bin/cp', ['-c', await realpath(process.execPath), join(bundle, relativeExecutable)])
    const delayStartup = slowHost && bundle === staged ? 'await new Promise(resolve => setTimeout(resolve, 12500));\n' : ''
    await writeFile(entry, `${delayStartup}import(${JSON.stringify(host)}).catch(error => { console.error(error); process.exitCode = 1 })\n`)
  }
  daemon = spawn(daemonPath, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { stdio: ['ignore', 'ignore', 'inherit', 'pipe'] })
  await Promise.race([once(daemon.stdio[3], 'data'), once(daemon, 'exit').then(([code]) => { throw new Error(`Private Native exited ${code}`) })])
  if (foreground) {
    previousHost = spawn(service.executable, [service.entrypoint, '--store', store],
      { env: { ...process.env, ...service.environment }, stdio: ['ignore', 'pipe', 'inherit'] })
    await Promise.race([once(previousHost.stdout, 'data'), once(previousHost, 'exit').then(([code]) => { throw new Error(`Private Host exited ${code}`) })])
  } else await ensureMacosHostService(service)
  await connect()
  const before = await observe(owner, value => value.ctxmux !== null, 'Original Native owner was not observed')
  const run = await client.createTerminal({ createOperationId: 'finder-original-terminal', workspacePath: root,
    command: '/bin/cat', args: [] })
  const baseline = await client.attachTerminal(run.runId, 0)
  await disconnect()
  await reloadReplacedMacosHost(service)
  await connect()
  assert.equal((await owner()).processId, before.processId, 'A normal launch keeps the current Host')
  await disconnect()

  // Finder moves the old App away. The still-running Host now maps the renamed bundle.
  await rename(app, backup)
  await rename(staged, app)
  const wrongStore = { ...service, storePath: join(state, 'unrelated-sessions.json') }
  await assert.rejects(reloadReplacedMacosHost(wrongStore), /not confirmed for this installation and Store/u)
  const identities = ['semantic-runtime.json', 'semantic-runtime.json.original'].map(name => join(state, name))
  for (const held of [identities.slice(0, 1), identities]) {
    for (const identity of held) await rename(identity, identity + '.fixture-held')
    try {
      await assert.rejects(reloadReplacedMacosHost(service), { code: 'IDENTITY_SOURCE_MISSING' })
      await connect()
      assert.equal((await owner()).processId, before.processId, 'A missing primary leaves the live original Host available')
      await disconnect()
    } finally { for (const identity of held) await rename(identity + '.fixture-held', identity) }
  }
  const wrongRuntime = join(root, 'wrong-runtime')
  await mkdir(wrongRuntime, { mode: 0o700 })
  process.env.AGENTMUX_RUNTIME_DIRECTORY = wrongRuntime
  try { await assert.rejects(reloadReplacedMacosHost(service), /original CtxMux Runtime could not be confirmed/u) }
  finally { process.env.AGENTMUX_RUNTIME_DIRECTORY = runtime }
  await connect()
  assert.equal((await owner()).processId, before.processId, 'An unconfirmed installation leaves the original Host available')
  await disconnect()
  const reloadStartedAt = Date.now()
  await reloadReplacedMacosHost(service)
  const reloadMs = Date.now() - reloadStartedAt
  if (slowHost) assert.ok(reloadMs >= 12_500, 'The concrete replacement endpoint opened after the old readiness window')
  await connect()
  const after = await observe(owner, value => value.ctxmux !== null, 'The new Host did not connect to Native')
  assert.notEqual(after.processId, before.processId, 'The installed bundle must reload the resident Host')
  assert.notEqual(after.ownerInstanceId, before.ownerInstanceId)
  assert.equal(after.runtimeId, before.runtimeId)
  assert.equal(after.ctxmux.instanceId, before.ctxmux.instanceId)
  assert.equal(daemon.exitCode, null)
  process.kill(daemon.pid, 0)
  const resumed = await client.attachTerminal(run.runId, 0)
  assert.equal(resumed.run.pid, baseline.run.pid)
  assert.equal(resumed.run.state, 'running')
  const input = 'after-finder-swap\n'
  await client.writeTerminal(run, { operationId: 'finder-original-pty-input', ownerInstanceId: after.ctxmux.instanceId,
    expectedByte: resumed.run.acceptedInputBytes, data: input })
  await observe(() => client.readRunReplay(run, 0, 'raw'),
    replay => replay.replay.some(chunk => Buffer.from(chunk.dataBytes).toString().includes(input.trim())),
    'The original PTY did not echo input after the Host swap')
  const mesh = await rpc.call('settings.mesh.inspect', {})
  assert.equal(mesh.owner.ownerInstanceId, after.ownerInstanceId)
  await disconnect()
  await reloadReplacedMacosHost(service)
  await connect()
  assert.equal((await owner()).processId, after.processId, 'The refreshed Host is stable on another opening')
  console.log(JSON.stringify({ mode: foreground ? 'foreground' : 'launchd', reloadMs, originalRuntime: before.runtimeId,
    hostPidBefore: before.processId, hostPidAfter: after.processId, nativeInstance: after.ctxmux.instanceId,
    nativePid: daemon.pid, originalRun: run.runId, originalPtyPid: resumed.run.pid, mesh: 'ready' }))
} finally {
  try { await disconnect() }
  finally {
    try {
      const registration = await macosHostServiceRegistration(service)
      if (registration) {
        const process = registration.pid ? await inspectMacosHostProcess(registration.pid) : null
        await exec('/bin/launchctl', ['bootout', service.target])
        if (process) await observe(() => inspectMacosHostProcess(process.pid), value => value?.birth !== process.birth,
          'The private Host did not release its Store before cleanup')
      }
      if (previousHost && previousHost.exitCode === null && previousHost.signalCode === null) {
        previousHost.kill('SIGTERM'); await once(previousHost, 'exit')
      }
    } finally {
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGTERM'); await once(daemon, 'exit') }
      await rm(root, { recursive: true, force: true })
    }
  }
}
