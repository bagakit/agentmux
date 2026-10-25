import { access, appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { offlineEndpoint } from './helpers/codex-offline-endpoint.js'
import { nativeProcessTcpListeners } from '../src/agent-native-process.js'
import { connectCodexNativeActor } from '../src/providers/codex-native-rpc.js'

const core = await import(/* @vite-ignore */ process.env.AGENTMUX_NATIVE_INITIAL_ENTRY!)
const native = process.env.AGENTMUX_TEST_CODEX_EXECUTABLE!
const close: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of close.splice(0).reverse()) try { await cleanup() } catch (error) { failures.push(error) }
  vi.restoreAllMocks()
  if (failures.length) throw new AggregateError(failures, 'Private original-input cleanup failed')
})
const exec = promisify(execFile)
const exists = (path: string) => access(path).then(() => true, () => false)

it.runIf(process.platform === 'darwin').each(['plain', 'git'] as const)(
  'real Core owner resumes the original prepared input once through real Native and remote TUI in %s cwd', async mode => {
    const scope = await headlessFixture(); close.push(scope.cleanup)
    const workspace = join(scope.root, mode), home = join(scope.root, 'codex-home')
    await mkdir(workspace); await mkdir(home)
    let sha: string | undefined
    if (mode === 'git') {
      await exec('git', ['init', '-q', workspace])
      await writeFile(join(workspace, 'original.txt'), 'private original Git fact\n')
      await exec('git', ['-C', workspace, 'add', 'original.txt'])
      await exec('git', ['-C', workspace, '-c', 'user.name=Private fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'Original private fact'])
      sha = (await exec('git', ['-C', workspace, 'rev-parse', 'HEAD'])).stdout.trim()
    }
    const inputs: string[] = [], offline = await offlineEndpoint(home, inputs, workspace)
    close.push(async () => { for (const socket of offline.sockets) socket.destroy(); await new Promise<void>(yes => offline.endpoint.close(() => yes())) })
    const sdk = await scope.client(), store = new core.AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
    const prompt = 'PRIVATE_QUEUE_ORIGINAL_CORE_INPUT_' + mode, context = 'PRIVATE_QUEUE_ORIGINAL_PLATFORM_CONTEXT_' + mode
    const original = await sdk.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: 'initial-original-' + mode,
      createOperationId: 'create-original-' + mode, workspacePath: workspace, commandOverride: native,
      args: ['--no-alt-screen', '--dangerously-bypass-hook-trust', '--model', 'private-queue', '--sandbox', 'read-only', '--ask-for-approval', 'never'],
      env: { CODEX_HOME: home }, prompt, agentMuxNote: context, injectAgentMuxGuide: false })
    close.push(async () => { const reader = await scope.client(); const current = await reader.statusAgent(original.agentSessionId)
      if (current.run.state === 'running') await reader.stopAgent(original.agentSessionId, current.session.run) })
    const before = await until(() => sdk.statusAgent(original.agentSessionId), value => value.session.terminalFrontend?.state === 'detached' &&
      value.session.terminalFrontend.exitCode === 1 && value.session.terminalFrontend.initialization?.phase === 'ready', 'original real TUI failed, original Native remains ready')
    // The real history reader observes the still-absent Native record before
    // the original initialization input is continued by a new Core owner.
    await sdk.sessionHistoryPage(original.agentSessionId, { refreshNativeSource: true, commandOverride: native, env: { CODEX_HOME: home } }).catch(() => {})
    const saved = await store.readMetadata(original.agentSessionId), key = saved.initialInput.key
    if (process.env.AGENTMUX_NATIVE_INITIAL_EVIDENCE) await writeFile(process.env.AGENTMUX_NATIVE_INITIAL_EVIDENCE + '-before-' + mode + '.json',
      JSON.stringify({ nativeHandle: saved.nativeHandle, initialInput: saved.initialInput, nativeSourceObservation: saved.nativeSourceObservation, frontend: before.session.terminalFrontend }, null, 2))
    expect(saved.initialInput).toMatchObject({ state: 'prepared', delivery: 'post-launch', message: { userContent: prompt } })
    expect(saved.initialInput.message.systemContext).toContain(context)
    expect(saved.nativeSourceObservation).toMatchObject({ state: 'unknown', run: original.run })
    expect(await sdk.inspectAgentPromptSubmission(key)).toBeNull()
    expect(inputs, 'The original prepared input has never reached the model').toEqual([])
    expect(before.run.state).toBe('running')
    const listeners = await nativeProcessTcpListeners(before.run.pid!, new AbortController().signal)
    expect(listeners).toHaveLength(1)
    const connection = await connectCodexNativeActor(listeners[0]!.endpoint, saved.nativeActor.token, new AbortController().signal, 'agentmux_managed_initialization')
    close.push(async () => connection.dispose())
    const id = saved.nativeHandle.sessionId, empty = await connection.request('thread/read', { threadId: id, includeTurns: false })
    expect(empty.thread.id).toBe(id); expect(empty.thread.canAcceptDirectInput).toBe(true)
    expect(await exists(empty.thread.path)).toBe(false)
    await expect(connection.request('thread/resume', { threadId: id, excludeTurns: false })).rejects.toThrow(/no rollout found/u)
    const nativeRuntime = empty.thread.sessionId, originalActor = saved.nativeActor, firstOwner = scope.owner, firstOwnerPid = scope.ownerProcess.pid
    const provider = new core.AgentProviderRegistry().get('codex')
    const nativeContext = { processId: before.run.pid!, workspacePath: workspace, signal: new AbortController().signal,
      nativeActor: originalActor, nativeHandle: saved.nativeHandle, assertCurrent: async () => {} }
    await expect(provider.reconnectTerminalFrontend({ ...nativeContext, nativeHandle: { ...saved.nativeHandle, sessionId: 'wrong-native-object' } }, {
      operationId: 'wrong-native-handle', expectedFrontendId: before.session.terminalFrontend!.frontendId,
      target: { kind: 'native-session', nativeSessionId: id } })).rejects.toMatchObject({ code: 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED' })
    expect((await sdk.statusAgent(original.agentSessionId)).session.terminalFrontend!.frontendId).toBe(before.session.terminalFrontend!.frontendId)
    await sdk.dispose(); await scope.stopOwner()
    await writeFile(join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'use-candidate'), 'continue exact original saved input')
    const barrier = join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'hold-original-input')
    await writeFile(barrier, 'private deterministic scheduling, never a Native response')
    close.push(() => rm(barrier, { force: true }))
    await scope.restart(); const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
    close.push(() => rpc.dispose()); const reader = await scope.client(rpc)
    expect(scope.owner.ownerInstanceId).not.toBe(firstOwner.ownerInstanceId)
    expect(scope.ownerProcess.pid).not.toBe(firstOwnerPid); expect(scope.owner.ctxmux).toEqual(firstOwner.ctxmux)
    const retained = await store.readMetadata(original.agentSessionId)
    expect(retained.initialInput.key).toEqual(key); expect(retained.initialInput.digest).toBe(saved.initialInput.digest)
    expect(retained.nativeActor).toEqual(originalActor); expect(retained.run).toEqual(original.run)
    // Immediately request the real public Resume while Core's original input
    // continuation is scheduled but has not written Native source yet.
    const errors: unknown[] = []; reader.onEvent((event: any) => { if (event.type === 'agent-error') errors.push(event) })
    let resumed: unknown
    await until(() => exists(join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'original-input-held')), Boolean, 'original Core continuation reached private scheduling barrier')
    const resumeRequest = { target: { kind: 'agent-session' as const, agentSessionId: original.agentSessionId }, operationId: 'resume-original-' + mode, text: '' }
    try { resumed = await rpc.call('agent.resume', resumeRequest) } catch (error) { resumed = { pendingError: String(error) } }
    const pending = await reader.statusAgent(original.agentSessionId)
    expect(pending.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
    expect(pending.session.terminalFrontend!.frontendId, 'A missing Native source must not dispatch or consume a new frontend generation').toBe(before.session.terminalFrontend!.frontendId)
    expect(await reader.inspectAgentPromptSubmission(key)).toBeNull()
    await rm(barrier)
    try { await expect.poll(async () => {
      const record = await reader.inspectAgentPromptSubmission(key)
      return record?.admission?.transport === 'native' ? record.admission.native.outcome : null
    }, { timeout: 5000 }).toBe('admitted') } catch (error) {
      if (process.env.AGENTMUX_NATIVE_INITIAL_EVIDENCE) {
        const current = await store.readMetadata(original.agentSessionId)
        await writeFile(process.env.AGENTMUX_NATIVE_INITIAL_EVIDENCE + '-failure-' + mode + '.json', JSON.stringify({ resumed, errors,
          causes: await readFile(join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'initial-input-errors.ndjson'), 'utf8').catch(() => ''),
          session: await reader.statusAgent(original.agentSessionId), initialInput: current.initialInput, claim: await reader.inspectAgentPromptSubmission(key), inputs }, null, 2))
      }
      // The polling reporter may omit its nested assertion cause. Read the
      // original receipt once more and fail on its actual business outcome.
      const outcome = await reader.inspectAgentPromptSubmission(key)
      expect(outcome?.admission?.transport === 'native' ? outcome.admission.native.outcome : null).toBe('admitted')
      throw error
    }
    const delivered = await reader.inspectAgentPromptSubmission(key)
    expect(delivered.admission.inputKey).toEqual(key)
    expect(delivered.admission.intent.prompt).toBe(saved.initialInput.prompt)
    expect(delivered.admission.intent.message).toEqual(saved.initialInput.message)
    await expect.poll(() => inputs.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(inputs[0]).toContain(prompt)
    expect(inputs[0]).toContain(context)
    await until(async () => (await connection.request('thread/read', { threadId: id, includeTurns: true })).thread.turns,
      turns => turns.length === 1 && turns[0].status === 'completed', 'original Native input turn completed')
    const nativeAfter = await connection.request('thread/read', { threadId: id, includeTurns: true })
    expect(nativeAfter.thread.sessionId).toBe(nativeRuntime); expect(nativeAfter.thread.id).toBe(id)
    expect(JSON.stringify(nativeAfter.thread.turns)).toContain(prompt)
    expect(nativeAfter.thread.turns).toHaveLength(1); expect(await exists(nativeAfter.thread.path)).toBe(true)
    let authorizationReads = 0
    await expect(provider.reconnectTerminalFrontend({ ...nativeContext, assertCurrent: async () => {
      if (++authorizationReads === 2) throw new core.AgentMuxError('Private original recovery was cancelled after Native preparation', 'PRIVATE_RECOVERY_CANCELLED')
    } }, { operationId: 'cancelled-after-native-preparation', expectedFrontendId: before.session.terminalFrontend!.frontendId,
      target: { kind: 'native-session', nativeSessionId: id } })).rejects.toMatchObject({ code: 'PRIVATE_RECOVERY_CANCELLED' })
    expect(authorizationReads).toBe(2)
    expect((await reader.statusAgent(original.agentSessionId)).session.terminalFrontend!.frontendId).toBe(before.session.terminalFrontend!.frontendId)
    // Rejoin the same public operation; no replacement request or Native input.
    resumed = await rpc.call('agent.resume', resumeRequest)
    const after = await until(() => reader.statusAgent(original.agentSessionId), value => value.session.terminalFrontend?.state === 'attached', 'original remote TUI rejoined')
    expect(after.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
    expect(after.session.nativeHandle).toMatchObject(saved.nativeHandle)
    if (sha) {
      expect((await exec('git', ['-C', workspace, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(sha)
      const records = (await readFile(nativeAfter.thread.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(records.find(value => value.type === 'session_meta').payload.git.commit_hash).toBe(sha)
    }
    const originalReceipt = structuredClone(delivered)
    await rpc.call('agent.resume', { target: { kind: 'agent-session', agentSessionId: original.agentSessionId }, operationId: 'repeat-original-' + mode, text: '' })
    expect(await reader.inspectAgentPromptSubmission(key)).toEqual(originalReceipt)
    expect((await connection.request('thread/read', { threadId: id, includeTurns: true })).thread.turns).toHaveLength(1)
    // Prove the actual rejoined remote TUI has completed its native bootstrap,
    // rather than treating a spawned frontend projection as successful rejoin.
    const replay = async () => (await reader.readRunReplay(original.run)).replay.map(chunk => chunk.data).join('')
    try { await expect.poll(replay, { timeout: 10_000 }).toContain('PRIVATE_QUEUE_COMPLETE') } catch (error) {
      if (process.env.AGENTMUX_NATIVE_INITIAL_EVIDENCE) await writeFile(process.env.AGENTMUX_NATIVE_INITIAL_EVIDENCE + '-tui-failure-' + mode + '.json',
        JSON.stringify({ status: await reader.statusAgent(original.agentSessionId), replay: await replay(), inputs }, null, 2))
      throw error
    }
    const followup = 'PRIVATE_QUEUE_REJOINED_TUI_INPUT_' + mode
    await reader.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: '\x1b[200~' + followup + '\x1b[201~' })
    await reader.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: '\r' })
    // Native may make several model requests within one user turn. HTTP proves
    // receipt only; exact user-input counts belong to Native's original turns.
    await expect.poll(() => inputs.filter(text => text.includes(followup)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(inputs.some(text => text.includes(prompt))).toBe(true)
    const final = await reader.statusAgent(original.agentSessionId)
    expect(final.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
    const finalTurns = (await connection.request('thread/read', { threadId: id, includeTurns: true })).thread.turns
    expect(finalTurns).toHaveLength(2)
    const nativeUserInputs = finalTurns.flatMap((turn: any) => turn.items.filter((item: any) => item.type === 'userMessage'))
      .map((item: any) => item.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(''))
    expect(nativeUserInputs).toHaveLength(2)
    expect(nativeUserInputs.filter((text: string) => text.includes(prompt))).toHaveLength(1)
    expect(nativeUserInputs.filter((text: string) => text === followup)).toHaveLength(1)
    expect(await reader.inspectAgentPromptSubmission(key)).toEqual(originalReceipt)
    if (process.env.AGENTMUX_NATIVE_INITIAL_EVIDENCE) await appendFile(process.env.AGENTMUX_NATIVE_INITIAL_EVIDENCE,
      JSON.stringify({ mode, native, original: { agentSessionId: original.agentSessionId, run: original.run, pid: before.run.pid,
        actorId: originalActor.actorId, nativeId: id, nativeRuntime }, coreOwners: [firstOwnerPid, scope.ownerProcess.pid],
        oldTuiExit: 1, originalPreparedClaim: null, originalObservation: saved.nativeSourceObservation.state,
        firstInputCount: nativeUserInputs.filter((text: string) => text.includes(prompt)).length, actualTuiInputCount: finalTurns.length - nativeAfter.thread.turns.length,
        tuiFollowupModelRequestCount: inputs.filter(text => text.includes(followup)).length,
        nativeTurnCountBeforeTuiFollowup: nativeAfter.thread.turns.length, sourceExists: true, gitShaPreserved: sha ?? null }) + '\n')
  })

async function coordinator() {
  const run = { runId: 'initial-run', pid: 42, state: { type: 'running' }, args: [], acceptedInputBytes: 0, latestOutputBytes: 0 }
  const session: any = { kind: 'agent', agentSessionId: 'initial-session', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: '/private/fixture', run: { runId: run.runId }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'initial-binding', hookToken: 'initial-hook',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'initial-native' },
    nativeActor: { protocolId: 'fixture', actorId: 'initial-actor', token: 'a'.repeat(64), lifecycleOperationId: 'initial-lifecycle', launch: { command: 'codex', args: [] } },
    nativeSourceObservation: { state: 'unknown', reason: 'current-main-unconfirmed', observedAt: 1, run: { runId: run.runId } } }
  const store = new core.AgentMuxMemoryAgentSessionStore(), registry = new core.AgentMuxAgentSessionRegistry(store)
  await registry.put(session)
  const send = vi.fn(async () => ({ outcome: 'admitted', turnId: 'initial-turn' })), prepare = vi.fn(async (_context: unknown, source: any) => ({
    plan: { kind: 'native-rpc', protocolId: 'fixture', actorId: 'initial-actor', sourceId: JSON.stringify([source.providerId, source.nativeSessionId]),
      threadId: source.nativeSessionId, operation: 'start-or-steer' }, assertCurrent: async () => {}, send, dispose() {} }))
  const providers = new core.AgentProviderRegistry(); providers.get('codex').prepareNativeInput = prepare
  const kernel = { identity: () => ({ daemonInstanceId: 'private-daemon' }), status: async () => run, input: vi.fn() }
  const owner = new core.AgentPromptSubmissionCoordinator({ store, registry, providers, kernel, publisher: new core.AgentMuxClientEventPublisher(),
    screenEvidence: {}, requireAgentSession: (id: string) => registry.get(id), assertAgentRun() {},
    updateExactAgentSession: (id: string, expectedRun: unknown, update: any) => registry.update(id, expectedRun, update) })
  const key = { kind: 'prompt', agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: 'original-input' }
  const source = { providerId: 'codex', nativeSessionId: 'initial-native' }
  const submit = (requiredNativeSource = source, onlyIfUnclaimed = true) => owner.submitInputPlan(session, run, key.submissionId, 'PRIVATE_QUEUE_ORIGINAL',
    { kind: 'single-phase', data: 'PRIVATE_QUEUE_ORIGINAL\r' }, { expectedRun: session.run, afterSubmissionId: null }, undefined, undefined, false,
    undefined, undefined, { userContent: 'PRIVATE_QUEUE_ORIGINAL' }, undefined, undefined, undefined, undefined, key, { requiredNativeSource, onlyIfUnclaimed })
  return { run, session, store, registry, owner, key, source, send, prepare, kernel, submit }
}
it('refuses a different required Native object before preparing or claiming the original input', async () => {
  const f = await coordinator()
  await expect(f.submit({ ...f.source, nativeSessionId: 'wrong-native' })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  expect(await f.store.readPromptAdmission(f.session.agentSessionId, f.session.run, f.key.submissionId)).toBeNull()
})
it.each(['changed', 'ambiguous', 'conflicting-handle', 'ordinary-question'])(
  'refuses %s without borrowing the original initialization exception', async reason => {
    const f = await coordinator(), current = await f.store.readMetadata(f.session.agentSessionId)
    const next = reason === 'conflicting-handle' ? { ...current, observedNativeHandle: { ...current.nativeHandle, sessionId: 'different-object' } }
      : reason === 'ordinary-question' ? current : { ...current, nativeSourceObservation: { ...current.nativeSourceObservation, state: reason },
        ...(reason === 'changed' ? { observedNativeHandle: { ...current.nativeHandle, sessionId: 'different-object' } } : {}) }
    await f.store.compareAndSwap(current, next)
    await expect(f.submit(f.source, reason !== 'ordinary-question')).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })
it.each(['admitted', 'unknown'] as const)('the original %s claim cannot be borrowed or replayed by a new deferred owner', async outcome => {
  const f = await coordinator()
  if (outcome === 'unknown') f.send.mockImplementation(async () => { throw new Error('Original Native ACK unavailable') })
  if (outcome === 'unknown') await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  else await f.submit()
  const before = await f.store.readPromptAdmission(f.session.agentSessionId, f.session.run, f.key.submissionId)
  expect(before.admission.native.outcome).toBe(outcome)
  await expect(f.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
  expect(await f.store.readPromptAdmission(f.session.agentSessionId, f.session.run, f.key.submissionId)).toEqual(before)
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.kernel.input).not.toHaveBeenCalled()
})
