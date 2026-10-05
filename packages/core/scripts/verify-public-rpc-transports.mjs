import { tmpdir as fixtureTmpdir } from 'node:os'
import { join as fixtureJoin, sep as fixtureSep } from 'node:path'
const fixtureRootPath = relative => { const temporary = relative.replace(/^(?:private\/)?tmp\//u, ''); return (temporary === relative ? fixtureJoin(fixtureTmpdir(), 'agentmux-fixtures') : fixtureTmpdir()) + fixtureSep + temporary.replaceAll('/', fixtureSep) }
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, createConnection } from 'node:net'
import { userInfo } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses, signalOwnedProbeProcess, stopProbeProcesses } from '../../../apps/desktop/scripts/probe-process.mjs'

const base = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const exec = promisify(execFile), delay = ms => new Promise(yes => setTimeout(yes, ms))
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const wait = async (read, label) => {
  const deadline = Date.now() + 10_000
  do { const result = await read(); if (result) return result; await delay(25) } while (Date.now() < deadline)
  throw new Error('Private proof deadline: ' + label)
}
async function inputs() {
  const paths = []
  const walk = async path => { for (const item of await readdir(path, { withFileTypes: true })) {
    const child = join(path, item.name)
    if (item.isDirectory()) await walk(child)
    else if (item.isFile() && /\.(ts|js|json)$/u.test(child)) paths.push(child)
  } }
  await walk(join(base, 'packages/core/src')); await walk(join(base, 'packages/core/dist'))
  paths.push(fileURLToPath(import.meta.url), join(base, 'packages/core/package.json'), join(base, 'pnpm-lock.yaml'),
    join(base, 'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),
    join(base, 'packages/core/vendor/ctxmux/darwin-arm64/manifest.json'))
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [relative(base, path),
    createHash('sha256').update(await readFile(path)).digest('hex')])))
}
async function freePort() {
  const server = createServer()
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  const port = server.address().port
  await new Promise(yes => server.close(yes)); return port
}
async function worker(root) {
  const { AgentMuxControlServer, connectAgentMuxRpc, connectLocalAgentMux, AgentMuxFileAgentSessionStore,
    AgentProviderRegistry, defineAgentProvider } = await import('../dist/index.js')
  const records = [], diagnostics = [], cleanup = { errors: [], remaining: [], rootRemoved: false }, clients = []
  const token = randomUUID(), path = join(root, 'control.sock'), sshConfig = join(root, 'sshd.conf')
  let core, server, session, sshd, failure
  try {
    await mkdir(join(root, 'bin'), { mode: 0o700 })
    await exec('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host-key')])
    await exec('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'client-key')])
    await writeFile(join(root, 'authorized_keys'), await readFile(join(root, 'client-key.pub')), { mode: 0o600 })
    const port = await freePort(), user = userInfo().username
    await writeFile(sshConfig, [
      'Port ' + port, 'ListenAddress 127.0.0.1', 'HostKey ' + join(root, 'host-key'),
      'PidFile ' + join(root, 'sshd.pid'), 'AuthorizedKeysFile ' + join(root, 'authorized_keys'),
      'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes',
      'StrictModes no', 'AllowUsers ' + user, 'LogLevel ERROR'
    ].join('\n') + '\n', { mode: 0o600 })
    await writeFile(join(root, 'ssh-client.conf'), [
      'Host 127.0.0.1', '  IdentityFile ' + join(root, 'client-key'), '  IdentitiesOnly yes',
      '  UserKnownHostsFile ' + join(root, 'known_hosts'), '  StrictHostKeyChecking accept-new', '  LogLevel ERROR'
    ].join('\n') + '\n', { mode: 0o600 })
    // This wrapper only configures the standard OpenSSH process used by the public transport.
    await writeFile(join(root, 'bin/ssh'), '#!/bin/sh\nexec /usr/bin/ssh -F ' + quote(join(root, 'ssh-client.conf')) + ' "$@"\n', { mode: 0o700 })
    await writeFile(join(root, 'remote-cli'), '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' +
      quote(join(base, 'packages/core/bin/amux')) + ' "$@"\n', { mode: 0o700 })
    process.env.PATH = join(root, 'bin') + ':' + process.env.PATH
    let sshStderr = ''
    sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', sshConfig], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    await writeFile(join(root, 'worker-processes.json'), JSON.stringify({ sshDaemonPid: sshd.pid }))
    sshd.stderr.on('data', chunk => { sshStderr += chunk.toString() })
    await wait(async () => {
      if (sshd.exitCode !== null) throw new Error('Private SSH daemon exited: ' + sshStderr)
      return await new Promise(yes => { const socket = createConnection({ host: '127.0.0.1', port })
        socket.once('connect', () => { socket.destroy(); yes(true) }); socket.once('error', () => yes(false)) })
    }, 'explicit private SSH listener')
    await writeFile(join(root, 'pty.py'), `import os,tty,json\ntty.setraw(0)\nfd=os.open(${JSON.stringify(join(root, 'managed.json'))},os.O_CREAT|os.O_WRONLY|os.O_TRUNC,0o600)\nos.write(fd,json.dumps({'agentSessionId':os.environ['AGENTMUX_AGENT_SESSION_ID'],'capability':os.environ['AGENTMUX_AGENT_CAPABILITY']}).encode())\nos.close(fd)\nos.write(1,b'PRIVATE-RPC-READY\\n')\nwhile True:\n b=os.read(0,1)\n if b==b'q':break\n os.write(1,b'PRIVATE-RPC-ACK:'+b+b'\\n')\n`)
    const template = new AgentProviderRegistry().get('codex')
    const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'private-rpc-protocol', label: 'Private RPC protocol',
      executable: '/usr/bin/python3', expectedProcess: '/usr/bin/python3', hookStrategy: { kind: 'none' },
      readySignal: { kind: 'foreground-process', expectedProcess: '/usr/bin/python3' } },
      hook: template.hook,
      buildArgs: (_prompt, args) => args })
    core = await connectLocalAgentMux({ providers: [provider], store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) })
    session = await core.createAgent({ providerId: provider.id, executorId: 'private-rpc', workspacePath: root,
      commandOverride: '/usr/bin/python3', args: ['-u', join(root, 'pty.py')], injectAgentMuxGuide: false })
    const before = await wait(async () => { const state = await core.statusAgent(session.agentSessionId)
      return state.run.state === 'running' && state.run.latestOutputBytes > 0 ? state : null }, 'one real private Run')
    const credentials = JSON.parse(await readFile(join(root, 'managed.json'), 'utf8'))
    assert.equal(credentials.agentSessionId, session.agentSessionId)
    const catalog = { spaces: [{ spaceId: 'private-space', kind: 'folder', name: 'Private transport', hostId: session.hostId,
      directoryPath: root, projectId: 'private-project' }], zones: [], tabs: [], regions: [], locations: [], bindings: [] }
    server = new AgentMuxControlServer({ socketPath: path, coreClients: () => [{ hostId: session.hostId, client: core }],
      http: { host: '127.0.0.1', port: 0, token }, execute: async request => {
        if (request.operation === 'space.ls') return { operation: request.operation, catalog }
        throw new Error('Private Desktop observation is unavailable')
      } })
    await server.start()
    const endpoints = [{ transport: 'unix', path }, { transport: 'http', url: `http://127.0.0.1:${server.httpAddress.port}/`, token },
      { transport: 'ssh', host: '127.0.0.1', user, port, command: join(root, 'remote-cli'), socketPath: path }]
    for (const endpoint of endpoints) {
      const client = await connectAgentMuxRpc({ endpoint, credentials }); clients.push(client)
      const queryStartedAt = Date.now()
      let inspected
      try { inspected = await client.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } }) }
      finally { diagnostics.push({ step: 'initial-agent-inspect', transport: endpoint.transport, durationMs: Date.now() - queryStartedAt }) }
      assert.equal(inspected.session.agentSessionId, session.agentSessionId); assert.deepEqual(inspected.session.run, session.run)
      assert.equal(inspected.status.run.pid, before.run.pid); assert.equal(inspected.session.workspacePath, before.session.workspacePath)
      assert.equal(inspected.status.run.state, 'running')
      assert.deepEqual((await client.call('space.ls', { target: {} })).catalog.spaces, catalog.spaces)
      const invalid = await connectAgentMuxRpc({ endpoint, credentials: { ...credentials, capability: 'invalid-private-claim' } }); clients.push(invalid)
      await assert.rejects(invalid.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } }), { code: 'AGENT_CAPABILITY_INVALID' })
      await invalid.dispose()
      const frames = [], bytes = [], inputBefore = await core.statusAgent(session.agentSessionId), cursor = inputBefore.run.latestOutputBytes
      let ready, ended, failed
      const opened = new Promise(yes => { ready = yes }), live = new Promise((yes, no) => { ended = yes; failed = no })
      let sub
      try {
        sub = await client.subscribe('agent.output', { agentSessionId: 'self', afterByte: cursor, follow: true }, {
          onInitial: initial => { assert.equal(initial.session.agentSessionId, session.agentSessionId); assert.equal(initial.run.runId, session.run.runId); ready() },
          onFrame: frame => frames.push(frame), onEvent: event => {
            if (event.type === 'error') failed(new Error(event.error.message))
            if (event.type === 'output') { assert.equal(event.data.runId, session.run.runId); assert.ok(event.data.startByte >= cursor)
              bytes.push(Buffer.from(event.data.dataBase64, 'base64')); if (Buffer.concat(bytes).includes('PRIVATE-RPC-ACK:x')) ended() }
          }, onEnd: error => { if (error) failed(error) }
        })
        await opened
        await core.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: 'x', source: 'user' })
        let deadline
        try { await Promise.race([live, new Promise((_, no) => { deadline = setTimeout(() => no(new Error('Private live bytes deadline')), 10_000) })]) }
        finally { clearTimeout(deadline) }
        assert.ok(frames.length >= 2); assert.ok(Object.hasOwn(frames[0], 'result'))
        assert.equal(frames[1].method, 'system.subscription.event')
      } finally { await sub?.dispose() }
      const current = await core.statusAgent(session.agentSessionId)
      assert.equal(current.run.state, 'running'); assert.equal(current.run.pid, before.run.pid)
      assert.deepEqual(current.session.run, before.session.run); assert.equal(current.session.workspacePath, before.session.workspacePath)
      assert.ok(current.run.acceptedInputBytes > inputBefore.run.acceptedInputBytes)
      records.push({ transport: endpoint.transport, agentSessionId: session.agentSessionId, run: session.run,
        pid: current.run.pid, cwd: current.session.workspacePath, independentReaderCancelled: true,
        cursor, inputBefore: inputBefore.run.acceptedInputBytes, inputAfter: current.run.acceptedInputBytes,
        capabilityRejected: true,
        outputBytes: Buffer.concat(bytes).length, outputSha256: createHash('sha256').update(Buffer.concat(bytes)).digest('hex'),
        frameCount: frames.length, responseBeforeNotifications: true, actualSshDaemonPid: endpoint.transport === 'ssh' ? sshd.pid : null })
      await client.dispose()
    }
    assert.equal(new Set(records.map(record => record.transport)).size, 3)
    await core.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: 'q', source: 'user' })
    await wait(async () => (await core.statusAgent(session.agentSessionId)).run.state === 'exited', 'natural private Agent exit')
  } catch (error) { failure = { name: error.name, code: error.code ?? null, message: error.message, stack: error.stack } }
  finally {
    for (const client of clients) await client.dispose().catch(error => cleanup.errors.push(String(error)))
    await server?.stop().catch(error => cleanup.errors.push(String(error)))
    if (core && session) { try { const state = await core.statusAgent(session.agentSessionId)
      if (state.run.state === 'running') await core.stopAgent(session.agentSessionId, session.run)
    } catch (error) { cleanup.errors.push(String(error)) } }
    await core?.dispose().catch(error => cleanup.errors.push(String(error)))
    if (sshd?.pid) await stopProbeProcesses(sshd.pid, root).catch(error => cleanup.errors.push(String(error)))
    for (const pid of await listProbeProcesses(-1, root)) await signalOwnedProbeProcess(pid, root, 'SIGTERM').catch(error => cleanup.errors.push(String(error)))
    await wait(async () => !(await listProbeProcesses(-1, root)).length, 'private processes cleaned').catch(error => cleanup.errors.push(String(error)))
    cleanup.remaining = await listProbeProcesses(-1, root)
    await writeFile(join(root, 'worker-receipt.json'), JSON.stringify({ passed: !failure && !cleanup.errors.length && !cleanup.remaining.length,
      records, diagnostics, failure: failure ?? null, cleanup, workerPid: process.pid }, null, 2) + '\n')
  }
}
if (process.argv[2] === '--worker') {
  await worker(process.argv[3])
} else {
  const output = resolve(base, process.argv[2] ?? '.tmp/public-rpc-transports/last')
  await mkdir(output, { recursive: true })
  const root = await mkdtemp(fixtureRootPath("tmp/amx-rpc-transports-")), before = await inputs()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key)))
  Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })
  let executionFailure, receipt
  try {
    const result = await exec(process.execPath, [fileURLToPath(import.meta.url), '--worker', root], { cwd: base, env, timeout: 90_000, maxBuffer: 1024 * 1024 })
    await writeFile(join(output, 'worker.log'), result.stdout + result.stderr)
    receipt = JSON.parse(await readFile(join(root, 'worker-receipt.json'), 'utf8'))
  } catch (error) {
    executionFailure = { message: error.message, code: error.code ?? null }
    await writeFile(join(output, 'worker.log'), [error.stack, error.stdout, error.stderr].filter(Boolean).join('\n'))
    try { receipt = JSON.parse(await readFile(join(root, 'worker-receipt.json'), 'utf8')) } catch { receipt = { passed: false, cleanup: { errors: [], remaining: [] } } }
  }
  // A watchdog/setup failure is not an absence receipt. Reap only this root's
  // verified daemon group and processes before considering removal.
  if ((await listProbeProcesses(-1, root)).length) {
    try {
      const { sshDaemonPid } = JSON.parse(await readFile(join(root, 'worker-processes.json'), 'utf8'))
      const command = (await exec('/bin/ps', ['-p', String(sshDaemonPid), '-o', 'command='])).stdout
      assert.ok(command.includes(root) && command.includes('sshd'))
      await stopProbeProcesses(sshDaemonPid, root)
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 1) receipt.cleanup.errors.push(String(error)) }
    for (const pid of await listProbeProcesses(-1, root)) await signalOwnedProbeProcess(pid, root, 'SIGTERM').catch(error => receipt.cleanup.errors.push(String(error)))
    await wait(async () => !(await listProbeProcesses(-1, root)).length, 'outer private cleanup').catch(error => receipt.cleanup.errors.push(String(error)))
  }
  receipt.cleanup.remaining = await listProbeProcesses(-1, root)
  const after = await inputs(), same = JSON.stringify(before) === JSON.stringify(after)
  if (!receipt.cleanup.remaining.length && !receipt.cleanup.errors.length) { await rm(root, { recursive: true, force: true }); receipt.cleanup.rootRemoved = true }
  const result = { schema: 'agentmux.public-rpc-transports.private.v1', ...receipt,
    passed: receipt.passed && !executionFailure && same, inputs: before, inputsAfter: after,
    executionFailure: executionFailure ?? null, sourceUnchanged: same,
    scope: 'Actual standard OpenSSH daemon/client and stdio relay, authenticated Unix and opt-in HTTP/SSE, one real private Agent Run/PTY with ordered bytes. Reader cancellation keeps Run/PID/cwd/Session. No production App/Runtime, actual remote machine, Provider semantic resume or browser UI claim.' }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ passed: result.passed, transports: result.records?.map(record => record.transport), failure: result.failure, executionFailure: result.executionFailure, cleanup: result.cleanup }))
  if (!result.passed) process.exitCode = 1
}
