import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import type { AgentMuxRunRef } from '../src/types.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'

const exec = promisify(execFile)
const entry = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
type RecordedRequest = { pid: number; id?: number | string; method: string; params: unknown }

it('opens and rejoins one ACP Session, then awaits an exact resume before binding a replacement Run', async () => {
  const scope = await headlessFixture({ ownerEntry: entry('./fixtures/acp-spatial-host.mjs'),
    ownerNodeArgs: ['--experimental-transform-types', '--import', entry('./fixtures/acp-spatial-host-loader.mjs')] })
  let core = await scope.client()
  let started: { agentSessionId: string; run: AgentMuxRunRef } | undefined
  try {
    const trace = join(scope.root, 'acp-run.ndjson'), release = join(scope.root, 'release-original-native-reply')
    const resumeRelease = join(scope.root, 'release-original-native-resume-reply')
    const cancelRelease = join(scope.root, 'release-original-native-cancel-reply')
    const executorId = 'structured-acp-test'
    await core.configureHostExecutor({ executorId, config: {
      providerId: 'antigravity', label: 'Structured ACP test', command: entry('./fixtures/acp-run-cli.mjs'),
      args: [], env: { ACP_RUN_TRACE: trace, ACP_RUN_RELEASE: release, ACP_RUN_RESUME_RELEASE: resumeRelease, ACP_RUN_CANCEL_RELEASE: cancelRelease }, injectAgentMuxGuide: false
    } })
    const createOperationId = 'original-structured-acp'
    const spatial = new AgentMuxSpatialStateStore(join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'spatial-state.json'))
    const state = await spatial.read()
    const { spaceId, zoneId } = state!.graph.bindings[0]!
    const launchOptions = join(scope.root, 'launch-options.json')
    await writeFile(launchOptions, JSON.stringify({ interaction: 'acp' }))
    const cli = [entry('../bin/amux'), '--endpoint', `unix:${scope.socketPath}`]
    const inputEpoch = await core.readAgentInputEpoch()
    const opened = await exec(process.execPath, [...cli, 'agent', 'open', '--space', spaceId, '--zone', zoneId, '--new-tab', '--executor', executorId,
      '--launch-options', launchOptions, '--prompt', 'Original creation draft', '--operation-id', createOperationId,
      ...(inputEpoch ? ['--input-epoch', inputEpoch] : [])], { env: scope.env }).catch(error => {
      const report = JSON.parse(error.stdout || error.stderr || '{}')
      if (report.ok !== true || report.result?.outcome !== 'partial') throw error
      return { stdout: JSON.stringify(report) }
    })
    const result = JSON.parse(opened.stdout).result
    expect(result).toMatchObject({ outcome: 'partial', agent: { initialPrompt: 'unconfirmed' } })
    const session = (await core.readAgentSession(result.agent.agentSessionId))!
    started = session
    expect(session.run).toEqual({ runId: result.agent.runId })
    expect((await spatial.read())?.graph.regions.some(region => region.agentSessionId === session.agentSessionId && region.runId === session.run.runId)).toBe(true)
    const calls = async (): Promise<RecordedRequest[]> => await readFile(trace, 'utf8').then(body => body.trim().split('\n').map(line => JSON.parse(line)), error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const initial = await until(calls, calls => calls.length >= 2, 'exact ACP initialization and creation')
    expect(initial.map(call => call.method)).toEqual(['initialize', 'session/new'])
    expect(initial[1]!.params).toEqual({ cwd: scope.root, mcpServers: [] })
    expect(initial[0]!.pid).toBe(initial[1]!.pid)
    const nativePid = initial[0]!.pid
    const original = (await core.listRuns()).find(run => run.runId === session.run.runId)!
    expect(original.state).toBe('running')
    expect(session.nativeHandle).toBeUndefined()
    const initialKey = session.creation?.initialInputKey
    expect(initialKey).toMatchObject({ agentSessionId: session.agentSessionId, expectedRun: session.run })
    expect(await core.inspectAgentPromptSubmission(initialKey!)).toBeNull()
    expect(await calls()).toEqual(initial)
    const owner = scope.owner
    await core.dispose()
    const restarted = await scope.restart()
    expect(restarted.owner.runtimeId).toBe(owner.runtimeId)
    expect(restarted.owner.ownerInstanceId).not.toBe(owner.ownerInstanceId)
    core = await scope.client()
    const current = (await core.listRuns()).find(run => run.runId === session.run.runId)!
    expect(current).toMatchObject({ runId: original.runId, pid: original.pid, state: 'running' })
    expect(() => process.kill(nativePid, 0)).not.toThrow()
    await writeFile(release, 'complete the original request')
    const saved = await until(() => core.readAgentSession(session.agentSessionId), value => value?.creation?.initialPrompt === 'confirmed', 'original ACP identity and deferred input from the restarted Core')
    expect(saved).toMatchObject({ agentSessionId: session.agentSessionId, run: session.run,
      nativeHandle: { kind: 'provider', providerId: 'antigravity', sessionId: 'fixture-original-acp-session' } })
    const initialInput = await until(calls, value => value.length >= 3, 'the original launch draft on the restarted Core')
    expect(initialInput.map(call => call.method)).toEqual(['initialize', 'session/new', 'session/prompt'])
    expect(initialInput[2]).toMatchObject({ pid: nativePid, params: { sessionId: 'fixture-original-acp-session',
      prompt: [{ type: 'text', text: expect.stringMatching(/Original creation draft$/u) }] } })
    expect(saved?.creation?.initialInputKey).toEqual(initialKey)
    expect((await core.inspectAgentPromptSubmission(initialKey!))?.admission).toMatchObject({
      inputKey: initialKey, intent: { message: { userContent: 'Original creation draft' }, prompt: (initialInput[2]!.params as { prompt: { text: string }[] }).prompt[0]!.text }, native: { outcome: 'admitted', requestId: initialInput[2]!.id }
    })
    const inspected = await exec(process.execPath, [entry('../bin/amux'), '--endpoint', `unix:${scope.socketPath}`, 'agent', 'inspect',
      '--provider-native', 'fixture-original-acp-session', '--provider', 'antigravity'], { env: scope.env })
    expect(JSON.parse(inspected.stdout).result.session).toMatchObject({ agentSessionId: session.agentSessionId, run: session.run })
    await expect(core.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: 'ordinary terminal input', source: 'user' }))
      .rejects.toMatchObject({ code: 'AGENT_ACP_TERMINAL_INPUT_UNAVAILABLE', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    expect(await calls()).toEqual(initialInput)
    expect(() => process.kill(nativePid, 0)).not.toThrow()

    const promptFile = join(scope.root, 'prompt.json')
    await writeFile(promptFile, JSON.stringify({ prompt: 'Original structured request', expectedRun: session.run, afterSubmissionId: initialKey!.submissionId }))
    const submit = () => exec(process.execPath, [...cli, 'agent', 'input', 'submit', '--session', session.agentSessionId,
      '--operation-id', 'original-structured-prompt', '--input', promptFile], { env: scope.env })
    const promptResult = JSON.parse((await submit()).stdout).result
    const promptCalls = await until(calls, value => value.length >= 4, 'the original native session/prompt')
    const promptRequest = promptCalls[3]!
    expect(promptRequest).toMatchObject({ pid: nativePid, method: 'session/prompt',
      params: { sessionId: 'fixture-original-acp-session', prompt: [{ type: 'text', text: 'Original structured request' }] } })
    expect(promptResult.record?.admission?.native).toMatchObject({ outcome: 'admitted', requestId: promptRequest.id })
    expect(promptResult.record?.admission?.native).not.toHaveProperty('turnId')
    expect(JSON.parse((await submit()).stdout).result.record.admission.native).toEqual(promptResult.record.admission.native)
    expect(await calls()).toEqual(promptCalls)
    await core.dispose()
    await scope.restart()
    core = await scope.client()
    const cancel = (promptOperationId: string) => exec(process.execPath, [...cli, 'agent', 'interrupt', '--session', session.agentSessionId, '--run', session.run.runId,
      '--prompt-operation-id', promptOperationId], { env: scope.env })
    await expect(cancel('foreign-prompt-operation')).rejects.toMatchObject({ stderr: expect.stringContaining('AGENT_ACP_CANCEL_UNCONFIRMED') })
    expect(await calls()).toEqual(promptCalls)
    const cancelling = cancel('original-structured-prompt')
    void cancelling.catch(() => {})
    const cancelCalls = await until(calls, value => value.length >= 5, 'the original native session/cancel notification')
    expect(cancelCalls[4]).toEqual({ pid: nativePid, method: 'session/cancel', params: { sessionId: 'fixture-original-acp-session' } })
    expect(await Promise.race([cancelling.then(() => 'returned'), wait(175, 'pending')])).toBe('pending')
    expect((await core.listRuns()).find(run => run.runId === session.run.runId)).toMatchObject({ pid: original.pid, state: 'running' })
    await writeFile(cancelRelease, 'complete the original cancelled prompt')
    const cancelled = JSON.parse((await cancelling).stdout).result
    expect(cancelled).toEqual({ agentSessionId: session.agentSessionId, runId: session.run.runId, promptOperationId: 'original-structured-prompt' })
    expect(JSON.parse((await cancel('original-structured-prompt')).stdout).result).toEqual(cancelled)
    expect(await calls()).toEqual(cancelCalls)
    expect(() => process.kill(nativePid, 0)).not.toThrow()

    const restartRequest = { agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'restore-original-acp-session' }
    const restarting = exec(process.execPath, [...cli, 'agent', 'restart', '--session', restartRequest.agentSessionId,
      '--run', restartRequest.expectedRun.runId, '--operation-id', restartRequest.operationId], { env: scope.env })
    void restarting.catch(() => {})
    const resumedCalls = await until(calls, value => value.length >= 7, 'replacement child already requesting the original ACP session')
    expect(resumedCalls.map(call => call.method)).toEqual(['initialize', 'session/new', 'session/prompt', 'session/prompt', 'session/cancel', 'initialize', 'session/resume'])
    expect(resumedCalls[5]!.pid).not.toBe(nativePid)
    expect(resumedCalls[6]).toMatchObject({ pid: resumedCalls[5]!.pid,
      params: { sessionId: 'fixture-original-acp-session', cwd: scope.root, mcpServers: [] } })
    const beforeAck = await core.inspectAgentRestart(restartRequest)
    expect(beforeAck.phase).not.toBe('restarted')
    expect((await core.readAgentSession(session.agentSessionId))?.run).toEqual(session.run)
    await writeFile(resumeRelease, 'complete the original resume request')
    const resumed = JSON.parse((await restarting).stdout).result.session
    started = resumed
    expect(resumed.agentSessionId).toBe(session.agentSessionId)
    expect(resumed.run.runId).not.toBe(session.run.runId)
    expect(resumed.nativeHandle).toEqual(saved?.nativeHandle)
    expect(await calls()).toEqual(resumedCalls)

    process.kill(resumedCalls[5]!.pid, 'SIGTERM')
    await until(async () => (await core.listRuns()).find(run => run.runId === resumed.run.runId),
      run => run !== undefined && run.state !== 'running', 'confirmed terminal state on the exact ACP Run')
    const resumeInput = { agentSessionId: session.agentSessionId, operationId: 'resume-with-original-draft', prompt: 'Original resumed draft',
      ...(inputEpoch ? { inputEpoch } : {}) }
    const withDraft = await core.resumeAgent(resumeInput)
    started = withDraft
    expect(withDraft.nativeHandle).toEqual(saved?.nativeHandle)
    const withDraftCalls = await until(calls, value => value.length >= 10, 'typed SDK resume with the original deferred draft')
    expect(withDraftCalls.slice(7).map(call => call.method)).toEqual(['initialize', 'session/resume', 'session/prompt'])
    expect(withDraftCalls[9]).toMatchObject({ pid: withDraftCalls[8]!.pid, params: { sessionId: 'fixture-original-acp-session',
      prompt: [{ type: 'text', text: expect.stringMatching(/Original resumed draft$/u) }] } })
    expect((await core.resumeAgent(resumeInput)).run).toEqual(withDraft.run)
    expect(await calls()).toEqual(withDraftCalls)

    await writeFile(resumeRelease, 'mismatch')
    const wrongReply = { agentSessionId: session.agentSessionId, expectedRun: withDraft.run, operationId: 'original-acp-with-foreign-ack' }
    await expect(core.restartAgent(wrongReply)).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
    expect((await core.inspectAgentRestart(wrongReply)).phase).not.toBe('restarted')
    const retained = await core.readAgentSession(session.agentSessionId)
    expect(retained?.nativeHandle).toEqual(saved?.nativeHandle)
    expect(retained?.run).toEqual(withDraft.run)
    expect((await calls()).slice(10).map(call => call.method)).toEqual(['initialize', 'session/resume'])
    await core.stopAgent(started.agentSessionId, started.run, { operationId: 'stop-original-structured-acp' })
    started = undefined
  } finally {
    try {
      if (started) await core.stopAgent(started.agentSessionId, started.run, { operationId: 'stop-original-structured-acp' }).catch(() => {})
    } finally { await scope.cleanup() }
  }
}, 65_000)
