import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const exec = promisify(execFile)

/** Actual public service and compiled CLI against the existing private Native owner. */
export async function verifyCapabilityPublicCli({ client, core, ControlServer, privateRoot, coreSnapshot, ids }) {
  const store = new core.AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json'))
  const env = { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1',
    AGENTMUX_FAKE_NATIVE_PRESERVE: '1', AGENTMUX_FAKE_NATIVE_LAUNCH_INPUT: '1',
    CODEX_HOME: path.join(privateRoot, 'codex'), AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: path.join(privateRoot, 'codex', 'sessions') }
  const launch = { providerId: 'codex', executorId: 'private-public-cli', workspacePath: path.join(privateRoot, 'workspace'),
    commandOverride: path.join(privateRoot, 'fake-codex'), env, injectAgentMuxGuide: false }
  const wait = async read => {
    const deadline = Date.now() + 20_000
    do { const value = await read(); if (value) return value; await new Promise(done => setTimeout(done, 40)) } while (Date.now() < deadline)
    throw new Error('The private public-CLI Native fact did not settle.')
  }
  const created = await client.createAgent({ ...launch, createOperationId: 'private-public-cli-create' })
  await wait(async () => {
    const value = (await store.load()).find(one => one.agentSessionId === created.agentSessionId)
    return value?.nativeHandle?.kind === 'provider'
  })
  const observer = await core.connectLocalAgentMux({ store })
  let server
  try {
    assert.ok(client.runtimeIdentity().instanceId)
    assert.equal(observer.runtimeIdentity().instanceId, client.runtimeIdentity().instanceId)
    assert.equal(observer.agentSession(created.agentSessionId).run.runId, created.run.runId)
    await client.stopTerminal(created.run)
    const resumed = await client.resumeAgent({ ...launch, agentSessionId: created.agentSessionId,
      operationId: 'private-public-cli-resume', prompt: 'Continue the private original conversation for the public observation check.' })
    assert.notEqual(resumed.run.runId, created.run.runId)
    assert.deepEqual(resumed.nativeHandle, client.agentSession(created.agentSessionId).nativeHandle)
    await wait(async () => {
      const replay = await client.readRunReplay(resumed.run)
      return Buffer.concat(replay.replay.map(one => Buffer.from(one.dataBytes))).toString('utf8').includes('codex-ready:')
    })
    const socketPath = path.join(privateRoot, 'control.sock')
    server = new ControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: observer }] })
    await server.start()
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const cliEnv = { ...cleanEnv, CODEX_HOME: env.CODEX_HOME, AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath,
      AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'runtime/state'),
      AGENTMUX_AGENT_SESSION_STORE: store.path, AGENTMUX_MESSAGE_QUEUE_PATH: path.join(privateRoot, 'messages.ndjson') }
    const facts = async () => (await client.listRuns()).map(one => ({ runId: one.runId, pid: one.pid,
      state: one.state, acceptedInputBytes: one.acceptedInputBytes })).sort((a, b) => a.runId.localeCompare(b.runId))
    const cases = [
      { kind: 'healthy', sessionId: ids.healthy.sessionId, run: ids.healthy.run },
      { kind: 'rebound', sessionId: created.agentSessionId, run: resumed.run },
      { kind: 'unconfirmed', sessionId: ids.working.sessionId, run: ids.working.run },
      { kind: 'retired', sessionId: ids.idle.sessionId, run: ids.idle.run }
    ]
    const results = []
    for (const target of cases) {
      const before = await facts()
      assert.ok(before.some(one => one.runId === ids.healthy.run.runId && one.state === 'running'))
      assert.ok(before.filter(one => one.state === 'running').every(one => Number.isSafeInteger(one.acceptedInputBytes) && one.acceptedInputBytes >= 0),
        'Unknown Native input cursors cannot prove a side-effect-free read.')
      let code = 0, stdout = '', stderr = ''
      try {
        const result = await exec(process.execPath, [path.join(coreSnapshot, 'bin/amux'), 'agent', 'refresh', '--session', target.sessionId],
          { env: cliEnv, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
        stdout = result.stdout; stderr = result.stderr
      } catch (error) {
        assert.equal(error.signal, null, 'A killed CLI is not a semantic refusal.')
        assert.equal(error.code, 1, 'The retired target must return an ordinary typed refusal.')
        code = error.code; stdout = error.stdout ?? ''; stderr = error.stderr ?? ''
      }
      const reply = JSON.parse(code === 0 ? stdout : stderr)
      assert.equal(reply.operation, 'agent.refresh')
      if (target.kind === 'retired') {
        assert.equal(code, 1); assert.equal(reply.ok, false)
        assert.equal(reply.error.code, 'UNKNOWN_AGENT_SESSION')
        assert.ok((await store.loadRetiredAgentSessions()).some(one => one.agentSessionId === target.sessionId && one.source === 'user'))
        assert.equal((await store.load()).some(one => one.agentSessionId === target.sessionId), false)
      } else {
        assert.equal(code, 0); assert.equal(reply.ok, true)
        assert.equal(reply.result.session.agentSessionId, target.sessionId)
        assert.equal(reply.result.session.hostId, 'local')
        assert.deepEqual(reply.result.session.run, target.run)
        if (target.kind === 'unconfirmed') assert.equal(reply.result.session.nativeHandle, undefined)
      }
      const after = await facts()
      assert.deepEqual(after, before, 'Public refresh cannot start, stop or write any original Native Run.')
      results.push({ ...target, code, reply, nativeBefore: before, nativeAfter: after, nativeFactsUnchanged: true })
    }
    assert.equal((await client.listRuns()).find(one => one.runId === ids.healthy.run.runId)?.state, 'running')
    return { passed: true, boundary: 'compiled amux -> public ControlServer -> actual Core/FileStore/Native', runtimeIdentity: client.runtimeIdentity(),
      auxiliarySession: { sessionId: created.agentSessionId, previousRun: created.run, reboundRun: resumed.run },
      results, zeroLifecycleOrInputDuringRefresh: true }
  } finally {
    await server?.stop()
    await observer.dispose()
  }
}
