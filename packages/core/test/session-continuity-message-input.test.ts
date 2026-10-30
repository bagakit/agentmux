import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { defineRun } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import { assertPreparedResumeBinding } from '../src/agent-prepared-resume.js'
import type { AgentInputSubmissionReceipt } from '../src/agent-input-wait.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentExternalMessageAuthor } from '../src/external-author.js'
import type { AgentMuxMessageEnvelope } from '../src/agent-message-envelope.js'
import type { AgentProvider } from '../src/agent-provider.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** Same real Client/Store/journal fixture as the fresh-input launch suite.
 * Only Runtime, executable discovery, and Hook/terminal leaf observations are controlled. */
async function fixture(options: { providerId?: 'grok' | 'gemini'; postLaunch?: boolean; managedPostLaunch?: boolean;
  lostStart?: boolean; noRun?: boolean; failedStart?: boolean; intent?: 'manual-actor' | 'session-conversation' | 'native-conversation';
  nativeDelivery?: boolean; expectedTurnId?: string; nativeSessionId?: string; oldRunning?: boolean } = {}) {
  const providerId = options.providerId ?? 'grok'
  const h = await rpcOwnerFixture(['recipient'], { AgentMuxClient, AgentMuxFileAgentSessionStore }, () => ({ providerId, executorId: providerId,
    nativeHandle: { kind: 'provider', providerId, sessionId: 'native-original' } }))
  const core = h.client as any, builtin = h.client.providers.get(providerId)
  const nativeSend = vi.fn(async (_prompt: string, plan: { expectedTurnId?: string }) => ({ outcome: 'admitted' as const,
    turnId: plan.expectedTurnId ?? 'original-native-turn' }))
  const nativePrepare = vi.fn<NonNullable<AgentProvider['prepareNativeInput']>>(async (context, target) => {
    expect(context.processId).toBe(1234)
    expect(context.nativeHandle).toMatchObject({ kind: 'provider', providerId, sessionId: 'native-original' })
    if (target.providerId !== providerId || target.nativeSessionId !== 'native-original') throw new AgentMuxError('Original native source is not loaded', 'AGENT_NATIVE_INPUT_UNAVAILABLE')
    return { plan: { kind: 'native-rpc', protocolId: 'fixture-native', sourceId: JSON.stringify([target.providerId, target.nativeSessionId]),
      actorId: 'original-native-actor', threadId: target.nativeSessionId, ...(target.expectedTurnId === undefined
        ? { operation: 'start-or-steer' as const } : { operation: 'steer' as const, expectedTurnId: target.expectedTurnId }) },
      assertCurrent: async () => {}, send: nativeSend, dispose: async () => {} }
  })
  const provider = { ...builtin, catalog: { ...builtin.catalog, ...(options.postLaunch ? { promptDelivery: 'post-launch-only' as const } : {}) },
    ...(options.nativeDelivery ? { prepareNativeInput: nativePrepare } : {}),
    prepareManagedLaunch: async (plan: any, _id: string, context: { prompt?: string }) => options.managedPostLaunch
      ? { plan: { ...plan, args: plan.args.filter((arg: string) => arg !== context.prompt && arg !== '--') }, promptDelivery: 'post-launch' as const }
      : { plan } }
  h.client.providers.replace(provider)
  const previousRun = { runId: 'run-recipient' }, newRun = { runId: 'message-resumed-run' }
  const started: any[] = []
  let failedStart = options.failedStart === true, authorized = true
  const currentRun = () => ({ ...h.run(newRun.runId), ...(options.nativeDelivery ? { pid: 1234 } : {}), program: started[0]?.program ?? provider.executable,
    args: started[0]?.args ?? [], lifecycleOperationId: started[0]?.operationKey ?? null })
  core.kernel.launchIdentity = ({ program, args }: { program: string; args: readonly string[] }) => ({ program,
    argsDigest: createHash('sha256').update(JSON.stringify(args)).digest('base64url') })
  core.kernel.status = vi.fn(async (id: string) => id === previousRun.runId
    ? { ...h.run(id), ...(options.nativeDelivery ? { pid: 1234 } : {}), state: options.oldRunning ? { type: 'running' } : { type: 'exited', code: 0, signal: null } } : currentRun())
  core.kernel.list = vi.fn(async () => options.noRun ? [] : started.length ? [currentRun()] : [])
  core.kernel.inspectCreation = vi.fn(async (id: string) => options.noRun || started[0]?.operationKey !== id ? null : currentRun())
  core.kernel.start = vi.fn(async (spec: any) => {
    if (failedStart) throw new AgentMuxError('Exact Start was refused before process creation', 'CTXMUX_START_REJECTED', undefined, undefined, undefined,
      { operationId: spec.operationKey, disposition: 'not_applied' })
    started.push(spec)
    if (options.lostStart) throw new AgentMuxError('Applied Start lost its ACK', 'CTXMUX_START_UNKNOWN', undefined, { disposition: 'unknown', confirmedInputBytes: null })
    return currentRun()
  })
  core.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'original-fixture-runtime', instanceId: 'fixture-instance', buildIdentity: 'fixture', protocolVersion: 1 })
  core.kernel.prepareStart = (input: any) => defineRun(input.program, { args: input.args, cwd: input.cwd, env: input.env,
    initialSize: { cols: input.cols ?? 80, rows: input.rows ?? 24 } })
  core.kernel.startPrepared = vi.fn(async (request: any, operationKey: string) => core.kernel.start({ program: request.program, args: request.args,
    cwd: request.cwd, env: request.env, operationKey }))
  core.kernel.inspectPreparedStart = vi.fn(async (request: any, operationKey: string) => {
    const run = await core.kernel.inspectCreation(operationKey)
    if (run && (request.program !== run.program || JSON.stringify(request.args) !== JSON.stringify(run.args))) throw new Error('Fixture observed another prepared launch')
    return run
  })
  core.probePreparedAgent = vi.fn(async () => ({ providerId, executable: provider.executable, installed: true, capabilities: provider.catalog.capabilities }))
  core.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxStoredAgentSession) => session
  core.hookServer.isRunning = () => true
  core.hookServer.createBinding = (_session: string, _provider: string, bindingId: string) => ({ bindingId, endpoint: { url: 'http://127.0.0.1:0', token: 'token'.padEnd(43, 'T') }, bindRun: async () => {}, close: async () => {} })
  vi.spyOn(core.screenEvidence, 'wait').mockResolvedValue(1)
  const external: AgentExternalMessageAuthor = { kind: 'external', connectionId: 'original-connection',
    actor: { application: { domain: 'example.test', appId: 'app' }, idType: 'user-id', userId: 'original-author' },
    externalConversationId: 'private-chat', externalMessageId: 'native-message', bindingId: 'original-binding', bindingRevision: 1,
    grantId: 'original-grant', grantRevision: 1 }
  const context = { externalAuthor: { identity: external, assertCurrent: vi.fn(async () => {
    if (!authorized) throw new AgentMuxError('Original author authorization was revoked', 'EXTERNAL_AUTHORITY_REVOKED')
  }) } }
  const envelope: AgentMuxMessageEnvelope = { schema: 'agentmux.a2a.v1', messageId: 'original-message', operationId: 'original-control', createdAt: 1,
    sender: external, recipient: { kind: 'agent-session', agentSessionId: 'recipient' }, senderSessionId: null, senderRunId: null,
    recipientSessionId: 'recipient', recipientRunId: previousRun.runId, threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null,
    body: '--literal message\n保留完整多行原文\nFinal line.' }
  core.connected = false
  const saved = await h.client.submitAgentMessage({ agentSessionId: 'recipient', envelope, execution: 'immediate',
    admissionIntent: options.intent === 'native-conversation' ? { kind: 'native-conversation', expectedRun: previousRun,
      source: { providerId, nativeSessionId: options.nativeSessionId ?? 'native-original' }, ...(options.expectedTurnId ? { expectedTurnId: options.expectedTurnId } : {}) }
      : { kind: options.intent ?? 'manual-actor', expectedRun: previousRun } }, context) as AgentInputSubmissionReceipt
  await settleWaiting(core)
  expect(saved.status).toBe('waiting'); expect(core.kernel.input).not.toHaveBeenCalled()
  core.connected = true
  const request = { agentSessionId: 'recipient', expectedRun: previousRun, operationId: 'original-message-resume', trigger: 'input' as const,
    messageInputRef: saved.ref, policy: { recheckMaxAttempts: 0 } }
  const op = () => h.client.agentSession('recipient').continuityOperations?.[request.operationId]
  return { ...h, core, provider, previousRun, newRun, started, currentRun, saved, context, request, op, nativeSend, nativePrepare,
    revoke: () => { authorized = false }, acceptStart: () => { failedStart = false } }
}

async function settleWaiting(core: any) {
  for (;;) {
    if (core.inputWaitingRestore) await core.inputWaitingRestore
    const pending = [...core.inputWaitingRecipients.values()] as { pending: Promise<void> }[]
    if (!pending.length && !core.inputWaitingRestore) return
    await Promise.all(pending.map(value => value.pending))
  }
}

it.each([{ providerId: 'grok' as const, intent: 'manual-actor' as const }, { providerId: 'gemini' as const, intent: 'session-conversation' as const }])(
  'carries the saved message through $providerId resume argv with its original $intent owner and no PTY input', async options => {
    const h = await fixture(options)
    try {
      const result = await h.client.ensureAgentContinuity(h.request, h.context)
      expect(result.kind, JSON.stringify(result)).toBe('resumed')
      const recipe = h.op()!.messageInput!
      expect(recipe.ref).toEqual(h.saved.ref); expect(recipe.key).toEqual(h.saved.key)
      const journal = await h.core.messageQueue.inspectInput({ key: h.saved.key })
      expect(recipe.prompt).toBe(journal.intent.source.promptWire)
      expect(h.op()!.launchInput).toBeUndefined(); expect(recipe).not.toHaveProperty('outcome')
      const nativeArgs = h.provider.buildResumeLaunch({ workspacePath: h.root, nativeHandle: { kind: 'provider', providerId: options.providerId, sessionId: 'native-original' }, prompt: recipe.prompt, args: [], env: {} }).args
      expect(h.started).toHaveLength(1); expect(h.started[0].args).toEqual(nativeArgs)
      expect(h.started[0].args).toContain(recipe.prompt)
      const record = await h.client.inspectAgentInput({ key: h.saved.key })
      expect(record).toMatchObject({ key: h.saved.key, ref: h.saved.ref, status: 'launch-carried', control: { state: 'dispatch-authorized' },
        admission: { run: h.previousRun, admission: { transport: 'launch', inputKey: h.saved.key, acknowledged: true,
          intent: { run: h.previousRun, prompt: recipe.prompt, message: recipe.message }, launch: { outcome: 'launch-carried',
            receipt: { kind: 'runtime-launch', operationId: h.started[0].operationKey, run: h.newRun } } } } })
      expect(record!.control.deliveryKey).toBeUndefined()
      await h.client.ensureAgentContinuity(h.request, h.context)
      await settleWaiting(h.core)
      expect(h.started).toHaveLength(1); expect(h.core.kernel.input).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

it('reconciles the exact applied Start after a lost ACK in a new Client without another Start or message', async () => {
  const h = await fixture({ lostStart: true }); let reader: AgentMuxClient | undefined
  try {
    expect((await h.client.ensureAgentContinuity(h.request, h.context)).kind).toBe('pending')
    expect(await h.client.inspectAgentInput({ key: h.saved.key })).toMatchObject({ status: 'unknown', admission: { admission: { launch: { outcome: 'unknown' } } } })
    const correlation = (await h.store.loadResumeCorrelation('recipient', h.op()!.messageInput!.lifecycleOperationId))!
    const preparedSession = correlation.preparedSession!, pending = preparedSession.continuity!.messageInput!
    expect(pending).toMatchObject({ ref: h.saved.ref, key: h.saved.key, plan: { kind: 'runtime-launch',
      lifecycleOperationId: h.started[0].operationKey, nativeTarget: { kind: 'provider', providerId: 'grok', sessionId: 'native-original' } } })
    expect(pending.plan!.argsDigest).toBe(createHash('sha256').update(JSON.stringify(h.started[0].args)).digest('base64url'))
    // Qualify the actual durable dispatch, then reject each substituted binding
    // before that retained request can authorize another lifecycle projection.
    expect(() => assertPreparedResumeBinding(correlation.preparedDispatch!.prepared, preparedSession, correlation.operationId)).not.toThrow()
    for (const substituted of [{ program: 'another-program' }, { argsDigest: 'another-argv' },
      { lifecycleOperationId: 'another-operation' }, { nativeTarget: { ...pending.plan!.nativeTarget, sessionId: 'another-native-session' } }]) {
      const changed = { ...preparedSession, continuity: { ...preparedSession.continuity!,
        messageInput: { ...pending, plan: { ...pending.plan!, ...substituted } } } }
      expect(() => assertPreparedResumeBinding(correlation.preparedDispatch!.prepared, changed, correlation.operationId))
        .toThrow(expect.objectContaining({ code: 'INVALID_AGENT_SESSION_STORE' }))
    }
    reader = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path) })
    const core = reader as any; await core.registry.load('local'); core.connected = true
    core.kernel.isConnected = () => true; core.kernel.status = h.core.kernel.status; core.kernel.list = h.core.kernel.list; core.kernel.inspectCreation = h.core.kernel.inspectCreation
    core.kernel.inspectPreparedStart = h.core.kernel.inspectPreparedStart
    core.kernel.start = vi.fn(); core.kernel.input = vi.fn()
    core.recovery.lifecycle.restoreReopenObservation = async () => {}; core.ensureTerminalHandshakeOrDegrade = h.core.ensureTerminalHandshakeOrDegrade
    expect((await reader.ensureAgentContinuity(h.request)).kind).toBe('resumed')
    expect(reader.agentSession('recipient').continuityOperations![h.request.operationId]!.messageInput).toEqual(pending)
    expect(await reader.inspectAgentInput({ key: h.saved.key })).toMatchObject({ status: 'launch-carried', key: h.saved.key,
      admission: { run: h.previousRun, admission: { launch: { receipt: { run: h.newRun } } } } })
    expect(h.started).toHaveLength(1); expect(core.kernel.start).not.toHaveBeenCalled(); expect(core.kernel.input).not.toHaveBeenCalled()
  } finally { await reader?.dispose(); await h.close() }
})

it('keeps an unresolved Start and the original input unknown without replay', async () => {
  const h = await fixture({ lostStart: true, noRun: true })
  try {
    await h.client.ensureAgentContinuity(h.request, h.context)
    await h.client.ensureAgentContinuity(h.request)
    expect(await h.client.inspectAgentInput({ key: h.saved.key })).toMatchObject({ status: 'unknown', key: h.saved.key,
      admission: { admission: { launch: { outcome: 'unknown' } } } })
    expect(h.started).toHaveLength(1); expect(h.core.kernel.input).not.toHaveBeenCalled()
    expect(h.op()!.newRun).toBeUndefined()
  } finally { await h.close() }
})

it.each(['stop', 'revoke'] as const)('does not Start when the original input %s wins after recipe preparation', async action => {
  const h = await fixture()
  try {
    const probe = h.core.probePreparedAgent.getMockImplementation()
    h.core.probePreparedAgent.mockImplementationOnce(async (...args: unknown[]) => {
      if (action === 'stop') await h.client.stopAgentInputWaiting({ ref: h.saved.ref, cancelOperationId: 'stop-before-start' })
      else h.revoke()
      return await probe(...args)
    })
    await h.client.ensureAgentContinuity(h.request, h.context)
    const original = await h.client.inspectAgentInput({ key: h.saved.key })
    expect(original?.status).toBe(action === 'stop' ? 'stopped' : 'waiting')
    expect(original?.admission).toBeNull(); expect(h.core.kernel.start).not.toHaveBeenCalled(); expect(h.core.kernel.input).not.toHaveBeenCalled()
    expect(await h.store.readLifecycleReservation('recipient')).toBeNull()
  } finally { await h.close() }
})

it('settles the durable claim not-applied when its original author is revoked before Start', async () => {
  const h = await fixture()
  try {
    const recordAccepted = h.core.recordAcceptedInput.bind(h.core)
    vi.spyOn(h.core, 'recordAcceptedInput').mockImplementationOnce(async (...args: unknown[]) => {
      expect((await h.client.inspectAgentPromptSubmission(h.saved.key))?.admission).toMatchObject({ transport: 'launch', launch: { outcome: 'claimed' } })
      await recordAccepted(...args)
      h.revoke()
    })
    await h.client.ensureAgentContinuity(h.request, h.context)
    expect(await h.client.inspectAgentInput({ key: h.saved.key })).toMatchObject({ key: h.saved.key, status: 'not-applied',
      admission: { run: h.previousRun, admission: { transport: 'launch', notApplied: true, launch: { outcome: 'not-applied' } } } })
    expect(h.client.agentSession('recipient').run).toEqual(h.previousRun); expect(h.op()?.newRun).toBeUndefined()
    expect(h.started).toHaveLength(0); expect(h.core.kernel.input).not.toHaveBeenCalled()
    expect(await h.store.readLifecycleReservation('recipient')).toBeNull()
  } finally { await h.close() }
})

it.each(['catalog', 'managed'] as const)('preserves the ordinary waiting owner when %s delivery requires post-launch input', async path => {
  const h = await fixture({ postLaunch: path === 'catalog', managedPostLaunch: path === 'managed' })
  try {
    const postLaunch = vi.spyOn(h.core, 'deliverPostLaunchPrompt')
    expect((await h.client.ensureAgentContinuity(h.request, h.context)).kind).toBe('resumed')
    expect(h.op()!.messageInput!.plan).toBeUndefined(); expect(h.op()!.launchInput).toBeUndefined()
    expect(h.started).toHaveLength(1); expect(h.started[0].args).not.toContain(h.op()!.messageInput!.prompt)
    expect(postLaunch).not.toHaveBeenCalled()
    const original = await h.client.inspectAgentInput({ key: h.saved.key })
    expect(original?.key).toEqual(h.saved.key)
    expect(original?.admission?.admission?.transport).not.toBe('launch')
  } finally { await h.close() }
})

it.each(['catalog', 'managed'] as const)('continues the original session-conversation owner after %s empty resume', async path => {
  const h = await fixture({ postLaunch: path === 'catalog', managedPostLaunch: path === 'managed', intent: 'session-conversation', nativeDelivery: true })
  try {
    expect((await h.client.ensureAgentContinuity(h.request, h.context)).kind).toBe('resumed')
    const recipe = h.op()!.messageInput!
    expect(recipe.admissionIntent).toEqual({ kind: 'session-conversation', expectedRun: h.previousRun })
    expect(recipe.plan).toBeUndefined(); expect(h.started[0].args).not.toContain(recipe.prompt)
    await h.client.rejoinAgentInputWaiting({ ref: h.saved.ref }, h.context); await settleWaiting(h.core)
    const observed = await h.client.inspectAgentInput({ key: h.saved.key })
    expect(observed, JSON.stringify(observed?.control.waiting)).toMatchObject({ key: h.saved.key, status: 'admitted',
      control: { deliveryKey: { ...h.saved.key, expectedRun: h.newRun } }, admission: { admission: { transport: 'native', native: { outcome: 'admitted' } } } })
    expect(h.nativeSend).toHaveBeenCalledTimes(1); expect(h.nativeSend.mock.calls[0]![0]).toBe(recipe.prompt)
    expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it.each([undefined, 'original-selected-turn'])('empty resumes explicit native input and preserves its original turn target %s', async expectedTurnId => {
  const h = await fixture({ intent: 'native-conversation', nativeDelivery: true, expectedTurnId })
  try {
    expect((await h.client.ensureAgentContinuity(h.request, h.context)).kind).toBe('resumed')
    const recipe = h.op()!.messageInput!
    expect(recipe.admissionIntent).toEqual({ kind: 'native-conversation', expectedRun: h.previousRun,
      source: { providerId: 'grok', nativeSessionId: 'native-original' }, ...(expectedTurnId ? { expectedTurnId } : {}) })
    expect(recipe.plan).toBeUndefined(); expect(h.started[0].args).not.toContain(recipe.prompt)
    await h.client.rejoinAgentInputWaiting({ ref: h.saved.ref }, h.context); await settleWaiting(h.core)
    const observed = await h.client.inspectAgentInput({ key: h.saved.key })
    expect(observed, JSON.stringify(observed?.control.waiting)).toMatchObject({ key: h.saved.key, status: 'admitted',
      admission: { admission: { transport: 'native', native: { plan: { threadId: 'native-original',
        operation: expectedTurnId ? 'steer' : 'start-or-steer', ...(expectedTurnId ? { expectedTurnId } : {}) }, outcome: 'admitted' } } } })
    expect(h.nativeSend).toHaveBeenCalledTimes(1); expect(h.nativeSend.mock.calls[0]![0]).toBe(recipe.prompt)
    await h.client.rejoinAgentInputWaiting({ ref: h.saved.ref }, h.context); await settleWaiting(h.core)
    expect(h.nativeSend).toHaveBeenCalledTimes(1); expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('preserves healthy native input and refuses to recover a selected source outside the original native Session', async () => {
  const healthy = await fixture({ intent: 'native-conversation', nativeDelivery: true, oldRunning: true })
  try {
    await healthy.client.rejoinAgentInputWaiting({ ref: healthy.saved.ref }, healthy.context); await settleWaiting(healthy.core)
    expect(await healthy.client.inspectAgentInput({ key: healthy.saved.key })).toMatchObject({ status: 'admitted' })
    expect(healthy.nativeSend).toHaveBeenCalledTimes(1); expect(healthy.started).toHaveLength(0)
    expect(healthy.core.kernel.input).not.toHaveBeenCalled(); expect(healthy.core.kernel.stop).not.toHaveBeenCalled()
  } finally { await healthy.close() }
  const other = await fixture({ intent: 'native-conversation', nativeDelivery: true, nativeSessionId: 'another-native-source' })
  try {
    await expect(other.client.ensureAgentContinuity(other.request, other.context)).rejects.toMatchObject({ code: 'AGENT_PROMPT_SOURCE_CHANGED' })
    expect((await other.client.inspectAgentInput({ key: other.saved.key }))?.admission).toBeNull()
    expect(other.started).toHaveLength(0); expect(other.nativeSend).not.toHaveBeenCalled(); expect(other.core.kernel.input).not.toHaveBeenCalled()
  } finally { await other.close() }
})

it('retains the Runtime refusal under the old key and requires a new recovery operation for the explicitly authorized retry', async () => {
  const h = await fixture({ failedStart: true })
  try {
    await h.client.ensureAgentContinuity(h.request, h.context)
    expect(await h.client.inspectAgentInput({ key: h.saved.key })).toMatchObject({ status: 'not-applied', admission: { admission: { launch: { outcome: 'not-applied' } } } })
    const retry = await h.client.rejoinAgentInputWaiting({ ref: h.saved.ref }, h.context)
    expect(retry.ref.waitGeneration).toBeGreaterThan(h.saved.ref.waitGeneration)
    await expect(h.client.ensureAgentContinuity({ ...h.request, messageInputRef: retry.ref }, h.context)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    h.acceptStart()
    const request = { ...h.request, operationId: 'original-message-resume-retry', messageInputRef: retry.ref }
    expect((await h.client.ensureAgentContinuity(request, h.context)).kind).toBe('resumed')
    const recipe = h.client.agentSession('recipient').continuityOperations![request.operationId]!.messageInput!
    expect(recipe.ref.key).toEqual(h.saved.key); expect(recipe.key.expectedRun).toEqual(h.previousRun); expect(recipe.key.attemptId).toBeTruthy()
    expect((await h.client.inspectAgentPromptSubmission(h.saved.key))?.admission).toMatchObject({ launch: { outcome: 'not-applied' } })
    expect((await h.client.inspectAgentPromptSubmission(recipe.key))?.admission).toMatchObject({ launch: { outcome: 'launch-carried', receipt: { run: h.newRun } } })
    expect(h.started).toHaveLength(1); expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('keeps the healthy resumed Run when input receipt persistence fails and repairs it through the same public operation', async () => {
  const h = await fixture(); let reader: AgentMuxClient | undefined
  try {
    vi.spyOn(h.store, 'settlePromptAdmission').mockRejectedValueOnce(new Error('Original receipt storage unavailable'))
    expect((await h.client.ensureAgentContinuity(h.request, h.context)).kind).toBe('resumed')
    expect(h.client.agentSession('recipient').run).toEqual(h.newRun)
    expect((await h.client.inspectAgentInput({ key: h.saved.key }))?.status).toBe('unknown')
    reader = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path) })
    const core = reader as any; await core.registry.load('local'); core.connected = true
    core.kernel.isConnected = () => true; core.kernel.status = h.core.kernel.status; core.kernel.start = vi.fn(); core.kernel.input = vi.fn()
    expect((await reader.ensureAgentContinuity(h.request)).kind).toBe('resumed')
    expect((await reader.inspectAgentInput({ key: h.saved.key }))?.status).toBe('launch-carried')
    expect(h.started).toHaveLength(1); expect(core.kernel.start).not.toHaveBeenCalled(); expect(core.kernel.input).not.toHaveBeenCalled()
  } finally { await reader?.dispose(); await h.close() }
})

it.each([false, true])('durable native gate continues only its frozen original plan (changed preparation=%s)', async changed => {
  const h = await fixture({ nativeDelivery: true, oldRunning: true, intent: 'native-conversation' })
  try {
    const queue = h.core.messageQueue, originalGate = queue.authorizeInputDispatch.bind(queue)
    vi.spyOn(queue, 'authorizeInputDispatch').mockImplementationOnce(async (...args: unknown[]) => { await originalGate(...args); throw Error('Native gate committed before original claim') })
    await h.client.rejoinAgentInputWaiting({ ref: h.saved.ref }, h.context); await settleWaiting(h.core)
    const before = (await h.client.inspectAgentInput({ key: h.saved.key }))!
    expect(before).toMatchObject({ status: 'unknown', admission: null, control: { handoff: { carrier: { kind: 'native', plan: { kind: 'native-rpc', threadId: 'native-original' } } } } })
    expect(h.nativeSend).not.toHaveBeenCalled()
    vi.spyOn(h.provider, 'planPromptInput').mockImplementation(() => { throw Error('Original native carrier cannot be reselected') })
    if (changed) {
      const prepare = h.nativePrepare.getMockImplementation()!
      h.nativePrepare.mockImplementation(async (...args) => { const next = await prepare(...args); return { ...next, plan: { ...next.plan, actorId: 'different-native-actor' } } })
    }
    await h.client.rejoinAgentInputWaiting({ ref: h.saved.ref }, h.context); await settleWaiting(h.core)
    const after = await h.client.inspectAgentInput({ key: h.saved.key })
    expect(after, JSON.stringify(after)).toMatchObject({ key: before.key, ref: before.ref, control: before.control, status: changed ? 'unknown' : 'admitted' })
    expect(h.nativeSend).toHaveBeenCalledTimes(changed ? 0 : 1)
    expect(h.core.kernel.input).not.toHaveBeenCalled(); expect(h.started).toEqual([])
    await h.client.rejoinAgentInputWaiting({ ref: h.saved.ref }, h.context); await settleWaiting(h.core)
    expect(h.nativeSend).toHaveBeenCalledTimes(changed ? 0 : 1)
  } finally { await h.close() }
})

it('durable launch gate first uses only its original retained prepared Start and never a replacement carrier', async () => {
  const h = await fixture()
  try {
    const queue = h.core.messageQueue, originalGate = queue.authorizeInputDispatch.bind(queue)
    vi.spyOn(queue, 'authorizeInputDispatch').mockImplementationOnce(async (...args: unknown[]) => { await originalGate(...args); throw Error('Launch gate committed before original claim') })
    await h.client.ensureAgentContinuity(h.request, h.context)
    const before = (await h.client.inspectAgentInput({ key: h.saved.key }))!
    expect(before).toMatchObject({ status: 'unknown', admission: null, control: { handoff: { carrier: { kind: 'launch', lifecycleOperationId: h.op()!.messageInput!.lifecycleOperationId } } } })
    const carrier = before.control.handoff!.carrier
    expect(carrier.kind).toBe('launch'); if (carrier.kind !== 'launch') throw Error('Original launch pointer missing')
    expect(Object.keys(carrier).sort()).toEqual(['kind', 'lifecycleOperationId', 'reservationId'])
    const reservation = (await h.store.loadResumeCorrelation('recipient', carrier.lifecycleOperationId))!
    expect(reservation.reservationId).toBe(carrier.reservationId)
    expect(h.started).toEqual([])
    await h.client.rejoinAgentInputWaiting({ ref: h.saved.ref }, h.context); await settleWaiting(h.core)
    expect(await h.client.inspectAgentInput({ key: h.saved.key })).toMatchObject({ status: 'launch-carried', key: before.key, ref: before.ref, control: before.control })
    expect(h.started).toHaveLength(1)
    expect(h.started[0].operationKey).toBe(carrier.lifecycleOperationId)
    expect(h.started[0].args).toContain(h.op()!.messageInput!.prompt)
    expect(h.core.kernel.input).not.toHaveBeenCalled()
    await h.client.rejoinAgentInputWaiting({ ref: h.saved.ref }, h.context); await settleWaiting(h.core)
    expect(h.started).toHaveLength(1)
  } finally { await h.close() }
})

it.each(['revoke', 'cancel'] as const)('a held remote launch author read leaves another Session journal/input usable and late %s cannot Start', async action => {
  const h = await fixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const atRead = new Promise<void>(resolve => { entered = resolve })
  let afterGate = false, stoppedAtRead = false
  let running: Promise<unknown> | undefined
  try {
    const original = (await h.store.readMetadata('recipient'))!
    await h.store.compareAndSwap(null, { ...original, agentSessionId: 'independent', run: { runId: 'independent-run' }, nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: 'independent-native' } })
    await h.core.registry.load('local')
    const status = h.core.kernel.status.bind(h.core.kernel)
    h.core.kernel.status = vi.fn(async (id: string) => id === 'independent-run' ? h.run(id) : await status(id))
    vi.spyOn(h.provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
    const gate = h.core.messageQueue.authorizeInputDispatch.bind(h.core.messageQueue)
    vi.spyOn(h.core.messageQueue, 'authorizeInputDispatch').mockImplementation(async (...args: unknown[]) => { afterGate = true; return await gate(...args) })
    const author = h.context.externalAuthor.assertCurrent.getMockImplementation()!
    h.context.externalAuthor.assertCurrent.mockImplementation(async () => {
      if (afterGate && !stoppedAtRead) { stoppedAtRead = true; entered(); await held }
      return await author()
    })
    running = h.client.ensureAgentContinuity(h.request, h.context)
    await atRead
    let persisted = false
    const independent = h.client.submitAgentPrompt({ agentSessionId: 'independent', expectedRun: { runId: 'independent-run' },
      operationId: 'independent-local-author', prompt: 'Independent input while foreign author is held', authorHuman: true,
      execution: 'immediate', admissionIntent: { kind: 'manual-actor' } }).then(() => { persisted = true })
    await vi.waitFor(() => expect(persisted, 'another Session must retain original input without waiting for foreign authority').toBe(true), { timeout: 1500 })
    await independent
    await vi.waitFor(() => expect(h.core.kernel.input, 'another Session normal input must progress').toHaveBeenCalledOnce(), { timeout: 1500 })
    if (action === 'revoke') h.revoke()
    else await h.client.stopAgentInputWaiting({ ref: h.saved.ref, cancelOperationId: 'stop-exact-author-observation' })
    if (action === 'cancel') {
      await vi.waitFor(async () => expect((await h.client.inspectAgentInput({ key: h.saved.key }))?.status).toBe('not-applied'), { timeout: 1500 })
      expect(h.started).toEqual([])
    }
    release(); await running; running = undefined
    expect(h.started).toEqual([])
    expect(await h.client.inspectAgentInput({ key: h.saved.key })).toMatchObject({ status: 'not-applied' })
  } finally { release(); await running?.catch(() => {}); await h.close() }
}, 25_000)

it.each(['native', 'launch'] as const)('the live %s gate writer excludes a second Session claim callback before any effect', async mode => {
  const h = await fixture(mode === 'native' ? { nativeDelivery: true, oldRunning: true, intent: 'native-conversation' } : {})
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const gate = h.core.messageQueue.authorizeInputDispatch.bind(h.core.messageQueue)
  vi.spyOn(h.core.messageQueue, 'authorizeInputDispatch').mockImplementationOnce(async (...args: unknown[]) => { const link = await gate(...args); enter(); await held; return link })
  let running: Promise<unknown> | undefined
  try {
    running = mode === 'native' ? h.client.rejoinAgentInputWaiting({ ref: h.saved.ref }, h.context) : h.client.ensureAgentContinuity(h.request, h.context)
    await entered
    let anotherClaim = false
    await expect(h.store.withPromptSubmission('recipient', async () => { anotherClaim = true })).rejects.toMatchObject({ code: 'AGENT_PROMPT_SUBMISSION_BUSY' })
    expect(anotherClaim).toBe(false); expect(h.nativeSend).not.toHaveBeenCalled(); expect(h.started).toEqual([])
  } finally { release(); await running?.catch(() => {}); await settleWaiting(h.core); await h.close() }
})

it.each(['missing', 'different'] as const)('an unavailable or %s original launch reservation preserves its gate without another Start', async state => {
  const h = await fixture()
  try {
    const gate = h.core.messageQueue.authorizeInputDispatch.bind(h.core.messageQueue)
    vi.spyOn(h.core.messageQueue, 'authorizeInputDispatch').mockImplementationOnce(async (...args: unknown[]) => { await gate(...args); throw Error('Original prepared launch gate retained before claim') })
    await h.client.ensureAgentContinuity(h.request, h.context)
    const before = (await h.client.inspectAgentInput({ key: h.saved.key }))!
    expect(before).toMatchObject({ status: 'unknown', admission: null, control: { handoff: { carrier: { kind: 'launch' } } } })
    const load = h.store.loadResumeCorrelation.bind(h.store)
    vi.spyOn(h.store, 'loadResumeCorrelation').mockImplementation(async (...args) => {
      const original = await load(...args)
      return state === 'missing' || !original ? null : { ...original, reservationId: 'different-original-reservation' }
    })
    await h.client.rejoinAgentInputWaiting({ ref: h.saved.ref }, h.context); await settleWaiting(h.core)
    expect(await h.client.inspectAgentInput({ key: h.saved.key })).toMatchObject({ key: before.key, ref: before.ref, control: before.control, status: 'unknown', admission: null })
    expect(h.started).toEqual([]); expect(h.nativeSend).not.toHaveBeenCalled(); expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})
