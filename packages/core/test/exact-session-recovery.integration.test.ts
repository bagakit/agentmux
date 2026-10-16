import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import * as core from '../dist/index.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from './helpers/object-cli-rpc.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private exact recovery cleanup failed')
})
const rows = async (path: string): Promise<any[]> => (await readFile(path, 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error; return ''
})).split('\n').filter(Boolean).map(line => JSON.parse(line))

it('cold Hosted recovery admits only the exact Session while full observation and native status are pending', async () => {
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/exact-recovery-owner.mjs'))
  const scope = await headlessFixture(); cleanup.push(scope.cleanup); await scope.stopOwner()
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(scope.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, value)
  const directory = scope.env.AGENTMUX_STATE_DIRECTORY!, store = new core.AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const seed = new core.AgentMuxClient({ store }); cleanup.push(() => seed.dispose())
  Object.defineProperty((seed as any).hookServer, 'port', { value: 0 }); await seed.connect()
  const command = resolve(import.meta.dirname, 'fixtures/fake-codex-cli.mjs')
  const env = { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_PRESERVE: '1',
    AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(scope.root, 'native') }
  const create = async (id: string, context = true) => {
    const session = await seed.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: id, createOperationId: 'create-' + id,
      workspacePath: scope.root, commandOverride: command, args: [], env: context ? env : { AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false })
    return context ? await until(() => seed.agentSession(id), value => Boolean(value.nativeHandle), 'original native handle') : session
  }
  const statusTarget = await create('cold-status'), live = await create('cold-continuity'), ended = await create('cold-resume'),
    unknown = await create('cold-unconfirmed-context', false), retired = await create('cold-retired'), heldStatus = await create('cold-native-status')
  const before = await seed.statusAgent(live.agentSessionId), native = seed.runtimeIdentity(), nativePid = scope.nativeProcessId
  for (const session of [ended, unknown]) {
    const status = await seed.statusAgent(session.agentSessionId); process.kill(status.run.pid!, 'SIGTERM')
    await until(() => seed.statusAgent(session.agentSessionId), value => value.run.state === 'exited', 'original ended Run')
  }
  await seed.stopAgent(retired.agentSessionId, retired.run)
  const retirement = await store.readRetiredAgentSession(retired.agentSessionId)
  expect(retirement).toMatchObject({ agentSessionId: retired.agentSessionId, run: retired.run, source: 'user' })
  await seed.dispose()
  const hold = join(directory, 'hold-full-observation'), nativeHold = join(directory, 'hold-native-observation')
  await writeFile(hold, 'original full observation remains pending'); await writeFile(nativeHold, heldStatus.nativeHandle!.sessionId)
  const release = async () => { await Promise.all([hold, nativeHold].map(path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error }))) }
  cleanup.push(release)
  const restarted = await scope.restart(), rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: restarted.socketPath } })
  cleanup.push(() => rpc.dispose())
  const sdk = await scope.client(rpc)
  const readCut = (await rows(join(directory, 'metadata-reads'))).length
  await until(() => rows(join(directory, 'connect-attempts')), value => value.some(row => row.pid === restarted.owner.processId), 'pending background full observation')
  const attempts = () => rows(join(directory, 'connect-attempts')).then(value => value.filter(row => row.pid === restarted.owner.processId).length)
  async function exact<T>(operation: () => Promise<T>, label: string): Promise<T> {
    const count = await attempts(); let settled = false
    const result = operation().then(value => ({ value }), error => ({ error }))
    const observer = (async () => {
      while (!settled) {
        if (await attempts() > count) return { blocked: true }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return { cancelled: true }
    })()
    const outcome = await Promise.race([result, observer]); settled = true
    if ('blocked' in outcome) { await release(); await result }
    expect(outcome, label).toHaveProperty('value')
    if (!('value' in outcome)) throw new Error(label + ': ' + JSON.stringify(outcome))
    return outcome.value
  }
  const physical = await exact(() => sdk.statusAgent(statusTarget.agentSessionId), 'physical status cannot await full Host observation')
  expect(physical.run).toMatchObject({ runId: statusTarget.run.runId, state: 'running' })
  const again = sdk.statusAgent(heldStatus.agentSessionId); let statusSettled = false; void again.then(() => { statusSettled = true })
  await until(() => readFile(join(directory, 'native-observation-entered'), 'utf8').catch(() => ''), Boolean, 'pending native observer')
  await rpc.call('runtime.owner.identity', {}); await rpc.call('runtime.owner.identity', {})
  const independentlyAvailable = statusSettled
  if (!independentlyAvailable) { await unlink(nativeHold); await again }
  expect(independentlyAvailable, 'physical status cannot wait for its auxiliary native observer').toBe(true)
  await again
  const reattached = await exact(() => sdk.ensureAgentContinuity({ agentSessionId: live.agentSessionId, expectedRun: live.run,
    operationId: 'original-live-rejoin', trigger: 'manual' }), 'healthy continuity cannot await full Host observation')
  expect(reattached.kind, 'cold exact continuity must adopt its original metadata').toBe('reattachable')
  expect(reattached).toMatchObject({ session: { agentSessionId: live.agentSessionId, run: live.run }, run: { pid: before.run.pid } })
  const attached = await sdk.reattachAgent(live.agentSessionId)
  expect(attached.attachment.replay.reduce((bytes, chunk) => bytes + chunk.dataBytes.length, 0), 'the rejoined original Run must retain readable terminal bytes').toBeGreaterThan(0)
  const input = await sdk.writeAgent({ agentSessionId: live.agentSessionId, expectedRun: live.run, source: 'user', data: 'new authorized original input' })
  expect(input.appliedByteRange!.startByte).toBe(before.run.acceptedInputBytes)
  expect((await sdk.statusAgent(live.agentSessionId)).run).toMatchObject({ runId: live.run.runId, pid: before.run.pid, state: 'running' })
  const context = await exact(() => sdk.ensureAgentContinuity({ agentSessionId: unknown.agentSessionId, expectedRun: unknown.run,
    operationId: 'original-context-unknown', trigger: 'manual' }), 'unknown context inspection cannot await full Host observation')
  expect(context).toMatchObject({ kind: 'unavailable', reason: 'native-handle-unavailable' })
  const stopped = await exact(() => sdk.ensureAgentContinuity({ agentSessionId: retired.agentSessionId, expectedRun: retired.run,
    operationId: 'original-retirement-inspect', trigger: 'manual' }), 'retirement inspection cannot await full Host observation')
  expect(stopped, 'cold exact retirement must retain its original refusal').toMatchObject({ kind: 'retired', evidence: { observedAt: retirement!.observedAt } })
  const db = new DatabaseSync(store.path)
  try {
    db.prepare('UPDATE retired_sessions SET json=? WHERE id=?').run(JSON.stringify({ ...retirement, hostId: 'another-private-host' }), retired.agentSessionId)
    const foreign = await sdk.ensureAgentContinuity({ agentSessionId: retired.agentSessionId, expectedRun: retired.run,
      operationId: 'foreign-retirement-inspect', trigger: 'manual' })
    expect(foreign, 'another Host retirement cannot become a local Session fact').toMatchObject({ kind: 'unavailable', reason: 'unknown-session' })
  } finally {
    db.prepare('UPDATE retired_sessions SET json=? WHERE id=?').run(JSON.stringify(retirement), retired.agentSessionId); db.close()
  }
  const resumed = await exact(() => sdk.resumeAgent({ agentSessionId: ended.agentSessionId, operationId: 'original-cold-resume',
    prompt: 'Continue the same original fixture conversation.', commandOverride: command, env }),
  'native resume cannot await full Host observation')
  expect(resumed.run, 'cold exact resume must adopt the original Session before its lifecycle').not.toEqual(ended.run)
  expect(resumed.nativeHandle).toEqual(ended.nativeHandle)
  const stored = (await store.readMetadata(ended.agentSessionId))!, receipt = stored.continuityOperations!['original-cold-resume']!
  expect(receipt).toMatchObject({ previousRun: ended.run, newRun: resumed.run, kind: 'resumed', nativeTarget: ended.nativeHandle })
  const retry = await sdk.resumeAgent({ agentSessionId: ended.agentSessionId, operationId: 'original-cold-resume',
    prompt: 'Continue the same original fixture conversation.', commandOverride: command, env })
  expect(retry.run).toEqual(resumed.run)
  await expect(sdk.resumeAgent({ agentSessionId: ended.agentSessionId, operationId: 'original-cold-resume',
    prompt: 'A changed original request.', commandOverride: command, env })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  const wrong = await sdk.ensureAgentContinuity({ agentSessionId: live.agentSessionId, expectedRun: ended.run, operationId: 'wrong-original-run' })
  expect(wrong).toMatchObject({ kind: 'conflict', reason: 'session-run-changed', currentRun: live.run })
  const reads = (await rows(join(directory, 'metadata-reads'))).slice(readCut).filter(row => row.pid === restarted.owner.processId)
  expect(reads.filter(row => row.consumer && ['loadMetadata', 'loadRetiredAgentSessions'].includes(row.method)), 'exact recovery cannot scan the Session or retirement catalog').toEqual([])
  expect((await rows(join(directory, 'native-operations'))).filter(row => row.method === 'start')).toHaveLength(1)
  expect((await rows(join(directory, 'native-operations'))).filter(row => row.method === 'input' && row.runId === live.run.runId)).toHaveLength(1)
  expect(sdk.runtimeIdentity()).toEqual(native); expect(scope.nativeProcessId).toBe(nativePid)
  // Actual public CLI inspection uses the exact physical status consumer while the same full observer remains held.
  const cli = await runCompiledObjectCli(['--endpoint', `unix:${restarted.socketPath}`, 'agent', 'inspect', '--session', live.agentSessionId], scope.env)
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.status.run).toMatchObject({ runId: live.run.runId, pid: before.run.pid })
  await release()
}, 60_000)

it('full Runtime observation contains exact auxiliary failures without declaring the full Host observed', async () => {
  const scope = await headlessFixture(); cleanup.push(scope.cleanup); await scope.stopOwner()
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(scope.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, value)
  const store = new core.AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const seed = new core.AgentMuxClient({ store }); cleanup.push(() => seed.dispose())
  Object.defineProperty((seed as any).hookServer, 'port', { value: 0 }); await seed.connect()
  const command = resolve(import.meta.dirname, 'fixtures/fake-codex-cli.mjs'), env = { AGENTMUX_FAKE_READY_MODE: 'before',
    AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(scope.root, 'native') }
  const predispatch = vi.spyOn((seed as any).kernel, 'input').mockRejectedValueOnce(new core.AgentMuxError(
    'Private optional reply was not dispatched.', 'CTXMUX_io', undefined, { disposition: 'not_applied', confirmedInputBytes: 0 }))
  const first = await seed.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: 'auxiliary-failure',
    createOperationId: 'auxiliary-first-create', workspacePath: scope.root, commandOverride: command, args: [], env, injectAgentMuxGuide: false })
  predispatch.mockRestore()
  const second = await seed.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: 'auxiliary-native-failure',
    createOperationId: 'auxiliary-second-create', workspacePath: scope.root, commandOverride: command, args: [], env, injectAgentMuxGuide: false })
  await until(() => seed.agentSession(second.agentSessionId), value => Boolean(value.nativeHandle), 'original sibling native handle')
  const original = await seed.statusAgent(second.agentSessionId), claim = (await store.readMetadata(first.agentSessionId))!.terminalHandshake!
  await seed.dispose()
  let capabilityFailing = true, nativeFailing = true
  const provider = new core.AgentProviderRegistry().get('codex')
  const next = new core.AgentMuxClient({ store, providers: [{ ...provider, observeSessionStatus: async context => {
    if (nativeFailing && context.nativeHandle?.sessionId === original.session.nativeHandle!.sessionId) throw new core.AgentMuxError(
      'Private original native status source is unavailable.', 'PRIVATE_NATIVE_STATUS_UNAVAILABLE')
    return await provider.observeSessionStatus!(context)
  } }] }); cleanup.push(() => next.dispose())
  Object.defineProperty((next as any).hookServer, 'port', { value: 0 })
  const kernel = (next as any).kernel, observe = kernel.attach.bind(kernel)
  const fault = vi.spyOn(kernel, 'attach').mockImplementation(async (...args: any[]) => {
    if (capabilityFailing && args[0] === first.run.runId) throw new core.AgentMuxError('Private exact capability observation failed.', 'PRIVATE_CAPABILITY_OBSERVATION_UNAVAILABLE')
    return await observe(...args)
  })
  const starts = vi.spyOn(kernel, 'start'), inputs = vi.spyOn(kernel, 'input'), events: core.AgentMuxClientEvent[] = []
  next.onEvent(event => { events.push(event) })
  const opened = await next.connect().then(() => ({ available: true }), error => ({ error }))
  expect(opened, 'one auxiliary Session failure cannot fail the shared Runtime connection').toEqual({ available: true })
  expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', agentSessionId: first.agentSessionId, code: 'PRIVATE_CAPABILITY_OBSERVATION_UNAVAILABLE' }))
  expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', agentSessionId: second.agentSessionId, code: 'PRIVATE_NATIVE_STATUS_UNAVAILABLE' }))
  const connection = events.filter(event => event.type === 'connection-state' && event.observationOrigin?.boundary === 'core-ctxmux').at(-1)
  expect(connection, 'incomplete Session observations cannot be silently declared complete').toMatchObject({ state: 'restored', diagnostic: { code: 'CTXMUX_CONNECTION_OBSERVATION_UNCONFIRMED' } })
  expect((next as any).connectionNeedsObservation).toBe(true)
  expect(inputs.mock.calls.filter((call: any[]) => call[0] === first.run.runId), 'failed exact observation cannot submit a capability reply').toHaveLength(0)
  expect((await store.readMetadata(first.agentSessionId))!.terminalHandshake).toEqual(claim)
  const status = await next.statusAgent(second.agentSessionId)
  expect(status.run).toMatchObject({ runId: second.run.runId, pid: original.run.pid, state: 'running' })
  const attached = await next.reattachAgent(second.agentSessionId)
  expect(attached.attachment.replay.length).toBeGreaterThan(0)
  const ack = await next.writeAgent({ agentSessionId: second.agentSessionId, expectedRun: second.run, source: 'user', data: 'new authorized input under auxiliary failure' })
  expect(ack.appliedByteRange!.startByte).toBe(original.run.acceptedInputBytes)
  expect(starts).not.toHaveBeenCalled()
  expect(inputs.mock.calls.filter((call: any[]) => call[0] === first.run.runId)).toHaveLength(0)
  capabilityFailing = false; fault.mockRestore()
  await next.connect()
  expect((next as any).connectionNeedsObservation, 'native observation failure cannot become full observation success').toBe(true)
  nativeFailing = false
  const hookFault = vi.spyOn((next as any).hookServer, 'start').mockRejectedValue(Object.assign(new Error('Private listener cannot bind.'), { code: 'EADDRINUSE' }))
  await next.connect()
  expect((next as any).connectionNeedsObservation, 'Hook restoration failure cannot become full observation success').toBe(true)
  expect(next.agentSession(second.agentSessionId).hookIngressObservation).toMatchObject({ run: second.run, code: 'EADDRINUSE' })
  hookFault.mockRestore()
  await next.connect()
  expect((next as any).connectionNeedsObservation).toBe(false)
  expect(events.filter(event => event.type === 'connection-state').at(-1)).toMatchObject({ state: 'restored' })
  expect(events.filter(event => event.type === 'connection-state').at(-1)).not.toHaveProperty('diagnostic')
}, 60_000)
