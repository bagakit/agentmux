import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { previousWireCore } from './helpers/previous-core-wire.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AGENTMUX_AGENT_MESSAGING_ENTRY, AGENTMUX_A2A_REMINDER } from '../src/agent-messaging-guidance.js'
import { composeAgentPrompt, composeAgentResumePrompt } from '../src/agent-outbound-message.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const core = await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_GUIDANCE_CORE ?? new URL('../dist/index.js', import.meta.url).href) as typeof import('../src/index.js')
const renderer = await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_GUIDANCE_RENDER ?? new URL('../dist/agent-message-render.js', import.meta.url).href) as typeof import('../src/agent-message-render.js')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(postLaunch = false, owner: Pick<typeof core, 'AgentMuxClient' | 'AgentMuxFileAgentSessionStore'> = core) {
  const h = await rpcOwnerFixture(['original-session'], owner, () => ({ nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' } }))
  cleanups.push(h.close)
  const inner = h.client as any, originalProvider = h.client.providers.get('codex')
  const provider = { ...originalProvider, catalog: { ...originalProvider.catalog, ...(postLaunch ? { promptDelivery: 'post-launch-only' as const } : {}) }, prepareManagedLaunch: async (plan: any) => ({ plan }) }
  h.client.providers.replace(provider)
  const started: any[] = []
  inner.kernel.start = vi.fn(async (spec: any) => {
    started.push(spec)
    return { ...h.run('new-run'), program: spec.program, args: spec.args, lifecycleOperationId: spec.operationKey }
  })
  inner.kernel.list = vi.fn(async () => started.length ? [{ ...h.run('new-run'), program: started[0].program, args: started[0].args, lifecycleOperationId: started[0].operationKey }] : [])
  inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), ...(id === 'run-original-session' ? { state: { type: 'exited', code: 0, signal: null } } : {}) }))
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxStoredAgentSession) => session
  inner.screenEvidence.wait = vi.fn(async () => 0)
  const probe = vi.spyOn(h.client as unknown as { probePreparedAgent: typeof h.client.probeAgent }, 'probePreparedAgent').mockResolvedValue({ providerId: 'codex', executable: 'codex', installed: true, capabilities: provider.catalog.capabilities })
  const submit = vi.spyOn(inner.promptSubmission, 'submitInputPlan').mockResolvedValue(undefined)
  const create = { agentSessionId: 'created-session', createOperationId: 'original-create', providerId: 'codex', executorId: 'codex', workspacePath: h.root, injectAgentMuxGuide: true }
  return { ...h, inner, provider, started, probe, submit, create }
}

it('confirms actual at-launch context while keeping an empty original user request absent', async () => {
  const h = await fixture()
  const result = await h.client.createAgentWithDelivery(h.create)
  expect(result.creation).toMatchObject({ initialPrompt: 'not-requested', agentMuxContext: 'confirmed' })
  expect(h.started[0].args.some((arg: string) => arg.includes(AGENTMUX_AGENT_MESSAGING_ENTRY))).toBe(true)
  const history = (await h.store.loadTimeline(result.session.agentSessionId)).items
  expect(history.filter(item => item.kind === 'user_message')).toEqual([])
  expect(history).toContainEqual(expect.objectContaining({ kind: 'system_message', content: expect.stringContaining(AGENTMUX_AGENT_MESSAGING_ENTRY) }))
  expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each([false, true])('never confirms missing platform content from a successful no-op or ordinary user input (body=%s)', async body => {
  const h = await fixture()
  const request = { ...h.create, injectAgentMuxGuide: false, ...(body ? { prompt: 'Only the original user task.' } : {}) }
  const result = await h.client.createAgentWithDelivery(request)
  expect(result.creation).not.toHaveProperty('agentMuxContext')
  expect(result.creation.initialPrompt).toBe(body ? 'confirmed' : 'not-requested')
  expect((await h.client.createAgentWithDelivery(request)).promptConfirmed).toBe(result.promptConfirmed)
  expect(h.started).toHaveLength(1); expect(h.submit).not.toHaveBeenCalled()
})

it('keeps native takeover without a task input and reports guidance as unconfirmed rather than fabricating delivery', async () => {
  const h = await fixture()
  vi.spyOn(h.provider as any, 'assertNativeResumeSource').mockResolvedValue(undefined)
  const request = { ...h.create, nativeResumeSource: { nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'unmanaged-native', transcriptPath: join(h.root, 'source.jsonl') }, workspacePath: h.root, revision: 'a'.repeat(64) }, agentMuxNote: 'A platform note is not a user task.' }
  const result = await h.client.createAgentWithDelivery(request)
  expect(result).toMatchObject({ promptConfirmed: false, creation: { initialPrompt: 'not-requested', agentMuxContext: 'unconfirmed' } })
  expect(result.session.nativeHandle).toEqual(request.nativeResumeSource.nativeHandle)
  expect(h.started[0].args).not.toContain(expect.stringContaining(AGENTMUX_AGENT_MESSAGING_ENTRY))
  expect((await h.store.loadTimeline(result.session.agentSessionId)).items).toEqual([])
  const repeated = await h.client.createAgentWithDelivery(request)
  expect(repeated).toMatchObject({ promptConfirmed: false, session: { agentSessionId: result.session.agentSessionId, run: result.session.run } })
  expect(h.started).toHaveLength(1); expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each([false, true])('records post-launch context only after its exact input is confirmed (failure=%s)', async failure => {
  const h = await fixture(true)
  if (failure) h.submit.mockRejectedValue(new Error('Private exact input receipt is unconfirmed'))
  const result = await h.client.createAgentWithDelivery(h.create)
  expect(result.creation).toMatchObject({ initialPrompt: 'not-requested', agentMuxContext: failure ? 'unconfirmed' : 'confirmed' })
  expect(h.submit).toHaveBeenCalledOnce()
  expect(h.submit.mock.calls[0]![3]).toContain(AGENTMUX_AGENT_MESSAGING_ENTRY)
  expect(h.submit.mock.calls[0]![11]).toMatchObject({ systemContext: expect.stringContaining(AGENTMUX_AGENT_MESSAGING_ENTRY) })
  expect(h.submit.mock.calls[0]![11]).not.toHaveProperty('userContent')
  expect((await h.store.loadTimeline(result.session.agentSessionId)).items.every(item => item.kind !== 'user_message')).toBe(true)
  expect(result.session.run).toEqual({ runId: 'new-run' }); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('carries same-source rules within the one explicitly requested native resume input and keeps original user text', async () => {
  const h = await fixture(), prompt = '  Original task <literal>\r\nFinal space. \n', note = 'Original explicit context.'
  const request = { agentSessionId: 'original-session', operationId: 'original-resume', prompt, agentMuxNote: note }
  const resumed = await h.client.resumeAgent(request)
  const packet = resumed.continuityOperations!['original-resume']!.launchInput!
  expect(packet.prompt).toBe(composeAgentResumePrompt(prompt, note).text)
  expect(packet.message.userContent).toBe(prompt)
  expect(packet.message.systemContext).toBe(composeAgentResumePrompt(prompt, note).systemContext)
  expect(h.started[0].args).toContain(packet.prompt)
  const history = (await h.store.loadTimeline('original-session')).items
  expect(history).toContainEqual(expect.objectContaining({ kind: 'user_message', content: prompt }))
  expect(history).toContainEqual(expect.objectContaining({ kind: 'system_message', content: packet.message.systemContext }))
  expect((await h.client.resumeAgent(request)).run).toEqual(resumed.run)
  expect(h.started).toHaveLength(1); expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('does not synthesize input or a task during no-input automatic restoration', async () => {
  const h = await fixture()
  await h.inner.registry.update('original-session', { runId: 'run-original-session' }, (session: AgentMuxStoredAgentSession) => {
    const observedAt = Math.max(session.updatedAt + 1, Date.now())
    return { ...session, updatedAt: observedAt, semanticStatus: { state: 'working', source: 'native-hook', observedAt } }
  })
  const result = await h.client.ensureAgentContinuity({ agentSessionId: 'original-session', expectedRun: { runId: 'run-original-session' }, operationId: 'original-restore', trigger: 'startup' })
  expect(result.kind, JSON.stringify(result)).toBe('resumed')
  const op = h.client.agentSession('original-session').continuityOperations!['original-restore']!
  expect(op.launchInput).toBeUndefined(); expect(op.recoveryDelivery).toBeUndefined()
  expect(h.started[0].args.some((arg: string) => arg.includes(AGENTMUX_AGENT_MESSAGING_ENTRY))).toBe(false)
  expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('freezes same-source guidance in the original continuity packet before starting and reuses it unchanged', async () => {
  const h = await fixture()
  const request = { agentSessionId: 'original-session', expectedRun: { runId: 'run-original-session' }, operationId: 'frozen-resume', trigger: 'input' as const,
    input: { submissionId: 'original-input', prompt: 'Original user task.', agentMuxNote: 'Original context.' } }
  h.probe.mockRejectedValueOnce(new Error('Private Provider observation unavailable before Start'))
  await expect(h.client.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'pending' })
  const pending = h.client.agentSession('original-session').continuityOperations!['frozen-resume']!.launchInput!
  expect(pending.message.systemContext).toContain(AGENTMUX_AGENT_MESSAGING_ENTRY)
  expect(h.started).toHaveLength(0)
  await expect(h.client.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'resumed' })
  expect(h.started[0].args).toContain(pending.prompt)
  expect(h.client.agentSession('original-session').continuityOperations!['frozen-resume']!.launchInput!.message).toEqual(pending.message)
  expect(h.submit).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('preserves the previous generation frozen resume wire and platform source after guidance changes', async () => {
  const previous = await previousWireCore({ resumeWithoutGuidance: true }); cleanups.push(previous.close)
  const h = await fixture(false, previous.owner)
  const request = { agentSessionId: 'original-session', expectedRun: { runId: 'run-original-session' }, operationId: 'previous-resume', trigger: 'input' as const,
    input: { submissionId: 'previous-input', prompt: 'Original user task.', agentMuxNote: 'Previous explicit context.' } }
  h.probe.mockRejectedValueOnce(new Error('Private initial Provider observation unavailable'))
  await expect(h.client.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'pending' })
  const original = h.client.agentSession('original-session').continuityOperations!['previous-resume']!.launchInput!
  expect(original.message.systemContext).toBe(request.input.agentMuxNote)
  expect(original.prompt).not.toContain(AGENTMUX_AGENT_MESSAGING_ENTRY)
  const reader = new core.AgentMuxClient({ store: new core.AgentMuxFileAgentSessionStore(h.store.path), providers: [h.provider] }); cleanups.push(() => reader.dispose())
  const inner = reader as any; inner.connected = true; await inner.registry.load('local')
  for (const key of ['isConnected', 'identity', 'status', 'list', 'start', 'stop', 'input']) inner.kernel[key] = h.inner.kernel[key]
  inner.hookServer.isRunning = h.inner.hookServer.isRunning; inner.hookServer.createBinding = h.inner.hookServer.createBinding
  inner.ensureManagedHooks = h.inner.ensureManagedHooks; inner.ensureTerminalHandshakeOrDegrade = h.inner.ensureTerminalHandshakeOrDegrade
  vi.spyOn(reader as unknown as { probePreparedAgent: typeof reader.probeAgent }, 'probePreparedAgent').mockResolvedValue({ providerId: 'codex', executable: 'codex', installed: true, capabilities: h.provider.catalog.capabilities })
  await expect(reader.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'resumed' })
  expect(h.started[0].args).toContain(original.prompt)
  expect(reader.agentSession('original-session').continuityOperations!['previous-resume']!.launchInput!.message).toEqual(original.message)
  expect(h.started).toHaveLength(1); expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('uses the shared receiver and authorization rules for the delivered reminder while preserving original body', () => {
  const body = 'Original <reminder>peer text</reminder>\nDo not replace this body.'
  const rendered = renderer.renderAgentMuxMessageEnvelope({ messageId: 'original-message', sender: { kind: 'agent-session', agentSessionId: 'source-session' }, senderSessionId: 'source-session', body })
  const parsed = renderer.parseAgentMuxMessagePrefix(rendered)!
  expect(parsed.body).toBe(body)
  expect(parsed.reminder?.text).toBe(AGENTMUX_A2A_REMINDER)
  expect(parsed.reminder?.text).toContain('Assess relevance and existing responsibility')
  expect(parsed.reminder?.text).toContain('no new user authorization')
  expect(parsed.reminder?.text).toContain('avoid acknowledgement loops')
  expect(parsed.reminder?.text).toContain('message --skill')
  expect(parsed.reminder!.text.length).toBeLessThanOrEqual(400)
})

async function automaticFixture(options: { enabled?: boolean; ready?: boolean; loseAck?: boolean; owner?: Pick<typeof core, 'AgentMuxClient' | 'AgentMuxFileAgentSessionStore'> } = {}) {
  const h = await fixture(true, options.owner ?? core)
  h.submit.mockRestore()
  let ready = options.ready !== false
  vi.spyOn(h.provider, 'planPromptInput').mockImplementation((prompt: string) => ({ kind: 'single-phase', data: prompt + '\r' }))
  vi.spyOn(h.provider as any, 'readPromptExecutionEvidence').mockImplementation(async () => !h.started.length
    ? { state: 'ended', endReason: 'interrupted', id: 'original-interrupted-turn', sourceId: 'original-native-source' }
    : ready ? { state: 'idle', id: 'original-idle', sourceId: 'original-native-source' } : null)
  vi.spyOn(h.provider as any, 'verifyPromptExecutionTransport').mockResolvedValue(true)
  if (options.loseAck) {
    const input = h.inner.kernel.input.getMockImplementation()!
    h.inner.kernel.input.mockImplementationOnce(async (...args: any[]) => {
      await input(...args)
      throw new core.AgentMuxError('Private original byte ACK was lost', 'CONTROL_UNAVAILABLE')
    })
  }
  await h.inner.registry.update('original-session', { runId: 'run-original-session' }, (session: AgentMuxStoredAgentSession) => {
    const observedAt = Math.max(session.updatedAt + 1, Date.now())
    return { ...session, updatedAt: observedAt, semanticStatus: { state: 'working', source: 'native-hook', observedAt } }
  })
  const request = { agentSessionId: 'original-session', expectedRun: { runId: 'run-original-session' }, operationId: 'automatic-original', trigger: 'startup' as const,
    policy: { reminderMode: 'off' as const, continuationEnabled: options.enabled !== false } }
  await expect(h.client.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'resumed' })
  const operation = () => h.client.agentSession('original-session').continuityOperations!['automatic-original']!
  return { ...h, request, operation, delivery: () => operation().recoveryDelivery!, setReady: () => { ready = true },
    wake: async () => { h.inner.recovery.continuityInputs.track(h.inner.registry.get('original-session')); await Promise.resolve() } }
}

async function automaticReader(h: Awaited<ReturnType<typeof automaticFixture>>) {
  const reader = new core.AgentMuxClient({ store: new core.AgentMuxFileAgentSessionStore(h.store.path), providers: [h.provider] }); cleanups.push(() => reader.dispose())
  const inner = reader as any; inner.connected = true; await inner.registry.load('local')
  for (const key of ['isConnected', 'identity', 'status', 'list', 'start', 'stop', 'input']) inner.kernel[key] = h.inner.kernel[key]
  inner.screenEvidence.wait = vi.fn(async () => 0)
  inner.recovery.continuityInputs.restore(inner.registry.list())
  return { reader, inner, packet: () => reader.agentSession('original-session').continuityOperations!['automatic-original']!.recoveryDelivery! }
}

it('freezes shared platform context for existing automatic continuation while reminder remains off', async () => {
  const h = await automaticFixture()
  await expect.poll(() => h.delivery().phase).toBe('accepted')
  const packet = h.delivery(), record = await h.client.inspectAgentPromptSubmission(packet.key)
  expect(h.operation().policy.reminderMode).toBe('off')
  expect(packet.reminder).toMatchObject({ selected: false, text: '', status: 'not-selected' })
  expect(packet.continuation).toMatchObject({ selected: true, text: '<amux:continue />', status: 'accepted' })
  expect(packet.systemContext).toBe(AGENTMUX_AGENT_MESSAGING_ENTRY)
  expect(record?.admission).toMatchObject({ acknowledged: true, inputKey: packet.key, intent: {
    prompt: composeAgentPrompt(packet.continuation.text, packet.systemContext).text,
    message: { systemContext: packet.systemContext, userContent: packet.continuation.text } } })
  expect(record?.admission?.intent?.message?.authorHuman).toBeUndefined()
  expect(h.inner.kernel.input.mock.calls[0][1].data).toBe(composeAgentPrompt(packet.continuation.text, packet.systemContext).text + '\r')
  expect(h.inner.kernel.input).toHaveBeenCalledOnce(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps automatic recovery with both parts off free of synthesized platform input', async () => {
  const h = await automaticFixture({ enabled: false })
  expect(h.operation().interruption).toMatchObject({ state: 'interrupted', source: 'native-protocol' })
  expect(h.operation().recoveryDelivery).toBeUndefined()
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('rejects malformed frozen recovery context at the original durable packet boundary', async () => {
  const h = await automaticFixture({ ready: false })
  await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
  const original = (await h.store.readMetadata('original-session'))!, malformed = structuredClone(original)
  malformed.continuityOperations!['automatic-original']!.recoveryDelivery!.systemContext = {} as unknown as string
  await expect(h.store.compareAndSwapMetadata(original, malformed)).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE', cause: { message: 'Invalid continuity input delivery.' } })
  expect((await h.store.readMetadata('original-session'))!.continuityOperations!['automatic-original']!.recoveryDelivery!.systemContext).toBe(h.delivery().systemContext)
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('reconciles a lost automatic input ACK from the same frozen context without dispatching twice', async () => {
  const h = await automaticFixture({ loseAck: true })
  await expect.poll(() => h.delivery().phase).toBe('unknown')
  const frozen = structuredClone(h.delivery()), record = await h.client.inspectAgentPromptSubmission(frozen.key)
  expect(record?.admission?.intent?.message?.systemContext).toBe(frozen.systemContext)
  expect(frozen.systemContext).toContain(AGENTMUX_AGENT_MESSAGING_ENTRY)
  await h.wake(); await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
  expect(h.delivery().systemContext).toBe(frozen.systemContext)
  expect(h.delivery().reason).toBe('original-input-delivery-unconfirmed')
  const { reader, inner, packet } = await automaticReader(h)
  await expect.poll(() => inner.recovery.continuityInputs.tails.size).toBe(0)
  expect(packet()).toMatchObject({ phase: 'unknown', key: frozen.key, systemContext: frozen.systemContext, reason: 'original-input-delivery-unconfirmed' })
  expect((await reader.inspectAgentPromptSubmission(frozen.key))?.admission?.intent?.prompt).toBe(record?.admission?.intent?.prompt)
  expect(h.inner.kernel.input).toHaveBeenCalledOnce(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('preserves the previous automatic packet without recomputing context when a new Core owner reads it', async () => {
  const previous = await previousWireCore({ resumeWithoutGuidance: true }); cleanups.push(previous.close)
  const h = await automaticFixture({ ready: false, owner: previous.owner })
  await expect.poll(() => h.inner.recovery.continuityInputs.tails.size).toBe(0)
  const frozen = structuredClone(h.delivery())
  expect(frozen.phase).toBe('waiting'); expect(frozen.systemContext).toBeUndefined()
  expect(frozen.reminder.selected).toBe(false); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  h.setReady()
  const { reader } = await automaticReader(h)
  await expect.poll(() => reader.agentSession('original-session').continuityOperations!['automatic-original']!.recoveryDelivery!.phase).toBe('accepted')
  const packet = reader.agentSession('original-session').continuityOperations!['automatic-original']!.recoveryDelivery!
  const record = await reader.inspectAgentPromptSubmission(packet.key)
  expect(packet.key).toEqual(frozen.key); expect(packet.systemContext).toBeUndefined()
  expect(record?.admission?.intent?.prompt).toBe(frozen.continuation.text)
  expect(record?.admission?.intent?.message?.systemContext).toBeUndefined()
  expect(h.started).toHaveLength(1); expect(h.inner.kernel.input).toHaveBeenCalledOnce(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})
