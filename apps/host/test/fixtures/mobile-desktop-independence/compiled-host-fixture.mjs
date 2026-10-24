import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function until(label, read, accept = Boolean, budget = 30_000) {
  const deadline = performance.now() + budget
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (performance.now() >= deadline) throw new Error('Private compiled candidate did not confirm: ' + label)
    await delay(40)
  }
}

async function firstJson(child, label, stream = child.stdout) {
  return await new Promise((yes, no) => {
    let output = '', errors = ''
    const timer = setTimeout(() => no(new Error(label + ' readiness timed out: ' + errors)), 30_000)
    child.stderr.on('data', value => { errors += String(value) })
    stream.on('data', value => {
      output += String(value)
      if (!output.includes('\n')) return
      clearTimeout(timer)
      try { yes(JSON.parse(output.slice(0, output.indexOf('\n')))) } catch (error) { no(error) }
    })
    child.once('error', error => { clearTimeout(timer); no(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); no(new Error(label + ' exited before readiness: ' + code + '/' + signal + ' ' + errors)) })
  })
}

// This worker is a private client of the original public Host library, not a second supervisor.
async function ownerWorker() {
  const [library, repository, mobileBuildDirectory, port] = process.argv.slice(3)
  const core = await import(pathToFileURL(join(repository, 'packages/core/dist/index.js')).href)
  const { startAgentMuxHost } = await import(pathToFileURL(library).href)
  let startup, closing
  const shutdown = () => closing ??= (async () => {
    const host = await startup
    await host.dispose()
    process.exit(0)
  })().catch(error => { console.error(error); process.exit(1) })
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown)
  startup = startAgentMuxHost({ store: new core.AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE),
    configurationPath: process.env.AGENTMUX_CONFIG_PATH,
    socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'control.sock'),
    mobileBuildDirectory, mobilePort: Number(port), shutdown })
  const host = await startup
  const { owner } = await host.hosted.call('runtime.owner.identity', {})
  const access = await until('original local Relay access', () => host.mobileAccessState(), value => value.state === 'connected' && value.origin)
  const origin = new URL(access.origin)
  const publicKey = JSON.parse(await readFile(join(dirname(process.env.AGENTMUX_AGENT_SESSION_STORE), 'agentmux-relay-keypair.json'), 'utf8')).publicKeyB64
  const offer = { v: 2, serverId: (await host.deviceAuthority()).hostId, daemonPublicKeyB64: publicKey,
    relay: { endpoint: '127.0.0.1:' + origin.port, useTls: false } }
  process.stdout.write(JSON.stringify({ owner, port: Number(origin.port), offer, origin: 'http://127.0.0.1:' + origin.port + '/' }) + '\n')
}

export async function compiledHostFixture(candidate) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ami-'))
  const privateHome = join(root, 'home'), userData = join(root, 'user-data'), runtime = join(root, 'runtime'), state = join(root, 'state')
  const workspace = join(root, 'workspace'), scratch = join(root, 'topics'), store = join(userData, 'agent-sessions.json')
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key))),
    ...Object.fromEntries(Object.keys(process.env).filter(key => /^(AGENTMUX_|CTXMUX_)/u.test(key)).map(key => [key, undefined])),
    HOME: privateHome, CODEX_HOME: join(privateHome, 'codex'), AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
    AGENTMUX_WORKSPACE_MOVE_HELPER: join(candidate.root, 'apps/host/resources/bin/agentmux-workspace-move'),
    AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_AGENT_SESSION_STORE: store,
    AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), AGENTMUX_SPATIAL_STATE_STORE: join(state, 'spatial-state.json'),
    AGENTMUX_CONFIG_PATH: join(userData, 'agentmux.config.json') }
  const children = new Set(), connections = new Set(), clients = new Set(), rpcClients = new Set(), ownedSessions = new Set()
  const core = await import(pathToFileURL(join(candidate.root, 'packages/core/dist/index.js')).href)
  const hosted = await import(pathToFileURL(join(candidate.root, 'packages/core/dist/hosted.js')).href)
  const desktop = await import(new URL('../../../../desktop/scripts/fixtures/settings-cli/desktop.mjs', import.meta.url).href)
  let daemon, owner, ready, desktopProbe, original, sdk, rpc
  const cleanup = { errors: [], completed: [] }
  const waitFor = (label, read, budget) => until(label, read, Boolean, budget)
  const terminate = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
    assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null)
    children.delete(child)
  }
  const connect = async () => {
    rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } }); rpcClients.add(rpc)
    sdk = await hosted.connectHostedAgentMux({ rpc, expectedStorePath: store }); clients.add(sdk)
    return { sdk, rpc }
  }
  const startHost = async (port = 0) => {
    owner = spawn(process.execPath, [import.meta.filename, '--owner', candidate.hostLibrary, candidate.root, candidate.mobileRoot, String(port), root],
      { cwd: candidate.root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(owner)
    ready = await firstJson(owner, 'compiled Node Host')
    assert.equal(ready.owner.processId, owner.pid)
    await connect()
    ready.owner = (await until('original public Native identity', () => rpc.call('runtime.owner.identity', {}), value => value.owner.ctxmux !== null)).owner
    return ready
  }
  async function quitDesktop() {
    if (!desktopProbe) return
    try { await desktopProbe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(candidate.root, 'apps/desktop/package.json'))})('electron').app.quit()`) }
    catch { /* Ordinary App quit can close its inspector before the reply. */ }
    desktopProbe.main.close(); desktopProbe.cdp.close()
    await until('ordinary private Desktop exit', () => desktopProbe.child.exitCode !== null || desktopProbe.child.signalCode !== null)
    assert.equal(desktopProbe.child.exitCode, 0); assert.equal(desktopProbe.child.signalCode, null)
    children.delete(desktopProbe.child); desktopProbe = undefined
  }
  const close = async () => {
    for (const [name, operation] of [
      ['private-desktop', quitDesktop],
      ['private-agents', async () => { if (sdk) for (const sessionId of ownedSessions) { const current = await sdk.statusAgent(sessionId); if (current.run.state === 'running') await sdk.stopAgent(sessionId, current.session.run) } }],
      ['hosted-clients', async () => { for (const value of clients) await value.dispose() }],
      ['rpc-clients', async () => { for (const value of rpcClients) await value.dispose() }],
      ['compiled-host', () => terminate(owner)],
      ['ctxmux', async () => { if (daemon?.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited } }],
      ['observers', async () => { for (const value of connections) value.close() }]
    ]) try { await operation(); cleanup.completed.push(name) } catch (error) { cleanup.errors.push({ name, message: error.message }) }
    const { listProbeProcesses, signalOwnedProbeProcess } = await import(pathToFileURL(join(candidate.root, 'apps/desktop/scripts/probe-process.mjs')).href)
    const remaining = await listProbeProcesses(process.pid + 1_000_000_000, root)
    cleanup.remainingBeforeRecovery = remaining
    // Private-namespace recovery cleans up failed proofs; it never turns them green.
    for (const pid of remaining) await signalOwnedProbeProcess(pid, root, 'SIGTERM')
    if (remaining.length) cleanup.errors.push({ name: 'private-processes', message: 'Ordinary cleanup left processes; exact private namespace recovery was needed' })
    await until('private process cleanup', () => listProbeProcesses(process.pid + 1_000_000_000, root), value => value.length === 0)
    if (!cleanup.errors.length) await rm(root, { recursive: true })
    assert.deepEqual(cleanup.errors, [], 'Private fixture cleanup must complete independently')
  }
  try {
    for (const path of [privateHome, environment.CODEX_HOME, userData, runtime, join(state, 'ctxmux'), workspace, scratch]) await mkdir(path, { recursive: true, mode: 0o700 })
    await desktop.preparePrivateNotesIsolation({ root, privateHome, environment })
    const command = join(workspace, 'managed-cli.mjs')
    await writeFile(command, '#!' + process.execPath + '\nif (process.argv.includes("--version")) { console.log("Private native fixture"); process.exit(0) }\nawait import(' + JSON.stringify(new URL('../../../../../packages/core/test/fixtures/fake-codex-cli.mjs', import.meta.url).href) + ');\n', { mode: 0o700 })
    const executorEnv = { CODEX_HOME: environment.CODEX_HOME, AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1',
      AGENTMUX_FAKE_NATIVE_PRESERVE: '1', AGENTMUX_FAKE_NATIVE_CONTEXT: 'Original retained mobile conversation',
      AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(root, 'native') }
    const executorConfig = { label: 'Original mobile Agent', providerId: 'codex', command, args: [], env: executorEnv, injectAgentMuxGuide: false }
    await writeFile(environment.AGENTMUX_CONFIG_PATH, JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private Host' }],
      executors: { codex: executorConfig },
      workspaces: [{ id: '__scratch__', name: 'Topics', hostId: 'local', path: scratch, kind: 'folder' },
        { id: 'original-workspace', name: 'Original mobile workspace', hostId: 'local', path: workspace, kind: 'folder' }], appearance: { terminalTheme: 'graphite' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, notifications: { mode: 'off' } }))
    const native = join(candidate.root, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd')
    daemon = spawn(native, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
      { env: environment, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    await new Promise((yes, no) => {
      const timer = setTimeout(() => no(new Error('Private official ctxmux readiness timed out')), 30_000)
      daemon.stdio[3].once('data', () => { clearTimeout(timer); yes() })
      daemon.once('error', error => { clearTimeout(timer); no(error) })
      daemon.once('exit', (code, signal) => { clearTimeout(timer); no(new Error('Private ctxmux exited before readiness: ' + code + '/' + signal)) })
    })
    await startHost()
    const inventory = await sdk.listHostExecutors({ refresh: true })
    assert.equal(inventory.executors.find(value => value.executorId === 'codex')?.source, 'provider-default')
    original = await sdk.createAgent({ providerId: 'codex', executorId: 'codex', createOperationId: 'original-mobile-session',
      workspacePath: workspace, commandOverride: command, args: [], env: executorEnv, injectAgentMuxGuide: false })
    assert.equal(original.creation.executorRevision, undefined)
    ownedSessions.add(original.agentSessionId)
    original = await until('original Provider-native identity and ready input frame', () => sdk.statusAgent(original.agentSessionId), value =>
      value.run.state === 'running' && Boolean(value.session.nativeHandle) &&
      value.session.terminalPromptReadiness?.run.runId === original.run.runId &&
      value.session.terminalPromptReadiness.readyThroughByte !== undefined).then(value => value.session)
    const launch = desktop.desktopFixture({ desktopRoot: join(candidate.root, 'apps/desktop'), root, privateHome, environment: { ...environment, ELECTRON_RUN_AS_NODE: undefined }, children, connections, waitFor })
    return { root, privateHome, userData, workspace, environment, children, cleanup, core, get sdk() { return sdk }, get rpc() { return rpc },
      get ready() { return ready }, get ownerProcess() { return owner }, original, executorInventory: inventory, nativeProcessId: daemon.pid,
      async readNativeRun(run) {
        const { CtxmuxClient } = await import(pathToFileURL(join(candidate.root, 'packages/core/node_modules/@ctxmux/sdk/dist/index.js')).href)
        const socketPath = join(runtime, 'ctxmux.sock'), identity = await new CtxmuxClient({ socketPath }).runtimeInfo()
        assert.equal(identity.daemonInstanceId, ready.owner.ctxmux.instanceId)
        return await new CtxmuxClient({ socketPath, expectedRuntimeIdentity: identity }).status(run.runId)
      },
      ownCreatedSession(sessionId) { ownedSessions.add(sessionId) },
      async startDesktop(seed) { if (seed) await launch('seed', seed); desktopProbe = await launch('ordinary-' + String(children.size)); return desktopProbe },
      quitDesktop,
      async restartHost() {
        const port = ready.port
        await terminate(owner)
        for (const value of clients) await value.dispose(); clients.clear()
        for (const value of rpcClients) await value.dispose(); rpcClients.clear()
        return await startHost(port)
      },
      close }
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Private compiled Host fixture failed') }
    throw error
  }
}

if (process.argv[2] === '--owner') await ownerWorker()
