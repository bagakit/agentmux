import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { renderAgentMuxMessageEnvelope } from '../src/agent-message-render.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

async function harness(singlePhase = false) {
  const template = new AgentProviderRegistry().get('codex')
  const generic = defineAgentProvider({
    catalog: { ...template.catalog, id: 'generic', label: 'Generic', executable: 'generic', expectedProcess: 'generic' },
    hook: template.hook,
    buildArgs: (_prompt, args) => [...args]
  })
  const providerId = singlePhase ? generic.id : 'codex'
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId: 'a', providerId, executorId: providerId,
    hostId: 'local', workspacePath: '/repo', run: { runId: 'r' }, retiredRuns: [],
    hookBindingId: 'binding', hookToken: 'token',
    createdAt: 1, updatedAt: 1
  })
  const client = new AgentMuxClient({ store, ...(singlePhase ? { providers: [generic] } : {}) })
  const inner = client as any
  await inner.registry.load('local')
  inner.connected = true
  let cursor = 0
  const writes: string[] = []
  const run = () => ({ runId: 'r', lifecycleOperationId: null, program: 'codex', args: [],
    workspacePath: '/repo', pid: 123, state: { type: 'running' }, cols: 80, rows: 24,
    latestOutputBytes: 100, firstAvailableByte: 0, acceptedInputBytes: cursor })
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'daemon' })
  inner.kernel.status = async () => run()
  const accepted = new Map<string, unknown>()
  inner.kernel.input = async (_id: string, op: { operationId: string; expectedByte: number; data: string }) => {
    if (accepted.has(op.operationId)) return accepted.get(op.operationId)
    writes.push(op.data)
    cursor = op.expectedByte + Buffer.byteLength(op.data)
    const receipt = { run: run(), appliedByteRange: { startByte: op.expectedByte, endByte: cursor } }
    accepted.set(op.operationId, receipt)
    return receipt
  }
  vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(120)
  const send = (operationId: string, prompt: string, allowUncertainTurn = false) =>
    client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession('a')), agentSessionId: 'a', operationId, prompt, allowUncertainTurn })
  const complete = async (observedAt: number) => inner.registry.update('a', { runId: 'r' },
    (current: AgentMuxStoredAgentSession) => ({ ...current, updatedAt: Math.max(current.updatedAt, observedAt),
      semanticStatus: { state: 'done', source: 'native-hook', observedAt } }))
  return { client, inner, store, writes, send, complete, setCursor: (value: number) => { cursor = value } }
}

it('keeps unknown turns honest and offers explicit continuation without weakening replay', async () => {
  const h = await harness()
  try {
    await h.send('first', 'hello')
    expect(h.inner.promptSubmission.localSubmissionClaims.size).toBe(0)
    expect(h.writes).toEqual(['hello', '\r'])
    await expect(h.send('second', 'next')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    expect(h.writes).toEqual(['hello', '\r'])
    await h.send('second', 'next', true)
    expect(h.writes).toEqual(['hello', '\r', 'next', '\r'])
    expect(h.client.agentSession('a').terminalPromptDelivery).toMatchObject({
      reason: 'turn-end-unconfirmed', submissionId: 'second'
    })
    expect((await h.store.loadTimeline('a')).items.find((item) => item.id === 'prompt:second')).toMatchObject({
      content: 'next', status: 'complete'
    })
    await h.send('second', 'next', true)
    expect(h.writes).toEqual(['hello', '\r', 'next', '\r'])
    await expect(h.send('second', 'changed', true)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  } finally { await h.client.dispose() }
})

it('uses each native completion once and does not let automation bypass a consumed turn', async () => {
  const h = await harness()
  try {
    await h.send('first', 'hello')
    await h.complete(200)
    await h.send('after-end', 'next')
    expect(h.writes).toEqual(['hello', '\r', 'next', '\r'])
    expect(h.client.agentSession('a').terminalPromptDelivery).toBeUndefined()
    await expect(h.send('unknown', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    await expect(h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession('a')), agentSessionId: 'a', operationId: 'auto', prompt: 'auto',
      allowUncertainTurn: true, expectedCompletionId: JSON.stringify(['r', 200]), expectedInputByte: (await h.client.statusAgent('a')).run.acceptedInputBytes
    })).rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
    expect(h.writes).toEqual(['hello', '\r', 'next', '\r'])
  } finally { await h.client.dispose() }
})

it('does not overwrite a partially accepted claim from a previous owner', async () => {
  const h = await harness()
  try {
    vi.mocked(h.inner.screenEvidence.wait).mockRejectedValueOnce(new Error('render observation lost'))
    await expect(h.send('original', 'hello')).rejects.toThrow('render observation lost')
    expect(h.writes).toEqual(['hello'])
    expect(h.inner.promptSubmission.localSubmissionClaims.size).toBe(1)
    h.inner.promptSubmission.localSubmissionClaims.clear()
    await expect(h.send('different', 'new text', true)).rejects.toMatchObject({ code: 'AGENT_PROMPT_SUBMISSION_BUSY' })
    expect(h.writes).toEqual(['hello'])
    await h.send('original', 'hello')
    expect(h.writes).toEqual(['hello', '\r'])
  } finally { await h.client.dispose() }
})


it('applies the same one-message turn boundary to a generic default single-phase Provider', async () => {
  const h = await harness(true)
  try {
    await h.send('first', 'hello')
    expect(h.inner.promptSubmission.localSubmissionClaims.size).toBe(0)
    expect(h.writes).toEqual(['hello\r'])
    await expect(h.send('second', 'next')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    expect(h.writes).toEqual(['hello\r'])
    await h.send('second', 'next', true)
    expect(h.writes).toEqual(['hello\r', 'next\r'])
    expect(h.client.agentSession('a').terminalPromptDelivery).toMatchObject({ reason: 'turn-end-unconfirmed', submissionId: 'second' })
    expect((await h.store.loadTimeline('a')).items.find((item) => item.id === 'prompt:second')).toMatchObject({ status: 'complete' })
    await h.send('second', 'next')
    expect(h.writes).toEqual(['hello\r', 'next\r'])
    expect(h.client.agentSession('a').terminalPromptDelivery).toMatchObject({ reason: 'turn-end-unconfirmed', submissionId: 'second' })
    await expect(h.send('third', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    await expect(h.send('second', 'different', true)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    await h.complete(200)
    await h.send('after-end', 'after')
    expect(h.writes).toEqual(['hello\r', 'next\r', 'after\r'])
    expect(h.client.agentSession('a').terminalPromptDelivery).toBeUndefined()
    await expect(h.send('unknown', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
  } finally { await h.client.dispose() }
})

it('keeps a partial single-phase claim exclusive and permits only zero-byte old-owner takeover', async () => {
  const h = await harness(true)
  try {
    const input = h.inner.kernel.input
    h.inner.kernel.input = async () => { throw new Error('receipt unavailable') }
    await expect(h.send('old', 'hello')).rejects.toThrow('receipt unavailable')
    await expect(h.send('new', 'next', true)).rejects.toMatchObject({ code: 'AGENT_PROMPT_SUBMISSION_BUSY' })
    h.inner.promptSubmission.localSubmissionClaims.clear()
    h.setCursor(2)
    await expect(h.send('new', 'next', true)).rejects.toMatchObject({ code: 'AGENT_PROMPT_SUBMISSION_BUSY' })
    expect(h.writes).toEqual([])
    h.setCursor(0)
    h.inner.kernel.input = input
    await h.send('new', 'next', true)
    expect(h.writes).toEqual(['next\r'])
    await h.complete(200)
    h.inner.kernel.input = async (...args: unknown[]) => { await input(...args); throw new Error('receipt unavailable') }
    await expect(h.send('accepted', 'sent')).rejects.toThrow('receipt unavailable')
    h.inner.promptSubmission.localSubmissionClaims.clear()
    h.inner.kernel.input = input
    await expect(h.send('different', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    await h.send('accepted', 'sent')
    expect(h.writes).toEqual(['next\r', 'sent\r'])
  } finally { await h.client.dispose() }
})


it.each([false, true])('never lends a failed zero-byte operation its explicit choice to a different operation (single phase=%s)', async (singlePhase) => {
  const h = await harness(singlePhase)
  try {
    await h.send('first', 'hello')
    const input = h.inner.kernel.input
    h.inner.kernel.input = async () => { throw new Error('input not accepted') }
    await expect(h.send('second', 'next', true)).rejects.toThrow('input not accepted')
    expect(h.client.agentSession('a').terminalPromptDelivery).toMatchObject({ reason: 'turn-end-unconfirmed', submissionId: 'second' })
    h.inner.promptSubmission.localSubmissionClaims.clear()
    h.inner.kernel.input = input
    await expect(h.send('third', 'different')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    expect(h.writes).toEqual(singlePhase ? ['hello\r'] : ['hello', '\r'])
    await h.send('second', 'next')
    expect(h.client.agentSession('a').terminalPromptDelivery).toMatchObject({ reason: 'turn-end-unconfirmed', submissionId: 'second' })
    expect(h.writes).toEqual(singlePhase ? ['hello\r', 'next\r'] : ['hello', '\r', 'next', '\r'])
    await expect(h.send('third', 'different')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    await h.send('third', 'different', true)
    expect(h.writes).toEqual(singlePhase ? ['hello\r', 'next\r', 'different\r'] : ['hello', '\r', 'next', '\r', 'different', '\r'])
  } finally { await h.client.dispose() }
})


it('delivers a projected A2A body without trimming its original trailing bytes', async () => {
  const h = await harness(true)
  try {
    const body = 'original body \n\n  '
    const prompt = renderAgentMuxMessageEnvelope({
      schema: 'agentmux.a2a.v1', messageId: 'msg', operationId: 'message-op', createdAt: 1,
      sender: { kind: 'agent-session', agentSessionId: 'sender' }, recipient: { kind: 'agent-session', agentSessionId: 'a' },
      threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null,
      senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: 'a', recipientRunId: 'r', body
    })
    await h.send('a2a-body', prompt)
    expect(h.writes).toEqual([`${prompt}\r`])
    expect((await h.store.loadTimeline('a')).items.find((item) => item.id === 'prompt:a2a-body')).toMatchObject({ content: prompt })
    await expect(h.send('blank', ' \n\t')).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
  } finally { await h.client.dispose() }
})


it.each([false, true])('durably keeps the scoped uncertainty notice before first input even if publication is interrupted (single phase=%s)', async (singlePhase) => {
  const h = await harness(singlePhase)
  try {
    await h.send('first', 'hello')
    const publication = vi.spyOn(h.inner.promptSubmission, 'publishDeliveryDegrade').mockRejectedValueOnce(new Error('publication interrupted'))
    await expect(h.send('second', 'next', true)).rejects.toThrow('publication interrupted')
    expect(((await h.store.load())[0] as AgentMuxStoredAgentSession).terminalPromptDelivery).toMatchObject({ reason: 'turn-end-unconfirmed', submissionId: 'second' })
    expect(h.writes).toEqual(singlePhase ? ['hello\r'] : ['hello', '\r'])
    publication.mockRestore()
    h.inner.promptSubmission.localSubmissionClaims.clear()
    await h.send('second', 'next')
    expect(h.client.agentSession('a').terminalPromptDelivery).toMatchObject({ reason: 'turn-end-unconfirmed', submissionId: 'second' })
    expect(h.writes).toEqual(singlePhase ? ['hello\r', 'next\r'] : ['hello', '\r', 'next', '\r'])
  } finally { await h.client.dispose() }
})
