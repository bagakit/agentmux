import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { parseRpcAgentSession } from '../src/rpc-native-codec.js'
import { parseRpcControlResult } from '../src/rpc-business-codec.js'
import { join } from 'node:path'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { expect, it, vi } from 'vitest'
import { agentLifecycleOperationIdentity } from '../src/agent-session-store.js'
import { core, cleanups, fixture, otherRuntime } from './helpers/prepared-resume-fixture.js'

it.each([['file', 'positional-argv'], ['memory', 'positional-argv'], ['file', 'post-launch-only']] as const)('explicit resolution fences the exact missing prepared Start and resumes once without old input: %s %s', async (owner, delivery) => {
  const f = await fixture(delivery, false, owner)
  f.start.mockRejectedValueOnce(new Error('Controlled unknown before Native dispatch'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const original = await f.correlation()
  expect(original?.preparedDispatch).toBeDefined()
  const retire = vi.spyOn(f.inner.kernel, 'retirePreparedStart')
  const request = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'manual-resolution', trigger: 'manual',
    args: f.request.args, env: f.request.env, policy: { reminderMode: 'default' as const, continuationEnabled: true } }
  const resumed = await f.client.ensureAgentContinuity(request)
  expect(resumed.kind).toBe('resumed')
  if (resumed.kind !== 'resumed') throw new Error(JSON.stringify(resumed))
  expect(resumed.session.agentSessionId).toBe(f.previous.agentSessionId)
  expect(resumed.session.nativeHandle).toEqual(f.previous.nativeHandle)
  expect(resumed.continuity?.resolution).toMatchObject({ operationId: request.operationId, originalOperationId: f.request.operationId,
    originalCreationKey: original!.operationId, outcome: 'retired', continuedBy: { operationId: request.operationId } })
  expect(retire).toHaveBeenCalledTimes(1)
  expect(await f.inner.kernel.observePreparedStartRetirement(original!.operationId, original!.preparedDispatch!.runtime)).toMatchObject({ outcome: 'retired' })
  expect(f.start).toHaveBeenCalledTimes(2)
  expect(f.start.mock.calls[1]![0].args).not.toContain(f.request.prompt)
  expect(resumed.continuity?.launchInput).toBeUndefined()
  expect(resumed.continuity?.recoveryInputs).toEqual({ reminder: '', continuation: '' })
  expect(resumed.session.continuityOperations?.[f.request.operationId]?.launchInput?.input.prompt).toBe(f.request.prompt)
  const again = await f.client.ensureAgentContinuity(request)
  expect(again.kind).toBe('resumed'); expect(f.start).toHaveBeenCalledTimes(2); expect(retire).toHaveBeenCalledTimes(1)
  await f.write(resumed.session)
  expect(f.inputCount()).toBe(1)
})

it('explicit resolution redrives the same durable intent after a pre-send owner exit and fences late old metadata', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new Error('Controlled unknown Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const old = await f.correlation(), retired = vi.spyOn(f.inner.kernel, 'retirePreparedStart')
  vi.spyOn(f.inner.kernel, 'observePreparedStartRetirement').mockRejectedValueOnce(new Error('Controlled pre-send crash boundary'))
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'resume-after-crash', trigger: 'manual', args: f.request.args, env: f.request.env }
  const admitted = await f.client.ensureAgentContinuity(manual)
  expect(admitted.kind).toBe('pending'); expect(admitted.continuity?.resolution?.outcome).toBe('pending')
  expect(retired).not.toHaveBeenCalled()
  await expect(f.inner.updateExactAgentSession(f.previous.agentSessionId, f.previous.run, (value: any) => ({ ...value,
    continuity: { ...old!.preparedSession!.continuity!, kind: 'pending', reason: 'operation-unconfirmed', error: 'late old callback' },
    continuityOperations: { ...value.continuityOperations, [f.request.operationId]: old!.preparedSession!.continuity } }))).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  await f.client.refreshAgentSession(f.previous.agentSessionId)
  const automatic = await f.client.ensureAgentContinuity({ ...manual, operationId: 'read-only-observer', trigger: 'startup' })
  expect(automatic.kind).toBe('pending'); expect(retired).not.toHaveBeenCalled()
  const competitor = await f.client.ensureAgentContinuity({ ...manual, operationId: 'different-manual-intent' })
  expect(competitor.continuity?.resolution?.operationId).toBe(manual.operationId)
  expect(retired).not.toHaveBeenCalled()
  await f.client.dispose()
  const next = await f.reader(), retire = vi.spyOn(next.inner.kernel, 'retirePreparedStart')
  const resumed = await next.client.ensureAgentContinuity({ agentSessionId: manual.agentSessionId, expectedRun: manual.expectedRun, operationId: manual.operationId, trigger: 'manual' })
  expect(resumed.kind).toBe('resumed'); expect(retire).toHaveBeenCalledTimes(1)
  expect(resumed.continuity?.errorCode).toBeUndefined(); expect(resumed.continuity?.error).toBeUndefined()
  expect(next.start).toHaveBeenCalledTimes(1)
  expect((await next.store.readMetadata(f.previous.agentSessionId))?.continuityOperations?.[f.request.operationId]?.resolution?.continuedBy?.operationId).toBe(manual.operationId)
})

it('explicit resolution consumes a late retained original Start and delivers its unadmitted post-launch input once', async () => {
  const f = await fixture('post-launch-only')
  f.start.mockRejectedValueOnce(new Error('Controlled unknown Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const saved = (await f.correlation())!, dispatch = saved.preparedDispatch!, raw = JSON.parse(dispatch.prepared.launch)
  const inspect = vi.spyOn(f.inner.kernel, 'inspectPreparedStart')
  const observe = f.inner.kernel.observePreparedStartRetirement.bind(f.inner.kernel)
  let retainedRun: any
  vi.spyOn(f.inner.kernel, 'observePreparedStartRetirement').mockImplementationOnce(async (...args: any[]) => {
    retainedRun = await f.nativeStart(raw.request, saved.operationId, dispatch.runtime)
    inspect.mockRejectedValue(new Error('Additional key observation unavailable after the retained witness'))
    return await observe(...args)
  })
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'retained-resolution', trigger: 'manual' }
  const result = await f.client.ensureAgentContinuity(manual)
  expect(result.kind).toBe('resumed')
  if (result.kind !== 'resumed') throw new Error(JSON.stringify(result))
  expect(result.session.run.runId).toBe(retainedRun.runId)
  expect(result.continuity?.resolution).toMatchObject({ outcome: 'retained', retainedRun: result.session.run, originalOperationId: f.request.operationId })
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.inputCount()).toBe(1)
  await vi.waitFor(async () => expect(await f.replay(result.session)).toContain(f.request.prompt))
  await f.client.ensureAgentContinuity(manual)
  expect(f.inputCount()).toBe(1)
})

it.each([false, true])('explicit resolution records the manual retained relation before settling a first-observed lost ACK: chained=%s', async chained => {
  const f = await fixture()
  let started: any, originalId = f.request.operationId
  if (chained) {
    f.start.mockRejectedValueOnce(new Error('Unknown predecessor Start'))
    await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
    const prior = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'first-manual-now-unknown', trigger: 'manual', args: f.request.args, env: f.request.env }
    vi.spyOn(f.inner.kernel, 'observePreparedStartRetirement').mockRejectedValueOnce(new Error('Original manual pre-send failure'))
    expect((await f.client.ensureAgentContinuity(prior)).kind).toBe('pending')
    f.start.mockImplementationOnce(async (...args: any[]) => { started = await f.nativeStart(...args); throw new Error('Lost successor ACK') })
    expect((await f.client.ensureAgentContinuity(prior)).kind).toBe('pending')
    originalId = prior.operationId
  } else {
    f.start.mockImplementationOnce(async (...args: any[]) => { started = await f.nativeStart(...args); throw new Error('Lost original ACK') })
    await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  }
  const history = (await f.store.readMetadata(f.previous.agentSessionId))!.continuityOperations?.[originalId]
  if (chained) expect(history?.errorCode).toBeDefined()
  const retire = vi.spyOn(f.inner.kernel, 'retirePreparedStart')
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'first-retained-manual', trigger: 'manual' }
  const value = await f.client.ensureAgentContinuity(manual)
  expect(value.kind).toBe('resumed')
  expect(value.continuity?.errorCode).toBeUndefined(); expect(value.continuity?.error).toBeUndefined()
  expect(value.continuity?.resolution).toMatchObject({ operationId: manual.operationId, originalOperationId: originalId,
    originalCreationKey: agentLifecycleOperationIdentity('resume', f.previous.agentSessionId, originalId), outcome: 'retained', retainedRun: { runId: started.runId } })
  const canonical = (await f.store.readMetadata(f.previous.agentSessionId))!
  expect(canonical.continuityOperations?.[manual.operationId]).toEqual(value.continuity)
  if (history) expect(canonical.continuityOperations?.[originalId]).toMatchObject({ errorCode: history.errorCode, error: history.error })
  expect(retire).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledTimes(chained ? 2 : 1)
})

it('explicit resolution late same-intent error cannot demote the committed successor', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new Error('Controlled unknown before Native dispatch'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const second = await f.reader()
  let release!: () => void, reached!: () => void
  const paused = new Promise<void>(resolve => { reached = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const inspect = second.inner.kernel.inspectPreparedStart.bind(second.inner.kernel)
  vi.spyOn(second.inner.kernel, 'inspectPreparedStart').mockImplementationOnce(async (...args: any[]) => {
    const value = await inspect(...args); expect(value).toBeNull(); reached(); await gate; return value
  })
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'same-manual-race', trigger: 'manual', args: f.request.args, env: f.request.env }
  const late = second.client.ensureAgentContinuity(manual)
  cleanups.push(async () => { release(); await late.catch(() => {}) })
  await paused
  const winner = await f.client.ensureAgentContinuity(manual)
  expect(winner.kind).toBe('resumed')
  const before = await f.store.readMetadata(f.previous.agentSessionId)
  release()
  const observed = await late
  expect(observed.kind).toBe('resumed'); expect(observed.continuity).toEqual(winner.continuity)
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.continuity).toEqual(before?.continuity)
  expect(second.start).not.toHaveBeenCalled()
})

it('explicit resolution releases only the finished request so another healthy Core can retry the same intent', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new Error('Controlled unknown Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  vi.spyOn(f.inner.kernel, 'observePreparedStartRetirement').mockRejectedValueOnce(new Error('Controlled observation unavailable'))
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'retry-with-live-core', trigger: 'manual', args: f.request.args, env: f.request.env }
  expect((await f.client.ensureAgentContinuity(manual)).kind).toBe('pending')
  expect(f.inner.kernel.isConnected()).toBe(true)
  expect((await f.correlation())?.ownerReleased).toBe(true)
  const next = await f.reader()
  const result = await next.client.ensureAgentContinuity({ agentSessionId: manual.agentSessionId, expectedRun: manual.expectedRun, operationId: manual.operationId, trigger: 'manual' })
  expect(result.kind).toBe('resumed'); expect(next.start).toHaveBeenCalledTimes(1)
  expect(f.inner.kernel.isConnected()).toBe(true)
})

it('explicit resolution observer cannot release another still executing owner', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new Error('Controlled unknown Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const next = await f.reader()
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), paused = new Promise<void>(resolve => { reached = resolve })
  const observe = f.inner.kernel.observePreparedStartRetirement.bind(f.inner.kernel)
  vi.spyOn(f.inner.kernel, 'observePreparedStartRetirement').mockImplementationOnce(async (...args: any[]) => { reached(); await gate; return await observe(...args) })
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'inflight-owner', trigger: 'manual', args: f.request.args, env: f.request.env }
  const winner = f.client.ensureAgentContinuity(manual)
  cleanups.push(async () => { release(); await winner.catch(() => {}) })
  await paused
  await f.inner.registry.claimStaleLifecycles() // The live owner's reconnect observation cannot release its in-flight invocation.
  const observed = await next.client.ensureAgentContinuity(manual)
  expect(observed.kind).toBe('pending')
  expect((await f.correlation())?.ownerReleased).not.toBe(true)
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.continuity?.errorCode).toBeUndefined()
  release()
  expect((await winner).kind).toBe('resumed')
  expect(next.start).not.toHaveBeenCalled()
})

it('explicit resolution retries an already retired key after failed atomic handoff without re-retiring or replaying input', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new Error('Unknown original Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const old = (await f.correlation())!, retire = vi.spyOn(f.inner.kernel, 'retirePreparedStart')
  vi.spyOn(f.store, 'handoffResumeResolution').mockRejectedValueOnce(new Error('Controlled durable handoff rejected'))
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'handoff-retry', trigger: 'manual', args: f.request.args, env: f.request.env }
  const pending = await f.client.ensureAgentContinuity(manual)
  expect(pending.kind).toBe('pending'); expect(pending.continuity?.resolution?.outcome).toBe('pending')
  expect((await f.correlation())?.operationId).toBe(old.operationId)
  expect(await f.inner.kernel.observePreparedStartRetirement(old.operationId, old.preparedDispatch!.runtime)).toMatchObject({ outcome: 'retired' })
  expect(f.start).toHaveBeenCalledTimes(1)
  const result = await f.client.ensureAgentContinuity(manual)
  expect(result.kind).toBe('resumed'); expect(retire).toHaveBeenCalledTimes(1); expect(f.start).toHaveBeenCalledTimes(2); expect(f.inputCount()).toBe(0)
})

it('explicit resolution after atomic handoff never resends unknown successor and requires a new manual intent', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new Error('Unknown original Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const retire = vi.spyOn(f.inner.kernel, 'retirePreparedStart'), handoff = f.store.handoffResumeResolution.bind(f.store)
  vi.spyOn(f.store, 'handoffResumeResolution').mockImplementationOnce(async (...args: any[]) => { await handoff(...args); throw new Error('Lost committed handoff acknowledgement before Start') })
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'handoff-unknown', trigger: 'manual', args: f.request.args, env: f.request.env }
  const first = await f.client.ensureAgentContinuity(manual)
  expect(first.kind).toBe('pending'); expect(first.continuity?.resolution?.outcome).toBe('retired')
  const canonical = (await f.store.readMetadata(f.previous.agentSessionId))!.continuity!
  expect(canonical).toEqual(first.continuity)
  expect(canonical).toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed', resolution: { outcome: 'retired' } })
  if (process.env.AGENTMUX_TEST_RESOLUTION_HANDOFF_RECEIPT) await writeFile(process.env.AGENTMUX_TEST_RESOLUTION_HANDOFF_RECEIPT, JSON.stringify(canonical))
  const successor = await f.store.readLifecycleReservation(f.previous.agentSessionId)
  expect(successor?.operationId).toBe(first.continuity?.resolution?.continuedBy?.creationKey)
  const retry = await f.client.ensureAgentContinuity(manual)
  expect(retry.kind).toBe('pending'); expect(f.start).toHaveBeenCalledTimes(1); expect(retire).toHaveBeenCalledTimes(1)
  const continued = await f.client.ensureAgentContinuity({ ...manual, operationId: 'new-successor-resolution' })
  expect(continued.kind).toBe('resumed'); expect(f.start).toHaveBeenCalledTimes(2); expect(retire).toHaveBeenCalledTimes(2)
  expect(continued.continuity?.resolution).toMatchObject({ originalOperationId: manual.operationId, originalCreationKey: successor!.operationId, outcome: 'retired' })
  expect(f.inputCount()).toBe(0)
})

it('explicit resolution Hosted, public RPC, compiled CLI and inspect retain the complete safe relation without private launch data', async () => {
  const f = await fixture(), hosted = new core.AgentMuxHostedRuntimeService(f.client, f.store.path, () => ({ runtimeId: 'resolution-runtime', ownerInstanceId: 'resolution-owner', protocolVersion: 2,
    processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const remote = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => remote.dispose())
  f.start.mockRejectedValueOnce(new Error('Unknown original Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  vi.spyOn(f.inner.kernel, 'observePreparedStartRetirement').mockRejectedValueOnce(new Error('Controlled pre-send failure'))
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'public-resolution', trigger: 'manual',
    args: f.request.args, env: { ...f.request.env, PRIVATE_RESOLUTION_SENTINEL: 'never-project-execution-env' } }
  const pending = await remote.ensureAgentContinuity(manual)
  expect(pending.kind).toBe('pending'); expect(pending.continuity?.resolution?.outcome).toBe('pending')
  expect(JSON.stringify(pending)).not.toContain('never-project-execution-env')
  const result = await rpc.call('agent.resume', { target: { kind: 'agent-session', agentSessionId: f.previous.agentSessionId }, operationId: manual.operationId, text: '' })
  expect(result.resolution).toMatchObject({ operationId: manual.operationId, originalOperationId: f.request.operationId, outcome: 'retired',
    originalCreationKey: agentLifecycleOperationIdentity('resume', f.previous.agentSessionId, f.request.operationId),
    runtimeId: f.inner.kernel.creationRuntimeIdentity().runtimeId, requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    continuedBy: { operationId: manual.operationId, creationKey: agentLifecycleOperationIdentity('resume', f.previous.agentSessionId, manual.operationId) } })
  const inspected = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: f.previous.agentSessionId } })
  expect(inspected.session.continuity.resolution).toEqual(result.resolution)
  expect(inspected.session.continuityOperations[f.request.operationId].resolution).toEqual(result.resolution)
  expect(JSON.stringify(inspected)).not.toContain('never-project-execution-env')
  if (process.env.AGENTMUX_TEST_OBJECT_CLI) {
    const env = objectCliEnvironment(f.root, { NODE_NO_WARNINGS: '1' })
    const cli = await runCompiledObjectCli(['agent', 'resume', '--session', f.previous.agentSessionId, '--operation-id', manual.operationId], env)
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, result: { agentSessionId: f.previous.agentSessionId, runId: result.runId, resolution: result.resolution } })
    const inspect = await runCompiledObjectCli(['agent', 'inspect', '--session', f.previous.agentSessionId], env)
    expect(inspect.code, inspect.stderr).toBe(0)
    expect(JSON.parse(inspect.stdout).result.session.continuity.resolution).toEqual(result.resolution)
    expect(cli.stdout + cli.stderr + inspect.stdout + inspect.stderr).not.toContain('never-project-execution-env')
  }
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.inputCount()).toBe(0)
})

it('explicit resolution rejects a changed manual request both before and after handoff', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new Error('Unknown original Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  vi.spyOn(f.inner.kernel, 'observePreparedStartRetirement').mockRejectedValueOnce(new Error('Controlled pre-send failure'))
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'immutable-manual', trigger: 'manual', args: f.request.args, env: f.request.env }
  expect((await f.client.ensureAgentContinuity(manual)).kind).toBe('pending')
  await expect(f.client.ensureAgentContinuity({ ...manual, env: { altered: 'request' } })).rejects.toMatchObject({ code: 'AGENT_RESUME_RESOLUTION_CONFLICT' })
  await expect(f.client.ensureAgentContinuity({ ...manual, input: { submissionId: 'new-input', prompt: 'Keep this separate authored input' } })).rejects.toMatchObject({ code: 'AGENT_RESUME_RESOLUTION_REQUIRED' })
  await expect(f.client.ensureAgentContinuity({ ...manual, timingOverride: 'startup' })).rejects.toMatchObject({ code: 'AGENT_RESUME_RESOLUTION_REQUIRED' })
  await expect(f.client.ensureAgentContinuity({ agentSessionId: manual.agentSessionId, expectedRun: manual.expectedRun, operationId: manual.operationId, trigger: 'manual', input: { submissionId: 'identity-only-new-input', prompt: 'Do not swallow authored input' } })).rejects.toMatchObject({ code: 'AGENT_RESUME_RESOLUTION_REQUIRED' })
  expect((await f.client.ensureAgentContinuity(manual)).kind).toBe('resumed')
  await expect(f.client.ensureAgentContinuity({ ...manual, env: { altered: 'request' } })).rejects.toMatchObject({ code: 'AGENT_RESUME_RESOLUTION_CONFLICT' })
  expect(f.start).toHaveBeenCalledTimes(2)
})

it('explicit resolution preserves a confirmed retained startup exit instead of reporting it as unknown', async () => {
  const f = await fixture('positional-argv', true)
  let failedRun: any
  f.start.mockImplementationOnce(async (...args: any[]) => { failedRun = await f.nativeStart(...args); throw new Error('Lost ACK for retained failed Run') })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  await vi.waitFor(async () => expect((await f.inner.kernel.status(failedRun.runId)).state.type).toBe('exited'))
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'retained-fatal', trigger: 'manual' }
  const failure = { code: 'AGENT_TERMINAL_HANDSHAKE_FAILED', message: expect.stringContaining('controlled startup exit') }
  await expect(f.client.ensureAgentContinuity(manual)).rejects.toMatchObject(failure)
  const failed = await f.store.readMetadata(f.previous.agentSessionId)
  expect(failed?.continuity).toMatchObject({ kind: 'unavailable', reason: 'process-exited', errorCode: failure.code,
    resolution: { outcome: 'retained', retainedRun: { runId: failedRun.runId } } })
  await expect(f.client.ensureAgentContinuity(manual)).rejects.toMatchObject(failure)
  const healthy = "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d));process.stdout.write('\\x1b[?u');setInterval(()=>{},1000)"
  const result = await f.client.ensureAgentContinuity({ ...manual, expectedRun: failed!.run, operationId: 'new-explicit-after-fatal', args: ['-e', healthy] })
  expect(result.kind).toBe('resumed')
  expect(result.session.nativeHandle).toEqual(f.previous.nativeHandle)
  expect(f.start).toHaveBeenCalledTimes(2)
})


it('explicit resolution public codecs preserve original read-only correlation and reject unrelated or malformed safe receipts', async () => {
  const f = await fixture()
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  f.start.mockImplementationOnce(async (...args: any[]) => { await f.nativeStart(...args); throw new Error('Lost original no-input Start ACK') })
  const admitted = await f.client.ensureAgentContinuity({ agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: f.request.operationId, trigger: 'manual', args: f.request.args, env: f.request.env, policy: { reminderMode: 'off', continuationEnabled: false } })
  expect(admitted.kind).toBe('pending'); expect(admitted.continuity?.launchInput).toBeUndefined()
  const target = { kind: 'agent-session', agentSessionId: f.previous.agentSessionId }
  const manual = await rpc.call('agent.resume', { target, operationId: 'observed-manual-relation', text: '' })
  const original = await rpc.call('agent.resume', { target, operationId: f.request.operationId, text: '' })
  expect(original).toEqual(manual)
  expect(original.resolution).toMatchObject({ outcome: 'retained', originalOperationId: f.request.operationId, operationId: 'observed-manual-relation' })
  expect(f.start).toHaveBeenCalledTimes(1)
  const inspected = await rpc.call('agent.inspect', { target })
  for (const resolution of [null, false, 0, { ...original.resolution, outcome: ['pending'], retainedRun: undefined }, { ...original.resolution, env: { SECRET: 'forbidden' } }, { ...original.resolution, retainedRun: undefined }]) {
    expect(() => parseRpcControlResult('agent.resume', { ...original, resolution }, { target, operationId: f.request.operationId, text: '' })).toThrow()
    expect(() => parseRpcAgentSession({ ...inspected.session, continuity: { ...inspected.session.continuity, resolution } })).toThrow()
  }
  expect(() => parseRpcControlResult('agent.resume', original, { target, operationId: 'unrelated-operation', text: '' })).toThrow()
  if (process.env.AGENTMUX_TEST_OBJECT_CLI) {
    const cli = await runCompiledObjectCli(['agent', 'resume', '--session', f.previous.agentSessionId, '--operation-id', f.request.operationId], objectCliEnvironment(f.root, { NODE_NO_WARNINGS: '1' }))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result).toEqual(original)
  }
})


it('explicit resolution pins its original Runtime after admission awaits and preserves the exact retry', async () => {
  const f = await fixture(), second = await otherRuntime(f), socket = f.inner.kernel.socketPath
  f.start.mockRejectedValueOnce(new Error('Unknown original Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const original = (await f.correlation())!, source = original.preparedDispatch!.runtime
  const admit = f.store.admitResumeResolution.bind(f.store), r2Retire = vi.spyOn(second.kernel.client, 'retireCreation')
  vi.spyOn(f.store, 'admitResumeResolution').mockImplementationOnce(async (...args: any[]) => {
    const value = await admit(...args)
    f.inner.kernel.disconnect(); Object.defineProperty(f.inner.kernel, 'socketPath', { value: second.socketPath, configurable: true }); await f.inner.kernel.connect()
    return value
  })
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'runtime-pinned-resolution', trigger: 'manual', args: f.request.args, env: f.request.env }
  const observed = await f.client.ensureAgentContinuity(manual)
  expect(observed.kind).toBe('pending'); expect(observed.continuity?.errorCode).toBe('TERMINAL_CREATION_RUNTIME_MISMATCH')
  expect((await f.correlation())?.preparedDispatch?.runtime).toEqual(source)
  expect(r2Retire).not.toHaveBeenCalled(); expect(await second.kernel.list()).toEqual([]); expect(f.start).toHaveBeenCalledTimes(1)
  f.inner.kernel.disconnect(); Object.defineProperty(f.inner.kernel, 'socketPath', { value: socket, configurable: true }); await f.inner.kernel.connect()
  const continued = await f.client.ensureAgentContinuity({ agentSessionId: manual.agentSessionId, expectedRun: manual.expectedRun, operationId: manual.operationId, trigger: 'manual' })
  expect(continued.kind).toBe('resumed'); expect(continued.continuity?.resolution?.runtimeId).toBe(source.runtimeId)
  expect(f.start).toHaveBeenCalledTimes(2); expect(r2Retire).not.toHaveBeenCalled()
})

it('explicit resolution cannot infer a legacy dispatch source from a missing current key', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new Error('Historical unknown Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const db = new DatabaseSync(f.store.path)
  try { db.prepare("UPDATE reservations SET json=json_remove(json, '$.preparedDispatch') WHERE id=?").run(f.previous.agentSessionId) } finally { db.close() }
  const before = await f.correlation(), retire = vi.spyOn(f.inner.kernel, 'retirePreparedStart')
  await expect(f.client.ensureAgentContinuity({ agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'legacy-manual-no-origin', trigger: 'manual' })).rejects.toMatchObject({ code: 'AGENT_RESUME_SOURCE_UNCONFIRMED' })
  expect(await f.correlation()).toEqual(before); expect(retire).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledTimes(1)
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run)
})


it.skipIf(!process.env.AGENTMUX_TEST_DURABLE_RESUME_ENTRY)('explicit resolution survives actual admitted-owner process death before Native retirement', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new Error('Unknown original Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const old = (await f.correlation())!, manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'actual-owner-crash', trigger: 'manual', args: f.request.args, env: f.request.env }
  const path = join(f.root, 'resolution-process.json')
  await writeFile(path, JSON.stringify({ root: f.root, storePath: f.store.path, delivery: 'positional-argv', request: f.request, resolution: manual }), { mode: 0o600 })
  const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures/prepared-resume-process.mjs'), 'resolution-crash'], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, AGENTMUX_TEST_RESUME_PROCESS_REQUEST: path } })
  let stderr = ''; child.stderr!.on('data', value => { stderr += value })
  const ended = once(child, 'exit')
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid!, 'SIGKILL'); await ended } })
  const [message] = await Promise.race([once(child, 'message'), ended.then(() => { throw new Error('Private resolution owner exited before admission: ' + stderr) })]) as any
  expect(message).toMatchObject({ phase: 'resolution-admitted', pid: child.pid, starts: 0, inputs: 0, resolution: { operationId: manual.operationId, outcome: 'pending' } })
  expect((await f.correlation())?.ownerPid).toBe(child.pid)
  expect(await f.inner.kernel.observePreparedStartRetirement(old.operationId, old.preparedDispatch!.runtime)).toMatchObject({ outcome: 'not_retired' })
  process.kill(-child.pid!, 'SIGKILL'); expect((await ended)[1]).toBe('SIGKILL')
  expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  const next = await f.reader(), retire = vi.spyOn(next.inner.kernel, 'retirePreparedStart')
  const observed = await next.client.ensureAgentContinuity({ ...manual, operationId: 'startup-observe-only', trigger: 'startup' })
  expect(observed.kind).toBe('pending'); expect(retire).not.toHaveBeenCalled()
  const result = await next.client.ensureAgentContinuity({ agentSessionId: manual.agentSessionId, expectedRun: manual.expectedRun, operationId: manual.operationId, trigger: 'manual' })
  expect(result.kind).toBe('resumed'); expect(retire).toHaveBeenCalledTimes(1); expect(next.start).toHaveBeenCalledTimes(1)
  expect(result.session.nativeHandle).toEqual(f.previous.nativeHandle); expect(next.inputCount()).toBe(0)
})


it('explicit resolution leaves an independent healthy Session and its real input usable while pending and after handoff', async () => {
  const f = await fixture()
  const healthy = await f.client.createAgent({ agentSessionId: 'independent-healthy', createOperationId: 'healthy-create', providerId: f.provider.id, executorId: 'configured-resume', workspacePath: f.root,
    commandOverride: process.execPath, args: f.request.args, injectAgentMuxGuide: false })
  await f.write(healthy)
  f.start.mockRejectedValueOnce(new Error('Unknown original Start'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  vi.spyOn(f.inner.kernel, 'observePreparedStartRetirement').mockRejectedValueOnce(new Error('Resolution observation temporarily unavailable'))
  const manual = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'isolated-resolution', trigger: 'manual', args: f.request.args, env: f.request.env }
  expect((await f.client.ensureAgentContinuity(manual)).kind).toBe('pending')
  await f.write(healthy)
  expect((await f.client.ensureAgentContinuity(manual)).kind).toBe('resumed')
  await f.write(healthy)
  expect((await f.store.readMetadata(healthy.agentSessionId))?.run).toEqual(healthy.run)
  expect((await f.inner.kernel.status(healthy.run.runId)).state.type).toBe('running')
  expect(f.stop).not.toHaveBeenCalled()
})
