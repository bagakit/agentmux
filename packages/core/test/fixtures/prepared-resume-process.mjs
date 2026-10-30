// One private Core process. Only the first process seeds the original Session.
import { readFile } from 'node:fs/promises'
const core = await import(process.env.AGENTMUX_TEST_DURABLE_RESUME_ENTRY)
const { root, storePath, delivery, request, resolution } = JSON.parse(await readFile(process.env.AGENTMUX_TEST_RESUME_PROCESS_REQUEST, 'utf8'))
const provider = core.defineAgentProvider({ catalog: { id: 'resume-process', label: 'Controlled resume process', executable: process.execPath,
  expectedProcess: 'node', promptDelivery: delivery, readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
  hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
  capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
  buildArgs: (_prompt, args) => [...args], buildResumeArgs: (id, _path, prompt, args) => [...args, id, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
const store = new core.AgentMuxFileAgentSessionStore(storePath), client = new core.AgentMuxClient({ store, providers: [provider] })
Object.defineProperty(client.hookServer, 'port', { value: 0 })
let starts = 0, inputs = 0, server, hosted, preserveSeed = false
const start = client.kernel.startPrepared.bind(client.kernel), input = client.kernel.input.bind(client.kernel)
client.kernel.startPrepared = async (...args) => { starts++; return await start(...args) }
client.kernel.input = async (...args) => { inputs++; return await input(...args) }
async function resume() {
  if (request.prompt) return await client.resumeAgent(request)
  const current = await store.readMetadata(request.agentSessionId)
  const result = await client.ensureAgentContinuity({ agentSessionId: request.agentSessionId, operationId: request.operationId,
    expectedRun: current.continuityOperations?.[request.operationId]?.previousRun ?? current.run,
    trigger: 'manual', args: request.args, env: request.env })
  if (result.kind !== 'resumed' && result.kind !== 'reattachable') throw new core.AgentMuxError(result.continuity?.error ?? 'Private original resume pending', result.continuity?.errorCode ?? 'AGENT_RESUME_UNCONFIRMED')
  return result.session
}
async function close() {
  const errors = [], stopped = []
  if (!preserveSeed && client.kernel.isConnected()) try {
    for (const run of await client.kernel.list()) if (run.state.type === 'running') {
      await client.kernel.stop(await client.kernel.prepareStop(run.runId))
      const terminal = await client.kernel.status(run.runId)
      if (terminal.state.type === 'running') throw new Error('Private stopped Run remains running: ' + run.runId)
      const deadline = Date.now() + 3000
      for (;;) {
        try { process.kill(run.pid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
        if (Date.now() >= deadline) throw new Error('Private Run PID did not exit after exact Stop: ' + run.pid)
        await new Promise(done => setTimeout(done, 10))
      }
      stopped.push({ runId: run.runId, pid: run.pid, terminal: terminal.state.type, processExited: true })
    }
  } catch (error) { errors.push(error) }
  for (const action of [() => server?.stop(), () => hosted?.dispose(), () => client.dispose()]) try { await action() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private Core process cleanup failed')
  return stopped
}
process.once('SIGTERM', async () => { try { await close(); process.exit(0) } catch { process.exit(1) } })
try {
  await client.connect()
  if (process.argv[2] === 'resolution-crash') {
    client.kernel.observePreparedStartRetirement = async () => {
      const reservation = await store.readLifecycleReservation(request.agentSessionId)
      process.send({ phase: 'resolution-admitted', pid: process.pid, starts, inputs, resolution: reservation.resolution.receipt })
      await new Promise(() => {}) // Parent kills this exact Core process group before any Native retirement.
    }
    await client.ensureAgentContinuity(resolution)
    throw new Error('Private pre-send crash boundary was not reached')
  } else if (process.argv[2] === 'seed') {
    const ended = await client.kernel.start({ operationKey: 'original-seed', program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, env: {} })
    while ((await client.kernel.status(ended.runId)).state.type === 'running') await new Promise(done => setTimeout(done, 10))
    const now = Date.now(), previous = { kind: 'agent', agentSessionId: request.agentSessionId, providerId: provider.id, executorId: 'configured-resume',
      hostId: 'local', workspacePath: root, run: { runId: ended.runId }, retiredRuns: [], createdAt: now, updatedAt: now,
      hookBindingId: 'original-binding', hookToken: 'original-token', nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'original-native' } }
    await store.compareAndSwap(null, previous); await client.registry.load('local')
    starts = 0; let actual
    client.kernel.startPrepared = async (...args) => { starts++; actual = await start(...args); throw new core.AgentMuxError('Private original Start ACK lost', 'CONTROL_UNAVAILABLE') }
    let code
    try { await resume() } catch (error) { code = error.code }
    const reservation = await store.readLifecycleReservation(request.agentSessionId)
    process.send({ phase: 'unknown', code, starts, inputs, actualRun: actual?.runId, actualPid: actual?.pid, previous, prepared: !!reservation?.preparedDispatch, pid: process.pid })
    preserveSeed = true; await close(); process.disconnect()
  } else {
    const session = await resume()
    hosted = new core.AgentMuxHostedRuntimeService(client, storePath, () => ({ runtimeId: 'private-process-runtime', ownerInstanceId: 'private-owner', protocolVersion: 2,
      processId: process.pid, ctxmux: client.runtimeIdentity(), availability: 'connected' }))
    server = new core.AgentMuxControlServer({ socketPath: root + '/control.sock', coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => hosted })
    await server.start()
    process.send({ phase: 'ready', session, starts, inputs, pid: process.pid })
    process.once('message', async () => {
      try { const stopped = await close(); process.send({ phase: 'final', starts, inputs, stopped }); process.disconnect() }
      catch (error) { process.send({ phase: 'error', message: error.message }); process.exitCode = 1; process.disconnect() }
    })
  }
} catch (error) {
  process.send?.({ phase: 'error', message: error.message, code: error.code })
  try { await close() } finally { process.exitCode = 1; process.disconnect?.() }
}
