import { fixtureEpoch as _liveTailFixtureEpoch } from "./helpers/fixture-values.js"
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentProvider } from '../src/agent-provider.js'
import { hashAgentCapability, type AgentCapabilityBinding } from '../src/agent-capability.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentPromptSubmissionCoordinator, type AgentPromptInputAuthority } from '../src/prompt-submission.js'
import { agentPromptCondition, agentPromptNotApplied, type AgentPromptCondition } from '../src/agent-prompt-condition.js'
import type { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type { AgentMuxStoredAgentSession, AgentNativePromptInputPlan, AgentPromptInputPlan } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const text = 'Original text 原文\n{"stop":true} stays opaque.'
const plan: AgentPromptInputPlan = { kind: 'render-then-submit', payload: '\x1b[200~' + text + '\x1b[201~', renderedText: text, submit: '\r' }
const nativePlan: AgentNativePromptInputPlan = { kind: 'native-rpc', operation: 'start-or-steer', protocolId: 'original-contract', sourceId: 'original-source', actorId: 'original-actor', threadId: 'original-thread' }

async function expectWritten(pending: Promise<unknown>): Promise<void> {
  const result = await pending.then(message => ({ message }), error => ({ error }))
  expect(result).not.toHaveProperty('error')
  expect(result).toEqual({ message: { userContent: text } })
}

/** Actual Core, journal, file Store, author CAS and coordinator; Runtime and Provider ports are controlled. */
async function fixture(working = true) {
  const h = await rpcOwnerFixture()
  const inner = h.client as unknown as { promptSubmission: AgentPromptSubmissionCoordinator; messageQueue: DurableAgentMuxMessageQueue; screenEvidence: AgentScreenEvidenceStore; kernel: Record<string, unknown> }
  const deps = Reflect.get(inner.promptSubmission, 'deps') as ConstructorParameters<typeof AgentPromptSubmissionCoordinator>[0]
  const builtin = new AgentProviderRegistry().get('codex')
  const forbidden = vi.fn(() => { throw new Error('Display/Native preparation must not decide current-terminal input') })
  const provider: AgentProvider = { ...builtin, catalog: { ...builtin.catalog, capabilities: { ...builtin.catalog.capabilities,
    promptExecution: { immediate: 'terminal-submit' } } }, inspectPromptExecution: forbidden,
    readPromptExecutionEvidence: forbidden, verifyPromptExecutionTransport: forbidden, preparePromptExecutionTransport: forbidden }
  vi.spyOn(inner.screenEvidence, 'wait').mockImplementation(forbidden)
  const coordinator = new AgentPromptSubmissionCoordinator({ ...deps, providers: new AgentProviderRegistry([provider]) })
  const initial = (await h.store.readMetadata('recipient'))!
  if (working) await h.store.compareAndSwapMetadata(initial, { ...initial,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: _liveTailFixtureEpoch(0, 0, 1) } })
  await deps.registry.refresh('recipient', initial.run)
  let cursor = 0, loseAck = false
  let onInput: ((data: string) => Promise<void>) | undefined
  const accepted = new Map<string, { expectedByte: number; data: string; startByte: number; endByte: number }>()
  const run = () => ({ ...h.run(initial.run.runId), acceptedInputBytes: cursor })
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'original-terminal-runtime' })
  h.inner.kernel.status = vi.fn(async () => run())
  const input = vi.fn(async (_runId: string, operation: { operationId: string; ownerInstanceId: string; expectedByte: number; data: string }) => {
    expect(operation.ownerInstanceId).toBe('original-terminal-runtime')
    let receipt = accepted.get(operation.operationId)
    if (receipt) expect(operation).toMatchObject({ expectedByte: receipt.expectedByte, data: receipt.data })
    else {
      if (operation.expectedByte !== cursor) throw new AgentMuxError('Actual controlled byte cursor changed.', 'CTXMUX_input_cursor_mismatch', 'not_applied')
      receipt = { expectedByte: cursor, data: operation.data, startByte: cursor, endByte: cursor + Buffer.byteLength(operation.data) }
      accepted.set(operation.operationId, receipt); cursor = receipt.endByte
      await onInput?.(operation.data)
    }
    if (loseAck) { loseAck = false; throw new AgentMuxError('Original Runtime reply lost after applying bytes.', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown') }
    return { run: run(), appliedByteRange: { startByte: receipt.startByte, endByte: receipt.endByte } }
  })
  h.inner.kernel.input = input
  const key = (id: string) => ({ kind: 'prompt' as const, agentSessionId: initial.agentSessionId, expectedRun: initial.run, submissionId: id })
  const save = async (id: string) => (await inner.messageQueue.savePromptInput({ key: key(id),
    admissionIntent: { kind: 'manual-actor', expectedRun: initial.run }, execution: 'immediate',
    environment: { providerId: initial.providerId, executorId: initial.executorId }, source: { kind: 'prompt', prompt: text, authorHuman: true } }))!
  const submit = async (id: string, options: { signal?: AbortSignal; authority?: AgentPromptInputAuthority;
    condition?: AgentPromptCondition; inputPlan?: AgentPromptInputPlan; gate?: () => Promise<import('../src/agent-input-wait.js').AgentInputDispatchLink | null> } = {}) => {
    const saved = await save(id)
    const current = h.client.agentSession('recipient')
    return coordinator.submitInputPlan(current, run(), id, text, options.inputPlan ?? plan,
      options.condition ?? { kind: 'manual-actor', expectedRun: initial.run }, undefined, options.signal,
      false, undefined, undefined, { userContent: text }, 'immediate', undefined, undefined, undefined, key(id),
      { ...(options.authority ? { authority: options.authority } : {}),
        authorizeDispatch: options.gate ?? (() => inner.messageQueue.authorizeInputDispatch(saved.control.ref, options.signal)) })
  }
  const stored = async () => (await h.store.readMetadata('recipient'))!
  const write = async (change: (value: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession) => {
    const current = await stored(); await h.store.compareAndSwapMetadata(current, change(current)); await deps.registry.refresh('recipient', initial.run)
  }
  const author = (await h.store.readMetadata('caller'))!
  const binding: AgentCapabilityBinding = { agentSessionId: author.agentSessionId, workspacePath: author.workspacePath,
    runId: author.run.runId, capabilityHash: author.capabilityHash! }
  const revoke = async () => {
    const current = (await h.store.readMetadata('caller'))!; await h.store.compareAndSwapMetadata(current, { ...current, capabilityHash: hashAgentCapability('private-revoked-capability') })
  }
  return { ...h, coordinator, initial, inner, input, accepted, forbidden, save, key, submit, stored, write, run, binding, revoke,
    loseAck: () => { loseAck = true }, onInput: (read: (data: string) => Promise<void>) => { onInput = read } }
}

it.each([false, true])('current terminal writes only payload then submit without display or native readiness (working=%s)', async working => {
  const h = await fixture(working)
  try {
    await expectWritten(h.submit('A'))
    expect([...h.accepted.values()].map(value => value.data)).toEqual([plan.payload, plan.submit])
    expect(h.forbidden).not.toHaveBeenCalled()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    const saved = await h.stored()
    expect(saved.promptCompletionAdmission).toMatchObject({ inputKey: h.key('A'), acknowledged: true,
      inputDispatch: { ref: { key: h.key('A'), waitGeneration: 1 } }, intent: { admissionIntent: { kind: 'manual-actor', expectedRun: h.initial.run } } })
    expect(saved.terminalPromptSubmission?.submit.acknowledged).toBe(true)
  } finally { await h.close() }
})

it('manual predecessor is selected under the original lock while an explicit stale condition remains rejected', async () => {
  const h = await fixture()
  try {
    const stale = agentPromptCondition(h.initial)
    await expectWritten(h.submit('A')); await expectWritten(h.submit('B'))
    expect([...h.accepted.values()].map(value => value.data)).toEqual([plan.payload, plan.submit, plan.payload, plan.submit])
    await expect(h.submit('C', { condition: stale })).rejects.toMatchObject({ code: 'AGENT_PROMPT_CONDITION_CHANGED' })
    expect(h.input).toHaveBeenCalledTimes(4)
    expect((await h.store.readPromptAdmission('recipient', h.initial.run, 'A'))?.admission?.acknowledged).toBe(true)
    await expectWritten(h.submit('A'))
    expect(h.input).toHaveBeenCalledTimes(4)
    expect((await h.stored()).promptCompletionAdmission?.submissionId).toBe('B')
  } finally { await h.close() }
})

it('a single-phase terminal protocol uses the same author, gate and byte owner', async () => {
  const h = await fixture()
  try {
    await h.submit('single', { inputPlan: { kind: 'single-phase', data: text + '\r' },
      authority: { binding: h.binding, assertCurrent: async () => {} } })
    expect([...h.accepted.values()].map(value => value.data)).toEqual([text + '\r'])
    expect((await h.stored()).promptCompletionAdmission).toMatchObject({ inputKey: h.key('single'), acknowledged: true,
      inputDispatch: { ref: { key: h.key('single') } } })
    expect(h.forbidden).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('a new manual message preserves unknown Native history; its old key never replays through the terminal', async () => {
  const h = await fixture()
  try {
    await h.write(value => ({ ...value, promptCompletionAdmission: { transport: 'native', operationId: 'old-native', submissionId: 'old-native',
      inputKey: h.key('old-native'), native: { plan: nativePlan, outcome: 'unknown' },
      intent: { run: value.run, ownerInstanceId: 'original-native-runtime', prompt: text, plan: nativePlan, execution: 'immediate',
        admissionIntent: { kind: 'manual-actor', expectedRun: value.run }, message: { userContent: text } } } }))
    await expectWritten(h.submit('new-terminal'))
    const old = await h.store.readPromptAdmission('recipient', h.initial.run, 'old-native')
    expect(old?.admission).toMatchObject({ transport: 'native', native: { outcome: 'unknown', plan: nativePlan } })
    await expect(h.submit('old-native')).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    expect(h.input).toHaveBeenCalledTimes(2)
    expect((await h.stored()).promptCompletionAdmission?.submissionId).toBe('new-terminal')
  } finally { await h.close() }
})

it('partial terminal input only rejoins its frozen original phases and cannot be covered by a different message', async () => {
  const h = await fixture()
  try {
    h.loseAck()
    await expect(h.submit('A')).rejects.toMatchObject({ code: 'CTXMUX_INPUT_UNCONFIRMED' })
    const frozen = await h.stored()
    expect(h.accepted.size).toBe(1)
    expect(agentPromptNotApplied(await h.stored())).toBeUndefined()
    await expect(h.submit('B')).rejects.toMatchObject({ code: 'AGENT_PROMPT_SUBMISSION_BUSY' })
    expect(h.accepted.size).toBe(1)
    await expectWritten(h.submit('A'))
    expect([...h.accepted.values()].map(value => value.data)).toEqual([plan.payload, plan.submit])
    expect((await h.stored()).promptCompletionAdmission).toMatchObject({ submissionId: 'A', inputKey: frozen.promptCompletionAdmission!.inputKey, acknowledged: true })
    expect(h.forbidden).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('a stopped original generation loses before any new terminal claim or write', async () => {
  const h = await fixture()
  try {
    const saved = await h.save('A')
    expect(await h.inner.messageQueue.stopInputWaiting(saved.control.ref, 'stop-A', false)).toMatchObject({ outcome: 'stopped-before-dispatch' })
    await expect(h.submit('A')).rejects.toMatchObject({ code: 'AGENT_INPUT_WAIT_STOPPED' })
    expect(h.input).not.toHaveBeenCalled(); expect((await h.stored()).promptCompletionAdmission).toBeUndefined()
  } finally { await h.close() }
})

it('the original dispatch gate wins before observer cancellation and retains both byte phases', async () => {
  const h = await fixture(), controller = new AbortController()
  try {
    const saved = await h.save('A')
    await expectWritten(h.submit('A', { signal: controller.signal, gate: async () => {
      const link = await h.inner.messageQueue.authorizeInputDispatch(saved.control.ref)
      controller.abort(new Error('Only the original observer stopped.'))
      return link
    } }))
    expect(h.input).toHaveBeenCalledTimes(2)
    expect((await h.stored()).promptCompletionAdmission?.acknowledged).toBe(true)
  } finally { await h.close() }
})

it('a current device-author refusal before submit keeps the accepted payload and cannot write the submit phase', async () => {
  const h = await fixture(), denial = new AgentMuxError('Current author revoked.', 'AGENT_CAPABILITY_INVALID')
  try {
    const result = await h.submit('A', { authority: { assertCurrent: async () => { if (h.input.mock.calls.length) throw denial } } }).catch(error => error)
    expect(result).toBe(denial)
    expect(agentPromptNotApplied(await h.stored())).toBeUndefined()
    expect([...h.accepted.values()].map(value => value.data)).toEqual([plan.payload])
    expect((await h.stored()).terminalPromptSubmission?.submit.acknowledged).toBe(false)
  } finally { await h.close() }
})

it('the final original Agent binding CAS refuses a stale author even when its earlier read resolved', async () => {
  const h = await fixture()
  try {
    const result = await h.submit('A', { authority: { binding: h.binding, assertCurrent: async () => {
      if (h.input.mock.calls.length) await h.revoke()
    } } }).catch(error => error)
    expect(result).toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect([...h.accepted.values()].map(value => value.data)).toEqual([plan.payload])
    expect((await h.stored()).terminalPromptSubmission?.submit.acknowledged).toBe(false)
  } finally { await h.close() }
})

it('later author revocation cannot erase an already confirmed Runtime byte receipt', async () => {
  const h = await fixture()
  try {
    h.onInput(async data => { if (data === plan.submit) await h.revoke() })
    await expectWritten(h.submit('A', { authority: { binding: h.binding, assertCurrent: async () => {} } }))
    expect(h.input).toHaveBeenCalledTimes(2)
    expect((await h.stored()).promptCompletionAdmission?.acknowledged).toBe(true)
  } finally { await h.close() }
})

it('a real pending interaction appearing after payload keeps that byte receipt and blocks submit', async () => {
  const h = await fixture()
  try {
    h.onInput(async data => {
      if (data !== plan.payload) return
      await h.write(current => ({ ...current, pendingInteraction: { request: {
        kind: 'permission', id: 'late-original-request', agentSessionId: current.agentSessionId,
        title: 'Display text does not grant permission', options: [{ id: 'deny', label: 'Deny', kind: 'reject-once' }],
        evidence: { source: 'native-hook', observedAt: _liveTailFixtureEpoch(0, 0, 2), run: current.run, hookReceiptId: 'late-original-hook' }
      } } }))
    })
    await expect(h.submit('late-pending')).rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
    expect([...h.accepted.values()].map(value => value.data)).toEqual([plan.payload])
    const current = await h.stored()
    expect(current.terminalPromptSubmission?.payload.inputByteRange).toEqual({ startByte: 0, endByte: Buffer.byteLength(plan.payload) })
    expect(Reflect.get(h.coordinator, 'deps').agentInputCursors.get(h.initial.agentSessionId)).toBe(Buffer.byteLength(plan.payload))
    expect(current.promptCompletionAdmission?.acknowledged).not.toBe(true)
    expect(current.promptCompletionAdmission?.notApplied).not.toBe(true)
    expect(current.terminalPromptSubmission?.submit.acknowledged).not.toBe(true)
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('an actual pending interaction and a preparation plan remain refused without entering the dispatch gate', async () => {
  const h = await fixture()
  try {
    await h.write(value => ({ ...value, pendingInteraction: { request: { kind: 'permission', id: 'exact-permission', agentSessionId: value.agentSessionId,
      title: 'Private request', options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }], evidence: { source: 'native-hook', observedAt: _liveTailFixtureEpoch(0, 0, 1), run: value.run, hookReceiptId: 'exact-permission-receipt' } } } }))
    await expect(h.submit('A')).rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
    const a = await h.save('A'); expect((await h.inner.messageQueue.inspectInput({ key: a.intent.key }))?.control.state).toBe('enabled')
    await h.write(value => { const next = { ...value }; delete next.pendingInteraction; return next })
    await expect(h.submit('B', { inputPlan: { ...plan, prepare: { interrupt: '\x1b', endEvent: 'Interrupt' } } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    expect(h.input).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('current-terminal execution cannot borrow manual authorization for automatic completion or input fences', async () => {
  const h = await fixture()
  try {
    for (const inputByte of [0, 7]) {
      const session = h.client.agentSession('recipient')
      await expect(h.coordinator.submitInputPlan(session, h.run(), 'auto-' + inputByte, text, plan, agentPromptCondition(session),
        'missing-original-completion', undefined, true, undefined, inputByte, { userContent: text }, 'immediate'))
        .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
    }
    expect(h.input).not.toHaveBeenCalled()
    expect((await h.stored()).promptCompletionAdmission).toBeUndefined()
  } finally { await h.close() }
})

it.each(['revoked', 'observation-unavailable'] as const)('a fresh owner refused before its first Runtime call confirms non-application without trapping the next input (%s)', async failure => {
  const h = await fixture()
  const refused = failure === 'revoked' ? new AgentMuxError('Current author revoked after the gate.', 'CONTROL_PERMISSION_DENIED')
    : new Error('Current author observation unavailable after the gate.')
  let gateWon = false
  try {
    const a = await h.save('A')
    const result = await h.submit('A', { authority: { assertCurrent: async () => { if (gateWon) throw refused } },
      gate: async () => { const link = await h.inner.messageQueue.authorizeInputDispatch(a.control.ref); gateWon = link !== null; return link } }).catch(error => error)
    expect(result).toBe(refused)
    expect(h.input).not.toHaveBeenCalled()
    expect(agentPromptNotApplied(await h.stored())).toEqual({ submissionId: 'A', run: h.initial.run })
    await expectWritten(h.submit('B'))
    await expect(h.submit('A')).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_NOT_APPLIED' })
    expect(h.input).toHaveBeenCalledTimes(2)
    expect((await h.store.readPromptAdmission('recipient', h.initial.run, 'A'))?.admission?.notApplied).toBe(true)
  } finally { await h.close() }
})
