import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DOMParser } from '@xmldom/xmldom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient as DefaultClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { DurableAgentMuxMessageQueue, type AgentMuxMessageEnvelope } from '../src/agent-global-message-queue.js'
import { agentPromptCondition, agentPromptNotApplied } from '../src/agent-prompt-condition.js'
import { AgentMuxError } from '../src/errors.js'
import { hashAgentCapability, issueAgentCapability } from '../src/agent-capability.js'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE } from '../src/agent-messaging-guidance.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

const Client: typeof DefaultClient = process.env.AGENTMUX_TEST_A2A_CLIENT
  ? (await import(process.env.AGENTMUX_TEST_A2A_CLIENT)).AgentMuxClient : DefaultClient
const disposals: (() => Promise<void>)[] = []
const roots: string[] = []
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.restoreAllMocks(); vi.unstubAllEnvs() })
type Internals = {
  connected: boolean; registry: { load(host: string): Promise<void> }; kernel: Record<string, unknown>
  hookServer: Record<string, unknown>; ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown
  promptSubmission: { submitInputPlan: unknown }; messageQueue: DurableAgentMuxMessageQueue
}
const body = '  unchanged <body> & "quotes"\nSecond line.  '
function agentMuxContext(outbound: unknown): string {
  if (typeof outbound !== 'string') throw new Error('Expected the original outbound text')
  expect(outbound.startsWith('<amux from="amux">')).toBe(true)
  const end = outbound.indexOf('</amux>')
  expect(end).toBeGreaterThan(0)
  // Only the platform context is XML; the following authored body remains literal text.
  return new DOMParser().parseFromString(outbound.slice(0, end + '</amux>'.length), 'application/xml')
    .documentElement!.textContent ?? ''
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-a2a-owner-'))
  roots.push(root)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const capability = issueAgentCapability()
  for (const id of ['sender', 'recipient']) await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId: id, providerId: 'traex', executorId: 'traex', hostId: 'local', workspacePath: root,
    run: { runId: `${id}-run` }, retiredRuns: [], hookBindingId: `hook-${id}`, hookToken: `token-${id}`,
    ...(id === 'sender' ? { capabilityHash: hashAgentCapability(capability) } : {}), createdAt: 1, updatedAt: 1
  })
  const client = new Client({ store }), inner = client as unknown as Internals
  const accepted = new Map<string, { run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number } }>()
  const cursor = new Map<string, number>(), writes: string[] = [], events: AgentMuxClientEvent[] = []
  const run = (runId = 'initial-run'): CtxmuxAdapterRun => ({ nativeService: null, runId, lifecycleOperationId: null, program: 'fixture', args: [],
    workspacePath: root, pid: 123, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0,
    firstAvailableByte: 0, acceptedInputBytes: cursor.get(runId) ?? 0 })
  const configure = async (owner: DefaultClient) => {
    const internals = owner as unknown as Internals
    await internals.registry.load('local'); internals.connected = true
    internals.kernel.isConnected = () => true
    internals.kernel.identity = () => ({ daemonInstanceId: 'private-fixture', protocolVersion: 21, buildIdentity: 'fixture' })
    internals.kernel.status = async (id: string) => run(id)
    internals.kernel.input = async (id: string, operation: { operationId: string; expectedByte: number; data: string }) => {
      const key = `${id}:${operation.operationId}`, prior = accepted.get(key)
      if (prior) return prior
      writes.push(operation.data)
      const endByte = operation.expectedByte + Buffer.byteLength(operation.data); cursor.set(id, endByte)
      const acknowledgement = { run: run(id), appliedByteRange: { startByte: operation.expectedByte, endByte } }
      accepted.set(key, acknowledgement)
      return acknowledgement
    }
    disposals.push(async () => await owner.dispose())
  }
  await configure(client)
  const start = vi.fn(async (_input: { args: string[]; operationKey: string }) => run()), stop = vi.fn()
  inner.kernel.start = start; inner.kernel.stop = stop
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43),
    endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  vi.spyOn(client, 'probeAgent').mockImplementation(async id => ({ providerId: id, executable: id,
    installed: true, capabilities: new AgentProviderRegistry().get(id).catalog.capabilities }))
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  client.onEvent(event => events.push(structuredClone(event)))
  const queue = new DurableAgentMuxMessageQueue(join(root, 'messages.ndjson'))
  const envelope: AgentMuxMessageEnvelope = { schema: 'agentmux.a2a.v1', messageId: 'message-one', operationId: 'operation-one', createdAt: 100,
    sender: { kind: 'agent-session', agentSessionId: 'sender' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: 'recipient', recipientRunId: 'recipient-run',
    threadId: 'thread-one', correlationId: 'correlation-one', replyTo: null, workspaceId: null, body }
  const input = () => ({ agentSessionId: 'recipient', envelope, condition: agentPromptCondition(client.agentSession('recipient')),
    caller: { agentSessionId: 'sender', capability } })
  const reopen = async () => { const owner = new Client({ store: new AgentMuxFileAgentSessionStore(store.path) }); await configure(owner); return owner }
  return { root, client, store, inner, queue, writes, start, stop, events, envelope, input, capability, reopen }
}

describe('Core owns authenticated durable Agent delivery', () => {
  it('persists identity before actual Input, adds source to unchanged bytes and reopens without replay', async () => {
    const f = await fixture()
    const originalCondition = f.input().condition
    const input = f.inner.kernel.input as (id: string, operation: { expectedByte: number; data: string }) => Promise<unknown>
    f.inner.kernel.input = async (id: string, operation: { expectedByte: number; data: string }) => {
      const before = await f.queue.listAfter()
      expect(before).toHaveLength(1)
      expect(before[0]).toMatchObject({ envelope: f.envelope, delivery: { state: 'queued' }, promptCondition: originalCondition })
      return await input(id, operation)
    }
    await f.client.submitAgentMessage(f.input())
    expect(f.writes).toEqual([`[Message from Agent sender]\n${body}\r`])
    const records = await new DurableAgentMuxMessageQueue(f.queue.path).listAfter()
    expect(records).toEqual([expect.objectContaining({ envelope: f.envelope, delivery: { state: 'delivered', at: expect.any(Number) }, promptCondition: { expectedRun: { runId: 'recipient-run' }, afterSubmissionId: null } })])
    expect((await new AgentMuxFileAgentSessionStore(f.store.path).loadTimeline('recipient')).items).toEqual([
      expect.objectContaining({ id: 'prompt:message-one', content: `[Message from Agent sender]\n${body}`, authorAgentSessionId: 'sender' })
    ])
    const reopened = await f.reopen()
    await reopened.submitAgentMessage(f.input())
    expect(f.writes).toHaveLength(1)
    await expect(reopened.submitAgentMessage({ ...f.input(), envelope: { ...f.envelope, body: 'another body' } }))
      .rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
  })

  it('reconciles a lost original Input ACK after reopening without additional bytes or a new intent', async () => {
    const f = await fixture(), originalInput = f.inner.kernel.input as (...args: unknown[]) => Promise<unknown>
    f.inner.kernel.input = async (...args: unknown[]) => { await originalInput(...args); throw new Error('private Input ACK lost') }
    const originalCondition = f.input().condition
    await expect(f.client.submitAgentMessage(f.input())).rejects.toThrow('private Input ACK lost')
    expect(f.writes).toEqual([`[Message from Agent sender]\n${body}\r`])
    const unknown = await f.queue.listAfter(); expect(unknown).toHaveLength(1)
    expect(unknown[0]).toMatchObject({ delivery: { state: 'queued' }, promptCondition: originalCondition })
    const reopened = await f.reopen()
    await reopened.submitAgentMessage({ ...f.input(), condition: agentPromptCondition(reopened.agentSession('recipient')) })
    expect(f.writes).toEqual([`[Message from Agent sender]\n${body}\r`])
    const recovered = await f.queue.listAfter(); expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ envelope: f.envelope, promptCondition: originalCondition, delivery: { state: 'delivered' } })
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('keeps the original unknown message after a later real prompt admission instead of rebinding or replaying it', async () => {
    const f = await fixture(), originalInput = f.inner.kernel.input as (...args: unknown[]) => Promise<unknown>
    f.inner.kernel.input = async (...args: unknown[]) => { await originalInput(...args); throw new Error('private Input ACK lost') }
    const originalCondition = f.input().condition
    await expect(f.client.submitAgentMessage(f.input())).rejects.toThrow('private Input ACK lost')
    const reopened = await f.reopen()
    await reopened.submitAgentPrompt({ agentSessionId: 'recipient', ...agentPromptCondition(reopened.agentSession('recipient')),
      operationId: 'later-human-intent', prompt: 'later human text', allowUncertainTurn: true })
    const currentCondition = agentPromptCondition(reopened.agentSession('recipient'))
    expect(currentCondition).toEqual({ expectedRun: { runId: 'recipient-run' }, afterSubmissionId: 'later-human-intent' })
    await expect(reopened.submitAgentMessage({ ...f.input(), condition: currentCondition }))
      .rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED', detail: 'unknown' })
    expect(f.writes).toEqual([`[Message from Agent sender]\n${body}\r`, 'later human text\r'])
    const retained = await f.queue.listAfter(); expect(retained).toHaveLength(1)
    expect(retained[0]).toMatchObject({ envelope: f.envelope, promptCondition: originalCondition, delivery: { state: 'queued' } })
    expect(reopened.agentSession('recipient').run).toEqual({ runId: 'recipient-run' }); expect(f.stop).not.toHaveBeenCalled()
  })

  it.each(['missing', 'forged', 'sender', 'sender-run', 'recipient', 'recipient-run', 'initial-unknown-run'] as const)(
    'rejects %s identity without appending or Input', async variant => {
      const f = await fixture(), input = f.input()
      if (variant === 'missing') delete (input as { caller?: unknown }).caller
      if (variant === 'forged') input.caller.capability = 'forged'
      if (variant === 'sender') input.envelope = { ...f.envelope, sender: { kind: 'agent-session', agentSessionId: 'imposter' } }
      if (variant === 'sender-run') input.envelope = { ...f.envelope, senderRunId: 'old-sender-run' }
      if (variant === 'recipient') input.envelope = { ...f.envelope, recipient: { kind: 'agent-session', agentSessionId: 'sender' } }
      if (variant === 'recipient-run') input.envelope = { ...f.envelope, recipientRunId: 'old-recipient-run' }
      if (variant === 'initial-unknown-run') input.envelope = { ...f.envelope, recipientRunId: null }
      await expect(f.client.submitAgentMessage(input)).rejects.toMatchObject({ code: expect.any(String) })
      expect(await f.queue.listAfter()).toEqual([]); expect(f.writes).toEqual([])
    })

  it('keeps human submit/create bytes and rejects the removed raw author entry', async () => {
    const f = await fixture()
    await f.client.submitAgentPrompt({ ...f.input().condition, agentSessionId: 'recipient', operationId: 'manual', prompt: body, authorHuman: true })
    expect(f.writes).toEqual([body + '\r']); expect(await f.queue.listAfter()).toEqual([])
    await expect(f.client.submitAgentPrompt({ ...f.input().condition, agentSessionId: 'recipient', operationId: 'raw-agent', prompt: body,
      ...{ authorAgentSessionId: 'sender' } })).rejects.toMatchObject({ code: 'MESSAGE_ENVELOPE_REQUIRED' })
    await f.client.createAgentWithDelivery({ agentSessionId: 'human-created', createOperationId: 'human-create', providerId: 'claude',
      executorId: 'claude', workspacePath: f.root, prompt: body, injectAgentMuxGuide: false })
    expect(f.start.mock.calls[0]![0].args).toContain(body)
    expect((await f.store.loadTimeline('human-created')).items).toEqual([expect.objectContaining({ content: body })])
    expect(await f.queue.listAfter()).toEqual([])
  })

  it('rejects a previous capability after another owner changed the durable sender Run', async () => {
    const f = await fixture()
    const original = (await f.store.load() as AgentMuxStoredAgentSession[]).find(session => session.agentSessionId === 'sender')! as AgentMuxStoredAgentSession
    await f.store.compareAndSwap(original, { ...original, run: { runId: 'sender-resumed' }, retiredRuns: [original.run],
      capabilityHash: hashAgentCapability('new-capability'), updatedAt: original.updatedAt + 1 })
    await expect(f.client.submitAgentMessage(f.input())).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect(await f.queue.listAfter()).toEqual([]); expect(f.writes).toEqual([])
    expect((await f.client.authorizeAgentCaller('new-capability', 'sender')).run).toEqual({ runId: 'sender-resumed' })
    await f.client.submitAgentMessage({ ...f.input(), caller: { agentSessionId: 'sender', capability: 'new-capability' }, envelope: { ...f.envelope, senderRunId: 'sender-resumed' } })
    expect(f.writes).toEqual([`[Message from Agent sender]\n${body}\r`])
  })

  it('fails this durable intent before Input while preserving the healthy recipient', async () => {
    const f = await fixture()
    vi.spyOn(f.inner.messageQueue, 'append').mockRejectedValue(new Error('private journal unavailable'))
    await expect(f.client.submitAgentMessage(f.input())).rejects.toThrow('private journal unavailable')
    expect(f.writes).toEqual([]); expect(f.stop).not.toHaveBeenCalled()
    expect(f.client.agentSession('recipient').run).toEqual({ runId: 'recipient-run' })
  })
})

describe('initial Agent messages retain the single creation transport', () => {
  it.each(['claude', 'kimi'] as const)('durably binds %s first message and retry to one creation/initial Input', async providerId => {
    const f = await fixture()
    const initialInput = vi.fn(async (..._args: unknown[]) => {})
    f.inner.promptSubmission.submitInputPlan = initialInput
    const input = { callerAgentSessionId: 'sender', capability: f.capability, executorId: providerId, providerId,
      workspacePath: f.root, body, operationId: 'discussion-once' }
    const first = await f.client.startDiscussion(input)
    const wrapped = `[Message from Agent sender]\n${body}`
    expect(f.start).toHaveBeenCalledTimes(1)
    if (providerId === 'claude') {
      expect(f.start.mock.calls[0]![0].args.filter((arg: string) => arg.includes(wrapped))).toHaveLength(1)
      expect(agentMuxContext(f.start.mock.calls[0]![0].args.filter((arg: string) => arg.includes(wrapped))[0])).toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
      expect(initialInput).not.toHaveBeenCalled()
    } else {
      expect(f.start.mock.calls[0]![0].args.filter((arg: string) => arg.includes(wrapped))).toEqual([])
      expect(initialInput).toHaveBeenCalledTimes(1); expect(initialInput.mock.calls[0]![3]).toContain(wrapped); expect(agentMuxContext(initialInput.mock.calls[0]![3])).toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
    }
    const records = await new DurableAgentMuxMessageQueue(f.queue.path).listAfter()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ envelope: { messageId: `${first.thread.threadId}:0`, recipientRunId: null, senderRunId: 'sender-run',
      recipientSessionId: first.session.agentSessionId, body }, promptCondition: { expectedRun: { runId: 'initial-run' } }, delivery: { state: 'delivered' } })
    expect(first.session.creation).toEqual({ createOperationId: input.operationId, initialPrompt: 'confirmed' })
    expect(first.thread.messages[0]!.body).toBe(body)
    const reopened = await f.reopen()
    const retry = await reopened.startDiscussion(input)
    expect(retry.session.agentSessionId).toBe(first.session.agentSessionId)
    expect(retry.session.run).toEqual(first.session.run)
    expect(f.start).toHaveBeenCalledTimes(1); expect(initialInput).toHaveBeenCalledTimes(providerId === 'kimi' ? 1 : 0)
    expect(await f.queue.listAfter()).toEqual(records)
    // The existing Dispatch consumer uses the same first condition's real Run, never invents one.
    await expect(reopened.openDispatch({ capability: f.capability, callerAgentSessionId: 'sender', sourceMessageId: `${first.thread.threadId}:0` }))
      .resolves.toMatchObject({ ownerAgentSessionId: 'sender', workerAgentSessionId: first.session.agentSessionId })
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('routes agent open initialMessage through the same envelope owner', async () => {
    const f = await fixture()
    await f.client.createAgentWithDelivery({ agentSessionId: 'opened-session', createOperationId: 'open-once', providerId: 'claude', executorId: 'claude',
      workspacePath: f.root, injectAgentMuxGuide: false, prompt: body, initialMessage: { callerAgentSessionId: 'sender', capability: f.capability } })
    expect(f.start.mock.calls[0]![0].args).toContain(`[Message from Agent sender]\n${body}`)
    expect(await f.queue.listAfter()).toEqual([expect.objectContaining({ envelope: expect.objectContaining({ body, senderSessionId: 'sender', recipientSessionId: 'opened-session', recipientRunId: null }),
      promptCondition: expect.objectContaining({ expectedRun: { runId: 'initial-run' } }) })])
  })

  it('keeps uncertain original initial Input queued and never replays it after reopening', async () => {
    const f = await fixture(), initialInput = vi.fn(async (..._args: unknown[]) => { throw new Error('private original receipt lost') })
    f.inner.promptSubmission.submitInputPlan = initialInput
    const input = { callerAgentSessionId: 'sender', capability: f.capability, executorId: 'kimi', providerId: 'kimi' as const,
      workspacePath: f.root, body, operationId: 'discussion-uncertain' }
    const first = await f.client.startDiscussion(input), reopened = await f.reopen(), retry = await reopened.startDiscussion(input)
    expect(first.session.creation?.initialPrompt).toBe('unconfirmed'); expect(retry.thread.delivery.state).toBe('queued')
    expect(retry.session.run).toEqual(first.session.run)
    expect(initialInput).toHaveBeenCalledTimes(1); expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
    expect(await f.queue.listAfter()).toEqual([expect.objectContaining({ delivery: { state: 'queued', at: expect.any(Number), reason: expect.stringContaining('unconfirmed') },
      envelope: expect.objectContaining({ recipientRunId: null }), promptCondition: expect.objectContaining({ expectedRun: { runId: 'initial-run' } }) })])
  })

  it('preserves the original created Agent when Native refuses its initial Input and never replays it after reopening', async () => {
    const f = await fixture()
    // The real create owner and Prompt submission execute; only the Native transport
    // refuses once, before applying any bytes. This is distinct from a lost ACK.
    const input = f.inner.kernel.input as (...args: unknown[]) => Promise<unknown>
    const nativeInput = vi.fn(async (...args: unknown[]) => {
      if (nativeInput.mock.calls.length === 1) throw new AgentMuxError('The initial Native Input was not applied.',
        'CTXMUX_input_cursor_mismatch', 'not_applied', { disposition: 'not_applied', confirmedInputBytes: 0 })
      return await input(...args)
    })
    f.inner.kernel.input = nativeInput
    const request = { callerAgentSessionId: 'sender', capability: f.capability, executorId: 'kimi', providerId: 'kimi' as const,
      workspacePath: f.root, body, operationId: 'discussion-native-refused' }
    const first = await f.client.startDiscussion(request)
    const sessionId = first.session.agentSessionId
    const originalAdmission = agentPromptNotApplied(first.session)
    expect(originalAdmission).toEqual({ submissionId: `launch-prompt:${f.start.mock.calls[0]![0].operationKey}`, run: { runId: 'initial-run' } })
    expect(first.session.creation?.initialPrompt).toBe('unconfirmed')
    expect(await f.store.readMetadata(sessionId)).toMatchObject({ agentSessionId: sessionId, run: { runId: 'initial-run' },
      creation: { createOperationId: request.operationId, initialPrompt: 'unconfirmed' },
      promptCompletionAdmission: { submissionId: originalAdmission!.submissionId, notApplied: true } })
    const [original] = await f.queue.listAfter()
    expect(original).toMatchObject({ envelope: { body, senderSessionId: 'sender', recipientSessionId: sessionId, recipientRunId: null },
      promptCondition: { expectedRun: { runId: 'initial-run' }, afterSubmissionId: originalAdmission!.submissionId }, delivery: { state: 'queued' } })
    const originalTimeline = await f.store.loadTimeline(sessionId)
    expect(originalTimeline.items).toContainEqual(expect.objectContaining({ kind: 'user_message', status: 'failed',
      content: `[Message from Agent sender]\n${body}` }))
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', agentSessionId: sessionId, code: 'CTXMUX_input_cursor_mismatch' }))
    expect(nativeInput).toHaveBeenCalledTimes(1); expect(f.writes).toEqual([])

    const reopened = await f.reopen(), reopenedInner = reopened as unknown as Internals
    reopenedInner.kernel.input = nativeInput; reopenedInner.kernel.start = f.start; reopenedInner.kernel.stop = f.stop
    const retry = await reopened.startDiscussion(request)
    expect(retry.session).toMatchObject({ agentSessionId: sessionId, run: { runId: 'initial-run' },
      creation: { createOperationId: request.operationId, initialPrompt: 'unconfirmed' } })
    expect(agentPromptNotApplied(retry.session)).toEqual(originalAdmission)
    expect(await f.queue.listAfter()).toEqual([expect.objectContaining({ envelope: original!.envelope,
      promptCondition: original!.promptCondition, delivery: expect.objectContaining({ state: 'queued' }) })])
    expect(await f.store.loadTimeline(sessionId)).toEqual(originalTimeline)
    expect(nativeInput).toHaveBeenCalledTimes(1); expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()

    // A separate explicit intent can still use that same healthy Agent and Run.
    await reopened.submitAgentPrompt({ agentSessionId: sessionId, ...agentPromptCondition(retry.session),
      operationId: 'explicit-new-intent-after-initial-refusal', prompt: 'new explicit input', authorHuman: true, allowUncertainTurn: true })
    expect(nativeInput).toHaveBeenCalledTimes(2); expect(f.writes).toEqual(['new explicit input\r'])
    expect(reopened.agentSession(sessionId).run).toEqual({ runId: 'initial-run' })
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
    expect((await f.queue.listAfter())[0]!.envelope).toEqual(original!.envelope)
  })

  it('never backfills a lost initial Run binding from a later resumed Session', async () => {
    const f = await fixture()
    vi.spyOn(f.inner.messageQueue, 'preparePrompt').mockRejectedValueOnce(new Error('private initial condition save failed'))
    const input = { agentSessionId: 'binding-session', createOperationId: 'binding-once', providerId: 'claude' as const, executorId: 'claude',
      workspacePath: f.root, injectAgentMuxGuide: false, prompt: body, initialMessage: { callerAgentSessionId: 'sender', capability: f.capability } }
    const first = await f.client.createAgentWithDelivery(input)
    const original = (await f.store.load() as AgentMuxStoredAgentSession[]).find(session => session.agentSessionId === first.session.agentSessionId)! as AgentMuxStoredAgentSession
    await f.store.compareAndSwap(original, { ...original, run: { runId: 'later-resumed-run' }, retiredRuns: [original.run], updatedAt: original.updatedAt + 1 })
    const reopened = await f.reopen(), retry = await reopened.createAgentWithDelivery(input)
    expect(retry.session.run).toEqual({ runId: 'later-resumed-run' })
    const records = await f.queue.listAfter(); expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ envelope: { recipientRunId: null }, promptCondition: null, delivery: { state: 'queued' } })
    await expect(reopened.openDispatch({ capability: f.capability, callerAgentSessionId: 'sender', sourceMessageId: records[0]!.envelope.messageId }))
      .rejects.toMatchObject({ code: 'DISPATCH_MESSAGE_INVALID' })
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
  })

  it('retains the initial healthy Run with a service notice when its post Input queue receipt cannot be saved', async () => {
    const f = await fixture()
    vi.spyOn(f.inner.messageQueue, 'recordDelivery').mockRejectedValue(new Error('private receipt save failed'))
    const created = await f.client.createAgentWithDelivery({ agentSessionId: 'retained-session', createOperationId: 'receipt-once', providerId: 'claude', executorId: 'claude',
      workspacePath: f.root, injectAgentMuxGuide: false, prompt: body, initialMessage: { callerAgentSessionId: 'sender', capability: f.capability } })
    expect(created.promptConfirmed).toBe(true); expect(created.session.run).toEqual({ runId: 'initial-run' })
    expect(f.stop).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.events.filter(event => event.type === 'agent-error')).toEqual([expect.objectContaining({ code: 'AGENT_MESSAGE_RECEIPT_UNCONFIRMED', message: expect.stringContaining('Agent continues') })])
    const records = await f.queue.listAfter(); expect(records).toHaveLength(1); expect(records[0]!.delivery.state).toBe('queued')
  })
})
