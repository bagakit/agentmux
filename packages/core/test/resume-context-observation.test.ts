import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import * as Source from '../src/index.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const core: typeof Source & Record<string, any> = process.env.AGENTMUX_TEST_RESUME_CONTEXT_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_RESUME_CONTEXT_ENTRY) : { ...Source, ...await import('../src/public-rpc-server.js'), ...await import('../src/hosted-runtime-service.js') }
if (process.env.AGENTMUX_TEST_RESUME_CONTEXT_MUTANT) expect(Reflect.get(core, 'AGENTMUX_RESUME_CONTEXT_MUTANT')).toBe(process.env.AGENTMUX_TEST_RESUME_CONTEXT_MUTANT)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(options: { shape?: 'explicit'; failFirst?: boolean; unsupported?: boolean; callbackFailure?: boolean; witnessPath?: boolean; direct?: boolean; originalPath?: boolean; mutate?: 'context-to-cancel' | 'cancel-to-context' } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-context-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const runtime = join(root, 'runtime'), state = join(root, 'state')
  await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemon.stderr!.on('data', bytes => { daemonError += String(bytes) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    await rm(root, { recursive: true, force: true })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(daemonError) })])
  const actual = new core.AgentProviderRegistry().get('codex')
  const providerId = options.shape ? 'native-observer' : 'codex'
  const reused: any = {}
  const explicitHook: any = { eventNameSource: { kind: 'payload', payloadKey: 'eventName' }, nativeHandle: { sessionIdKeys: ['nativeKey'] }, processNativeIdentity: true,
    resolveSubject: (payload: any, context: any) => ({ kind: payload.nativeKey !== context.processNativeHandle?.sessionId ? 'foreign' : payload.actorScope === 'child' ? 'child' : 'main', basis: 'provider-protocol', nativeSessionId: payload.nativeKey, reason: 'declared-native-subject' }),
    rules: [{ events: ['context_ready'], state: 'working', lifecycleEvent: 'session-start' }, { events: ['intent_cancelled', 'turn_end'], state: 'unknown', lifecycleEvent: 'turn-end' }],
    continuity: (eventName: string, payload: any) => {
      if (options.callbackFailure) throw new Error('Original Provider continuity observation cause')
      const value = eventName === 'context_ready' && payload.recovered === true ? { kind: 'context-restored', nativeSessionId: payload.nativeKey }
        : eventName === 'intent_cancelled' && payload.actor === 'human' && payload.scope === 'recovery-intent' && typeof payload.nativeOperationId === 'string'
          ? { kind: 'explicit-user-cancelled', scope: 'recovery-intent', nativeSessionId: payload.nativeKey, nativeOperationId: payload.nativeOperationId } : undefined
      if (!value || !options.mutate) return value
      Object.assign(reused, value)
      queueMicrotask(() => { reused.kind = options.mutate === 'context-to-cancel' ? 'explicit-user-cancelled' : 'context-restored'; reused.nativeOperationId = 'mutated-operation'; reused.scope = 'recovery-intent' })
      return reused
    } }
  if (options.unsupported) delete explicitHook.continuity
  const program = "const fs=require('node:fs');fs.writeFileSync('native.json',JSON.stringify({pid:process.pid,id:process.argv[1],children:['native-child']}));console.log('LAUNCH:'+JSON.stringify(process.argv.slice(1)));" + (options.failFirst ? "if(!fs.existsSync('failed')){fs.writeFileSync('failed','yes');process.exit(7)}" : '') + "process.stdin.setRawMode(true);process.stdin.on('data',d=>{if(d.toString()==='exit-failed')process.exit(7);process.stdout.write('INPUT:'+d.toString())});setInterval(()=>{},1000)"
  const provider = core.defineAgentProvider({ catalog: { id: providerId, label: 'Controlled native Hook process', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'native', installation: 'unmanaged' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
    buildArgs: (_prompt, args) => [...args], buildResumeArgs: (id, _path, prompt) => ['-e', program, id, ...(prompt ? [prompt] : [])], hook: options.shape ? explicitHook : actual.hook,
    // Controlled machine witness on a real Native PID; this does not claim an actual Codex binary.
    discoverNativeSession: async context => {
      const witness = JSON.parse(await readFile(join(root, 'native.json'), 'utf8'))
      if (witness.pid !== context.processId) return null
      return { handle: { kind: 'provider', providerId, sessionId: witness.id, ...(options.witnessPath ? { transcriptPath: join(root, 'native.json') } : {}) }, childSessionIds: witness.children,
        async assertCurrent() { context.signal.throwIfAborted(); expect(JSON.parse(await readFile(join(root, 'native.json'), 'utf8'))).toEqual(witness) } }
    } })
  const store = new core.AgentMuxFileAgentSessionStore(join(root, 'sessions.sqlite')), client = new core.AgentMuxClient({ store, providers: [provider] }), inner = client as any
  Object.defineProperty(inner.hookServer, 'port', { value: 0 }); await client.connect()
  const nativeStart = inner.kernel.start.bind(inner.kernel), start = vi.spyOn(inner.kernel, 'start'), input = vi.spyOn(inner.kernel, 'input'), stop = vi.spyOn(inner.kernel, 'stop')
  cleanups.push(async () => {
    for (const run of await inner.kernel.list()) if (run.state.type === 'running') {
      try { await inner.kernel.stop(await inner.kernel.prepareStop(run.runId)) }
      catch (error) { if ((await inner.kernel.status(run.runId)).state.type === 'running') throw error }
    }
    await client.dispose()
  })
  const ended = await nativeStart({ operationKey: 'original-seed', program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, env: {} })
  await vi.waitFor(async () => expect((await inner.kernel.status(ended.runId)).state.type).toBe('exited'), { timeout: 5000 })
  const original = { kind: 'agent' as const, agentSessionId: 'original-session', providerId, executorId: 'configured-native', hostId: 'local', workspacePath: root,
    run: { runId: ended.runId }, retiredRuns: [], hookBindingId: 'original-binding', hookToken: 'original-token', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider' as const, providerId, sessionId: 'native-original', ...(options.originalPath ? { transcriptPath: join(root, 'native.json') } : {}) }, semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: _historyFixtureEpoch(0, 0, 1) } }
  await store.compareAndSwap(null, original); await inner.registry.load('local')
  const result = options.direct
    ? { kind: 'resumed', session: await client.resumeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, operationId: 'automatic-root', prompt: 'Original explicit resume input' }) }
    : await client.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: original.run, operationId: 'automatic-root', trigger: 'startup', policy: { retryInitialDelayMs: 20, retryMaxDelayMs: 40 } })
  expect(result.kind).toBe('resumed')
  if (options.failFirst) await vi.waitFor(async () => expect((await store.readMetadata(original.agentSessionId))?.continuityOperations?.['automatic-root']?.supervision).toMatchObject({ attemptCount: 2, process: { state: 'running' } }))
  const current = client.agentSession(original.agentSessionId)
  await vi.waitFor(async () => expect((await client.readRunReplay(current.run)).replay.map(chunk => chunk.data).join('')).toContain('LAUNCH:'))
  const binding = inner.hookBindings.get(current.run.runId)
  const post = async (payload: Record<string, unknown>, receiptId = 'context-receipt', token = binding.endpoint.token) => await fetch(binding.endpoint.url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ receiptId, payload }) })
  const saved = async () => (await store.readMetadata(original.agentSessionId))!
  const rootOf = async () => (await saved()).continuityOperations!['automatic-root']!
  const events: any[] = []; client.onEvent(event => { events.push(event) })
  return { root, store, client, inner, current, original, binding, start, input, stop, post, saved, rootOf, events }
}

it('persists an exact resumed main context through the original authenticated Hook without replaying native first input', async () => {
  const f = await fixture(), before = await f.rootOf()
  expect(before.launchInput!.state).toBe('launch-carried'); expect(before.supervision!.contextEvidence).toBeUndefined()
  expect((await f.post({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'native-original' })).status).toBe(204)
  const root = await f.rootOf()
  expect(root.supervision!.contextEvidence).toMatchObject({ source: 'native-hook', run: f.current.run, nativeTarget: f.original.nativeHandle, hookReceiptId: 'context-receipt' })
  expect((await f.saved()).hookReceipt).toMatchObject({ id: 'context-receipt', subject: { kind: 'main' } })
  expect(root.launchInput).toEqual(before.launchInput)
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

const resumed = { hook_event_name: 'SessionStart', source: 'resume', session_id: 'native-original' }
const ready = { eventName: 'context_ready', recovered: true, nativeKey: 'native-original' }
const cancelled = { eventName: 'intent_cancelled', actor: 'human', scope: 'recovery-intent', nativeOperationId: 'native-cancel', nativeKey: 'native-original' }
async function raw(f: Awaited<ReturnType<typeof fixture>>) {
  await f.client.writeAgent({ agentSessionId: f.current.agentSessionId, expectedRun: f.current.run, source: 'user', data: 'still-working' })
  await vi.waitFor(async () => expect((await f.client.readRunReplay(f.current.run)).replay.map(chunk => chunk.data).join('')).toContain('INPUT:still-working'))
}

it('withholds resume context from other Codex sources while retaining the original main Hook receipt', async () => {
  const f = await fixture()
  for (const [index, source] of ['startup', 'clear', 'compact', 'fork', undefined].entries()) {
    const id = 'source-' + index
    expect((await f.post({ ...resumed, source }, id)).status).toBe(204)
    expect((await f.rootOf()).supervision!.contextEvidence).toBeUndefined()
    expect((await f.saved()).hookReceipt).toMatchObject({ id, subject: { kind: 'main' } })
    expect((await f.saved()).semanticStatus?.state).toBe('working')
  }
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); await raw(f)
})
it('requires the native resume source on the original payload rather than a flattened auxiliary object', async () => {
  const f = await fixture()
  expect((await f.post({ ...resumed, source: undefined, extra: { source: 'resume' } })).status).toBe(204)
  expect((await f.rootOf()).supervision!.contextEvidence).toBeUndefined()
  expect((await f.saved()).hookReceipt?.id).toBe('context-receipt'); await raw(f)
})
it('keeps child and foreign native subjects outside the recovery fact boundary', async () => {
  const f = await fixture()
  for (const [index, payload] of [{ ...resumed, agent_id: 'native-child' }, { ...resumed, session_id: 'native-foreign' }].entries()) {
    expect((await f.post(payload, 'subject-' + index)).status).toBe(204)
    expect((await f.rootOf()).supervision!.contextEvidence).toBeUndefined()
    expect((await f.saved()).hookReceipt?.subject?.kind).not.toBe('main')
  }
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); await raw(f)
})
it('rejects an old Hook token and ignores an authenticated old Run without revoking current raw input', async () => {
  const f = await fixture(), before = await f.saved()
  expect((await f.post(resumed, 'old-token', 'old-token')).status).toBe(403)
  const old = f.inner.hookServer.createBinding(f.original.agentSessionId, 'codex'); await old.bindRun(f.original.run.runId)
  expect((await fetch(old.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${old.endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId: 'old-run', payload: resumed }) })).status).toBe(204)
  await old.close()
  expect((await f.rootOf()).supervision!.contextEvidence).toBeUndefined()
  expect((await f.saved()).hookReceipt).toEqual(before.hookReceipt); await raw(f)
})
it('does not interpret Codex Interrupt or internal compaction interruption as cancellation of the recovery intent', async () => {
  const f = await fixture()
  expect((await f.post({ hook_event_name: 'Interrupt', session_id: 'native-original', turn_id: 'compact-turn' }, 'internal-interrupt')).status).toBe(204)
  const root = await f.rootOf()
  expect(root.supervision!.cancellation).toBeUndefined(); expect(root.supervision!.phase).not.toBe('cancelled')
  expect((await f.saved()).hookReceipt).toMatchObject({ id: 'internal-interrupt', lifecycleEvent: 'turn-end', subject: { kind: 'main' } })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); await raw(f)
})
it('attributes a verified context event to the exact active child attempt of its original intent', async () => {
  const f = await fixture({ failFirst: true })
  expect((await f.post(resumed)).status).toBe(204)
  const root = await f.rootOf(), current = await f.saved(), child = current.continuityOperations![root.supervision!.activeAttemptOperationId]!
  expect(child.intentOperationId).toBe('automatic-root'); expect(child.newRun).toEqual(f.current.run)
  expect(root.supervision!.contextEvidence?.run).toEqual(child.newRun)
  expect(root.newRun).not.toEqual(child.newRun); expect(child.launchInput).toBeUndefined()
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})
it('does not attribute a valid Hook to a superseded root attempt', async () => {
  const f = await fixture()
  await f.inner.registry.update(f.current.agentSessionId, f.current.run, (session: any) => {
    const root = session.continuityOperations['automatic-root']
    return { ...session, continuityOperations: { ...session.continuityOperations, 'automatic-root': { ...root,
      supervision: { ...root.supervision, activeAttemptOperationId: 'foreign-attempt' } },
      'foreign-attempt': { ...root, operationId: 'foreign-attempt', supervision: undefined, launchInput: undefined, recoveryDelivery: undefined,
        intentOperationId: 'automatic-root', newRun: { runId: 'foreign-run' } } } }
  })
  expect((await f.post(resumed)).status).toBe(204)
  expect((await f.rootOf()).supervision!.contextEvidence).toBeUndefined()
  expect((await f.saved()).hookReceipt?.id).toBe('context-receipt'); expect(f.start).toHaveBeenCalledTimes(1)
})
it('uses a second explicit native protocol to persist cancellation and keep it above later context evidence', async () => {
  const f = await fixture({ shape: 'explicit' })
  expect((await f.post(cancelled, 'native-cancellation')).status).toBe(204)
  const before = await f.rootOf()
  expect(before.supervision).toMatchObject({ phase: 'cancelled', cancellation: { source: 'native-hook', operationId: 'native-cancel', hookReceiptId: 'native-cancellation', run: f.current.run, nativeTarget: f.original.nativeHandle } })
  expect((await f.post(ready, 'late-context')).status).toBe(204)
  expect((await f.rootOf()).supervision).toEqual(before.supervision)
  expect((await f.saved()).hookReceipt?.id).toBe('late-context')
  expect((await f.saved()).semanticStatus?.state).toBe('working')
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); await raw(f)
})
it('keeps an exact explicit cancellation authoritative after context observation already settled', async () => {
  const f = await fixture({ shape: 'explicit' })
  expect((await f.post(ready, 'ready-first')).status).toBe(204)
  await vi.waitFor(async () => expect((await f.rootOf()).supervision!.phase).toBe('settled'))
  expect((await f.post(cancelled, 'cancel-later')).status).toBe(204)
  expect((await f.rootOf()).supervision).toMatchObject({ phase: 'cancelled', contextEvidence: { hookReceiptId: 'ready-first' }, cancellation: { hookReceiptId: 'cancel-later', operationId: 'native-cancel' } })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
})
it('withholds cancellation for ambiguous actor, scope and turn-end facts without consuming their original receipts', async () => {
  const f = await fixture({ shape: 'explicit' })
  for (const [index, payload] of [{ ...cancelled, actor: 'system' }, { ...cancelled, scope: 'turn' }, { ...cancelled, nativeOperationId: undefined },
    { eventName: 'turn_end', nativeKey: 'native-original', reason: 'interrupted' }].entries()) {
    const id = 'ambiguous-' + index
    expect((await f.post(payload, id)).status).toBe(204)
    expect((await f.rootOf()).supervision!.cancellation).toBeUndefined()
    expect((await f.saved()).hookReceipt?.id).toBe(id)
  }
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); await raw(f)
})
it('retains normal Hook activity and healthy input when this Provider has no context contribution', async () => {
  const f = await fixture({ shape: 'explicit', unsupported: true })
  expect((await f.post(ready)).status).toBe(204)
  expect((await f.rootOf()).supervision!.contextEvidence).toBeUndefined()
  expect((await f.saved()).hookReceipt?.id).toBe('context-receipt'); expect((await f.saved()).semanticStatus?.state).toBe('working')
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); await raw(f)
})
it('retains the original Hook receipt and activity when its optional continuity projection throws', async () => {
  const f = await fixture({ shape: 'explicit', callbackFailure: true })
  expect((await f.post(ready, 'projection-failure')).status).toBe(204)
  expect((await f.rootOf()).supervision!.contextEvidence).toBeUndefined()
  expect((await f.saved()).hookReceipt?.id).toBe('projection-failure'); expect((await f.saved()).semanticStatus?.state).toBe('working')
  expect(f.events.some(event => event.type === 'agent-error' && event.code === 'AGENT_CONTINUITY_HOOK_UNCONFIRMED' &&
    event.evidence?.hookReceiptId === 'projection-failure' && event.message.includes('Original Provider continuity observation cause'))).toBe(true)
  await raw(f)
})
it('snapshots context evidence before a Provider reuses its return object as cancellation', async () => {
  const f = await fixture({ shape: 'explicit', mutate: 'context-to-cancel' })
  expect((await f.post(ready, 'frozen-context')).status).toBe(204)
  expect((await f.rootOf()).supervision!.contextEvidence).toMatchObject({ hookReceiptId: 'frozen-context' })
  expect((await f.rootOf()).supervision!.cancellation).toBeUndefined()
  expect((await f.saved()).hookReceipt?.id).toBe('frozen-context')
})
it('snapshots original cancellation identity before a Provider reuses its return object as context', async () => {
  const f = await fixture({ shape: 'explicit', mutate: 'cancel-to-context' })
  expect((await f.post(cancelled, 'frozen-cancellation')).status).toBe(204)
  expect((await f.rootOf()).supervision).toMatchObject({ phase: 'cancelled', cancellation: { operationId: 'native-cancel', hookReceiptId: 'frozen-cancellation' } })
  expect((await f.rootOf()).supervision!.contextEvidence).toBeUndefined()
  expect((await f.saved()).hookReceipt?.id).toBe('frozen-cancellation')
})


it('accepts a verified first locator enrichment without changing the frozen native target or first input', async () => {
  const f = await fixture({ witnessPath: true }), before = await f.rootOf()
  expect((await f.post(resumed)).status).toBe(204)
  await vi.waitFor(async () => expect((await f.rootOf()).supervision).toMatchObject({ phase: 'settled', reason: 'context-observed' }))
  const saved = await f.saved(), root = await f.rootOf()
  expect(saved.nativeHandle).toMatchObject({ ...f.original.nativeHandle, transcriptPath: join(f.root, 'native.json') })
  expect(root.nativeTarget).toEqual(f.original.nativeHandle)
  expect(root.supervision!.contextEvidence!.nativeTarget).toEqual(saved.nativeHandle)
  expect(root.launchInput).toEqual(before.launchInput)
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); await raw(f)
  // The recovery intent completes at verified context, rather than guarding later task execution.
  await f.client.writeAgent({ agentSessionId: f.current.agentSessionId, expectedRun: f.current.run, source: 'user', data: 'exit-failed' })
  await vi.waitFor(async () => expect((await f.inner.kernel.status(f.current.run.runId)).state.type).toBe('exited'))
  await f.client.refreshAgentSession(f.current.agentSessionId, f.current.run)
  await f.inner.continuitySupervisor.serialize(f.current.agentSessionId, async () => {})
  expect((await f.rootOf()).supervision).toMatchObject({ phase: 'settled', reason: 'context-observed', attemptCount: 1 })
  expect(f.start).toHaveBeenCalledTimes(1)
})

it('retains the same native intent through locator enrichment and an exact failed Run retry', async () => {
  const f = await fixture({ witnessPath: true })
  expect((await f.post({ ...resumed, source: 'startup' })).status).toBe(204)
  expect((await f.saved()).nativeHandle).toHaveProperty('transcriptPath', join(f.root, 'native.json'))
  await f.client.writeAgent({ agentSessionId: f.current.agentSessionId, expectedRun: f.current.run, source: 'user', data: 'exit-failed' })
  await vi.waitFor(async () => expect((await f.rootOf()).supervision).toMatchObject({ attemptCount: 2, process: { state: 'running' } }), { timeout: 5000 })
  const root = await f.rootOf(), active = (await f.saved()).continuityOperations![root.supervision!.activeAttemptOperationId]!
  expect(root.nativeTarget).toEqual(f.original.nativeHandle)
  expect(active.nativeTarget).toEqual((await f.saved()).nativeHandle)
  expect(active.launchInput).toBeUndefined(); expect(active.recoveryDelivery).toBeUndefined()
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.input).toHaveBeenCalledTimes(1)
})


it.each(['provider', 'session', 'path-change', 'path-removal'] as const)('withholds recovery facts for a changed known native target: %s', async change => {
  const f = await fixture({ witnessPath: change !== 'path-removal' })
  await f.inner.registry.update(f.current.agentSessionId, f.current.run, (saved: any) => {
    const root = saved.continuityOperations['automatic-root']
    const target = { ...root.nativeTarget, ...(change === 'provider' ? { providerId: 'another-provider' } :
      change === 'session' ? { sessionId: 'another-native-session' } : { transcriptPath: join(f.root, 'known-original.json') }) }
    const changed = { ...root, nativeTarget: target }
    return { ...saved, continuity: changed, continuityOperations: { ...saved.continuityOperations, [root.operationId]: changed } }
  })
  expect((await f.post(resumed)).status).toBe(204)
  expect((await f.rootOf()).supervision!.contextEvidence).toBeUndefined()
  expect((await f.saved()).hookReceipt).toMatchObject({ id: 'context-receipt', subject: { kind: 'main' } })
  await f.client.refreshAgentSession(f.current.agentSessionId, f.current.run)
  await vi.waitFor(async () => expect((await f.rootOf()).supervision).toMatchObject({ phase: 'paused', reason: 'original-target-changed' }))
  expect(f.start).toHaveBeenCalledTimes(1); await raw(f)
})

it('retains full verified locator provenance on explicit native cancellation', async () => {
  const f = await fixture({ shape: 'explicit', witnessPath: true })
  expect((await f.post(cancelled, 'full-cancellation')).status).toBe(204)
  const root = await f.rootOf()
  expect(root.supervision).toMatchObject({ phase: 'cancelled', cancellation: { hookReceiptId: 'full-cancellation', nativeTarget: (await f.saved()).nativeHandle } })
  expect(root.supervision!.cancellation!.nativeTarget).toHaveProperty('transcriptPath', join(f.root, 'native.json'))
  expect(root.nativeTarget).toEqual(f.original.nativeHandle); await raw(f)
})

it('publishes original Hook evidence through Hosted and existing actual inspect and refresh CLI consumers', async () => {
  if (!process.env.AGENTMUX_TEST_OBJECT_CLI) throw new Error('This public proof requires the source-bound compiled CLI gate entry.')
  const f = await fixture({ shape: 'explicit', witnessPath: true }), hosted = new core.AgentMuxHostedRuntimeService(f.client, f.store.path, () => ({ runtimeId: 'context-runtime', ownerInstanceId: 'context-owner', protocolVersion: 2,
    processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const reader = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => reader.dispose())
  expect((await f.post(ready)).status).toBe(204)
  await vi.waitFor(() => expect(reader.agentSession(f.current.agentSessionId).continuityOperations!['automatic-root']!.supervision!.contextEvidence).toMatchObject({ hookReceiptId: 'context-receipt' }))
  const inspected = await runCompiledObjectCli(['agent', 'inspect', '--session', f.original.agentSessionId], objectCliEnvironment(f.root))
  expect(inspected.code, inspected.stderr).toBe(0)
  const facts = JSON.parse(inspected.stdout).result.session, root = facts.continuityOperations['automatic-root']
  expect(root.supervision.contextEvidence).toMatchObject({ run: f.current.run, nativeTarget: facts.nativeHandle, hookReceiptId: 'context-receipt' })
  expect(root.launchInput.state).toBe('launch-carried')
  expect((await f.post(cancelled, 'public-cancellation')).status).toBe(204)
  const refreshed = await runCompiledObjectCli(['agent', 'refresh', '--session', f.original.agentSessionId], objectCliEnvironment(f.root))
  expect(refreshed.code, refreshed.stderr).toBe(0)
  expect(JSON.parse(refreshed.stdout).result.session.continuityOperations['automatic-root'].supervision).toMatchObject({ phase: 'cancelled', cancellation: { operationId: 'native-cancel', hookReceiptId: 'public-cancellation' } })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})


it('reads the original explicit resume receipt after a verified first locator enrichment without replaying Start or input', async () => {
  const f = await fixture({ witnessPath: true, direct: true }), before = await f.rootOf()
  const request = { agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, operationId: 'automatic-root', prompt: 'Original explicit resume input' }
  expect((await f.post(resumed)).status).toBe(204)
  expect((await f.saved()).nativeHandle).toHaveProperty('transcriptPath', join(f.root, 'native.json'))
  await expect(f.client.resumeAgent(request)).resolves.toMatchObject({ run: f.current.run })
  await expect(f.client.resumeAgent({ ...request, prompt: 'Another explicit input' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect((await f.rootOf()).nativeTarget).toEqual(f.original.nativeHandle)
  expect((await f.rootOf()).launchInput).toEqual(before.launchInput)
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); await raw(f)
})

it('refuses a changed known locator when reading an original explicit resume receipt while retaining its healthy Run', async () => {
  const f = await fixture({ witnessPath: true, direct: true, originalPath: true }), before = await f.rootOf()
  await f.inner.registry.update(f.current.agentSessionId, f.current.run, (saved: any) => ({ ...saved, nativeHandle: { ...saved.nativeHandle, transcriptPath: join(f.root, 'another-native.json') } }))
  await expect(f.client.resumeAgent({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, operationId: 'automatic-root', prompt: 'Original explicit resume input' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect((await f.rootOf()).nativeTarget).toEqual(before.nativeTarget)
  expect((await f.rootOf()).launchInput).toEqual(before.launchInput)
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); await raw(f)
})
