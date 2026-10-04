import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, AgentMuxSessionDurabilityError, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { DurableWriteError } from '../src/durable-write.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxNativeSessionConfirmationInput, AgentMuxStoredAgentSession, NativeHookEnvelope } from '../src/types.js'

const SID = 'private-current-conversation', RUN = 'same-private-run', OLD = 'previous-main', NEW = 'current-main'
const cleanups: Array<() => Promise<void>> = []
function discoveryProvider(client: AgentMuxClient, id: 'codex' | 'claude'): AgentProvider & Required<Pick<AgentProvider, 'discoverNativeSession'>> {
  const provider = client.providers.get(id)
  if (!provider.discoverNativeSession) throw new Error('This fixture requires real native session discovery')
  return provider as AgentProvider & Required<Pick<AgentProvider, 'discoverNativeSession'>>
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function fixture(providerId: 'codex' | 'claude' = 'codex', mode: 'main' | 'child' | 'ambiguous' | 'unknown' = 'main') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-source-change-'))), provider = new AgentProviderRegistry().get(providerId)
  const record = (id: string, child = false) => providerId === 'codex'
    ? { type: 'session_meta', payload: { id, source: child ? { subagent: { thread_spawn: { parent_thread_id: OLD } } } : mode === 'unknown' && id !== OLD ? 'unknown' : 'cli' } }
    : { type: 'user', sessionId: id, isSidechain: child ? true : mode === 'unknown' && id !== OLD ? undefined : false, uuid: `${id}-message`, message: { role: 'user', content: `Original ${id} record` } }
  const path = (id: string) => join(root, providerId === 'codex' ? `rollout-${id}.jsonl` : `${id}.jsonl`)
  const oldPath = path(OLD), currentPath = path(NEW), files = [currentPath]
  await writeFile(oldPath, JSON.stringify(record(OLD)) + '\n')
  await writeFile(currentPath, JSON.stringify(record(NEW, mode === 'child')) + '\n')
  if (mode === 'ambiguous') { files.push(path('another-main')); await writeFile(files[1]!, JSON.stringify(record('another-main')) + '\n') }
  const holder = spawn(process.execPath, ['-e', `const fs=require('fs'),mode=${JSON.stringify(providerId === 'claude' ? 'a+' : 'r')};let fds=process.argv.slice(1).map(p=>fs.openSync(p,mode));console.log('ready');process.stdin.on('data',d=>{const s=d.toString();if(s.startsWith('@fixture:open:')){fds.forEach(fd=>fs.closeSync(fd));fds=[fs.openSync(s.slice(14).trim(),mode)];console.log('switched')}else console.log('raw:'+s)});setInterval(()=>{},1000)`, ...files],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  await once(holder.stdout!, 'data')
  cleanups.push(async () => { if (holder.exitCode === null && holder.signalCode === null) { const exited = once(holder, 'exit'); holder.kill(); await exited }
    await rm(root, { recursive: true, force: true }) })
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const response = { kind: 'permission' as const, requestId: 'previous-permission', decision: { outcome: 'selected' as const, optionId: 'allow-once' } }
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: SID, providerId, executorId: providerId,
    hostId: 'local', workspacePath: root, run: { runId: RUN }, retiredRuns: [], hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId, sessionId: OLD, transcriptPath: oldPath },
    nativeBinding: { source: 'semantic-resume-target', run: { runId: RUN }, observedAt: 1 },
    reopenedFrom: { source: 'user', run: { runId: 'original-recovery-run' }, observedAt: 1 },
    pendingInteraction: { request: { kind: 'permission', id: response.requestId, agentSessionId: SID, title: 'Old native permission',
      options: [{ id: 'allow-once', label: 'Allow', kind: 'allow-once' }], nativeToolCallId: 'old-native-tool',
      evidence: { source: 'native-hook', observedAt: 1, run: { runId: RUN }, hookReceiptId: 'old-hook' } },
      response: { value: response, responseDigest: createHash('sha256').update(JSON.stringify(response)).digest('base64url'),
        operationId: 'old-unacknowledged-input', inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false } },
    terminalPromptReadiness: { source: 'native-stop', id: 'old-stop', run: { runId: RUN }, observedAt: 1, outputCursorBytes: 0, readyThroughByte: 0 },
    promptCompletionAdmission: { submissionId: 'previous-prompt', operationId: 'previous-prompt-input', startByte: 0, endByte: 1, acknowledged: false },
    semanticStatus: { state: 'waiting', source: 'native-hook', observedAt: 1 }, createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, original)
  const client = new AgentMuxClient({ store, providers: [provider] }), kernel = Reflect.get(client, 'kernel') as CtxmuxRunAdapter
  await Reflect.get(client, 'registry').load('local'); Reflect.set(client, 'connected', true)
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  vi.spyOn(kernel, 'identity').mockReturnValue({ daemonInstanceId: 'private-runtime', buildIdentity: 'private-fixture', protocolVersion: 1 } as ReturnType<CtxmuxRunAdapter['identity']>)
  const run = { runId: RUN, lifecycleOperationId: null, state: { type: 'running' as const }, pid: holder.pid!, workspacePath: root, program: process.execPath, args: [],
    cols: null, rows: null, firstAvailableByte: 0, nativeService: null, acceptedInputBytes: 0, latestOutputBytes: 0 }
  const status = vi.spyOn(kernel, 'status').mockResolvedValue(run as Awaited<ReturnType<CtxmuxRunAdapter['status']>>)
  const input = vi.spyOn(kernel, 'input').mockImplementation(async (_run, data) => {
    const payload = typeof data === 'string' ? data : data.data
    const bytes = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload)
    if (typeof data !== 'string') expect(data.expectedByte).toBe(run.acceptedInputBytes)
    const startByte = run.acceptedInputBytes, echo = once(holder.stdout!, 'data'); holder.stdin!.write(bytes)
    const [received] = await echo
    expect(String(received)).toContain('raw:' + bytes.toString('utf8'))
    run.acceptedInputBytes += bytes.length
    return { run: { ...run }, appliedByteRange: { startByte, endByte: run.acceptedInputBytes } } as Awaited<ReturnType<CtxmuxRunAdapter['input']>>
  })
  const controls = (['start', 'stop', 'resize', 'attach'] as const).map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('Unexpected Runtime control ' + name) }))
  const events: unknown[] = []; client.onEvent(event => events.push(event))
  const hook = async (id = NEW, eventName = providerId === 'claude' ? 'SessionStart' : 'PermissionRequest', extra: Record<string, unknown> = {}) => {
    const envelope: NativeHookEnvelope = { receiptId: `${eventName}-${id}-${events.length}`, agentSessionId: SID, providerId, runId: RUN,
      payload: { hook_event_name: eventName, source: 'clear', session_id: id, transcript_path: path(id), tool_name: 'Edit', tool_use_id: `tool-${id}`, tool_input: { file_path: 'private.txt' }, ...extra } }
    await Reflect.get(client, 'acceptHookEvent').call(client, envelope, new AbortController().signal)
  }
  const confirmation = (operationId = 'confirm-current'): AgentMuxNativeSessionConfirmationInput => {
    const session = client.agentSession(SID)
    return { agentSessionId: SID, expectedRun: { runId: RUN }, expectedNativeHandle: session.nativeHandle as AgentMuxNativeSessionConfirmationInput['expectedNativeHandle'],
      candidateNativeHandle: session.observedNativeHandle as AgentMuxNativeSessionConfirmationInput['candidateNativeHandle'], expectedObservationAt: session.nativeSourceObservation!.observedAt, operationId }
  }
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanups.push(async () => { await rpc.dispose(); await server.stop(); await client.dispose()
    for (const control of controls) expect(control).not.toHaveBeenCalled() })
  const switchToOld = async () => { const ready = once(holder.stdout!, 'data'); holder.stdin!.write('@fixture:open:' + oldPath + '\n'); expect(String((await ready)[0])).toContain('switched') }
  return { root, oldPath, currentPath, client, store, kernel, status, input, holder, original, run, events, hook, confirmation, rpc, server, switchToOld,
    cli: (value: unknown) => runCompiledObjectCli(['agent', 'native', 'confirm', '--input', '-'], objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: `unix:${server.path}` }), JSON.stringify(value)) }
}

it.each(['codex', 'claude'] as const)('publishes witnessed %s source change, preserves source authority until explicit public confirmation and supports real CLI', async provider => {
  const f = await fixture(provider)
  await f.hook()
  const observed = f.client.agentSession(SID)
  expect(observed.nativeHandle).toEqual(f.original.nativeHandle)
  expect(observed.nativeSourceObservation?.state).toBe('changed')
  expect(observed.observedNativeHandle).toEqual({ kind: 'provider', providerId: provider, sessionId: NEW, transcriptPath: f.currentPath })
  expect(observed.pendingInteraction).toEqual(f.original.pendingInteraction)
  expect(observed.terminalPromptReadiness).toEqual(f.original.terminalPromptReadiness)
  await expect(f.client.respondAgentInteraction({ agentSessionId: SID, expectedRun: { runId: RUN }, response: f.original.pendingInteraction!.response!.value }))
    .rejects.toMatchObject({ code: 'AGENT_INTERACTION_SOURCE_CHANGED' })
  expect(f.input).not.toHaveBeenCalled()
  await Reflect.get(f.client, 'recoverPendingInteractionResponses').call(f.client, [f.run])
  expect(f.input).not.toHaveBeenCalled()
  await f.client.writeAgent({ agentSessionId: SID, expectedRun: { runId: RUN }, source: 'user', data: 'x' })
  expect(f.input).toHaveBeenCalledOnce()
  const preservedInteraction = f.client.agentSession(SID).pendingInteraction
  const input = f.confirmation()
  const cli = await f.cli(input)
  expect(cli.stderr).toBe(''); expect(cli.code).toBe(0)
  const result = JSON.parse(cli.stdout).result
  expect(parseRpcNativeResult('agent.native.confirm', result, input)).toMatchObject({ persisted: true, session: { agentSessionId: SID, run: { runId: RUN } } })
  const confirmed = f.client.agentSession(SID)
  expect(confirmed.nativeBinding?.source).toBe('user-confirmed')
  expect(confirmed.nativeConfirmation?.previousInteraction).toEqual(preservedInteraction)
  expect(confirmed.reopenedFrom).toEqual(f.original.reopenedFrom)
  expect(confirmed.workspacePath).toBe(f.root); expect(confirmed.run).toEqual(f.original.run)
  expect(confirmed.pendingInteraction).toBeUndefined(); expect(confirmed.terminalPromptReadiness).toBeUndefined()
  expect(confirmed.promptCompletionAdmission).toEqual(f.original.promptCompletionAdmission)
  await expect(Reflect.get(f.client, 'promptSubmission').submitOwnedInputPlan(confirmed, f.run, 'previous-prompt', 'original input', { kind: 'single-phase', data: 'original input\r' }))
    .rejects.toMatchObject({ code: 'AGENT_PROMPT_SOURCE_CHANGED' })
  await expect(Reflect.get(f.client, 'promptSubmission').submitOwnedInputPlan({ ...confirmed,
    promptCompletionAdmission: { ...confirmed.promptCompletionAdmission!, acknowledged: true } }, f.run, 'previous-prompt', 'original input', { kind: 'single-phase', data: 'original input\r' })).resolves.toBeUndefined()
  expect(f.input).toHaveBeenCalledOnce()
  expect((await loadAgentSessions(f.store))[0]!.nativeConfirmation).toEqual(confirmed.nativeConfirmation)
  const modulePath = process.env.AMX_SOURCE_CONFIRM_STORE_MODULE
  expect(modulePath).toBeTruthy()
  const restore = spawn(process.execPath, ['--input-type=module', '-e', `const m=await import(process.argv[1]);console.log(JSON.stringify(await m.loadAgentSessions(new m.AgentMuxFileAgentSessionStore(process.argv[2]))))`, modulePath!, join(f.root, 'sessions.json')],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let restored = '', restoreError = ''; restore.stdout!.on('data', bytes => restored += bytes); restore.stderr!.on('data', bytes => restoreError += bytes)
  const [restoreCode] = await once(restore, 'exit')
  expect(restoreCode).toBe(0); expect(restoreError).toBe('')
  expect(JSON.parse(restored)[0]).toMatchObject({ agentSessionId: SID, run: { runId: RUN }, workspacePath: f.root,
    nativeHandle: confirmed.nativeHandle, nativeConfirmation: confirmed.nativeConfirmation, reopenedFrom: f.original.reopenedFrom })
  const help = await runCompiledObjectCli(['agent', 'native', 'confirm', '--help'], objectCliEnvironment(f.root))
  expect(help.code).toBe(0); expect(help.stdout).toContain('expectedObservationAt')
  const skill = await runCompiledObjectCli(['--skill'], objectCliEnvironment(f.root))
  expect(skill.code).toBe(0); expect(skill.stdout).toContain('agentmux agent native confirm')
  expect(await readFile(f.oldPath, 'utf8')).toContain(OLD)
  f.status.mockRejectedValue(new Error('private unavailable runtime observation'))
  Reflect.set(f.client, 'connected', false)
  const repeated = await f.cli(input)
  expect(repeated.code).toBe(0); expect(JSON.parse(repeated.stdout).result.confirmation).toEqual(result.confirmation)
  expect(await f.rpc.call('agent.native.confirm', input)).toMatchObject({ persisted: true, confirmation: result.confirmation })
  Reflect.set(f.client, 'connected', true); f.status.mockResolvedValue(f.run as Awaited<ReturnType<CtxmuxRunAdapter['status']>>)
  await f.hook(OLD, 'PermissionRequest')
  expect(f.client.agentSession(SID).pendingInteraction).toBeUndefined()
  await f.hook(NEW, 'PermissionRequest')
  expect(f.client.agentSession(SID).pendingInteraction?.request.id).toBeTruthy()
  expect(f.client.agentSession(SID).pendingInteraction?.request.nativeToolCallId).toBe(`tool-${NEW}`)
  expect(f.client.agentSession(SID).nativeHandle?.sessionId).toBe(NEW)
  const active = f.client.agentSession(SID).pendingInteraction!.request
  // Source-transition proof keeps main's exact target protocol. This private fixture supplies
  // the already-reviewed target frame; Provider target decoding has its own regression suite.
  const targetProvider = f.client.providers.get(provider), frame = { run: { runId: RUN },
    outputThroughByte: f.run.latestOutputBytes, geometryRevision: 0, evidenceGeneration: 0 }
  targetProvider.prepareInteractionResponse = async (context, request, response) => ({
    plan: targetProvider.planInteractionResponse(request, response), target: { ...frame, agentSessionId: SID,
      run: { runId: RUN }, requestId: request.id, nativeToolCallId: request.nativeToolCallId!,
      nativeSourceId: NEW, inputByte: context.inputByte, frame },
    inspectCurrentTarget: () => true, verifyCurrentTarget: async () => true })
  vi.spyOn(Reflect.get(f.client, 'screenEvidence'), 'currentCompleteFrame').mockReturnValue({ ...frame, snapshot: {} })
  await f.client.respondAgentInteraction({ agentSessionId: SID, expectedRun: { runId: RUN },
    response: { kind: 'permission', requestId: active.id, decision: { outcome: 'selected', optionId: 'allow-once' } } })
  expect(f.input).toHaveBeenCalledTimes(2)
  if (provider === 'claude') {
    const old = await f.client.sessionHistoryPage(SID, { nativeSource: 'previous' })
    const current = await f.client.sessionHistoryPage(SID)
    expect(old.source.nativeSessionId).toBe(OLD); expect(old.items[0]?.contentParts[0]).toEqual({ kind: 'text', text: `Original ${OLD} record` })
    expect(current.source.nativeSessionId).toBe(NEW)
    await expect(f.client.sessionHistoryPage(SID, { cursor: old.nextCursor ?? 'wrong-old-window' })).rejects.toBeDefined()
  }
})

it.each(['codex', 'claude'] as const)('keeps %s unknown, child and ambiguous observations non-adoptable with healthy original input', async provider => {
  for (const mode of ['child', 'ambiguous', 'unknown'] as const) {
    const f = await fixture(provider, mode)
    await f.hook()
    const observed = f.client.agentSession(SID)
    expect(observed.nativeSourceObservation?.state).toBe(mode === 'ambiguous' ? 'ambiguous' : 'unknown')
    expect(observed.observedNativeHandle).toBeUndefined(); expect(observed.nativeHandle).toEqual(f.original.nativeHandle)
    await f.client.writeAgent({ agentSessionId: SID, expectedRun: { runId: RUN }, source: 'user', data: 'x' })
    expect(f.input).toHaveBeenCalledOnce()
    const counterfeit = { agentSessionId: SID, expectedRun: { runId: RUN }, expectedNativeHandle: observed.nativeHandle,
      candidateNativeHandle: { kind: 'provider', providerId: provider, sessionId: NEW, transcriptPath: f.currentPath }, expectedObservationAt: observed.nativeSourceObservation!.observedAt, operationId: 'forged-current' }
    const answer = await f.cli(counterfeit)
    expect(answer.code).not.toBe(0); expect(JSON.parse(answer.stderr).error.code).toBe('AGENT_NATIVE_CONFIRMATION_STALE')
  }
})

it.each(['codex', 'claude'] as const)('publishes real %s unknown/ambiguous source facts before their diagnostics', async provider => {
  for (const mode of ['unknown', 'ambiguous'] as const) {
    const f = await fixture(provider, mode)
    const atDiagnostic: unknown[] = []
    f.client.onEvent(event => {
      if (event.type === 'agent-error') atDiagnostic.push(structuredClone(f.client.agentSession(SID)))
    })
    await f.hook()
    expect(f.events.map(event => (event as { type: string }).type)).toEqual(['agent-session', 'agent-error'])
    const state = mode === 'unknown' ? 'unknown' : 'ambiguous'
    expect(atDiagnostic).toHaveLength(1)
    expect(atDiagnostic[0]).toMatchObject({ nativeSourceObservation: { state, run: { runId: RUN } } })
    expect((await loadAgentSessions(f.store))[0]).toMatchObject({ nativeSourceObservation: { state, run: { runId: RUN } } })
    expect(f.events[1]).toMatchObject({ type: 'agent-error', code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED' })
    expect(f.client.agentSession(SID).pendingInteraction).toEqual(f.original.pendingInteraction)
    await f.client.writeAgent({ agentSessionId: SID, expectedRun: { runId: RUN }, source: 'user', data: 'x' })
    expect(f.input).toHaveBeenCalledOnce()
  }
})

it.each(['codex', 'claude'] as const)('retains the real %s save-failure diagnostic without publishing uncommitted source facts', async provider => {
  const f = await fixture(provider, 'unknown'), before = await readFile(join(f.root, 'sessions.json'))
  const failure = Object.assign(new Error('Private native observation save failed'), { code: 'ENOSPC' })
  vi.spyOn(f.store, 'compareAndSwap').mockRejectedValue(failure)
  await expect(f.hook()).rejects.toBe(failure)
  expect(f.events.map(event => (event as { type: string }).type)).toEqual(['agent-error'])
  expect(f.events[0]).toMatchObject({ code: 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED', evidence: { run: { runId: RUN } } })
  expect(f.client.agentSession(SID).nativeSourceObservation).toBeUndefined()
  expect(f.client.agentSession(SID).pendingInteraction).toEqual(f.original.pendingInteraction)
  expect(await readFile(join(f.root, 'sessions.json'))).toEqual(before)
  vi.mocked(f.store.compareAndSwap).mockRestore()
  await f.client.writeAgent({ agentSessionId: SID, expectedRun: { runId: RUN }, source: 'user', data: 'x' })
  expect(f.input).toHaveBeenCalledOnce()
})

it('retains the original stale Hook reason when a real current-main confirmation wins its observation race', async () => {
  const f = await fixture('codex'); await f.hook(); const input = f.confirmation()
  await f.client.refreshAgentSession(SID, { runId: RUN })
  const provider = discoveryProvider(f.client, 'codex'), discover = provider.discoverNativeSession.bind(provider)
  let enter!: () => void, release!: () => void, first = true
  const entered = new Promise<void>(resolve => { enter = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(provider, 'discoverNativeSession').mockImplementation(async (context: any) => {
    const witness = await discover(context)
    if (first) { first = false; enter(); await blocked }
    return witness
  })
  const waiting = f.hook()
  const rejected = expect(waiting).rejects.toMatchObject({ code: 'AGENT_NATIVE_CONFIRMATION_STALE', message: 'Native binding changed while observing its Hook.' })
  try {
    await entered
    const confirmed = await f.client.confirmAgentNativeSession(input)
    expect(confirmed.current).toBe(true)
  } finally { release() }
  await rejected
  const diagnostics = f.events.filter(event => (event as { type: string }).type === 'agent-error')
  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0]).toMatchObject({ code: 'AGENT_NATIVE_CONFIRMATION_STALE', message: 'Native binding changed while observing its Hook.' })
  expect(f.client.agentSession(SID).nativeHandle?.sessionId).toBe(NEW)
  expect(f.client.agentSession(SID).nativeSourceObservation).toBeUndefined()
  expect(f.client.agentSession(SID).nativeConfirmation?.previousInteraction).toEqual(f.original.pendingInteraction)
  await f.client.writeAgent({ agentSessionId: SID, expectedRun: { runId: RUN }, source: 'user', data: 'x' })
  expect(f.input).toHaveBeenCalledOnce()
})

it('rejects exact stale/ABA/Run/locator targets, enforces user confirmation and reconciles save-after-commit without duplicate input', async () => {
  const f = await fixture(); await f.hook(); const input = f.confirmation()
  for (const patch of [{ expectedRun: { runId: 'wrong-run' } }, { expectedObservationAt: input.expectedObservationAt - 1 },
    { candidateNativeHandle: { ...input.candidateNativeHandle, transcriptPath: f.oldPath } }, { expectedNativeHandle: { ...input.expectedNativeHandle, sessionId: 'wrong-old' } }]) {
    const answer = await f.cli({ ...input, ...patch }); expect(answer.code).not.toBe(0)
    expect(f.client.agentSession(SID).nativeHandle?.sessionId).toBe(OLD)
  }
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] })
  await expect(service.call('agent.native.confirm', input)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const old = (await loadAgentSessions(f.store))[0]!, aba = { ...old, nativeSourceObservation: { ...old.nativeSourceObservation!, observedAt: old.updatedAt + 1 }, updatedAt: old.updatedAt + 1 }
  await f.store.compareAndSwap(old, aba); await f.client.refreshAgentSession(SID, { runId: RUN })
  expect((await f.cli(input)).code).not.toBe(0)
  const actual = f.confirmation(), persist = f.store.compareAndSwap.bind(f.store)
  vi.spyOn(f.store, 'compareAndSwap').mockImplementation(async (...args) => { await persist(...args); throw Object.assign(new Error('private fsync outcome'), { code: 'EIO' }) })
  const saved = await f.cli(actual); expect(saved.code).toBe(0); expect(f.input).not.toHaveBeenCalled()
  const corrupt = { ...JSON.parse(saved.stdout).result, persisted: false }
  expect(() => parseRpcNativeResult('agent.native.confirm', corrupt, actual)).toThrow()
})

it('retains binding through failed persistence and process witness replacement; observation cannot auto-rebind via history', async () => {
  const f = await fixture('claude'); await f.hook(); const input = f.confirmation(), before = await readFile(join(f.root, 'sessions.json'))
  vi.spyOn(f.store, 'compareAndSwap').mockRejectedValue(Object.assign(new Error('private save failed'), { code: 'ENOSPC' }))
  expect((await f.cli(input)).code).not.toBe(0); expect(await readFile(join(f.root, 'sessions.json'))).toEqual(before)
  vi.restoreAllMocks(); // Keep this fixture private; restore its Runtime observations below.
  vi.spyOn(f.kernel, 'isConnected').mockReturnValue(true)
  vi.spyOn(f.kernel, 'status').mockResolvedValue(f.run as Awaited<ReturnType<CtxmuxRunAdapter['status']>>)
  const page = await f.client.sessionHistoryPage(SID, { refreshNativeSource: true })
  expect(page.source.nativeSessionId).toBe(OLD); expect(f.client.agentSession(SID).nativeHandle?.sessionId).toBe(OLD)
  const current = f.confirmation()
  await rm(f.currentPath); await writeFile(f.currentPath, '{"type":"user","sessionId":"current-main","isSidechain":false}\n')
  expect((await f.cli(current)).code).not.toBe(0)
  expect(f.client.agentSession(SID).nativeHandle?.sessionId).toBe(OLD)
})

it.each(['unknown', 'changed'] as const)('recovers %s to the exact same retained conversation only after a fresh current-main witness', async state => {
  const f = await fixture('claude', state === 'unknown' ? 'unknown' : 'main')
  await f.hook()
  expect(f.client.agentSession(SID).nativeSourceObservation?.state).toBe(state)
  const operation = f.client.agentSession(SID).pendingInteraction!.response
  const readiness = f.client.agentSession(SID).terminalPromptReadiness
  await f.client.refreshAgentSession(SID, { runId: RUN })
  expect(f.client.agentSession(SID).nativeSourceObservation?.state).toBe(state)
  await f.switchToOld()
  const page = await f.client.sessionHistoryPage(SID, { refreshNativeSource: true })
  expect(page.source.nativeSessionId).toBe(OLD)
  const restored = f.client.agentSession(SID)
  expect(restored.nativeSourceObservation).toBeUndefined(); expect(restored.observedNativeHandle).toBeUndefined()
  expect(restored.nativeHandle).toEqual(f.original.nativeHandle)
  expect(restored.pendingInteraction!.response).toEqual(operation); expect(restored.terminalPromptReadiness).toEqual(readiness)
  expect(restored.nativeBinding?.source).toBe('semantic-resume-target')
  expect(restored.run).toEqual(f.original.run); expect(f.holder.pid).toBe(f.run.pid)
  await expect(Reflect.get(f.client, 'assertNativeInteractionSource').call(f.client, restored)).resolves.toBeUndefined()
  await f.client.writeAgent({ agentSessionId: SID, expectedRun: restored.run, source: 'user', data: 'x' })
  expect(f.input).toHaveBeenCalledOnce()
})

it('retains both same-Run confirmation receipts and reconciles a historical operation without changing the current conversation', async () => {
  const f = await fixture('claude')
  await f.hook()
  const firstInput = f.confirmation('first-confirmation'), first = await f.cli(firstInput)
  expect(first.code).toBe(0)
  const firstReceipt = JSON.parse(first.stdout).result.confirmation
  expect(firstReceipt.previousInteraction).toEqual(f.original.pendingInteraction)
  expect(firstReceipt.previousPromptSubmissionId).toBe('previous-prompt')
  await f.switchToOld()
  await f.hook(OLD)
  const secondInput = f.confirmation('second-confirmation'), second = await f.cli(secondInput)
  expect(second.code).toBe(0)
  const current = f.client.agentSession(SID)
  expect(current.nativeHandle).toEqual(f.original.nativeHandle)
  expect(current.nativeConfirmationHistory).toEqual([firstReceipt])
  expect(current.nativeConfirmation?.operationId).toBe('second-confirmation')
  expect(current.nativeConfirmation?.previousNativeHandle).toEqual(firstInput.candidateNativeHandle)
  expect(current.promptCompletionAdmission).toEqual(f.original.promptCompletionAdmission)
  expect(current.run).toEqual(f.original.run); expect(current.workspacePath).toBe(f.root); expect(f.holder.pid).toBe(f.run.pid)
  const persisted = (await loadAgentSessions(f.store))[0]!
  expect(persisted.nativeConfirmationHistory).toEqual([firstReceipt])
  const inspected = await f.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: SID } })
  expect(inspected.session?.nativeConfirmationHistory).toEqual([firstReceipt])
  expect(inspected.session?.nativeConfirmationHistory?.[0]?.previousInteraction?.response).toMatchObject({
    operationId: 'old-unacknowledged-input', inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false })
  const before = await readFile(join(f.root, 'sessions.json'))
  f.status.mockRejectedValue(new Error('private unavailable runtime observation')); Reflect.set(f.client, 'connected', false)
  const repeated = await f.cli(firstInput)
  expect(repeated.code).toBe(0)
  const result = JSON.parse(repeated.stdout).result
  expect(parseRpcNativeResult('agent.native.confirm', result, firstInput)).toMatchObject({ current: false, persisted: true, confirmation: firstReceipt })
  expect(result.session.nativeHandle).toEqual(f.original.nativeHandle)
  expect(result.session.nativeConfirmation.operationId).toBe('second-confirmation')
  expect(() => parseRpcNativeResult('agent.native.confirm', { ...result, current: true }, firstInput)).toThrow()
  expect(await readFile(join(f.root, 'sessions.json'))).toEqual(before)
  const conflict = await f.cli({ ...firstInput, expectedObservationAt: firstInput.expectedObservationAt + 1 })
  expect(conflict.code).not.toBe(0); expect(JSON.parse(conflict.stderr).error.code).toBe('AGENT_NATIVE_CONFIRMATION_CONFLICT')
  expect(f.input).not.toHaveBeenCalled()
})


it('keeps a readable confirmation unconfirmed until main durability acknowledgement succeeds, without replaying input', async () => {
  const f = await fixture(); await f.hook(); const input = f.confirmation()
  const persist = f.store.compareAndSwap.bind(f.store)
  vi.spyOn(f.store, 'compareAndSwap').mockImplementationOnce(async (...args) => {
    await persist(...args)
    throw new AgentMuxSessionDurabilityError(new DurableWriteError(join(f.root, 'sessions.json'), 'after-replace', new Error('private directory sync failure')))
  })
  const confirmation = vi.spyOn(f.store, 'confirmDurability').mockRejectedValueOnce(new Error('private save still unconfirmed'))
  await expect(f.client.confirmAgentNativeSession(input)).rejects.toThrow('private save still unconfirmed')
  expect(f.client.agentSession(SID).nativeHandle?.sessionId).toBe(NEW)
  expect(f.client.agentSession(SID).run).toEqual({ runId: RUN })
  expect(f.input).not.toHaveBeenCalled()
  await expect(f.client.confirmAgentNativeSession(input)).resolves.toMatchObject({ persisted: true, current: true })
  expect(confirmation).toHaveBeenCalledTimes(2)
  expect(f.input).not.toHaveBeenCalled()
  await f.client.writeAgent({ agentSessionId: SID, expectedRun: { runId: RUN }, source: 'user', data: 'x' })
  expect(f.input).toHaveBeenCalledOnce()
})


it('never replays an older-source submission after an intervening prompt and a second native confirmation', async () => {
  const f = await fixture('claude'); await f.hook()
  await f.client.writeAgent({ agentSessionId: SID, expectedRun: { runId: RUN }, source: 'user', data: 'x' })
  await f.client.confirmAgentNativeSession(f.confirmation('first-source'))
  const first = f.client.agentSession(SID), coordinator = Reflect.get(f.client, 'promptSubmission')
  await coordinator.submitOwnedInputPlan(first, f.run, 'middle-prompt', 'middle body', { kind: 'single-phase', data: 'middle body\r' }, undefined, undefined, true)
  expect(f.client.agentSession(SID).promptCompletionAdmission?.submissionId).toBe('middle-prompt')
  expect(f.input).toHaveBeenCalledTimes(2)
  await f.switchToOld(); await f.hook(OLD)
  await f.client.confirmAgentNativeSession(f.confirmation('second-source'))
  const current = f.client.agentSession(SID)
  expect(current.nativeConfirmation?.previousPromptSubmissionId).toBe('middle-prompt')
  expect(current.nativeConfirmationHistory?.[0]?.previousPromptSubmissionId).toBe('previous-prompt')
  await expect(coordinator.submitOwnedInputPlan(current, f.run, 'previous-prompt', 'original body', { kind: 'single-phase', data: 'original body\r' }))
    .rejects.toMatchObject({ code: 'AGENT_PROMPT_SOURCE_CHANGED' })
  expect(f.input).toHaveBeenCalledTimes(2)
  await f.client.writeAgent({ agentSessionId: SID, expectedRun: current.run, source: 'user', data: 'x' })
  expect(f.input).toHaveBeenCalledTimes(3)
})

it('does not let a late failed history read replace a newly confirmed native source with unknown', async () => {
  const f = await fixture('claude'); await f.hook(); const input = f.confirmation()
  const registry = Reflect.get(f.client, 'registry'), update = registry.update.bind(registry)
  let began!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { began = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(discoveryProvider(f.client, 'claude'), 'discoverNativeSession').mockRejectedValueOnce(new Error('old source discovery failed'))
  vi.spyOn(registry, 'update').mockImplementationOnce(async (...args: unknown[]) => { began(); await hold; return update(...args) })
  const read = f.client.sessionHistoryPage(SID, { refreshNativeSource: true })
  const result = expect(read).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  try {
    await entered
    await f.client.confirmAgentNativeSession(input)
  } finally { release() }
  await result
  const current = f.client.agentSession(SID)
  expect(current.nativeHandle?.sessionId).toBe(NEW)
  expect(current.nativeConfirmation?.operationId).toBe(input.operationId)
  expect(current.nativeSourceObservation).toBeUndefined()
  await f.client.writeAgent({ agentSessionId: SID, expectedRun: current.run, source: 'user', data: 'x' })
  expect(f.input).toHaveBeenCalledOnce()
})

it('reports a failed history-source observation save while retaining readable records and real raw input', async () => {
  const f = await fixture('claude', 'unknown'), before = await readFile(join(f.root, 'sessions.json'))
  const failure = Object.assign(new Error('Private history observation save denied'), { code: 'EACCES' })
  vi.spyOn(f.store, 'compareAndSwap').mockRejectedValueOnce(failure)
  const page = await f.client.sessionHistoryPage(SID, { refreshNativeSource: true })
  expect(page.source.nativeSessionId).toBe(OLD)
  expect(f.events).toHaveLength(1)
  expect(f.events[0]).toMatchObject({ type: 'agent-error', code: 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED',
    evidence: { run: { runId: RUN } }, message: expect.stringContaining(failure.message) })
  expect(f.events[0]).toMatchObject({ message: expect.stringContaining('No unique main native Session was confirmed') })
  expect(await readFile(join(f.root, 'sessions.json'))).toEqual(before)
  expect(f.client.agentSession(SID).nativeHandle).toEqual(f.original.nativeHandle)
  expect(f.client.agentSession(SID).pendingInteraction).toEqual(f.original.pendingInteraction)
  await f.client.writeAgent({ agentSessionId: SID, expectedRun: { runId: RUN }, source: 'user', data: 'x' })
  expect(f.input).toHaveBeenCalledOnce()
})

it('does not publish an old-source persistence diagnostic after another native source is confirmed', async () => {
  const f = await fixture('claude'); await f.hook(); const input = f.confirmation(); f.events.length = 0
  let began!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { began = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(discoveryProvider(f.client, 'claude'), 'discoverNativeSession').mockRejectedValueOnce(new Error('old source discovery failed'))
  vi.spyOn(Reflect.get(f.client, 'registry'), 'update').mockImplementationOnce(async () => {
    began(); await hold
    throw Object.assign(new Error('late old-source save denied'), { code: 'EACCES' })
  })
  const read = f.client.sessionHistoryPage(SID, { refreshNativeSource: true })
  const result = expect(read).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  try {
    await entered
    await f.client.confirmAgentNativeSession(input)
  } finally { release() }
  await result
  expect(f.events.filter(event => (event as { type: string }).type === 'agent-error')).toHaveLength(0)
  const current = f.client.agentSession(SID)
  expect(current.nativeHandle?.sessionId).toBe(NEW)
  expect(current.nativeSourceObservation).toBeUndefined()
  await f.client.writeAgent({ agentSessionId: SID, expectedRun: current.run, source: 'user', data: 'x' })
  expect(f.input).toHaveBeenCalledOnce()
})
