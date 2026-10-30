import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { agentLifecycleOperationIdentity } from '../src/agent-session-store.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import type { AgentMuxAgentSession } from '../src/types.js'
import { core, cleanups, fixture, otherRuntime } from './helpers/prepared-resume-fixture.js'

it('freezes direct native resume input and exact plan before Start with no automatic recovery text', async () => {
  const f = await fixture(), start = f.nativeStart
  f.start.mockImplementation(async (...args: any[]) => { const [input, operationKey] = args;
    const prepared = await f.correlation(), op = prepared?.preparedSession?.continuity
    expect(prepared?.preparedSession, 'Original native resume request is not prepared').toBeDefined()
    expect(prepared?.operationId).toBe(operationKey)
    expect(prepared?.preparedDispatch).toMatchObject({ runtime: f.inner.kernel.creationRuntimeIdentity(), nativeTarget: f.previous.nativeHandle })
    expect(JSON.parse(prepared!.preparedDispatch!.prepared.launch)).toEqual({ createOperationId: operationKey, request: input })
    expect(input.env.RESUME_FIXTURE).toBe('original'); expect(input.initial_size).toEqual({ cols: 81, rows: 25 })
    expect(op).toMatchObject({ trigger: 'input', requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), recoveryInputs: { reminder: '', continuation: '' },
      previousRun: f.previous.run, nativeTarget: f.previous.nativeHandle, launchInput: { state: 'prepared', input: { prompt: f.request.prompt, agentMuxNote: f.request.agentMuxNote,
        submissionId: `launch-prompt:${operationKey}` }, launchPlan: { program: '/usr/bin/env' } } })
    expect(op!.launchInput!.prompt).toBe(input.args.at(-1)); expect(input.args.at(-2)).toBe('original-native')
    return await start(...args)
  })
  const resumed = await f.resume()
  expect(resumed.continuity).toMatchObject({ kind: 'resumed', launchInput: { state: 'launch-carried', receipt: { run: resumed.run } } })
  expect(await f.correlation()).toBeUndefined()
  expect((await f.resume()).run).toEqual(resumed.run); f.noReplacement()
  await f.write(resumed)
})

it('keeps acknowledged direct resume work and original prepared input after commit was not applied', async () => {
  const f = await fixture(), commit = vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled commit rejected'))
  const outcome = await f.resume().then(value => ({ value }), error => ({ error }))
  expect(outcome).not.toHaveProperty('error')
  const resumed = (outcome as { value: AgentMuxAgentSession }).value
  expect(resumed.continuity).toMatchObject({ reason: 'operation-unconfirmed', newRun: resumed.run })
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run)
  expect((await f.client.readAgentSessions())[0]!.run).toEqual(resumed.run)
  await f.inner.registry.load('local'); expect(f.client.agentSession(f.previous.agentSessionId).run).toEqual(resumed.run)
  expect((await f.client.refreshAgentSession(f.previous.agentSessionId)).run).toEqual(resumed.run)
  f.noReplacement(); await f.write(resumed)
  commit.mockRestore(); const recovered = await f.resume()
  expect(recovered.run).toEqual(resumed.run); expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(resumed.run)
  f.noReplacement(1)
})

it('reads the same direct resume receipt after applied commit ACK loss', async () => {
  const f = await fixture(), commit = f.store.commitLifecycle.bind(f.store)
  vi.spyOn(f.store, 'commitLifecycle').mockImplementationOnce(async (...args: any[]) => { await commit(...args as [any, any]); throw new Error('Controlled commit ACK lost') })
  const resumed = await f.resume(), same = await f.resume()
  expect(same.run).toEqual(resumed.run); expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(resumed.run)
  f.noReplacement(); await f.write(same)
})

it('reconciles an applied direct Start with lost ACK after dispose without another Start or input', async () => {
  const f = await fixture(); let actual: any
  f.start.mockImplementationOnce(async (...args: any[]) => { const [input, operationKey] = args; actual = await f.nativeStart(...args); throw new core.AgentMuxError('Lost original Start ACK', 'CONTROL_UNAVAILABLE', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  expect((await f.correlation())?.preparedSession?.continuity?.launchInput?.state).toBe('prepared')
  const observation = vi.spyOn(f.inner.kernel, 'inspectPreparedStart').mockResolvedValueOnce(null)
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' }); observation.mockRestore()
  await f.client.dispose(); const second = await f.reader(), recovery = f.resume({}, second)
  await expect(recovery).resolves.toMatchObject({ agentSessionId: f.previous.agentSessionId, run: { runId: actual.runId } })
  const recovered = await recovery
  expect(recovered.run.runId).toBe(actual.runId); expect(recovered.nativeHandle).toEqual(f.previous.nativeHandle)
  f.noReplacement(); await f.write(recovered, second)
})

it('does not claim a foreign lifecycle or repeat an unknown Start without a matching original Run', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new core.AgentMuxError('Original Start unknown', 'CONTROL_UNAVAILABLE'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const originalStart: any = f.start.mock.calls[0]![0]
  const foreign = await f.nativeStart({ ...originalStart, env: { ...originalStart.env, AGENTMUX_LIFECYCLE_OPERATION_ID: 'foreign-operation' } }, 'foreign-operation')
  expect(foreign.lifecycleOperationId).toBe('foreign-operation')
  const inventory = vi.spyOn(f.inner.kernel, 'list').mockRejectedValue(new Error('Unrelated inventory unavailable'))
  vi.spyOn(f.inner.kernel, 'inspectPreparedStart').mockResolvedValueOnce(foreign)
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run); expect(await f.correlation()).toBeDefined(); f.noReplacement(); expect(inventory).not.toHaveBeenCalled()
})

it.each([{ prompt: 'changed task' }, { agentMuxNote: 'changed context' }, { args: ['-e', 'process.exit(1)'] },
  { env: { RESUME_FIXTURE: 'changed' } }, { cols: 93 }, { commandOverride: 'another-command' }])('rejects changed direct input or launch intent against the immutable original operation: %j', async patch => {
  const f = await fixture()
  f.start.mockImplementationOnce(async (...args: any[]) => { const [input, operationKey] = args; await f.nativeStart(...args); throw new core.AgentMuxError('Original Start unknown', 'CONTROL_UNAVAILABLE') })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const original = await f.correlation()
  await expect(f.resume(patch)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(await f.correlation()).toEqual(original); f.noReplacement()
})

it('serializes same-client original operation and preserves strict distinct-operation running rejection', async () => {
  const f = await fixture(), results = await Promise.all([f.resume(), f.resume()])
  expect(results[0].run).toEqual(results[1].run)
  await expect(f.resume({ operationId: 'different-resume' })).rejects.toMatchObject({ code: 'AGENT_SESSION_STILL_RUNNING' })
  f.noReplacement()
})

it('admits one direct resume across independent FileStore clients and reconciles their original receipt', async () => {
  const f = await fixture(), second = await f.reader(), prepare = f.store.prepareResume.bind(f.store)
  let release!: () => void, entered!: () => void
  const arrived = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
  vi.spyOn(f.store, 'prepareResume').mockImplementationOnce(async (...args: any[]) => { const result = await prepare(...args as [any, any, any]); entered(); await held; return result })
  const first = f.resume(); await arrived
  try { await expect(f.resume({}, second)).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' }) } finally { release() }
  const resumed = await first
  expect((await f.resume({}, second)).run).toEqual(resumed.run); f.noReplacement()
})

it('delivers post-launch-only direct input once through the original frozen submission key', async () => {
  const f = await fixture('post-launch-only'), resumed = await f.resume()
  const original = resumed.continuity!.launchInput!
  expect(original).toMatchObject({ delivery: 'post-launch', state: 'terminal-confirmed', input: { submissionId: expect.stringMatching(/^launch-prompt:/u) } })
  // PTY reads can split a long payload anywhere. The controlled process marks
  // each received chunk, so remove those marks before checking the exact wire.
  await vi.waitFor(async () => expect((await f.replay(resumed)).replaceAll('\r\n', '\n').replaceAll('INPUT:', '')).toContain(original.prompt))
  expect((await f.resume()).run).toEqual(resumed.run)
  expect((await f.client.inspectAgentPromptSubmission(original.key!))?.admission).toMatchObject({ acknowledged: true })
  f.noReplacement(1)
})

it('retains the original unknown post-launch claim without replay after retry', async () => {
  const f = await fixture('post-launch-only'), nativeInput = f.input.getMockImplementation()!
  f.input.mockImplementationOnce(async (...args: any[]) => { await nativeInput(...args); throw new core.AgentMuxError('Original input ACK lost', 'CONTROL_UNAVAILABLE') })
  const resumed = await f.resume(), original = resumed.continuity!.launchInput!
  expect(original).toMatchObject({ delivery: 'post-launch', state: 'unknown' })
  const before = f.input.mock.calls.length
  expect((await f.resume()).run).toEqual(resumed.run)
  expect(f.input).toHaveBeenCalledTimes(before); expect(before).toBe(1); expect(f.stop).not.toHaveBeenCalled()
})

it('releases unused direct preparation for an authoritatively not-applied Start', async () => {
  const f = await fixture()
  f.start.mockImplementationOnce(async (_request: unknown, operationKey: string) => {
    throw new core.AgentMuxError('Start not applied', 'CONTROL_UNAVAILABLE', undefined, undefined, undefined,
      { operationId: operationKey, disposition: 'not_applied' })
  })
  await expect(f.resume()).rejects.toMatchObject({ creationFailure: { disposition: 'not_applied' } })
  expect(await f.correlation()).toBeUndefined(); expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run)
  expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it.each(['foreign-operation', 'input-receipt', 'unknown-start'] as const)('retains direct resume preparation for a %s negative receipt', async kind => {
  const f = await fixture()
  const storageFailure = { stage: 'start' as const, sqlitePrimaryCode: 14, sqliteExtendedCode: 14,
    systemErrno: 2, transactionOutcome: 'not_started' as const }
  const original = new core.AgentMuxError('Original Start transport outcome unknown', 'CTXMUX_io', undefined,
    kind === 'input-receipt' ? { disposition: 'not_applied', confirmedInputBytes: null } : undefined,
    undefined, kind === 'foreign-operation' ? { operationId: 'unrelated-start', disposition: 'not_applied' }
      : kind === 'unknown-start' ? { operationId: agentLifecycleOperationIdentity('resume', f.previous.agentSessionId, f.request.operationId), disposition: 'unknown' } : undefined, storageFailure)
  f.start.mockRejectedValueOnce(original)
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED', cause: original, storageFailure,
    creationFailure: { operationId: agentLifecycleOperationIdentity('resume', f.previous.agentSessionId, f.request.operationId), disposition: 'unknown' } })
  expect(await f.correlation()).toMatchObject({ preparedSession: { run: f.previous.run } })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  f.noReplacement()
})

it('existing Hosted direct resume and actual public CLI inspect share the original typed receipt', async () => {
  const f = await fixture()
  const hosted = new core.AgentMuxHostedRuntimeService(f.client, f.store.path, () => ({ runtimeId: 'resume-runtime', ownerInstanceId: 'resume-owner', protocolVersion: 2,
    processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const reader = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => reader.dispose())
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled Hosted commit rejected'))
  const resumed = await reader.resumeAgent(f.request)
  expect(resumed.continuity!.reason).toBe('operation-unconfirmed')
  if (process.env.AGENTMUX_TEST_OBJECT_CLI) {
    const inspected = await runCompiledObjectCli(['agent', 'inspect', '--session', f.previous.agentSessionId], objectCliEnvironment(f.root))
    expect(inspected.code, inspected.stderr).toBe(0)
    expect(JSON.parse(inspected.stdout)).toMatchObject({ ok: true, result: { session: { run: resumed.run,
      continuity: { reason: 'operation-unconfirmed', requestDigest: resumed.continuity!.requestDigest, launchInput: { state: 'launch-carried' } } } } })
  } else expect((await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: f.previous.agentSessionId } })).session.run).toEqual(resumed.run)
  expect((await reader.resumeAgent(f.request)).run).toEqual(resumed.run)
  f.noReplacement()
})

it('reconciles post-launch-only Start ACK loss before dispatching the original first input once', async () => {
  const f = await fixture('post-launch-only')
  f.start.mockImplementationOnce(async (...args: any[]) => { const [input, operationKey] = args; await f.nativeStart(...args); throw new core.AgentMuxError('Original Start ACK lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' }); expect(f.input).not.toHaveBeenCalled()
  await f.client.dispose(); const second = await f.reader(), resumed = await f.resume({}, second)
  expect(resumed.continuity!.launchInput).toMatchObject({ delivery: 'post-launch', state: 'terminal-confirmed' })
  expect((await f.resume({}, second)).run).toEqual(resumed.run); f.noReplacement(1)
})

it('rejects a mismatching actual RunSpec without claiming or replacing the original unknown Start', async () => {
  const f = await fixture(); let actual: any
  f.start.mockImplementationOnce(async (...args: any[]) => { const [input, operationKey] = args; actual = await f.nativeStart(...args); throw new core.AgentMuxError('Original Start ACK lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const native = f.inner.kernel.client, observe = native.observeCreation.bind(native)
  vi.spyOn(native, 'observeCreation').mockImplementationOnce(async (...args: any[]) => {
    const retained = await observe(...args)
    expect(retained.observation.outcome).toBe('retained')
    retained.observation.run.spec.env.RESUME_FIXTURE = 'different-private-environment'
    return retained
  })
  await expect(f.resume()).rejects.toMatchObject({ code: 'PREPARED_START_UNCONFIRMED' })
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run); f.noReplacement()
})

it('does not retain an unconfirmed started projection after its original canonical Host changes', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled commit rejected'))
  const resumed = await f.resume(), old = (await f.store.readMetadata(f.previous.agentSessionId))!
  await f.store.compareAndSwapMetadata(old, { ...old, hostId: 'foreign-host' })
  expect((await f.client.readAgentSessions())[0]!.hostId).toBe('foreign-host')
  await expect(f.resume()).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect((await f.inner.kernel.status(resumed.run.runId)).state.type).toBe('running'); f.noReplacement()
})

it('does not revive the prepared projection after authoritative user retirement', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled commit rejected'))
  await f.resume(); const reservation = (await f.correlation())!
  await f.store.releaseLifecycle(reservation)
  const retired = { reservationId: 'user-retirement', ownerId: 'private-user-owner', ownerPid: process.pid,
    expiresAt: Date.now() + 1000, kind: 'stop' as const, agentSessionId: f.previous.agentSessionId, operationId: 'user-stop', expectedRun: f.previous.run,
    stopOperation: { daemonInstance: 'private-runtime', operationKey: 'user-stop', runId: f.previous.run.runId } }
  await f.store.reserveLifecycle(retired); await f.store.commitLifecycle(retired, null)
  expect(await f.client.readAgentSessions()).toEqual([])
  await expect(f.resume()).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect(await f.store.loadRetiredAgentSessions()).toEqual([expect.objectContaining({ source: 'user', agentSessionId: f.previous.agentSessionId })]); f.noReplacement()
})


it('reports an already-exited original Start as typed fatal after ACK loss without replaying its task', async () => {
  const f = await fixture('positional-argv', true); let actual: any
  f.start.mockImplementationOnce(async (...args: any[]) => { const [input, operationKey] = args; actual = await f.nativeStart(...args); throw new core.AgentMuxError('Original Start ACK lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  await vi.waitFor(async () => expect((await f.inner.kernel.status(actual.runId)).state.type).toBe('exited'))
  await f.client.dispose(); const second = await f.reader()
  await expect(f.resume({}, second)).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED', message: expect.stringContaining('controlled startup exit') })
  const original = (await second.store.readMetadata(f.previous.agentSessionId))!.continuityOperations![f.request.operationId]!
  expect(original).toMatchObject({ errorCode: 'AGENT_TERMINAL_HANDSHAKE_FAILED', reason: 'process-exited', newRun: { runId: actual.runId } })
  await expect(f.resume({}, second)).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' }); f.noReplacement()
})


it.each(['executorId', 'workspacePath'] as const)('does not overwrite a changed original canonical %s while reconciling prepared resume', async field => {
  const f = await fixture()
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled commit rejected'))
  const resumed = await f.resume(), old = (await f.store.readMetadata(f.previous.agentSessionId))!
  await f.store.compareAndSwapMetadata(old, { ...old, [field]: field === 'workspacePath' ? join(f.root, 'another-workspace') : 'another-executor' })
  expect((await f.client.readAgentSessions())[0]!.run).toEqual(f.previous.run)
  await expect(f.resume()).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.[field]).not.toBe(f.previous[field])
  expect((await f.inner.kernel.status(resumed.run.runId)).state.type).toBe('running'); f.noReplacement()
})

it('keeps the prepared operation after a real fatal exit and unconfirmed original commit', async () => {
  const f = await fixture('positional-argv', true)
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled commit rejected'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' })
  expect(await f.correlation()).toBeDefined(); expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run)
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' })
  f.noReplacement()
})

it('keeps a real failed recovery terminal through public CLI reads and permits a separate explicit recovery', async () => {
  const f = await fixture('positional-argv', true)
  const runCli = process.env.AGENTMUX_TEST_OBJECT_CLI ? runCompiledObjectCli : runSourceObjectCli
  const request = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'failed-manual-recovery',
    trigger: 'manual' as const, args: f.request.args!, env: f.request.env! }
  const failure = { code: 'AGENT_TERMINAL_HANDSHAKE_FAILED', message: expect.stringContaining('controlled startup exit') }
  await expect(f.client.ensureAgentContinuity(request)).rejects.toMatchObject(failure)
  const failed = (await f.store.readMetadata(f.previous.agentSessionId))!, operation = failed.continuityOperations![request.operationId]!
  expect(failed).toMatchObject({ run: f.previous.run, nativeHandle: f.previous.nativeHandle,
    retiredRuns: [operation.newRun], continuity: { kind: 'unavailable', reason: 'process-exited', errorCode: failure.code, error: failure.message } })
  expect((await f.inner.kernel.status(operation.newRun!.runId)).state).toMatchObject({ type: 'exited', code: 1 })
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const env = objectCliEnvironment(f.root, { NODE_NO_WARNINGS: '1' })
  for (let i = 0; i < 2; i++) {
    const checked = await runCli(['agent', 'resume', '--session', f.previous.agentSessionId, '--operation-id', request.operationId], env)
    expect(checked.code, checked.stderr).toBe(1)
    expect(JSON.parse(checked.stderr)).toMatchObject({ ok: false, error: { code: failure.code, message: failure.message } })
  }
  const inspected = await runCli(['agent', 'inspect', '--session', f.previous.agentSessionId], env)
  expect(inspected.code, inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout)).toMatchObject({ ok: true, result: { session: { run: f.previous.run, nativeHandle: f.previous.nativeHandle,
    continuity: operation, continuityOperations: { [request.operationId]: operation } } } })
  expect(f.start).toHaveBeenCalledOnce(); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  const healthy = "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d));process.stdout.write('\\x1b[?u');setInterval(()=>{},1000)"
  const recovered = await f.client.ensureAgentContinuity({ ...request, operationId: 'new-explicit-recovery', args: ['-e', healthy] })
  expect(recovered.kind).toBe('resumed')
  if (recovered.kind !== 'resumed') throw new Error('Explicit recovery did not return its actual Run')
  expect(recovered.run).not.toEqual(f.previous.run); expect(recovered.run).not.toEqual(operation.newRun)
  expect(recovered.session.nativeHandle).toEqual(f.previous.nativeHandle)
  const saved = (await f.store.readMetadata(f.previous.agentSessionId))!
  expect(saved.continuityOperations![request.operationId]).toEqual(operation)
  expect(saved.retiredRuns).toEqual([operation.newRun, f.previous.run])
  await expect(f.client.ensureAgentContinuity(request)).rejects.toMatchObject(failure)
  const oldResult = await runCli(['agent', 'resume', '--session', f.previous.agentSessionId, '--operation-id', request.operationId], env)
  expect(oldResult.code, oldResult.stderr).toBe(1)
  expect(JSON.parse(oldResult.stderr)).toMatchObject({ ok: false, error: { code: failure.code, message: failure.message } })
  expect(await f.store.readMetadata(f.previous.agentSessionId)).toEqual(saved)
  expect((await f.inner.kernel.status(recovered.run.runId)).state.type).toBe('running')
  await expect(f.client.ensureAgentContinuity({ ...request, operationId: 'new-explicit-recovery', args: ['-e', healthy] }))
    .resolves.toMatchObject({ kind: 'resumed', run: recovered.run })
  const before = f.inputCount()
  await f.client.writeAgent({ agentSessionId: f.previous.agentSessionId, expectedRun: recovered.run, source: 'user', data: 'still-usable' })
  await vi.waitFor(async () => expect(await f.replay(recovered)).toContain('INPUT:still-usable'))
  expect(f.inputCount()).toBe(before + 1); expect(f.start).toHaveBeenCalledTimes(2); expect(f.stop).not.toHaveBeenCalled()
})

it('keeps an unknown recovery Start reconcilable after a new Core owner without classifying it as a rolled-back failure', async () => {
  const f = await fixture()
  const request = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: f.request.operationId,
    trigger: 'manual' as const, args: f.request.args!, env: f.request.env! }
  f.start.mockImplementationOnce(async (...args: any[]) => { const [input, operationKey] = args; await f.nativeStart(...args); throw new core.AgentMuxError('Original Start ACK lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.client.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed' })
  expect((await f.store.readMetadata(f.previous.agentSessionId))!.run).toEqual(f.previous.run)
  expect(await f.correlation()).toBeDefined()
  await f.client.dispose(); const second = await f.reader()
  const restored = await second.client.ensureAgentContinuity(request)
  expect(restored.kind).toBe('resumed')
  if (restored.kind !== 'resumed') throw new Error('Original Start was not reconciled')
  await f.write(restored.session, second)
  await expect(second.client.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'resumed', run: restored.run })
  f.noReplacement(1)
})


it.each(['positional-argv', 'post-launch-only'] as const)('settles a legacy prepared resume from its accurate retained secret binding: %s', async delivery => {
  const f = await fixture(delivery); let actual: any
  f.start.mockImplementationOnce(async (...args: any[]) => {
    actual = await f.nativeStart(...args)
    throw new core.AgentMuxError('Original legacy Start ACK lost', 'CONTROL_UNAVAILABLE')
  })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  await f.client.dispose()
  // Private historical fixture: preserve the original prepared Session but omit the field old owners never wrote.
  const db = new DatabaseSync(f.store.path)
  try { db.prepare("UPDATE reservations SET json=json_remove(json, '$.preparedDispatch') WHERE id=?").run(f.previous.agentSessionId) } finally { db.close() }
  expect((await f.correlation())?.preparedDispatch).toBeUndefined()
  const second = await f.reader(), resumed = await f.resume({}, second)
  expect(resumed.run.runId).toBe(actual.runId); expect(resumed.nativeHandle).toEqual(f.previous.nativeHandle)
  expect((await f.resume({}, second)).run).toEqual(resumed.run)
  f.noReplacement(delivery === 'post-launch-only' ? 1 : 0)
  await f.write(resumed, second)
})

it.each(['AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_HOOK_TOKEN', 'AGENTMUX_PROVIDER_ID', 'AGENTMUX_EXECUTOR_ID'] as const)(
  'rejects a legacy retained wrong subject without a second Start: %s', async field => {
  const f = await fixture(); let actual: any
  f.start.mockImplementationOnce(async (...args: any[]) => {
    actual = await f.nativeStart(...args); throw new core.AgentMuxError('Original legacy Start ACK lost', 'CONTROL_UNAVAILABLE')
  })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const db = new DatabaseSync(f.store.path)
  try { db.prepare("UPDATE reservations SET json=json_remove(json, '$.preparedDispatch') WHERE id=?").run(f.previous.agentSessionId) } finally { db.close() }
  const native = f.inner.kernel.client, observe = native.observeCreation.bind(native)
  vi.spyOn(native, 'observeCreation').mockImplementationOnce(async (...args: any[]) => {
    const retained = await observe(...args)
    retained.observation.run.spec.env[field] = 'foreign-subject'
    return retained
  })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_RETAINED_MISMATCH' })
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run)
  expect(await f.correlation()).toBeDefined(); expect((await f.inner.kernel.status(actual.runId)).state.type).toBe('running')
  f.noReplacement()
})

it('keeps a legacy missing key unknown without backfilling current Runtime or dispatching again', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new core.AgentMuxError('Original Start unknown', 'CONTROL_UNAVAILABLE'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const db = new DatabaseSync(f.store.path)
  try { db.prepare("UPDATE reservations SET json=json_remove(json, '$.preparedDispatch') WHERE id=?").run(f.previous.agentSessionId) } finally { db.close() }
  const original = await f.correlation()
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_SOURCE_UNCONFIRMED', message: expect.stringContaining('dispatch Runtime and complete request') })
  expect(await f.correlation()).toEqual(original); expect(original?.preparedDispatch).toBeUndefined(); f.noReplacement()
})


it('does not dispatch a frozen original Start to a different real Runtime after durable prepare awaits', async () => {
  const f = await fixture(), second = await otherRuntime(f), originalSocket = f.inner.kernel.socketPath
  const source = f.inner.kernel.creationRuntimeIdentity(), prepare = f.store.prepareResume.bind(f.store)
  const r1 = f.inner.kernel.client, r1Start = vi.spyOn(r1, 'start'), r2Start = vi.spyOn(second.kernel.client, 'start')
  vi.spyOn(f.store, 'prepareResume').mockImplementationOnce(async (...args: any[]) => {
    const saved = await prepare(...args as [any, any, any])
    expect(saved.preparedDispatch!.runtime).toEqual(source)
    f.inner.kernel.disconnect()
    Object.defineProperty(f.inner.kernel, 'socketPath', { value: second.socketPath, configurable: true })
    await f.inner.kernel.connect()
    return saved
  })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  expect(r1Start).not.toHaveBeenCalled(); expect(r2Start).not.toHaveBeenCalled()
  expect(await second.kernel.list()).toEqual([])
  expect((await f.correlation())?.preparedDispatch?.runtime).toEqual(source)
  await expect(f.resume()).rejects.toMatchObject({ code: 'PREPARED_START_RUNTIME_MISMATCH' })
  f.inner.kernel.disconnect(); Object.defineProperty(f.inner.kernel, 'socketPath', { value: originalSocket, configurable: true }); await f.inner.kernel.connect()
  expect((await f.nativeList()).map((run: any) => run.runId)).toEqual([f.previous.run.runId])
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  expect((await f.correlation())?.preparedDispatch?.runtime).toEqual(source); f.noReplacement()
})

it('does not treat another Runtime missing the healthy original Run as ended', async () => {
  const f = await fixture(), second = await otherRuntime(f), originalSocket = f.inner.kernel.socketPath
  const actual = await f.inner.kernel.start({ operationKey: 'healthy-original', program: process.execPath, args: f.request.args!, cwd: f.root, env: {} })
  f.start.mockClear()
  const before = (await f.store.readMetadata(f.previous.agentSessionId))!
  const healthy = { ...before, run: { runId: actual.runId }, updatedAt: before.updatedAt + 1 }
  await f.store.compareAndSwapMetadata(before, healthy); await f.inner.registry.load('local')
  f.inner.kernel.disconnect(); Object.defineProperty(f.inner.kernel, 'socketPath', { value: second.socketPath, configurable: true }); await f.inner.kernel.connect()
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_ORIGINAL_RUN_UNCONFIRMED' })
  expect(f.start).not.toHaveBeenCalled(); expect(await second.kernel.list()).toEqual([])
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(healthy.run)
  f.inner.kernel.disconnect(); Object.defineProperty(f.inner.kernel, 'socketPath', { value: originalSocket, configurable: true }); await f.inner.kernel.connect()
  expect((await f.inner.kernel.status(actual.runId)).state.type).toBe('running')
  await f.write(f.client.agentSession(f.previous.agentSessionId))
  expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('does not dispatch when durable preparation fails', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'prepareResume').mockRejectedValueOnce(new Error('Private durable preparation failed'))
  await expect(f.resume()).rejects.toThrow('Private durable preparation failed')
  expect(f.start).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect((await f.nativeList()).map((run: any) => run.runId)).toEqual([f.previous.run.runId])
})

it.each(['memory', 'file'] as const)('binds frozen Agent secrets through the original %s Store owner', async owner => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new core.AgentMuxError('Private unknown Start', 'CONTROL_UNAVAILABLE'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const original = (await f.correlation())!, { preparedSession, preparedDispatch, ...reservation } = original
  const store = owner === 'memory' ? new core.AgentMuxMemoryAgentSessionStore() : new core.AgentMuxFileAgentSessionStore(join(f.root, 'binding.sqlite'))
  await store.compareAndSwap(null, f.previous); await store.reserveLifecycle(reservation)
  let rejected = 0
  for (const field of ['AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_HOOK_TOKEN', 'AGENTMUX_PROVIDER_ID', 'AGENTMUX_EXECUTOR_ID']) {
    const wrong = structuredClone(preparedDispatch!), launch = JSON.parse(wrong.prepared.launch)
    launch.request.env[field] = 'different-subject'; wrong.prepared.launch = JSON.stringify(launch)
    await expect(store.prepareResume(reservation, preparedSession!, wrong)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
    expect((await store.readLifecycleReservation(f.previous.agentSessionId))?.preparedSession).toBeUndefined(); rejected++
  }
  expect(rejected).toBe(4)
  expect((await store.prepareResume(reservation, preparedSession!, preparedDispatch!)).preparedDispatch).toEqual(preparedDispatch)
  f.noReplacement()
})


it('publishes the current legacy source gap on original continuity recheck without rewriting its historical failure', async () => {
  const f = await fixture(), request = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run,
    operationId: f.request.operationId, trigger: 'manual' as const, args: f.request.args, env: f.request.env }
  f.start.mockRejectedValueOnce(new core.AgentMuxError('Historical private database mutation failed', 'CTXMUX_io'))
  await expect(f.client.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed' })
  const db = new DatabaseSync(f.store.path)
  try { db.prepare("UPDATE reservations SET json=json_remove(json, '$.preparedDispatch') WHERE id=?").run(f.previous.agentSessionId) } finally { db.close() }
  const original = await f.correlation()
  const before = (await f.store.readMetadata(f.previous.agentSessionId))!, old = before.continuity!
  const historical = { ...old, error: 'Historical private database mutation failed', errorCode: 'CTXMUX_io' }
  await f.store.compareAndSwapMetadata(before, { ...before, continuity: historical, continuityOperations: { ...before.continuityOperations, [request.operationId]: historical } })
  for (let index = 0; index < 2; index++) {
    const checked = await f.client.ensureAgentContinuity(request)
    expect(checked).toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed', continuity: {
      errorCode: 'AGENT_RESUME_SOURCE_UNCONFIRMED', error: expect.stringContaining('dispatch Runtime and complete request') } })
    expect(checked.continuity!.error).not.toContain('Historical private database mutation failed')
    expect((await f.store.readMetadata(f.previous.agentSessionId))?.continuity?.errorCode).toBe('AGENT_RESUME_SOURCE_UNCONFIRMED')
  }
  expect(await f.correlation()).toEqual(original); f.noReplacement()
})


it('retains the public Terminal preparation codec and its original error contract', () => {
  const createOperationId = 'terminal-codec', workspacePath = '/private/terminal-codec'
  const request = { program: '/bin/sh', args: [], cwd: workspacePath, env: { AGENTMUX_LIFECYCLE_OPERATION_ID: createOperationId },
    initial_size: { cols: 80, rows: 24 }, declared_inputs: [] }
  const prepared = { createOperationId, workspacePath, launch: JSON.stringify({ createOperationId, request }) }
  expect(core.parsePreparedTerminal(prepared)).toEqual(prepared)
  for (const wrong of [{ ...prepared, extra: true }, { ...prepared, createOperationId: 'different-key' },
    { ...prepared, launch: JSON.stringify({ createOperationId, request: { ...request, env: { AGENTMUX_LIFECYCLE_OPERATION_ID: 'different-key' } } }) }]) {
    expect(() => core.parsePreparedTerminal(wrong)).toThrow(expect.objectContaining({ code: 'INVALID_TERMINAL_PREPARATION' }))
  }
})
