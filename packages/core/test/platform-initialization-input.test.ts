import { afterEach, expect, it, vi } from 'vitest'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createMoteConversationStartFixture } from '../../../apps/host/test/helpers/mote-conversation-start-fixture.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { parseAgentInputSubmissionReceipt } from '../src/agent-input-receipt-codec.js'
import { readGrokInputInitialization } from '../src/providers/grok-input-initialization.js'
import { captureExecutorInvocation } from '../src/agent-executor-invocation.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '../src/agent-session-recovery/continuity-contract.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import type { AgentProviderInputInitialization, AgentProviderInputInitializationContext } from '../src/index.js'
import { withAgentInputClaimLease } from '../src/agent-input-claim-lease.js'
import type { AgentInputWaitReason } from '../src/agent-input-wait.js'
import { AgentMuxError } from '../src/index.js'
import { initializeInputWaitingIndex } from '../src/agent-message-journal.js'
import { parseAgentInputMailboxPage } from '../src/agent-input-mailbox-codec.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

function initialization(wait: AgentInputWaitReason | undefined) {
  return wait && 'initialization' in wait ? wait.initialization : undefined
}

async function nativeInspect(root: string) {
  const command = join(root, 'grok-protocol'), log = join(root, 'inspect-invocations.jsonl'), state = join(root, 'native-config.json')
  await writeFile(state, JSON.stringify({ cwd: root, projectTrusted: false, hooks: [] }))
  await writeFile(command, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),profile:process.env.ORIGINAL_NATIVE_PROFILE,home:process.env.HOME,nativeHome:process.env.GROK_HOME})+'\\n');process.stdout.write(fs.readFileSync(path.join(process.env.GROK_HOME||path.join(process.env.HOME,'.grok'),'native-config.json')));\n`)
  await chmod(command, 0o700)
  return { command, log, state }
}

it.each(['first-query', 'handover-query'] as const)('actual Mote setup keeps %s on original Core waiting inputs before native trust', async mode => {
  const f = await createMoteConversationStartFixture({ providerId: 'grok' }); closes.push(f.close)
  const native = await nativeInspect(f.h.root)
  await f.h.client.configureHostExecutor({ executorId: 'saved', config: { label: 'Private native', providerId: 'grok', command: native.command,
    args: [], env: { HOME: f.h.root, GROK_HOME: f.h.root }, injectAgentMuxGuide: false } })
  f.h.inner.kernel.readRunEnvironment = vi.fn(async (runId: string) => {
    const launched = f.h.started[Number(runId.replace('fixture-run-', ''))]
    return launched ? { HOME: f.h.root, GROK_HOME: f.h.root } : undefined
  })
  const status = f.h.inner.kernel.status
  f.h.inner.kernel.status = vi.fn(async (runId: string) => ({ ...await status(runId), pid: 20123 }))
  if (mode === 'handover-query') {
    await f.start('original-before-handover')
    await f.setup('original-before-handover')
  }
  const opened = await f.start('initialization-mote-original', 'Original first Query A', mode === 'handover-query')
  await writeFile(native.state, JSON.stringify({ cwd: opened.agent!.cwd, projectTrusted: false, hooks: [] }))
  const first = await f.setup('initialization-mote-original')
  expect(first.creation).toBe('confirmed'); expect(first.binding).toBe('confirmed')
  const key = first.record!.moteMainFollowUps!.deferredInputKey!
  await f.h.inner.inputWaitingRecipients.get(key.agentSessionId)?.pending
  expect(f.h.inner.kernel.input).not.toHaveBeenCalled(); expect(f.h.rawInput).not.toHaveBeenCalled()
  await vi.waitFor(async () => expect((await f.h.client.inspectAgentInput({ key }))?.control.waiting).toMatchObject({
    phase: 'session', reason: 'native-session-starting', wake: 'session-restored',
    initialization: { state: 'pending', reason: 'directory-trust', source: 'native-protocol', scope: 'prerequisite',
      providerId: 'grok', run: key.expectedRun, purpose: 'conversation-start' }
  }))
  const held = (await f.h.client.inspectAgentInput({ key }))!
  expect(initialization(held.control.waiting)).toMatchObject({ state: 'pending', reason: 'directory-trust', observedAt: expect.any(Number) })
  expect(held.admission).toBeNull()
  expect(parseAgentInputSubmissionReceipt(JSON.parse(JSON.stringify(held)))).toEqual(held)
  expect((await f.setup('initialization-mote-original', false)).deferredInput?.input?.status).toBe('waiting')
  expect(f.h.inner.kernel.input).not.toHaveBeenCalled(); expect(f.h.rawInput).not.toHaveBeenCalled()
  expect(await f.h.client.inspectAgentPromptSubmission(key)).toBeNull()
  // Revisit and another setup inspect never change the original producer or dispatch.
  expect((await f.setup('initialization-mote-original', false)).record!.moteMainFollowUps!.deferredInputKey).toEqual(key)
  expect(f.h.started).toHaveLength(mode === 'handover-query' ? 2 : 1)
  if (mode === 'handover-query') {
    const handover = (await f.setup('initialization-mote-original', false)).handoverInput!
    expect(handover.input?.status).toBe('waiting')
    expect(handover.record).toBeNull()
    expect(handover.route!.key.submissionId).toMatch(/^mote-main-handover-/u)
  }
  const invocation = JSON.parse((await readFile(native.log, 'utf8')).trim().split('\n')[0]!)
  expect(invocation.args).toEqual(['inspect', '--json']); expect(invocation.cwd).toBe(await realpath(first.record!.execution.workspacePath))
  expect(f.h.inner.kernel.readRunEnvironment).toHaveBeenCalledWith(key.expectedRun.runId, expect.any(AbortSignal))
})

async function startingFixture(reason: 'first-start' | 'post-resume') {
  const f = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: 'grok', executorId: 'grok' })); closes.push(f.close)
  const native = await nativeInspect(f.root), current = (await f.store.readMetadata('recipient'))!
  const source = captureExecutorInvocation('grok', 'grok', 'original-create', 'b'.repeat(64), { env: { HOME: f.root, GROK_HOME: f.root, ORIGINAL_NATIVE_PROFILE: 'creation-configuration-only' } })!
  const record: AgentMuxStoredAgentSession = { ...current,
    creation: { createOperationId: 'original-create', createdRun: reason === 'first-start' ? current.run : { runId: 'previous-run' },
      initialPrompt: 'not-requested', intentDigest: 'b'.repeat(64), executorInvocationDigest: source.digest }, executorInvocation: source.value }
  if (reason === 'post-resume') record.continuity = { operationId: 'original-resume', agentSessionId: current.agentSessionId,
    trigger: 'manual', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, reason: 'original-native-context',
    admittedAt: 1, rechecks: 0, kind: 'resumed', previousRun: { runId: 'previous-run' }, newRun: current.run, observedAt: 1,
    nativeTarget: { kind: 'provider', providerId: 'grok', sessionId: 'original-native' }, evidence: { kind: 'run-running', observedAt: 1 } }
  if (reason === 'post-resume') record.continuityExecutors = { 'original-resume': { source: 'sdk', providerId: 'grok', executorId: 'grok', options: { env: { HOME: f.root, GROK_HOME: f.root, ORIGINAL_NATIVE_PROFILE: 'resume-configuration-only' } } } }
  await f.store.compareAndSwapMetadata(current, record)
  const inner = f.client as any; await inner.registry.refresh(current.agentSessionId, current.run)
  inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), program: native.command, pid: 20124 }))
  const environment = { HOME: f.root, GROK_HOME: f.root, ORIGINAL_NATIVE_PROFILE: reason === 'post-resume' ? 'original-resume-profile' : 'original-profile' }
  inner.kernel.readRunEnvironment = vi.fn(async (runId: string) => runId === current.run.runId ? environment : undefined)
  return { ...f, native, inner, key: (id: string) => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: current.run, submissionId: id }) }
}

it('restorable conversation positions and mailbox retain only original sustainable local authority', async () => {
  const f = await startingFixture('first-start')
  const submit = async (id: string, authorHuman: boolean, restricted = false) => f.client.submitAgentPrompt({
    agentSessionId: 'recipient', expectedRun: f.key(id).expectedRun, operationId: id, prompt: 'Original ' + id,
    admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman
  }, restricted ? { assertCurrent: async () => {} } : undefined)
  await submit('local-conversation', true)
  await submit('nonhuman-conversation', false)
  await submit('restricted-conversation', true, true)
  await f.inner.inputWaitingRecipients.get('recipient')?.pending
  const queue = f.inner.messageQueue
  const keys = async () => (await queue.readRestorablePromptInputs()).map((entry: { intent: { key: unknown } }) => entry.intent.key)
  expect(await keys()).toEqual([f.key('local-conversation')])
  // The rebuild and incremental index must select the same original records.
  await queue.withLock(async () => {
    queue.db.exec('DROP TABLE input_waiting')
    initializeInputWaitingIndex(queue.db)
  })
  expect(await keys()).toEqual([f.key('local-conversation')])
  const request = { agentSessionId: 'recipient' }
  const page = await f.client.readAgentInputMailbox(request)
  expect(page.items).toHaveLength(3)
  expect(parseAgentInputMailboxPage(JSON.parse(JSON.stringify(page)), request)).toEqual(page)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('same-Run local conversation recovery grants no cross-Run semantic continuation', async () => {
  const f = await startingFixture('first-start'), current = (await f.store.readMetadata('recipient'))!
  const nativeHandle = { kind: 'provider' as const, providerId: 'grok', sessionId: 'original-native' }
  await f.store.compareAndSwapMetadata(current, { ...current, nativeHandle })
  await f.inner.registry.refresh('recipient', current.run)
  const key = f.key('local-conversation-fixed-run')
  await f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: key.expectedRun, operationId: key.submissionId,
    prompt: 'Original fixed-Run conversation', admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key }))?.control.waiting).toMatchObject({ phase: 'session', reason: 'native-session-starting', initialization: { state: 'pending', reason: 'directory-trust', source: 'native-protocol', scope: 'prerequisite' } }), { timeout: 6000 })
  const original = (await f.store.readMetadata('recipient'))!, nextRun = { runId: 'next-semantic-run' }, at = original.updatedAt + 1
  await f.store.compareAndSwapMetadata(original, { ...original, run: nextRun, retiredRuns: [...original.retiredRuns, original.run],
    nativeBinding: { source: 'semantic-resume-target', run: nextRun, observedAt: at }, updatedAt: at,
    continuity: { operationId: 'native-resume', agentSessionId: 'recipient', trigger: 'manual', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY },
      reason: 'original-native-context', admittedAt: at, observedAt: at, rechecks: 0, kind: 'resumed', previousRun: original.run,
      newRun: nextRun, nativeTarget: nativeHandle, evidence: { kind: 'run-running', observedAt: at } } })
  // An independently ready frontend removes initialization as an alternate
  // refusal, so this counterexample specifically proves the original Run fence.
  f.inner.terminalFrontendWatches.set('recipient', { key: JSON.stringify([nextRun.runId, undefined]), controller: new AbortController(),
    pending: Promise.resolve(true), failures: 0, ready: new Set(), frontend: { state: 'ready', run: nextRun, initialization: { phase: 'ready' } } })
  await f.inner.registry.refresh('recipient', nextRun); f.inner.publishSession(f.inner.registry.get('recipient'))
  await f.inner.inputWaitingRecipients.get('recipient')?.pending
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const retained = (await f.client.inspectAgentInput({ key }))!
  expect(retained.key).toEqual(key); expect(retained.admission).toBeNull()
  expect(retained.control.deliveryKey).toBeUndefined()
})

it('post-resume login keeps the original input waiting while native/manual healthy paths remain usable', async () => {
  const f = await startingFixture('post-resume'), provider = f.client.providers.get('grok')
  const account = join(f.root, 'native-account-protocol.json')
  await writeFile(account, JSON.stringify({ account: { state: 'login-required' } }))
  // A Provider contribution consuming another native machine protocol through
  // the public SDK types; Core never learns this account protocol's fields.
  const observed = vi.fn(async (context: AgentProviderInputInitializationContext): Promise<AgentProviderInputInitialization> => {
    expect(context.env).toEqual({ HOME: f.root, GROK_HOME: f.root, ORIGINAL_NATIVE_PROFILE: 'original-resume-profile' })
    const value = JSON.parse(await readFile(account, 'utf8'))
    return value.account.state === 'login-required' ? { state: 'pending', reason: 'authentication', source: 'native-protocol', scope: 'prerequisite' }
      : { state: 'unknown', reason: 'native-input-unconfirmed', source: 'unavailable', scope: 'unknown' }
  })
  f.client.providers.replace({ ...provider, readInputInitialization: observed })
  const submit = (operationId: string, kind: 'session-conversation' | 'manual-actor' = 'session-conversation') => f.client.submitAgentPrompt({
    agentSessionId: 'recipient', expectedRun: f.key(operationId).expectedRun, operationId, prompt: 'Original ' + operationId,
    execution: 'immediate', admissionIntent: { kind }, authorHuman: true })
  await submit('original-resumed-Q')
  await f.inner.inputWaitingRecipients.get('recipient')?.pending
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: f.key('original-resumed-Q') }))?.control.waiting).toMatchObject({ phase: 'session', reason: 'native-session-starting', initialization: { state: 'pending', reason: 'authentication', source: 'native-protocol', scope: 'prerequisite' } }))
  expect(await f.client.inspectAgentPromptSubmission(f.key('original-resumed-Q'))).toBeNull()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await submit('manual-original', 'manual-actor')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalled())
  const readsAfterManual = observed.mock.calls.length
  // A positive current native source stays independent of the optional diagnostic reader.
  const current = (await f.store.readMetadata('recipient'))!, at = current.updatedAt + 1
  await f.store.compareAndSwapMetadata(current, { ...current, nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: 'original-native' },
    nativeBinding: { source: 'native-hook', run: current.run, observedAt: at }, updatedAt: at })
  await f.inner.registry.refresh('recipient', current.run)
  await submit('healthy-current-Q')
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: f.key('healthy-current-Q') }))?.status).toBe('terminal-confirmed'))
  expect(observed).toHaveBeenCalledTimes(readsAfterManual)
  expect((await f.client.inspectAgentInput({ key: f.key('original-resumed-Q') }))?.key).toEqual(f.key('original-resumed-Q'))
})

it('native trust config true or hooks present cannot manufacture a first input channel', async () => {
  const f = await startingFixture('first-start')
  await writeFile(f.native.state, JSON.stringify({ cwd: f.root, projectTrusted: true, hooks: [{ event: 'SessionStart' }] }))
  await f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: f.key('original-A').expectedRun,
    operationId: 'original-A', prompt: 'Original retained A', admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: f.key('original-A') }))?.control.waiting).toMatchObject({ phase: 'session', reason: 'native-session-starting', initialization: { state: 'unknown', reason: 'native-input-unconfirmed', source: 'unavailable', scope: 'unknown' } }), { timeout: 6000 })
  expect(await f.client.inspectAgentPromptSubmission(f.key('original-A'))).toBeNull()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const invocation = JSON.parse((await readFile(f.native.log, 'utf8')).trim().split('\n')[0]!)
  expect(invocation.profile).toBe('original-profile')
})

it('missing original Runtime environment remains unknown without borrowing current Host defaults or executor overrides', async () => {
  const f = await startingFixture('first-start'), key = f.key('original-environment-unknown')
  vi.stubEnv('HOME', join(f.root, 'unrelated-host-home'))
  vi.stubEnv('GROK_HOME', join(f.root, 'unrelated-host-grok'))
  const reader = vi.spyOn(f.client.providers.get('grok'), 'readInputInitialization')
  f.inner.kernel.readRunEnvironment = vi.fn(async (runId: string) => { expect(runId).toBe(key.expectedRun.runId); return undefined })
  await f.client.submitAgentPrompt({ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId: key.submissionId,
    prompt: 'Retain original environment-unknown input', admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key }))?.control.waiting).toMatchObject({
    phase: 'service', reason: 'observation-failed', wake: 'session-restored',
    initialization: { state: 'unknown', reason: 'inspection-unavailable', source: 'unavailable', scope: 'unknown',
      providerId: 'grok', run: key.expectedRun, purpose: 'conversation-start' }
  }))
  expect(reader).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.client.inspectAgentInput({ key }))?.key).toEqual(key)
  await expect(readFile(f.native.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await f.client.submitAgentPrompt({ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId: 'original-environment-manual',
    prompt: 'Explicit original manual action', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(1))
})

it('Grok inspect preserves original argv/env and refuses input-bearing or unknown invocation forms', async () => {
  const f = await startingFixture('first-start'), context = { command: f.native.command, args: ['--model', 'private-model'],
    env: { HOME: f.root, GROK_HOME: f.root, ORIGINAL_NATIVE_PROFILE: 'private-original' }, workspacePath: f.root, processId: 20124, run: { runId: 'run-recipient' },
    agentSessionId: 'recipient', purpose: 'initial-input' as const }
  vi.stubEnv('HOME', join(f.root, 'unrelated-current-home')); vi.stubEnv('GROK_HOME', join(f.root, 'unrelated-current-native-home'))
  expect(await readGrokInputInitialization(context)).toEqual({ state: 'pending', reason: 'directory-trust', source: 'native-protocol', scope: 'prerequisite' })
  const original = JSON.parse((await readFile(f.native.log, 'utf8')).trim())
  expect(original.args).toEqual(['--model', 'private-model', 'inspect', '--json']); expect(original.profile).toBe('private-original')
  for (const args of [['--single', 'do not send'], ['--resume', 'old-native'], ['unknown-wrapper'], ['--cwd']]) {
    expect(await readGrokInputInitialization({ ...context, args })).toEqual({ state: 'unknown', reason: 'inspection-unavailable', source: 'unavailable', scope: 'unknown' })
  }
  expect((await readFile(f.native.log, 'utf8')).trim().split('\n')).toHaveLength(1)
  expect(await readGrokInputInitialization(context)).toEqual({ state: 'pending', reason: 'directory-trust', source: 'native-protocol', scope: 'prerequisite' })
  for (const env of [{}, { GROK_HOME: f.root }]) {
    expect(await readGrokInputInitialization({ ...context, env })).toEqual({ state: 'unknown', reason: 'inspection-unavailable', source: 'unavailable', scope: 'unknown' })
  }
  const invocations = (await readFile(f.native.log, 'utf8')).trim().split('\n').map(value => JSON.parse(value))
  expect(invocations).toHaveLength(2); expect(invocations[1]).toMatchObject({ home: f.root, nativeHome: f.root })
  await mkdir(join(f.root, '.grok'))
  await writeFile(join(f.root, '.grok/native-config.json'), JSON.stringify({ cwd: f.root, projectTrusted: false }))
  expect(await readGrokInputInitialization({ ...context, env: { HOME: f.root } })).toEqual({
    state: 'pending', reason: 'directory-trust', source: 'native-protocol', scope: 'prerequisite'
  })
  const defaultInvocation = JSON.parse((await readFile(f.native.log, 'utf8')).trim().split('\n').at(-1)!)
  expect(defaultInvocation.home).toBe(f.root)
  expect(Object.hasOwn(defaultInvocation, 'nativeHome')).toBe(false)
  expect(Object.hasOwn(defaultInvocation, 'profile')).toBe(false)
})

it('real private Core process restart retains the original pending first input and its live Run; source CLI reads it', async () => {
  const loader = resolve(import.meta.dirname, 'fixtures/platform-initialization-loader.mjs')
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/platform-initialization-owner.mjs'))
  vi.stubEnv('NODE_OPTIONS', '--experimental-transform-types --import ' + loader)
  const f = await headlessFixture({ ownerNodeArgs: ['--experimental-transform-types', '--import', loader] }); closes.push(f.cleanup)
  const command = join(f.root, 'private-grok'), writes = join(f.root, 'original-terminal-bytes'), hook = join(f.root, 'private-hook.json')
  await writeFile(command, `#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2);if(a.includes('--version')){console.log('grok 1.0.77');process.exit(0)}if(a.includes('inspect')){console.log(JSON.stringify({cwd:process.cwd(),projectTrusted:false,hooks:[]}));process.exit(0)}fs.writeFileSync(${JSON.stringify(hook)},JSON.stringify({url:process.env.AGENTMUX_HOOK_URL,token:process.env.AGENTMUX_HOOK_TOKEN}));process.stdin.setRawMode(true);process.stdin.on('data',d=>fs.appendFileSync(${JSON.stringify(writes)},d));console.log('Native initializer');setInterval(()=>{},1000);\n`)
  await chmod(command, 0o700); await writeFile(writes, '')
  let sdk = await f.client()
  const original = await sdk.createAgent({ providerId: 'grok', executorId: 'grok', agentSessionId: 'private-original-start',
    createOperationId: 'private-original-creation', workspacePath: f.root, commandOverride: command,
    // This native CLI fixture is plain JavaScript; Core's test-only source loader
    // belongs to the owner processes, not to its bounded read-only inspect command.
    env: { HOME: f.env.HOME!, GROK_HOME: join(f.root, 'grok-home'), NODE_OPTIONS: '' }, injectAgentMuxGuide: false })
  closes.push(async () => { try { const current = await (await f.client()).statusAgent(original.agentSessionId)
    if (current.run.state === 'running') await (await f.client()).stopAgent(original.agentSessionId, current.session.run)
  } catch { /* The private fixture still owns and closes its exact daemon below. */ } })
  const key = { kind: 'prompt' as const, agentSessionId: original.agentSessionId, expectedRun: original.run, submissionId: 'private-original-question' }
  const input = { agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId: key.submissionId,
    prompt: 'Preserve original A across Core restart', admissionIntent: { kind: 'session-conversation' as const }, execution: 'immediate' as const, authorHuman: true }
  await sdk.submitAgentPrompt(input)
  let latest: Awaited<ReturnType<typeof sdk.inspectAgentInput>>
  const before = await until(async () => { latest = await sdk.inspectAgentInput({ key }); return latest },
    value => initialization(value?.control.waiting)?.reason === 'directory-trust', 'original typed initialization wait').catch(error => {
      throw new Error(`${error.message}; last public initialization: ${JSON.stringify(initialization(latest?.control.waiting))}`)
    })
  expect(before!.admission).toBeNull(); expect(await readFile(writes, 'utf8')).toBe('')
  const live = await sdk.statusAgent(original.agentSessionId), firstOwner = f.ownerProcess.pid
  await f.restart(); sdk = await f.client()
  expect(f.ownerProcess.pid).not.toBe(firstOwner)
  const retained = await until(() => sdk.inspectAgentInput({ key }), value => value?.status === 'waiting' && initialization(value.control.waiting)?.reason === 'directory-trust', 'retained original typed wait after actual owner restart')
  expect(retained!.key).toEqual(key); expect(retained!.admission).toBeNull()
  const after = await sdk.statusAgent(original.agentSessionId)
  expect(after.run).toMatchObject({ runId: live.run.runId, pid: live.run.pid, state: 'running' })
  expect(after.session.run).toEqual(original.run); expect(await readFile(writes, 'utf8')).toBe('')
  const cli = await new Promise<{ code: number | null; stdout: string; stderr: string }>((yes, no) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--import', loader, resolve(import.meta.dirname, '../src/agentmux.ts'),
      '--endpoint', 'unix:' + f.socketPath, 'agent', 'input', 'inspect', '--input', '-'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.once('error', no); child.once('close', code => yes({ code, stdout, stderr })); child.stdin.end(JSON.stringify({ key }))
  })
  expect(cli.code, cli.stderr).toBe(0)
  const receipt = JSON.parse(cli.stdout).result.input
  expect(receipt.key, cli.stdout).toEqual(key); expect(receipt.status).toBe('waiting'); expect(receipt.admission).toBeNull()
  expect(receipt.control.waiting).toMatchObject({ phase: 'session', reason: 'native-session-starting',
    initialization: { state: 'pending', reason: 'directory-trust', providerId: 'grok', run: original.run,
      source: 'native-protocol', scope: 'prerequisite', purpose: 'conversation-start' } })
  await sdk.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, data: 'Explicit original terminal action', source: 'user' })
  await until(() => readFile(writes, 'utf8'), value => value === 'Explicit original terminal action', 'healthy original raw terminal input')
  // A saved waiting receipt is insufficient: after the actual owner restart,
  // this same live Run's native start must wake the original task without a
  // second submit/rejoin from a client. The isolated native protocol driver
  // supplies the real authenticated Hook, not a direct Registry write.
  const endpoint = JSON.parse(await readFile(hook, 'utf8'))
  const started = await fetch(endpoint.url, { method: 'POST', headers: {
    authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json'
  }, body: JSON.stringify({ receiptId: 'private-native-start-after-restart', eventName: 'session_start',
    payload: { hookEventName: 'session_start', sessionId: 'private-original-native' } }) })
  expect(started.status).toBe(204)
  await until(() => sdk.readAgentSession(original.agentSessionId), value => value?.nativeBinding?.run.runId === original.run.runId, 'same original Run native start is confirmed')
  const sent = await until(() => sdk.inspectAgentInput({ key }), value => value?.status === 'terminal-confirmed', 'original saved task automatically wakes after owner restart')
  expect(sent!.key).toEqual(key)
  expect(await readFile(writes, 'utf8')).toBe('Explicit original terminal action' + input.prompt + '\r')
  await f.restart(); sdk = await f.client()
  expect((await sdk.inspectAgentInput({ key }))?.status).toBe('terminal-confirmed')
  expect((await sdk.statusAgent(original.agentSessionId)).run).toMatchObject({ runId: live.run.runId, pid: live.run.pid, state: 'running' })
  expect(await readFile(writes, 'utf8')).toBe('Explicit original terminal action' + input.prompt + '\r')
  await sdk.stopAgent(original.agentSessionId, original.run)
})

it('same original saved input cannot rejoin into native trust; a current native binding wakes it once', async () => {
  const f = await startingFixture('first-start'), key = f.key('original-wake-A')
  await f.client.submitAgentPrompt({ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId: key.submissionId,
    prompt: 'Original A wakes once', admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
  const held = await until(() => f.client.inspectAgentInput({ key }), value => initialization(value?.control.waiting)?.reason === 'directory-trust', 'original start-only wait')
  await f.client.rejoinAgentInputWaiting({ ref: held!.ref })
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key }))?.control.waiting).toMatchObject({ phase: 'session', reason: 'native-session-starting', initialization: { state: 'pending', reason: 'directory-trust', source: 'native-protocol', scope: 'prerequisite' } }))
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(await f.client.inspectAgentPromptSubmission(key)).toBeNull()
  const current = (await f.store.readMetadata('recipient'))!, at = current.updatedAt + 1
  await f.store.compareAndSwapMetadata(current, { ...current, nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: 'original-native' },
    nativeBinding: { source: 'native-hook', run: current.run, observedAt: at }, updatedAt: at })
  await f.inner.registry.refresh('recipient', current.run); f.inner.publishSession(f.inner.registry.get('recipient'))
  const sent = await until(() => f.client.inspectAgentInput({ key }), value => value?.status === 'terminal-confirmed', 'same original input automatically wakes on current native binding')
  expect(sent!.key).toEqual(key); expect(sent!.admission!.admission!.intent!.message!.userContent).toBe('Original A wakes once')
  expect(held!.control.waiting?.wake).toBe('session-restored')
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  await f.client.rejoinAgentInputWaiting({ ref: sent!.ref })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
})

it('the actual native-start Host fixture qualifies its original main source for a frozen Query', async () => {
  const f = await createMoteConversationStartFixture({ providerId: 'claude' }); closes.push(f.close)
  await f.start('actual-native-ready', 'Original native-qualified A')
  const setup = await f.settledSetup('actual-native-ready'), sid = setup.reference!.sessionId
  const session = (await f.h.client.readAgentSession(sid))!
  expect(setup.deferredInput?.input?.status, JSON.stringify({ binding:session.nativeBinding,source:session.nativeSourceObservation,issue:setup.issue,input:setup.deferredInput?.input })).toBe('terminal-confirmed')
})

it('an original authorized carrier without a claim still cannot bypass startup on continuation', async () => {
  const f = await startingFixture('first-start'), key = f.key('original-handoff-A'), prompt = 'Original handoff A'
  const probe = vi.spyOn(f.client.providers.get('grok'), 'readInputInitialization')
  await f.client.submitAgentPrompt({ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId: key.submissionId,
    prompt, admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
  const held = await until(() => f.client.inspectAgentInput({ key }), value => initialization(value?.control.waiting)?.reason === 'directory-trust', 'original handoff preparation waits')
  await f.inner.inputWaitingRecipients.get('recipient')?.pending
  // The real journal and live Store lease retain an original pre-crash carrier.
  // No structural lease, native ACK or metadata claim is invented by the test.
  await withAgentInputClaimLease(f.store, f.inner.messageQueue.queueId, key, lease => f.inner.messageQueue.authorizeInputDispatch(held!.ref, undefined,
    { key, claimsAbsent: async () => !await f.client.inspectAgentPromptSubmission(key), assertTarget: async () => {
      expect((await f.store.readMetadata('recipient'))!.run).toEqual(key.expectedRun)
    } }, { lease, carrier: { kind: 'pty', plan: { kind: 'single-phase', data: prompt + '\r' } } }))
  expect((await f.client.inspectAgentInput({ key }))!.control.state).toBe('dispatch-authorized')
  await f.client.rejoinAgentInputWaiting({ ref: held!.ref })
  await f.inner.inputWaitingRecipients.get('recipient')?.pending
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(await f.client.inspectAgentPromptSubmission(key)).toBeNull()
  expect(probe).toHaveBeenCalledTimes(2)
  expect((await f.client.inspectAgentInput({ key }))!.control.handoff!.carrier).toEqual({ kind: 'pty', plan: { kind: 'single-phase', data: prompt + '\r' } })
})

it('an original unknown terminal write remains receipt-only after startup qualification changes', async () => {
  const f = await startingFixture('first-start'), key = f.key('original-unknown-A')
  const write = f.inner.kernel.input, status = f.inner.kernel.status
  let unknown = false
  f.inner.kernel.status = vi.fn(async (id: string) => ({ ...await status(id), ...(unknown ? { acceptedInputBytes: null } : {}) }))
  f.inner.kernel.input = vi.fn(async (...args: unknown[]) => {
    await write(...args); unknown = true
    throw new AgentMuxError('Original native write reply was lost after dispatch.', 'CTXMUX_DISCONNECTED', undefined, { disposition: 'unknown', confirmedInputBytes: 0 })
  })
  const input = { agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId: key.submissionId,
    prompt: 'Original unknown A', admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const, authorHuman: true }
  await f.client.submitAgentPrompt(input)
  const retained = await until(() => f.client.inspectAgentInput({ key }), value => Boolean(value?.admission), 'original possible terminal side effect remains claimed')
  expect(retained!.status).toBe('unknown'); expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  const original = structuredClone(retained!.admission)
  const diagnostic = vi.spyOn(f.client.providers.get('grok'), 'readInputInitialization')
  await f.client.rejoinAgentInputWaiting({ ref: retained!.ref })
  await f.client.submitAgentPrompt(input)
  const after = (await f.client.inspectAgentInput({ key }))!
  expect(after.key).toEqual(key); expect(after.status).toBe('unknown'); expect(after.admission).toEqual(original)
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1); expect(diagnostic).not.toHaveBeenCalled()
})
