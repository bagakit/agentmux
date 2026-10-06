import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { AgentPromptInputKey } from '../src/agent-prompt-condition.js'
import type { AgentPromptSubmissionCoordinator } from '../src/prompt-submission.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import * as sourceCore from '../src/index.js'

const core = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_RPC_CORE_ENTRY) as typeof sourceCore
  : sourceCore
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(singlePhase = false) {
  const h = await rpcOwnerFixture(['caller', 'recipient'], core)
  const inner = h.inner as unknown as {
    promptSubmission: AgentPromptSubmissionCoordinator
    screenEvidence: AgentScreenEvidenceStore
  }
  const accepted = new Map<string, { operationId: string; expectedByte: number; data: string }>()
  const cursors = new Map<string, number>()
  let loseAck = false
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'original-terminal-owner' })
  const run = (runId: string) => ({ ...h.run(runId), acceptedInputBytes: cursors.get(runId) ?? 0 })
  h.inner.kernel.status = vi.fn(async (runId: string) => run(runId))
  const input = vi.fn(async (runId: string, operation: { operationId: string; expectedByte: number; data: string }) => {
    const id = JSON.stringify([runId, operation.operationId]), original = accepted.get(id)
    if (original) expect(operation).toMatchObject(original)
    else {
      accepted.set(id, { operationId: operation.operationId, expectedByte: operation.expectedByte, data: operation.data })
      cursors.set(runId, operation.expectedByte + Buffer.byteLength(operation.data))
    }
    if (loseAck) { loseAck = false; throw new Error('Original Native ACK lost after durable input') }
    return { run: run(runId), appliedByteRange: { startByte: operation.expectedByte, endByte: operation.expectedByte + Buffer.byteLength(operation.data) } }
  })
  h.inner.kernel.input = input
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(1)
  if (singlePhase) vi.spyOn(h.client.providers.get('codex'), 'planPromptInput').mockImplementation(prompt => ({ kind: 'single-phase', data: prompt + '\r' }))
  const key = (operationId = 'original-input'): AgentPromptInputKey => ({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: operationId })
  const submit = (operationId = 'original-input') => h.client.submitAgentPrompt({
    ...core.agentPromptCondition(h.client.agentSession('recipient')), agentSessionId: 'recipient',
    operationId, prompt: ' Original body\n kept exactly. ', allowUncertainTurn: true
  })
  const coordinate = (inputKey?: AgentPromptInputKey, operationId = 'original-input') => {
    const session = h.client.agentSession('recipient'), prompt = ' Original body\n kept exactly. '
    return inner.promptSubmission.submitInputPlan(session, run(session.run.runId), operationId, prompt,
      h.client.providers.get('codex').planPromptInput(prompt), core.agentPromptCondition(session),
      undefined, undefined, true, undefined, undefined, { userContent: prompt }, 'default', undefined, undefined, undefined, inputKey)
  }
  const producerDeps = (inner.promptSubmission as unknown as { deps: {
    assertUncontrolledInput(key: AgentPromptInputKey): Promise<void>
    withUncontrolledInputClaim(key: AgentPromptInputKey, claim: () => Promise<unknown>): Promise<unknown>
  } }).deps
  return { ...h, input, accepted, key, submit, coordinate, producerDeps,
    loseAckOnce: () => { loseAck = true } }
}

describe('original terminal input producer key', () => {
  it.each([false, true])('stores the actual prompt producer key through ordinary SDK input and durable reread (single phase=%s)', async singlePhase => {
    const h = await fixture(singlePhase)
    try {
      await h.submit()
      const original = await h.client.inspectAgentPromptSubmission(h.key())
      expect(original).toMatchObject({ agentSessionId: 'recipient', run: { runId: 'run-recipient' }, admission: {
        submissionId: 'original-input', inputKey: h.key(), acknowledged: true,
        intent: { message: { userContent: ' Original body\n kept exactly. ' } }
      } })
      const restartedStore = new core.AgentMuxFileAgentSessionStore(join(h.root, 'sessions.json'))
      expect((await restartedStore.readPromptAdmission('recipient', { runId: 'run-recipient' }, 'original-input'))!.admission!.inputKey).toEqual(h.key())
      expect([...h.accepted.values()].map(item => item.data)).toEqual(singlePhase
        ? [' Original body\n kept exactly. \r'] : ['\x1b[200~ Original body\n kept exactly. \x1b[201~', '\r'])
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('keeps the coordinator default API an accurate prompt producer contract', async () => {
    const h = await fixture(true)
    try {
      await h.coordinate()
      expect((await h.client.inspectAgentPromptSubmission(h.key()))!.admission!.inputKey).toEqual(h.key())
    } finally { await h.close() }
  })

  it.each([false, true])('keeps message identity distinct through the actual A2A producer and original gates (single phase=%s)', async singlePhase => {
    const h = await fixture(singlePhase)
    try {
      const readGate = vi.spyOn(h.producerDeps, 'assertUncontrolledInput'), claimGate = vi.spyOn(h.producerDeps, 'withUncontrolledInputClaim')
      await h.client.submitAgentMessage({ agentSessionId: 'recipient', condition: core.agentPromptCondition(h.client.agentSession('recipient')),
        caller: { agentSessionId: 'caller', capability: h.capability }, envelope: {
          schema: 'agentmux.a2a.v1', operationId: 'original-message-operation', messageId: 'original-message', createdAt: reshapeFixtureEpoch(0, 0, 1),
          sender: { kind: 'agent-session', agentSessionId: 'caller' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
          senderSessionId: 'caller', senderRunId: 'run-caller', recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
          threadId: 'original-thread', correlationId: 'original-message', replyTo: null, workspaceId: null, body: 'Original message body'
        } })
      const key: AgentPromptInputKey = { kind: 'message', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, messageId: 'original-message' }
      expect((await h.client.inspectAgentPromptSubmission(key))!.admission).toMatchObject({ inputKey: key, acknowledged: true,
        intent: { message: { authorAgentSessionId: 'caller' } } })
      expect(readGate).toHaveBeenCalledWith(key)
      expect(claimGate.mock.calls.length).toBeGreaterThan(0)
      expect(claimGate.mock.calls.every(([actual]) => JSON.stringify(actual) === JSON.stringify(key))).toBe(true)
      await expect(h.client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'original-message' }))
        .rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it.each(['Session', 'Run', 'operation', 'kind'] as const)('rejects a wrong producer key %s before claim and keeps healthy input', async field => {
    const h = await fixture(true)
    try {
      const readGate = vi.spyOn(h.producerDeps, 'assertUncontrolledInput'), claimGate = vi.spyOn(h.producerDeps, 'withUncontrolledInputClaim')
      const invalid = h.key()
      if (field === 'Session') invalid.agentSessionId = 'caller'
      else if (field === 'Run') invalid.expectedRun.runId = 'run-caller'
      else if (field === 'operation') Object.assign(invalid, { submissionId: 'another-input' })
      else Object.assign(invalid, { kind: 'message' })
      await expect(h.coordinate(invalid)).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
      expect(h.input).not.toHaveBeenCalled()
      expect(readGate).not.toHaveBeenCalled(); expect(claimGate).not.toHaveBeenCalled()
      expect((await h.store.readMetadata('recipient'))!.promptCompletionAdmission).toBeUndefined()
      await h.submit('healthy-input')
      expect((await h.client.inspectAgentPromptSubmission(h.key('healthy-input')))!.admission!.acknowledged).toBe(true)
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('rejects a changed producer kind on the same original operation without changing its payload or key', async () => {
    const h = await fixture(true)
    try {
      await h.coordinate()
      const original = await h.client.inspectAgentPromptSubmission(h.key()), writes = [...h.accepted.values()]
      await expect(h.coordinate({ kind: 'message', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, messageId: 'original-input' }))
        .rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      expect(await h.client.inspectAgentPromptSubmission(h.key())).toEqual(original)
      expect([...h.accepted.values()]).toEqual(writes)
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('keeps an old missing producer key unknown on reread and refuses to backfill it during retry', async () => {
    const h = await fixture(true)
    try {
      await h.submit()
      const before = (await h.store.readMetadata('recipient'))!, old = structuredClone(before)
      delete old.promptCompletionAdmission!.inputKey; old.updatedAt++
      await h.store.compareAndSwap(before, old); await h.inner.registry.load('local')
      const writes = [...h.accepted.values()]
      expect((await h.client.inspectAgentPromptSubmission(h.key()))!.admission!.inputKey).toBeUndefined()
      await expect(h.submit()).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
      expect((await h.client.inspectAgentPromptSubmission(h.key()))!.admission!.inputKey).toBeUndefined()
      expect((await h.store.readMetadata('recipient'))!.promptCompletionAdmission!.intent).toEqual(old.promptCompletionAdmission!.intent)
      expect([...h.accepted.values()]).toEqual(writes)
      await h.submit('new-explicit-input')
      expect((await h.client.inspectAgentPromptSubmission(h.key('new-explicit-input')))!.admission!.inputKey).toEqual(h.key('new-explicit-input'))
      expect((await h.client.inspectAgentPromptSubmission(h.key()))!.admission!.inputKey).toBeUndefined()
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it.each([false, true])('keeps the frozen key after a lost ACK and rejoins only original Native operation identities (single phase=%s)', async singlePhase => {
    const h = await fixture(singlePhase)
    try {
      h.loseAckOnce()
      await expect(h.submit()).rejects.toThrow('Original Native ACK lost')
      const original = await h.client.inspectAgentPromptSubmission(h.key())
      expect(original!.admission).toMatchObject({ inputKey: h.key(), acknowledged: false })
      const actual = [...h.accepted.values()], calls = h.input.mock.calls.length
      await expect(h.coordinate({ kind: 'message', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, messageId: 'original-input' }))
        .rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
      expect(h.input.mock.calls).toHaveLength(calls)
      await h.submit()
      expect([...h.accepted.values()].slice(0, actual.length)).toEqual(actual)
      expect(h.accepted.size).toBe(singlePhase ? 1 : 2)
      expect((await h.client.inspectAgentPromptSubmission(h.key()))!.admission!.inputKey).toEqual(original!.admission!.inputKey)
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })
})
