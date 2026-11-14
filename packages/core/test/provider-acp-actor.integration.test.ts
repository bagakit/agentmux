import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import type { AgentMuxRunRef } from '../src/types.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { fileUploadRevision } from '../src/public-rpc-files.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'

const exec = promisify(execFile)
const entry = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
type RecordedRequest = { pid: number; id?: number | string; method: string; params: unknown; result?: unknown }

it('opens and rejoins one ACP Session, then awaits an exact resume before binding a replacement Run', async () => {
  const scope = await headlessFixture({ ownerEntry: entry('./fixtures/acp-spatial-host.mjs'),
    ownerNodeArgs: ['--experimental-transform-types', '--import', entry('./fixtures/acp-spatial-host-loader.mjs')] })
  let core = await scope.client()
  let started: { agentSessionId: string; run: AgentMuxRunRef } | undefined
  try {
    const trace = join(scope.root, 'acp-run.ndjson'), release = join(scope.root, 'release-original-native-reply')
    const resumeRelease = join(scope.root, 'release-original-native-resume-reply')
    const cancelRelease = join(scope.root, 'release-original-native-cancel-reply')
    const configRelease = join(scope.root, 'release-original-native-configuration-reply')
    const executorId = 'structured-acp-test'
    await core.configureHostExecutor({ executorId, config: {
      providerId: 'antigravity', label: 'Structured ACP test', command: entry('./fixtures/acp-run-cli.mjs'),
      args: [], env: { ACP_RUN_TRACE: trace, ACP_RUN_RELEASE: release, ACP_RUN_RESUME_RELEASE: resumeRelease, ACP_RUN_CANCEL_RELEASE: cancelRelease, ACP_RUN_CONFIGURATION_RELEASE: configRelease }, injectAgentMuxGuide: false
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
    const allCalls = async (): Promise<RecordedRequest[]> => await readFile(trace, 'utf8').then(body => body.trim().split('\n').map(line => JSON.parse(line)), error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const calls = async () => (await allCalls()).filter(call => call.method !== 'session/set_config_option')
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
    expect(saved).toMatchObject({ agentSessionId: session.agentSessionId, run: session.run, structuredPromptInput: true,
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

    const inspectConfiguration = async (operationId?: string) => JSON.parse((await exec(process.execPath,
      [...cli, 'agent', 'configuration', 'inspect', '--host', 'local', '--session', session.agentSessionId,
        ...(operationId ? ['--operation-id', operationId] : ['--run', session.run.runId])], { env: scope.env })).stdout).result
    const declaration = await inspectConfiguration()
    expect(declaration).toMatchObject({ kind: 'configuration', target: { agentSessionId: session.agentSessionId, expectedRun: session.run },
      snapshot: { options: [
        { id: 'native-mode', currentValue: 'native-ask' },
        { id: 'native-model', currentValue: 'native-small', choices: [
          { value: 'native-small', group: { id: 'available', name: 'Available models' } },
          { value: 'native-large', group: { id: 'available', name: 'Available models' } }
        ] },
        { id: 'native-verbose', type: 'boolean', currentValue: false }
      ] } })
    const configurationInput = { target: declaration.target, operationId: 'original-native-model-selection',
      expectedRevision: declaration.snapshot.revision, configId: 'native-model', value: 'native-large' }
    const chooseConfiguration = async (input: Record<string, unknown>) => {
      const file = join(scope.root, 'configuration-set.json')
      await writeFile(file, JSON.stringify(input))
      const output = await exec(process.execPath, [...cli, 'agent', 'configuration', 'set', '--input', file], { env: scope.env })
        .catch(error => {
          const report = JSON.parse(error.stdout || error.stderr || '{}')
          if (report.ok !== true) throw error
          return { stdout: JSON.stringify(report) }
        })
      return JSON.parse(output.stdout).result
    }
    const configCalls = async () => (await allCalls()).filter(call => call.method === 'session/set_config_option')
    const changing = chooseConfiguration(configurationInput)
    void changing.catch(() => {})
    await until(configCalls, value => value.length === 1, 'one original native model setter')
    expect((await inspectConfiguration()).snapshot).toEqual(declaration.snapshot)
    expect(await Promise.race([changing.then(() => 'returned'), wait(175, 'pending')])).toBe('pending')
    await writeFile(configRelease, 'return the complete original configuration')
    const changed = await changing
    expect(changed).toMatchObject({ outcome: 'applied', diskDurability: 'confirmed',
      acknowledgement: { options: [
        { id: 'native-mode', currentValue: 'native-plan' }, { id: 'native-model', currentValue: 'native-large' },
        { id: 'native-verbose', currentValue: false }
      ] } })
    expect(await configCalls()).toEqual([{ pid: nativePid, id: changed.nativeOperationId, method: 'session/set_config_option',
      params: { sessionId: 'fixture-original-acp-session', configId: 'native-model', value: 'native-large' } }])
    expect(await chooseConfiguration(configurationInput)).toEqual(changed)
    expect((await chooseConfiguration({ ...configurationInput, operationId: 'stale-revision-native-change', value: 'native-small' })).outcome).toBe('not-applied')
    expect(await configCalls()).toHaveLength(1)
    const finalConfiguration = await chooseConfiguration({ ...configurationInput, operationId: 'original-boolean-native-selection',
      configId: 'native-verbose', value: true, expectedRevision: changed.acknowledgement.revision })
    expect(finalConfiguration).toMatchObject({ outcome: 'applied', acknowledgement: { options: [
      { id: 'native-mode', currentValue: 'native-plan' }, { id: 'native-model', currentValue: 'native-large' },
      { id: 'native-verbose', type: 'boolean', currentValue: true }
    ] } })
    expect((await configCalls())[1]).toMatchObject({ id: finalConfiguration.nativeOperationId,
      params: { sessionId: 'fixture-original-acp-session', configId: 'native-verbose', value: true, type: 'boolean' } })

    const promptFile = join(scope.root, 'prompt.json')
    await writeFile(promptFile, JSON.stringify({ prompt: 'Original structured request', expectedRun: session.run, execution: 'immediate', admissionIntent: { kind: 'session-conversation' } }))
    const submit = () => exec(process.execPath, [...cli, 'agent', 'input', 'submit', '--session', session.agentSessionId,
      '--operation-id', 'original-structured-prompt', '--input', promptFile], { env: scope.env })
    const promptResult = JSON.parse((await submit()).stdout).result
    const promptCalls = await until(calls, value => value.length >= 4, 'the original native session/prompt', 4_000)
      .catch(async error => { throw new Error(JSON.stringify((await core.inspectAgentInput({ key: promptResult.key }))?.control ?? promptResult.input ?? null), { cause: error }) })
    const originalPromptReceipt = await until(() => core.inspectAgentPromptSubmission(promptResult.key),
      record => record?.admission?.native?.outcome === 'admitted', 'the original durable ACP input acknowledgement')
    const promptRequest = promptCalls[3]!
    expect(promptRequest).toMatchObject({ pid: nativePid, method: 'session/prompt',
      params: { sessionId: 'fixture-original-acp-session', prompt: [{ type: 'text', text: 'Original structured request' }] } })
    expect(originalPromptReceipt?.admission?.native).toMatchObject({ outcome: 'admitted', requestId: promptRequest.id })
    expect(originalPromptReceipt?.admission?.native).not.toHaveProperty('turnId')
    expect(JSON.parse((await submit()).stdout).result.record.admission.native).toEqual(originalPromptReceipt?.admission?.native)
    expect(await calls()).toEqual(promptCalls)
    const readPermission = async () => (await core.readAgentSession(session.agentSessionId))?.pendingInteraction?.request
    const permission = await until(readPermission, request => request?.kind === 'permission', 'first exact ACP permission')
    expect(permission).toMatchObject({ kind: 'permission', nativeToolCallId: 'original-tool-call', options: [
      { id: 'native-allow-exact', kind: 'allow-once' }, { id: 'native-deny-exact', kind: 'reject-once' }
    ] })
    const timeline = await until(() => core.sessionTimeline(session.agentSessionId),
      result => result.items.some(item => item.kind === 'tool_call' && item.status === 'complete'), 'actual ACP activity updates')
    expect(timeline.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'assistant_message', content: 'ACP fixture assistant content' }),
      expect.objectContaining({ kind: 'tool_call', title: 'Original tool activity', status: 'complete' })
    ]))
    expect(timeline.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Foreign message' })]))

    await core.dispose()
    await scope.restart()
    core = await scope.client()
    expect((await inspectConfiguration()).snapshot).toEqual(finalConfiguration.acknowledgement)
    expect((await inspectConfiguration(configurationInput.operationId)).operation).toMatchObject({
      outcome: 'applied', nativeOperationId: changed.nativeOperationId, acknowledgement: changed.acknowledgement
    })
    const liveConfiguration = await until(() => core.readAgentSession(session.agentSessionId),
      value => value?.nativeConfiguration?.revision === finalConfiguration.acknowledgement.revision, 'the same native configuration in the Core consumer projection')
    expect(liveConfiguration?.nativeConfiguration).toEqual(finalConfiguration.acknowledgement)
    expect(await configCalls()).toHaveLength(2)
    const originalPermission = await until(readPermission, request => request?.id === permission?.id && !request?.responseUnavailableReason,
      'same unanswered ACP permission after Core restart')
    expect(originalPermission).toEqual(permission)
    expect(await calls()).toEqual(promptCalls)
    const answerFile = join(scope.root, 'permission-answer.json')
    await writeFile(answerFile, JSON.stringify({ agentSessionId: session.agentSessionId, expectedRun: session.run,
      operationId: 'original-structured-permission-answer', expectedRequest: originalPermission,
      response: { kind: 'permission', requestId: originalPermission?.id, decision: { outcome: 'selected', optionId: 'native-deny-exact' } } }))
    const answered = await exec(process.execPath, [...cli, 'agent', 'interaction', 'respond', '--input', answerFile], { env: scope.env })
    expect(JSON.parse(answered.stdout).result).toMatchObject({ delivery: 'acp-acknowledged', expectedRequest: originalPermission })
    const answeredCalls = await until(calls, value => value.length >= 5, 'exact native response on the original permission')
    expect(answeredCalls[4]).toEqual({ pid: nativePid, id: 41, method: 'client-response', result: { outcome: { outcome: 'selected', optionId: 'native-deny-exact' } } })
    const nextPermission = await until(readPermission, request => !!request && request.id !== originalPermission?.id, 'new ACP permission occurrence')
    expect(nextPermission?.evidence).toMatchObject({ acpBindingId: originalPermission?.evidence.acpBindingId })

    const cancel = (promptOperationId: string) => exec(process.execPath, [...cli, 'agent', 'interrupt', '--session', session.agentSessionId, '--run', session.run.runId,
      '--prompt-operation-id', promptOperationId], { env: scope.env })
    await expect(cancel('foreign-prompt-operation')).rejects.toMatchObject({ stderr: expect.stringContaining('AGENT_ACP_CANCEL_UNCONFIRMED') })
    expect(await calls()).toEqual(answeredCalls)
    const cancelling = cancel('original-structured-prompt')
    void cancelling.catch(() => {})
    const cancelCalls = await until(calls, value => value.length >= 7, 'the original native cancel and permission cancellation')
    expect(cancelCalls[5]).toEqual({ pid: nativePid, method: 'session/cancel', params: { sessionId: 'fixture-original-acp-session' } })
    expect(cancelCalls[6]).toEqual({ pid: nativePid, id: '41', method: 'client-response', result: { outcome: { outcome: 'cancelled' } } })
    expect(await Promise.race([cancelling.then(() => 'returned'), wait(175, 'pending')])).toBe('pending')
    expect((await core.listRuns()).find(run => run.runId === session.run.runId)).toMatchObject({ pid: original.pid, state: 'running' })
    await writeFile(cancelRelease, 'complete the original cancelled prompt')
    const cancelled = JSON.parse((await cancelling).stdout).result
    expect(cancelled).toEqual({ agentSessionId: session.agentSessionId, runId: session.run.runId, promptOperationId: 'original-structured-prompt' })
    expect(JSON.parse((await cancel('original-structured-prompt')).stdout).result).toEqual(cancelled)
    expect(await calls()).toEqual(cancelCalls)
    const finalActivity = await until(() => core.sessionTimeline(session.agentSessionId),
      result => result.items.some(item => item.kind === 'assistant_message' && item.status === 'complete'), 'final Activity from the original cancelled turn')
    expect(finalActivity.items.filter(item => item.kind === 'assistant_message')).toEqual([
      expect.objectContaining({ content: 'ACP fixture assistant content', status: 'complete' })
    ])
    expect(await readPermission()).toBeUndefined()
    expect(() => process.kill(nativePid, 0)).not.toThrow()

    const restartRequest = { agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'restore-original-acp-session' }
    const restarting = exec(process.execPath, [...cli, 'agent', 'restart', '--session', restartRequest.agentSessionId,
      '--run', restartRequest.expectedRun.runId, '--operation-id', restartRequest.operationId], { env: scope.env })
    void restarting.catch(() => {})
    const resumedCalls = await until(calls, value => value.length >= 9, 'replacement child already requesting the original ACP session')
    expect(resumedCalls.map(call => call.method)).toEqual(['initialize', 'session/new', 'session/prompt', 'session/prompt', 'client-response', 'session/cancel', 'client-response', 'initialize', 'session/resume'])
    expect(resumedCalls[7]!.pid).not.toBe(nativePid)
    expect(resumedCalls[8]).toMatchObject({ pid: resumedCalls[7]!.pid,
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

    process.kill(resumedCalls[7]!.pid, 'SIGTERM')
    await until(async () => (await core.listRuns()).find(run => run.runId === resumed.run.runId),
      run => run !== undefined && run.state !== 'running', 'confirmed terminal state on the exact ACP Run')
    const resumeInput = { agentSessionId: session.agentSessionId, operationId: 'resume-with-original-draft', prompt: 'Original resumed draft',
      ...(inputEpoch ? { inputEpoch } : {}) }
    const withDraft = await core.resumeAgent(resumeInput)
    started = withDraft
    expect(withDraft.nativeHandle).toEqual(saved?.nativeHandle)
    const withDraftCalls = await until(calls, value => value.length >= 12, 'typed SDK resume with the original deferred draft')
    expect(withDraftCalls.slice(9).map(call => call.method)).toEqual(['initialize', 'session/resume', 'session/prompt'])
    expect(withDraftCalls[11]).toMatchObject({ pid: withDraftCalls[10]!.pid, params: { sessionId: 'fixture-original-acp-session',
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
    expect((await calls()).slice(12).map(call => call.method)).toEqual(['initialize', 'session/resume'])
    await core.stopAgent(started.agentSessionId, started.run, { operationId: 'stop-original-structured-acp' })
    started = undefined
  } finally {
    try {
      if (started) await core.stopAgent(started.agentSessionId, started.run, { operationId: 'stop-original-structured-acp' }).catch(() => {})
    } finally { await scope.cleanup() }
  }
}, 65_000)


it.each([true, false])('delivers an exact Host upload only when the original ACP subprocess advertises images (%s)', async imageSupported => {
  const scope = await headlessFixture({ ownerEntry: entry('./fixtures/acp-spatial-host.mjs'),
    ownerNodeArgs: ['--experimental-transform-types', '--import', entry('./fixtures/acp-spatial-host-loader.mjs')] })
  const core = await scope.client()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
  let original: { agentSessionId: string; run: AgentMuxRunRef } | undefined
  try {
    const trace = join(scope.root, 'acp-image.ndjson'), release = join(scope.root, 'release-original-session')
    await writeFile(release, 'ready')
    const executorId = 'native-acp-image-test'
    const nativeSessionId = '829bc99d-fcb4-4ce3-8c7c-679b38b9c207'
    await core.configureHostExecutor({ executorId, config: {
      providerId: 'antigravity', label: 'Original ACP image fixture', command: entry('./fixtures/acp-run-cli.mjs'),
      args: [], env: { ACP_RUN_TRACE: trace, ACP_RUN_RELEASE: release, ACP_RUN_IMAGES: imageSupported ? 'enabled' : 'absent', ACP_RUN_NATIVE_HISTORY_ID: nativeSessionId },
      injectAgentMuxGuide: false
    } })
    const spatial = new AgentMuxSpatialStateStore(join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'spatial-state.json'))
    const { spaceId, zoneId } = (await spatial.read())!.graph.bindings[0]!
    const options = join(scope.root, 'launch-options.json')
    await writeFile(options, JSON.stringify({ interaction: 'acp' }))
    const cli = [entry('../bin/amux'), '--endpoint', `unix:${scope.socketPath}`]
    const opened = await exec(process.execPath, [...cli, 'agent', 'open', '--space', spaceId, '--zone', zoneId, '--new-tab',
      '--executor', executorId, '--launch-options', options, '--operation-id', 'original-image-conversation'], { env: scope.env })
    const { agent } = JSON.parse(opened.stdout).result
    original = { agentSessionId: agent.agentSessionId, run: { runId: agent.runId } }
    const { agentSessionId, run } = original
    await until(() => core.readAgentSession(agentSessionId), state => state?.nativeHandle?.sessionId === nativeSessionId, 'the exact native image-session endpoint')
    const calls = async (): Promise<RecordedRequest[]> => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const nativePid = (await calls())[0]!.pid
    const dataBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    const bytes = Buffer.from(dataBase64, 'base64')
    const upload = { hostId: 'local', agentSessionId, expectedRun: run, operationId: 'exact-original-acp-upload',
      name: 'image.png', mimeType: 'image/png', byteLength: bytes.length, revision: fileUploadRevision(bytes) }
    expect(await rpc.call('file.upload', { ...upload, dataBase64 })).toMatchObject({ status: 'uploaded' })
    const prompt = 'Read the original @image.png'
    const reference = { upload, start: prompt.indexOf('@'), end: prompt.length, bodyRevision: fileUploadRevision(new TextEncoder().encode(prompt)) }
    const promptFile = join(scope.root, 'prompt.json')
    const submit = async (operationId: string, inputImages: typeof reference[], promptText = prompt) => {
      await writeFile(promptFile, JSON.stringify({ expectedRun: run, prompt: promptText, inputImages,
        admissionIntent: { kind: 'session-conversation' }, execution: 'immediate' }))
      return JSON.parse((await exec(process.execPath, [...cli, 'agent', 'input', 'submit', '--session', agentSessionId,
        '--operation-id', operationId, '--input', promptFile], { env: scope.env })).stdout).result
    }
    const receipt = await submit('original-prompt-with-image', [reference])
    const inspect = () => rpc.call('agent.input.inspect', { key: receipt.key })
    if (imageSupported) {
      const sent = await until(calls, value => value.some(request => request.method === 'session/prompt'),
        'the original prompt and image content on the native subprocess', 6_000)
        .catch(async error => { throw new Error(JSON.stringify(await inspect()), { cause: error }) })
      const nativePrompt = sent.find(request => request.method === 'session/prompt')!
      expect(nativePrompt).toMatchObject({ pid: nativePid, params: { sessionId: nativeSessionId,
        prompt: [{ type: 'text', text: prompt }, { type: 'image', mimeType: 'image/png', data: dataBase64 }] } })
      const admitted = await until(() => core.inspectAgentPromptSubmission(receipt.key), value => value?.admission?.native?.outcome === 'admitted',
        'the original native image input acknowledgement')
      expect(admitted?.admission).toMatchObject({ native: { requestId: nativePrompt.id }, intent: { message: { inputImages: [{ upload }] } } })
      expect(JSON.stringify(admitted)).not.toContain(dataBase64)
      const items = await until(() => core.sessionHistoryPage(agentSessionId, { limit: 5 }), value =>
        value.items.some(item => item.kind === 'assistant-message'), 'the original on-disk history through the public Core reader')
      expect(items).toMatchObject({ source: { providerId: 'antigravity', nativeSessionId }, items: [
        { kind: 'user-message', contentParts: [{ kind: 'text', text: prompt }] },
        { kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original native history reply' }] }
      ] })
      await expect(core.sessionHistoryPage(agentSessionId, { limit: 5, refreshNativeSource: true, requireCurrentSource: true }))
        .resolves.toMatchObject({ source: items.source, items: items.items })

    } else {
      const waiting = await until(inspect, value => JSON.stringify(value).includes('AGENT_ACP_PROMPT_CONTENT_UNSUPPORTED'),
        'confirmed negotiation refusal for this exact original image input')
      expect(waiting.input).toMatchObject({ key: receipt.key, status: 'waiting', persistence: 'confirmed' })
      expect(await rpc.call('agent.input.resource', { key: receipt.key, index: 0, revision: upload.revision, maxBytes: bytes.length }))
        .toMatchObject({ status: 'available', dataBase64 })
      expect(await core.inspectAgentPromptSubmission(receipt.key)).toBeNull()
      expect((await calls()).map(request => request.method)).toEqual(['initialize', 'session/new'])
      await submit('ordinary-text-same-native-session', [], 'Read the original text')
      const text = await until(calls, value => value.some(request => request.method === 'session/prompt'),
        'ordinary text still reaches the same native subprocess')
      expect(text.at(-1)).toMatchObject({ pid: nativePid, params: { sessionId: nativeSessionId, prompt: [{ type: 'text', text: 'Read the original text' }] } })
    }
  } finally {
    try {
      if (original) await core.stopAgent(original.agentSessionId, original.run, { operationId: 'stop-original-acp-image-session' }).catch(() => {})
    } finally {
      await rpc.dispose()
      await scope.cleanup()
    }
  }
}, 50_000)
