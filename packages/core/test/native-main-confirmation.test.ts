import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { AgentHookServer } from '../src/hook-server.js'
import { normalizeNativeHook } from '../src/hook-normalizer.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { hasCurrentNativeMainBinding } from '../src/agent-native-source.js'
import { sessionSemanticResumeSourceRuns } from '../src/agent-session-resume-sources.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '../src/agent-session-recovery/continuity-contract.js'
import type { AgentProvider } from '../src/agent-provider.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const until = <T>(read: () => T | Promise<T>) => vi.waitFor(read, { timeout: 5_000 })

async function fixture(providerId: 'grok' | 'gemini' = 'grok') {
  const f = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId, executorId: providerId }))
  cleanup.push(f.close)
  const provider = f.client.providers.get(providerId), { prepareNativeInput: _native, ...terminal } = provider
  f.client.providers.replace({ ...terminal, readInputInitialization: async () => ({ state: 'unknown', reason: 'inspection-unavailable', source: 'unavailable', scope: 'unknown' }) })
  f.inner.kernel.readRunEnvironment = async () => ({ HOME: f.root })
  const hooks = new AgentHookServer((event, signal) => Reflect.get(f.client, 'acceptHookEvent').call(f.client, event, signal), 0)
  await hooks.start(); Reflect.set(f.client, 'hookServer', hooks)
  const binding = hooks.createBinding('recipient', providerId)
  await binding.bindRun('run-recipient'); Reflect.get(f.client, 'hookBindings').set('run-recipient', binding)
  const old = (await f.store.readMetadata('recipient'))!, at = old.updatedAt + 1
  const nativeHandle = { kind: 'provider' as const, providerId, sessionId: 'original-native' }
  const current: AgentMuxStoredAgentSession = { ...old, hookBindingId: binding.bindingId, hookToken: binding.endpoint.token,
    nativeHandle, nativeBinding: { source: 'semantic-resume-target', run: old.run, observedAt: at }, retiredRuns: [{ runId: 'original-old-run' }],
    continuity: { operationId: 'original-resume', agentSessionId: old.agentSessionId, trigger: 'manual', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY },
      reason: 'original-native-context', admittedAt: at, observedAt: at, rechecks: 0, kind: 'resumed', previousRun: { runId: 'original-old-run' },
      newRun: old.run, nativeTarget: nativeHandle, evidence: { kind: 'run-running', observedAt: at } }, updatedAt: at }
  await f.store.compareAndSwapMetadata(old, current); await f.inner.registry.refresh('recipient', current.run)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'public.sock'), coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: f.credentials }); cleanup.push(() => rpc.dispose())
  const read = () => f.store.readMetadata('recipient').then(value => value!)
  const post = async (id: string, child = false) => {
    const payload = providerId === 'grok' ? { hookEventName: child ? 'subagent_start' : 'stop', sessionId: child ? 'child-native' : nativeHandle.sessionId,
      ...(child ? { subagentType: 'worker' } : {}) } : { hook_event_name: 'AfterAgent', session_id: nativeHandle.sessionId }
    const response = await fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: 'Bearer ' + binding.endpoint.token, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: id, eventName: providerId === 'grok' ? 'stop' : 'AfterAgent', payload }) })
    expect([200, 204], await response.text()).toContain(response.status)
    await until(async () => expect((await read()).hookReceipt?.id).toBe(id))
  }
  const submit = async (operationId: string) => {
    await f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: current.run, operationId, prompt: 'Original question ' + operationId,
      admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: current.run, submissionId: operationId }
    const receipt = await f.client.inspectAgentInput({ key })
    if (!receipt) throw Error('The original input must have a persisted Core receipt')
    return receipt
  }
  const inputs = () => vi.mocked(f.inner.kernel.input as () => Promise<unknown>).mock.calls.length + f.rawInput.mock.calls.length
  const cli = (key: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'agent', 'input', 'inspect', '--input', '-'],
    objectCliEnvironment(f.root, { AGENTMUX_TEST_OBJECT_CLI: join(realpathSync(join(import.meta.dirname, '../../../node_modules')), '../packages/core/bin/amux'),
      AGENTMUX_AGENT_SESSION_ID: f.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.credentials.capability }), JSON.stringify({ key }))
  return { ...f, current, nativeHandle, read, post, submit, inputs, rpc, cli }
}

it.each(['grok', 'gemini'] as const)('qualifies an authenticated %s main receipt without inventing lifecycle semantics', async providerId => {
  const f = await fixture(providerId), before = sessionSemanticResumeSourceRuns(f.client.agentSession('recipient'))
  await f.post('original-main')
  const stored = await f.read()
  expect(stored.hookReceipt).toMatchObject({ providerId, subject: { kind: 'main', nativeSessionId: f.nativeHandle.sessionId }, lifecycleEvent: null })
  expect(hasCurrentNativeMainBinding(stored)).toBe(true)
  expect(sessionSemanticResumeSourceRuns(f.client.agentSession('recipient')), 'qualified main evidence must retain the original canonical source Runs').toEqual(before)
  const receipt = await f.submit('main-qualified'), key = receipt.key
  await until(async () => expect((await f.client.inspectAgentInput({ key }))?.status, 'qualified main must release original initialization gating').toBe('terminal-confirmed'))
  expect(f.inputs()).toBe(1)
  const publicRead = await f.rpc.call('agent.input.inspect', { key })
  expect(publicRead.input).toMatchObject({ key, status: 'terminal-confirmed' })
  const cli = await f.cli(key)
  expect(cli.code, cli.stderr || cli.stdout).toBe(0); expect(JSON.parse(cli.stdout).result.input).toMatchObject({ key, status: 'terminal-confirmed' })
  await f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: f.current.run, operationId: 'main-qualified', prompt: 'Original question main-qualified',
    admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
  expect(f.inputs()).toBe(1)
})

it('keeps actual post-main input qualification after a later child receipt', async () => {
  const f = await fixture()
  await f.post('original-main'); await f.post('later-child', true)
  expect((await f.read()).hookReceipt?.subject?.kind).toBe('child')
  const receipt = await f.submit('post-child-original')
  await until(async () => expect((await f.client.inspectAgentInput({ key: receipt.key }))?.status,
    'a later child must not restore initialization gating after the main object was confirmed').toBe('terminal-confirmed'))
  expect(f.inputs()).toBe(1)
})

it('uses an exact retained weak-projection receipt but never a bare, foreign or selected target', async () => {
  const f = await fixture(); await f.post('retained-main')
  const strong = await f.read(), weak = { ...strong, nativeBinding: { ...strong.nativeBinding!, source: 'semantic-resume-target' as const } }
  expect(hasCurrentNativeMainBinding(weak)).toBe(true)
  for (const patch of [
    { hookReceipt: undefined }, { hookReceipt: { ...weak.hookReceipt!, agentSessionId: 'other' } },
    { hookReceipt: { ...weak.hookReceipt!, providerId: 'other' } }, { hookReceipt: { ...weak.hookReceipt!, run: { runId: 'other' } } },
    ...(['child', 'foreign', 'unknown'] as const).map(kind => ({ hookReceipt: { ...weak.hookReceipt!, subject: { ...weak.hookReceipt!.subject!, kind } } })),
    { hookReceipt: { ...weak.hookReceipt!, subject: { kind: 'main' as const, basis: 'provider-protocol' as const, reason: 'missing-id' } } },
    { hookReceipt: { ...weak.hookReceipt!, subject: { ...weak.hookReceipt!.subject!, nativeSessionId: 'other-native' } } },
    { nativeBinding: { ...weak.nativeBinding!, run: { runId: 'other-run' } } },
    { nativeBinding: { ...weak.nativeBinding!, source: 'user-selected' as const } }
  ]) expect(hasCurrentNativeMainBinding({ ...weak, ...patch } as AgentMuxStoredAgentSession)).toBe(false)
})

it('consumes the retained weak projection through the original input owner without another Hook', async () => {
  const f = await fixture(); await f.post('legacy-retained-main')
  const strong = await f.read(), weak: AgentMuxStoredAgentSession = { ...strong, nativeBinding: { ...strong.nativeBinding!, source: 'semantic-resume-target' } }
  await f.store.compareAndSwapMetadata(strong, weak); await f.inner.registry.refresh('recipient', weak.run)
  const receipt = await f.submit('retained-original')
  await until(async () => expect((await f.client.inspectAgentInput({ key: receipt.key }))?.status,
    'retained main proof must qualify the original input').toBe('terminal-confirmed'))
  expect((await f.read()).hookReceipt).toEqual(weak.hookReceipt)
  expect(f.inputs()).toBe(1)
})

it.each(['missing-id', 'wrong-id'] as const)('does not promote a main protocol observation with %s', async failure => {
  const f = await fixture(), provider = f.client.providers.get('grok'), resolve = provider.hook.resolveSubject!
  const hook = { ...provider.hook, resolveSubject: (...args: Parameters<typeof resolve>) => {
    const { nativeSessionId: _id, ...subject } = resolve(...args)
    return { ...subject, ...(failure === 'wrong-id' ? { nativeSessionId: 'wrong-native' } : {}) }
  } }
  f.client.providers.replace({ ...provider, hook, normalizeHook: (envelope, context) => normalizeNativeHook(hook, envelope, context) })
  await f.post('incomplete-main')
  expect((await f.read()).nativeBinding?.source).toBe('semantic-resume-target')
  const receipt = await f.submit('unconfirmed-' + failure)
  await until(async () => expect((await f.client.inspectAgentInput({ key: receipt.key }))?.status).toBe('waiting'))
  expect(f.inputs()).toBe(0)
})

it('preserves explicit selection and its richer original locator without granting startup qualification', async () => {
  const f = await fixture(), current = await f.read()
  const selected = { ...current, nativeHandle: { ...f.nativeHandle, transcriptPath: join(f.root, 'original-native-record') },
    nativeBinding: { ...current.nativeBinding!, source: 'user-selected' as const } }
  await f.store.compareAndSwapMetadata(current, selected); await f.inner.registry.refresh('recipient', current.run)
  await f.post('selected-main')
  const observed = await f.read()
  expect(observed.nativeBinding?.source).toBe('user-selected')
  expect(observed.nativeHandle).toEqual(selected.nativeHandle)
  expect(hasCurrentNativeMainBinding(observed)).toBe(false)
  const receipt = await f.submit('selected-original')
  await until(async () => expect((await f.client.inspectAgentInput({ key: receipt.key }))?.status).toBe('waiting'))
  expect(f.inputs()).toBe(0)
})

it('does not promote a semantic binding belonging to another Run', async () => {
  const f = await fixture(), current = await f.read()
  const stale = { ...current, nativeBinding: { ...current.nativeBinding!, run: { runId: 'different-binding-run' } } }
  expect(hasCurrentNativeMainBinding(stale)).toBe(false)
  await expect(f.store.compareAndSwapMetadata(current, stale)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
  expect(await f.read()).toEqual(current)
})

it('retains exact native channel selection for unknown observation and does not replay an unknown input', async () => {
  const f = await fixture(); await f.post('native-channel-main')
  const strong = await f.read(), weak: AgentMuxStoredAgentSession = { ...strong, nativeBinding: { ...strong.nativeBinding!, source: 'semantic-resume-target' },
    nativeSourceObservation: { state: 'unknown', run: strong.run, observedAt: strong.updatedAt + 1, reason: 'optional-observer-unavailable' }, updatedAt: strong.updatedAt + 1 }
  await f.store.compareAndSwapMetadata(strong, weak); await f.inner.registry.refresh('recipient', weak.run)
  f.inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), pid: 1234 }))
  const provider = f.client.providers.get('grok')
  const send = vi.fn(async () => { throw new Error('Private native result is unknown after dispatch') })
  const prepare = vi.fn<NonNullable<AgentProvider['prepareNativeInput']>>(async (_context, selected) => ({ plan: { kind: 'native-rpc' as const, protocolId: 'controlled-native-input',
    sourceId: JSON.stringify([selected.providerId, selected.nativeSessionId]), actorId: 'original-actor', threadId: selected.nativeSessionId,
    operation: 'start-or-steer' as const }, assertCurrent: async () => {}, send, dispose: async () => {} }))
  f.client.providers.replace({ ...provider, prepareNativeInput: prepare })
  const receipt = await f.submit('native-original')
  await until(() => expect(send, 'unknown optional observation must retain the qualified native channel').toHaveBeenCalledOnce())
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ processId: 1234 }), { providerId: 'grok', nativeSessionId: f.nativeHandle.sessionId })
  await until(async () => expect((await f.client.inspectAgentInput({ key: receipt.key }))?.status).toBe('unknown'))
  const before = await f.client.inspectAgentInput({ key: receipt.key })
  await f.submit('native-original')
  expect(await f.client.inspectAgentInput({ key: receipt.key })).toEqual(before)
  expect(send).toHaveBeenCalledOnce(); expect(f.inputs()).toBe(0)
})

it.each(['changed', 'ambiguous'] as const)('preserves the known %s source fence despite an exact retained main receipt', async state => {
  const f = await fixture(); await f.post('known-source-main')
  const current = await f.read()
  await f.store.compareAndSwapMetadata(current, { ...current,
    nativeSourceObservation: { state, run: current.run, observedAt: current.updatedAt + 1, reason: 'known-current-source-conflict' },
    ...(state === 'changed' ? { observedNativeHandle: { ...f.nativeHandle, sessionId: 'conflicting-native' } } : {}), updatedAt: current.updatedAt + 1 })
  await f.inner.registry.refresh('recipient', current.run)
  const provider = f.client.providers.get('grok'), prepare = vi.fn(async () => { throw new Error('Conflicted source must not reach native preparation') })
  f.client.providers.replace({ ...provider, prepareNativeInput: prepare })
  const receipt = await f.submit('known-fence-' + state)
  await until(async () => expect((await f.client.inspectAgentInput({ key: receipt.key }))?.status).toBe('waiting'))
  expect(prepare).not.toHaveBeenCalled(); expect(f.inputs()).toBe(0)
})
