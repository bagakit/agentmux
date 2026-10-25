import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient as DefaultClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxStoredAgentSession, AgentPromptSubmissionRecord } from '../src/types.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

// Finite mutations load a private compiled copy. Shared source/dist and production Runtime stay intact.
const Client: typeof DefaultClient = process.env.AGENTMUX_TEST_CREATION_CLIENT
  ? (await import(process.env.AGENTMUX_TEST_CREATION_CLIENT)).AgentMuxClient : DefaultClient
type Internals = {
  connected: boolean
  registry: { load(hostId: string): Promise<void> }
  kernel: Record<string, unknown>
  hookServer: Record<string, unknown>
  ensureManagedHooks: unknown
  ensureTerminalHandshakeOrDegrade: unknown
  promptSubmission: { submitInputPlan: unknown }
}
let root: string, store: AgentMuxFileAgentSessionStore, client: DefaultClient, inner: Internals
let events: AgentMuxClientEvent[]
let start: ReturnType<typeof vi.fn>, stop: ReturnType<typeof vi.fn>, submit: ReturnType<typeof vi.fn>
let providerId: 'claude' | 'kimi'
let inputReceipt: AgentPromptSubmissionRecord | null
const sessionId = 'private-creation-session', requestId = 'pmo-original-creation'
const runId = 'private-adapter-run', task = 'execute the exact original task'
function run(): CtxmuxAdapterRun {
  return { nativeService: null, runId, lifecycleOperationId: null, program: providerId, args: [], workspacePath: root,
    pid: 424242, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0,
    firstAvailableByte: 0, acceptedInputBytes: 0 }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amx-creation-fact-'))
  for (const name of Object.keys(process.env).filter(name => name.startsWith('AGENTMUX_'))) vi.stubEnv(name, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  vi.stubEnv('CODEX_HOME', join(root, 'private-home'))
  store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  client = new Client({ store })
  inner = client as unknown as Internals
  // Only Adapter/probe/Hook and actual Input admission are explicit fixture boundaries. The public
  // create owner, registry reservation/CAS, first-prompt routing, history and file Store all execute.
  await inner.registry.load('local')
  inner.connected = true
  providerId = 'claude'
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'private-adapter', protocolVersion: 18, buildIdentity: 'fixture' })
  inner.kernel.status = async () => run()
  start = vi.fn(async () => run()); inner.kernel.start = start
  stop = vi.fn(); inner.kernel.stop = stop
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43),
    endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  vi.spyOn(client as unknown as { probePreparedAgent: typeof client.probeAgent }, 'probePreparedAgent').mockImplementation(async id => ({ providerId: id, executable: id,
    installed: true, capabilities: new AgentProviderRegistry().get(id).catalog.capabilities }))
  inner.ensureManagedHooks = async () => {}
  inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  inputReceipt = null
  vi.spyOn(client, 'inspectAgentPromptSubmission').mockImplementation(async key =>
    inputReceipt?.admission?.submissionId === key.submissionId ? inputReceipt : null)
  submit = vi.fn(async () => { confirmInput() }); inner.promptSubmission.submitInputPlan = submit
  events = []; client.onEvent(event => { events.push(structuredClone(event)) })
})
afterEach(async () => {
  await client.dispose()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
function initialInputKey() {
  return { kind: 'prompt', agentSessionId: sessionId, expectedRun: { runId },
    submissionId: `launch-prompt:${start.mock.calls[0]![0].operationKey}` }
}
// The explicit Input admission fixture supplies the original typed receipt;
// a resolved submit Promise alone is not delivery evidence.
function confirmInput(acknowledged = true) {
  const [, , submissionId, prompt, plan, , , , , , , message] = submit.mock.calls[0]!
  inputReceipt = { agentSessionId: sessionId, run: { runId }, admission: { submissionId,
    inputKey: initialInputKey() as NonNullable<AgentPromptSubmissionRecord["admission"]>["inputKey"], operationId: submissionId, transport: 'pty', startByte: 0, endByte: Buffer.byteLength(prompt),
    acknowledged, intent: { run: { runId }, ownerInstanceId: 'private-adapter', prompt, plan, message } } }
}
function create(prompt?: string) {
  return client.createAgentWithDelivery({ agentSessionId: sessionId, createOperationId: requestId,
    providerId, executorId: 'exact-configured-executor', workspacePath: root,
    ...(prompt === undefined ? {} : { prompt }), injectAgentMuxGuide: false })
}
async function stored(): Promise<AgentMuxStoredAgentSession> {
  const records = await new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')).load() as AgentMuxStoredAgentSession[]
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ agentSessionId: sessionId, run: { runId } })
  return records[0]!
}
function healthyOneCreation() {
  expect(start).toHaveBeenCalledTimes(1)
  expect(stop).not.toHaveBeenCalled()
  expect(client.agentSession(sessionId).run).toEqual({ runId })
}

describe('public Agent creation retains the original first-prompt delivery fact', () => {
  it.each([undefined, '   '])('persists not-requested for absent or blank original prompt %j', async prompt => {
    const result = await create(prompt)
    const creation = { createOperationId: requestId, initialPrompt: 'not-requested', intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }
    expect(result.creation).toEqual(creation)
    expect(result.session.creation).toEqual(creation)
    expect(client.agentSession(sessionId).creation).toEqual(creation)
    expect((await stored()).creation).toEqual(creation)
    expect(submit).not.toHaveBeenCalled()
    expect((await store.loadTimeline(sessionId)).items).toEqual([])
    healthyOneCreation()
  })

  it('confirms an at-launch first prompt from the same creation, without another Input', async () => {
    const result = await create(task)
    const creation = { createOperationId: requestId, initialInputKey: initialInputKey(), initialPrompt: 'confirmed', intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }
    expect(result).toMatchObject({ promptConfirmed: true, creation, session: { creation } })
    expect(client.agentSession(sessionId).creation).toEqual(creation)
    expect((await stored()).creation).toEqual(creation)
    expect(start.mock.calls[0]![0].args.filter((arg: string) => arg === task)).toEqual([task])
    expect(submit).not.toHaveBeenCalled()
    expect((await store.loadTimeline(sessionId)).items.map(({ content, status }) => ({ content, status })))
      .toEqual([{ content: task, status: 'complete' }])
    healthyOneCreation()
  })

  it('keeps post-launch delivery unconfirmed until its one original Input is confirmed', async () => {
    providerId = 'kimi'
    let release!: () => void
    submit.mockImplementation(async () => { confirmInput(false); await new Promise<void>(resolve => { release = resolve }); confirmInput() })
    const creating = create(task)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    // The original receipt observer persists its projection before publishing the
    // in-memory snapshot. Holding Input does not await that separate metadata turn.
    await vi.waitFor(async () => {
      expect((await stored()).creation).toEqual({ createOperationId: requestId, initialInputKey: initialInputKey(), initialPrompt: 'unconfirmed', intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
      expect(client.agentSession(sessionId).creation).toEqual({ createOperationId: requestId, initialInputKey: initialInputKey(), initialPrompt: 'unconfirmed', intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    })
    expect((await store.loadTimeline(sessionId)).items).toEqual([])
    release()
    const result = await creating
    const creation = { createOperationId: requestId, initialInputKey: initialInputKey(), initialPrompt: 'confirmed', intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }
    expect(result).toMatchObject({ promptConfirmed: true, creation, session: { creation } })
    expect(client.agentSession(sessionId).creation).toEqual(creation)
    expect((await stored()).creation).toEqual(creation)
    expect(start.mock.calls[0]![0].args).not.toContain(task)
    expect(submit.mock.calls).toEqual([[expect.objectContaining({ agentSessionId: sessionId, run: { runId } }),
      expect.objectContaining({ runId }), `launch-prompt:${start.mock.calls[0]![0].operationKey}`, task, expect.any(Object),
      { expectedRun: { runId }, afterSubmissionId: null }, undefined, undefined, false, expect.any(AbortSignal),
      undefined, { userContent: task }, undefined, undefined, undefined, undefined, initialInputKey(),
      { onlyIfUnclaimed: true, authority: { assertCurrent: expect.any(Function) } }]])
    expect((await store.loadTimeline(sessionId)).items.map(({ content, status }) => ({ content, status })))
      .toEqual([{ content: task, status: 'complete' }])
    healthyOneCreation()
  })

  it('returns and persists unconfirmed delivery while retaining the healthy Run and original prompt once', async () => {
    providerId = 'kimi'
    submit.mockImplementation(async () => { confirmInput(false); throw new Error('Private fixture loses the original Input receipt') })
    const result = await create(task)
    const creation = { createOperationId: requestId, initialInputKey: initialInputKey(), initialPrompt: 'unconfirmed', intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }
    expect(result).toMatchObject({ promptConfirmed: false, creation, session: { creation } })
    expect(client.agentSession(sessionId).creation).toEqual(creation)
    expect((await stored()).creation).toEqual(creation)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![3]).toBe(task)
    expect(events.filter(event => event.type === 'agent-error')).toEqual([expect.objectContaining({
      agentSessionId: sessionId, code: 'AGENT_LAUNCH_PROMPT_UNDELIVERED', message: expect.stringContaining('was not confirmed')
    })])
    expect((await store.loadTimeline(sessionId)).items.map(({ content, status }) => ({ content, status })))
      .toEqual([{ content: task, status: 'failed' }])
    healthyOneCreation()
  })

  it('returns the actual Input confirmation and leaves durable unknown if saving that fact fails', async () => {
    providerId = 'kimi'
    const metadataCas = store.compareAndSwapMetadata.bind(store)
    let failedReceiptWrites = 0
    vi.spyOn(store, 'compareAndSwapMetadata').mockImplementation(async (expected, next, signal, future) => {
      if (next?.creation?.initialPrompt === 'confirmed') {
        expect(expected?.creation?.initialPrompt).toBe('unknown')
        expect(submit).toHaveBeenCalledTimes(1)
        failedReceiptWrites++
        throw new Error('Private fixture cannot save the delivery fact after Input')
      }
      return await metadataCas(expected, next, signal, future)
    })
    const result = await create(task)
    expect(failedReceiptWrites).toBeGreaterThan(0)
    expect(result).toMatchObject({ promptConfirmed: true,
      creation: { createOperationId: requestId, initialPrompt: 'confirmed' } })
    const retained = { createOperationId: requestId, initialInputKey: initialInputKey(), initialPrompt: 'unknown', intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }
    expect(result.session.creation).toEqual(retained)
    expect(client.agentSession(sessionId).creation).toEqual(retained)
    expect((await stored()).creation).toEqual(retained)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![3]).toBe(task)
    expect(events.filter(event => event.type === 'agent-error')).toContainEqual(expect.objectContaining({
      agentSessionId: sessionId, code: 'AGENT_CREATION_RECEIPT_UNCONFIRMED', message: expect.stringContaining('saving')
    }))
    healthyOneCreation()
  })

  it.each(['foreign-key', 'foreign-body', 'unknown-ack'] as const)('retains unconfirmed input when its post-failure receipt has %s', async mismatch => {
    providerId = 'kimi'
    const metadataCas = store.compareAndSwapMetadata.bind(store)
    let rejected = false
    vi.spyOn(store, 'compareAndSwapMetadata').mockImplementation(async (expected, next, signal, future) => {
      if (!rejected && next?.creation?.initialPrompt === 'confirmed') {
        rejected = true
        const admission = inputReceipt!.admission!
        if (mismatch === 'foreign-key') admission.inputKey = { ...initialInputKey(), kind: 'prompt', submissionId: 'another-input' }
        else if (mismatch === 'foreign-body') admission.intent!.prompt = 'another body'
        else admission.acknowledged = false
        throw new Error('The Session projection write failed before its original receipt was reobserved')
      }
      return await metadataCas(expected, next, signal, future)
    })
    const result = await create(task)
    expect(rejected).toBe(true)
    expect(result.promptConfirmed).toBe(false)
    expect(result.creation.initialPrompt).toBe('unconfirmed')
    expect(submit).toHaveBeenCalledTimes(1)
    healthyOneCreation()
  })

})
