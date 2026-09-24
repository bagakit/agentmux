import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
const sourceFiles = ['src/agent-handoff.ts', 'src/agent-global-message-queue.ts', 'src/client.ts',
  'src/agentmux.ts', 'src/agentmux-cli-help.ts', 'scripts/verify-dispatch-consumer-restart.mjs',
  'test/fixtures/dispatch-private-runtime.mjs', 'test/fixtures/fake-codex-cli.mjs']
const compiledFiles = ['dist/agent-handoff.js', 'dist/agent-global-message-queue.js', 'dist/client.js',
  'dist/agentmux.js', 'dist/agentmux-cli-help.js', 'dist/ctxmux-run-adapter.js']
const nativeFiles = ['vendor/ctxmux/darwin-arm64/manifest.json', 'vendor/ctxmux/darwin-arm64/bin/ctxmuxd']

async function fingerprint() {
  return Object.fromEntries(await Promise.all([...sourceFiles, ...compiledFiles, ...nativeFiles].map(async path => {
    const bytes = await readFile(join(packageRoot, path))
    return [path, { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }]
  })))
}

const exited = child => child.exitCode !== null || child.signalCode !== null
const pidGone = pid => {
  try { process.kill(pid, 0); return false } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
}
async function waitFor(read, label) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error(`Private dispatch fixture timed out: ${label}`)
}
async function stopOwnedChild(child, signal = 'SIGTERM') {
  if (exited(child)) return
  assert(child.pid, 'Owned child must have its recorded PID before signalling')
  process.kill(-child.pid, signal)
  const deadline = Date.now() + 3_000
  while (!exited(child) && Date.now() < deadline) await new Promise(done => setTimeout(done, 10))
  if (!exited(child)) {
    process.kill(-child.pid, 'SIGKILL')
    await waitFor(async () => exited(child) ? true : undefined, 'owned child exit')
  }
  assert(exited(child))
  assert(pidGone(child.pid))
}

/** Private process proof only: no user Runtime/App/global Provider configuration is selected. */
export async function runDispatchProof(scenario) {
  assert(['cli', 'restart'].includes(scenario), 'Unknown private proof scenario')
  const before = await fingerprint()
  const fixtureRoot = await mkdtemp('/tmp/amx-dispatch-')
  const runtimeDirectory = join(fixtureRoot, 'runtime')
  const stateDirectory = join(fixtureRoot, 'state')
  const captureDirectory = join(fixtureRoot, 'captures')
  const storePath = join(fixtureRoot, 'sessions.json')
  const queuePath = join(fixtureRoot, 'global-messages.ndjson')
  await Promise.all([runtimeDirectory, stateDirectory, captureDirectory].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  // No assignment to HOME/CODEX_HOME. Codex hooks live in our workspace/.codex only, and the
  // synthetic executable below never reads a global Provider configuration or calls a model.
  // This is an ordinary fixture process, never a managed user Agent. Remove inherited control
  // endpoints/credentials/Node imports before Core is imported or any owned child starts.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('AGENTMUX_') || name.startsWith('CTXMUX_') || name === 'NODE_OPTIONS') delete process.env[name]
  }
  const fixtureEnvironment = { PATH: process.env.PATH,
    AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_STATE_DIRECTORY: stateDirectory,
    AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_MESSAGE_QUEUE_PATH: queuePath }
  for (const [name, value] of Object.entries(fixtureEnvironment)) {
    if (value !== undefined) process.env[name] = value
  }
  const core = await import(new URL('../../dist/index.js', import.meta.url))
  const client = new core.AgentMuxClient({ store: new core.AgentMuxFileAgentSessionStore(storePath) })
  const queue = new core.DurableAgentMuxMessageQueue(queuePath)
  const daemon = spawn(join(packageRoot, 'vendor/ctxmux/darwin-arm64/bin/ctxmuxd'), [
    '--socket', join(runtimeDirectory, 'ctxmux.sock'), '--state-dir', join(stateDirectory, 'ctxmux'), '--readiness-fd', '3'
  ], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'], env: fixtureEnvironment })
  let daemonReady = '', daemonError
  daemon.once('error', error => { daemonError = error })
  daemon.stderr.on('data', () => {}) // Drain without retaining private native diagnostics.
  daemon.stdio[3].on('data', bytes => { daemonReady += bytes.toString() })
  const sessions = [], cliChildren = [], ownedAgentPids = new Set()
  const credentials = new Map(), operations = []
  let report, failure, cleanup
  try {
    await waitFor(async () => {
      if (daemonError) throw daemonError
      if (exited(daemon)) throw new Error('Private daemon exited before readiness')
      return daemonReady.includes('\n') && (await stat(join(runtimeDirectory, 'ctxmux.sock'))).isSocket() ? true : undefined
    }, 'private daemon readiness')
    const wrapper = join(fixtureRoot, 'synthetic-codex.mjs')
    const syntheticExecutor = fileURLToPath(new URL('./fake-codex-cli.mjs', import.meta.url))
    await writeFile(wrapper, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nif (process.argv.includes('--version')) { process.stdout.write('synthetic codex fixture 1\\n'); process.exit(0); }\nwriteFileSync(join(process.env.AMUX_DISPATCH_CAPTURE_DIRECTORY, process.env.AGENTMUX_AGENT_SESSION_ID + '.json'), JSON.stringify({ pid: process.pid, capability: process.env.AGENTMUX_AGENT_CAPABILITY, queuePath: process.env.AGENTMUX_MESSAGE_QUEUE_PATH, storePath: process.env.AGENTMUX_AGENT_SESSION_STORE }), { mode: 0o600 });\nawait import(${JSON.stringify(syntheticExecutor)});\n`, { mode: 0o700 })
    await chmod(wrapper, 0o700)
    const hold = join(fixtureRoot, 'hold-consumer.mjs')
    await writeFile(hold, 'setInterval(() => {}, 1000)\n', { mode: 0o600 })
    await client.connect()
    for (const agentSessionId of ['owner', 'worker']) {
      const session = await client.createAgent({ agentSessionId, providerId: 'codex', executorId: 'codex',
        commandOverride: wrapper, workspacePath: fixtureRoot, injectAgentMuxGuide: false,
        env: { ...fixtureEnvironment, AMUX_DISPATCH_CAPTURE_DIRECTORY: captureDirectory } })
      sessions.push(session)
      const credential = await waitFor(async () => {
        try { return JSON.parse(await readFile(join(captureDirectory, `${agentSessionId}.json`), 'utf8')) } catch { return undefined }
      }, 'issued private capability')
      assert.equal(credential.queuePath, queuePath)
      assert.equal(credential.storePath, storePath)
      assert(Number.isSafeInteger(credential.pid))
      ownedAgentPids.add(credential.pid)
      credentials.set(agentSessionId, credential)
    }
    const session = id => sessions.find(value => value.agentSessionId === id)
    const message = (id, sender = 'owner', recipient = 'worker', replyTo = null) => ({
      messageId: id, operationId: `operation-${id}`, createdAt: 100,
      sender: { kind: 'agent-session', agentSessionId: sender }, recipient: { kind: 'agent-session', agentSessionId: recipient },
      senderSessionId: sender, senderRunId: session(sender).run.runId,
      recipientSessionId: recipient, recipientRunId: session(recipient).run.runId,
      threadId: 'private-dispatch-thread', correlationId: `correlation-${id}`, replyTo,
      workspaceId: fixtureRoot, body: `Synthetic ${id}`
    })
    const invoke = async (agentSessionId, args, keepAlive = false) => {
      const capability = credentials.get(agentSessionId).capability
      const child = spawn(process.execPath, [...(keepAlive ? ['--import', hold] : []),
        join(packageRoot, 'dist/agentmux.js'), ...args], {
        detached: true, cwd: fixtureRoot, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...fixtureEnvironment, AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: agentSessionId,
          AGENTMUX_AGENT_CAPABILITY: capability }
      })
      cliChildren.push(child)
      let stdout = '', stderr = '', spawnError
      child.once('error', error => { spawnError = error })
      child.stdout.on('data', bytes => { stdout += bytes.toString() })
      child.stderr.on('data', bytes => { stderr += bytes.toString() })
      const receipt = await waitFor(async () => {
        if (spawnError) throw spawnError
        const line = `${stdout}\n${stderr}`.split('\n').find(value => value.trim().startsWith('{'))
        if (line) return JSON.parse(line)
        if (exited(child)) throw new Error('Private actual CLI exited without a receipt')
        return undefined
      }, 'actual CLI receipt')
      if (!keepAlive) await waitFor(async () => exited(child) ? true : undefined, 'actual CLI exit')
      assert(!`${stdout}\n${stderr}`.includes(capability), 'CLI receipt must never disclose its capability')
      operations.push({ pid: child.pid, command: args[0], verb: args[1], ok: receipt.ok,
        ...(receipt.error ? { errorCode: receipt.error.code } : {}) })
      return { child, receipt }
    }
    const sourceArguments = ['--source-message', 'source']
    const dispatch = (actor, verb, rest = []) => invoke(actor, ['dispatch', verb, ...sourceArguments, ...rest])
    const record = (actor, id, kind) => dispatch(actor, 'report', ['--reply-message', id, '--kind', kind])
    const healthyBefore = await client.statusAgent('owner')
    assert.equal(healthyBefore.run.state, 'running')
    assert.equal(healthyBefore.run.pid, credentials.get('owner').pid)
    await queue.append(message('source'))
    for (const id of ['question-one', 'question-two', 'done']) await queue.append(message(id, 'worker', 'owner', 'source'))
    const opened = (await dispatch('owner', 'open')).receipt
    assert.equal(opened.ok, true)
    assert.equal(opened.operation, 'dispatch.open')
    assert.deepEqual(opened.result, { sourceMessageId: 'source', ownerAgentSessionId: 'owner',
      workerAgentSessionId: 'worker', threadId: 'private-dispatch-thread', openedAt: opened.result.openedAt,
      originAwaits: true, events: [] })
    assert(Number.isFinite(opened.result.openedAt))
    assert.deepEqual((await dispatch('owner', 'open')).receipt.result, opened.result)
    const first = (await record('worker', 'question-one', 'question')).receipt
    assert.equal(first.ok, true)
    assert.deepEqual((await record('worker', 'question-one', 'question')).receipt.result, first.result)
    const second = (await record('worker', 'question-two', 'question')).receipt
    assert.equal(second.ok, true)
    assert.deepEqual(second.result.events.map(event => event.replyMessageId), ['question-one', 'question-two'])
    assert.equal(second.result.originAwaits, true)
    assert.deepEqual((await dispatch('owner', 'show')).receipt.result, second.result)
    assert.deepEqual((await dispatch('worker', 'show')).receipt.result, second.result)
    const journalBeforeInvalid = await readFile(queuePath)
    assert.equal((await dispatch('worker', 'open')).receipt.error.code, 'DISPATCH_PARTICIPANT_MISMATCH')
    assert.equal((await record('owner', 'question-one', 'worker_done')).receipt.error.code, 'DISPATCH_PARTICIPANT_MISMATCH')
    assert.equal((await record('worker', 'question-one', 'worker_done')).receipt.error.code, 'DISPATCH_EVENT_CONFLICT')
    assert.deepEqual(await readFile(queuePath), journalBeforeInvalid)
    if (scenario === 'restart') {
      const interrupted = await invoke('owner', ['deliveries', 'check', '--limit', '1'], true)
      assert.equal(interrupted.receipt.ok, true)
      const batch = interrupted.receipt.result
      assert.deepEqual(batch.messages.map(value => value.envelope.messageId), ['question-one'])
      assert.deepEqual(batch.messages.map(value => value.envelope.body), ['Synthetic question-one'])
      assert.deepEqual(batch.readerRun, session('owner').run)
      await stopOwnedChild(interrupted.child, 'SIGKILL')
      assert.equal(interrupted.child.signalCode, 'SIGKILL')
      await queue.append(message('question-three', 'worker', 'owner', 'source'))
      const replay = (await invoke('owner', ['deliveries', 'check', '--limit', '100'])).receipt
      assert.equal(replay.ok, true)
      assert.deepEqual(replay.result, batch)
      assert.equal((await dispatch('owner', 'show')).receipt.result.originAwaits, true)
      const ack = (await invoke('owner', ['deliveries', 'ack', '--generation', String(batch.generation),
        '--reader-run', batch.readerRun.runId])).receipt
      assert.equal(ack.ok, true)
      assert.deepEqual(ack.result.acknowledgedMessageIds, ['question-one'])
      const next = (await invoke('owner', ['deliveries', 'check', '--limit', '100'])).receipt
      assert.equal(next.ok, true)
      assert.deepEqual(next.result.messages.map(value => value.envelope.messageId), ['question-two', 'done', 'question-three'])
      assert.equal((await dispatch('owner', 'show')).receipt.result.originAwaits, true)
      report = { interruptedConsumer: { pid: interrupted.child.pid, signal: interrupted.child.signalCode },
        replayedBatch: batch, acknowledgement: ack.result, nextBatch: next.result }
    }
    const done = (await record('worker', 'done', 'worker_done')).receipt
    assert.equal(done.ok, true)
    assert.equal(done.result.originAwaits, false)
    assert.deepEqual((await dispatch('owner', 'show')).receipt.result, done.result)
    const healthyAfter = await client.statusAgent('owner')
    assert.deepEqual(healthyAfter.run.runId, healthyBefore.run.runId)
    assert.equal(healthyAfter.run.pid, healthyBefore.run.pid)
    assert.equal(healthyAfter.run.state, 'running')
    assert.equal(healthyAfter.run.acceptedInputBytes, healthyBefore.run.acceptedInputBytes)
    if (scenario === 'restart') {
      await client.writeAgent({ agentSessionId: 'owner', data: 'Synthetic input is still usable\r',
        source: 'user', expectedRun: session('owner').run })
      const inputAfter = await client.statusAgent('owner')
      assert.equal(inputAfter.run.runId, healthyBefore.run.runId)
      assert.equal(inputAfter.run.pid, healthyBefore.run.pid)
      assert.equal(inputAfter.run.state, 'running')
      assert(inputAfter.run.acceptedInputBytes > healthyAfter.run.acceptedInputBytes)
      report.healthyRun = { runId: healthyBefore.run.runId, pid: healthyBefore.run.pid,
        state: inputAfter.run.state, acceptedInputBytesBefore: healthyBefore.run.acceptedInputBytes,
        acceptedInputBytesAfter: inputAfter.run.acceptedInputBytes }
    }
    const journal = await queue.readJournal()
    assert.equal(journal.filter(record => record.kind === 'dispatch-open').length, 1)
    assert.deepEqual(journal.filter(record => record.kind === 'dispatch-event').map(record => record.replyMessageId),
      ['question-one', 'question-two', 'done'])
    report = { ...report, messageIds: ['question-one', 'question-two', 'done'], dispatch: done.result,
      operations, durableDispatchRecordCount: 4 }
  } catch (error) { failure = error } finally {
    const failures = []
    for (const child of [...cliChildren].reverse()) {
      try { await stopOwnedChild(child) } catch (error) { failures.push(error) }
    }
    for (const value of sessions) {
      try { await client.stopAgent(value.agentSessionId, value.run) } catch (error) { failures.push(error) }
    }
    try { await client.dispose() } catch (error) { failures.push(error) }
    for (const pid of ownedAgentPids) {
      try { await waitFor(async () => pidGone(pid) ? true : undefined, 'owned Agent process exit') } catch (error) { failures.push(error) }
    }
    try { await stopOwnedChild(daemon) } catch (error) { failures.push(error) }
    if (failures.length) {
      // Preserve this private root for its owner when cleanup cannot be proven. Never remove
      // its files while an owned process could still reference them, or signal another Runtime.
      throw new AggregateError([...(failure ? [failure] : []), ...failures], `Private dispatch cleanup incomplete: ${fixtureRoot}`)
    }
    await rm(fixtureRoot, { recursive: true })
    cleanup = { ownedAgentPids: [...ownedAgentPids], ownedCliPids: cliChildren.map(child => child.pid),
      daemonPid: daemon.pid, allOwnedProcessesGone: true, privateRootRemoved: true }
  }
  if (failure) throw failure
  const after = await fingerprint()
  assert.deepEqual(after, before, 'Source/compiled/native inputs changed during the private proof')
  return { schema: 'agentmux.dispatch-private-proof.v1', scenario, report, cleanup,
    inputs: { before, after } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--scenario')
  const result = await runDispatchProof(index === -1 ? 'cli' : process.argv[index + 1])
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
