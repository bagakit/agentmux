import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentProvider, AgentProviderPreparedNativeInput } from '../src/agent-provider.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { cloneSession } from '../src/agent-session-identity.js'
import { parseRpcAgentSession } from '../src/rpc-native-codec.js'
import { validateAgentPromptAdmissionIntent, validateAgentPromptInputBinding } from '../src/agent-prompt-condition.js'
import { parseAgentInputMailboxPage } from '../src/agent-input-mailbox-codec.js'
import { AgentMuxError } from '../src/errors.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const target = { providerId: 'codex', nativeSessionId: 'selected-original-thread' }
const actor = { protocolId: 'fixture-native-protocol', actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
const key = (submissionId: string) => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId })
const input = (operationId: string) => ({ agentSessionId: 'recipient', operationId, expectedRun: { runId: 'run-recipient' },
  admissionIntent: { kind: 'native-conversation' as const, source: target }, execution: 'immediate' as const, prompt: 'Original selected-source input', authorHuman: true })
async function owner(outcome: 'admitted' | 'unknown' | 'not-applied' = 'admitted') {
  const h = await rpcOwnerFixture(['recipient']); closes.push(h.close)
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(original, { ...original, nativeActor: actor }); await h.inner.registry.load('local')
  h.inner.kernel.status = vi.fn(async (runId: string) => ({ ...h.run(runId), pid: 1234 }))
  const inner = h.client as unknown as { providers: { get(id: string): AgentProvider } }
  const send = vi.fn<AgentProviderPreparedNativeInput['send']>(async (_prompt, plan) => {
    const token = JSON.parse(Buffer.from(plan.clientCorrelation!.split('.')[1]!, 'base64url').toString('utf8'))
    const persisted = await new AgentMuxFileAgentSessionStore(h.store.path).readPromptAdmission('recipient', { runId: 'run-recipient' }, token.key.submissionId ?? token.key.messageId)
    expect(persisted?.admission?.intent?.plan).toEqual(plan)
    expect(persisted?.admission?.inputKey).toEqual(token.key)
    expect(plan.clientCorrelation).toMatch(/^amux-input-v1\./u); expect(token.nonce).toHaveLength(32)
    if (outcome === 'unknown') throw new Error('The native request ACK was lost after send')
    if (outcome === 'not-applied') return { outcome, errorCode: -32600 }
    return { outcome, turnId: 'original-native-turn' }
  })
  const prepare = vi.fn<NonNullable<AgentProvider['prepareNativeInput']>>(async (context, selected) => {
    expect(context.nativeActor).toEqual(actor); expect(context.processId).toBe(1234)
    if (selected.providerId !== target.providerId || selected.nativeSessionId !== target.nativeSessionId) throw new AgentMuxError('Exact source is not loaded by this original actor', 'AGENT_NATIVE_INPUT_UNAVAILABLE')
    return { plan: { kind: 'native-rpc', protocolId: actor.protocolId, sourceId: JSON.stringify([selected.providerId, selected.nativeSessionId]), actorId: actor.actorId,
      threadId: selected.nativeSessionId, ...(selected.expectedTurnId ? { operation: 'steer', expectedTurnId: selected.expectedTurnId } : { operation: 'start-or-steer' }) }, send, dispose: vi.fn() }
  })
  inner.providers.get('codex').prepareNativeInput = prepare
  // Deterministic Provider byte port for coordinator tests; the native binary E2E uses its real TUI renderer.
  inner.providers.get('codex').planPromptInput = prompt => ({ kind: 'single-phase', data: prompt + '\r' })
  return { ...h, send, prepare }
}

it('freezes exact native input key and correlation in the original durable claim before dispatch; receipt-only retries never send', async () => {
  const h = await owner()
  await h.client.submitAgentPrompt(input('first-native'))
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('first-native') }))?.status).toBe('admitted')
  const first = await h.client.inspectAgentInput({ key: key('first-native') })
  expect(first).toMatchObject({ key: key('first-native'), status: 'admitted', admission: { admission: { transport: 'native', native: { outcome: 'admitted', turnId: 'original-native-turn' } } } })
  await h.client.submitAgentPrompt(input('first-native')); expect(h.send).toHaveBeenCalledTimes(1)
  await h.client.submitAgentPrompt(input('second-native')); await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('second-native') }))?.status).toBe('admitted'); expect(h.send).toHaveBeenCalledTimes(2)
  const old = await h.client.inspectAgentPromptSubmission(key('first-native')), latest = await h.client.inspectAgentPromptSubmission(key('second-native'))
  expect(old?.admission?.intent?.plan).toMatchObject({ clientCorrelation: h.send.mock.calls[0]![1].clientCorrelation })
  expect(old?.admission?.intent?.plan).not.toEqual(latest?.admission?.intent?.plan)
  const mailbox = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' }); expect(mailbox.items).toHaveLength(2)
  expect(parseAgentInputMailboxPage(mailbox, { agentSessionId: 'recipient' })).toEqual(mailbox)
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps unknown native outcome, original token and source after reopen and never upgrades or automatically replays it', async () => {
  const h = await owner('unknown')
  await h.client.submitAgentPrompt(input('unknown-native')); await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('unknown-native') }))?.status).toBe('unknown')
  const first = await h.client.inspectAgentPromptSubmission(key('unknown-native'))
  expect(first?.admission).toMatchObject({ transport: 'native', acknowledged: false, native: { outcome: 'unknown' } })
  expect(await h.client.submitAgentPrompt(input('unknown-native'))).toMatchObject({ status: 'unknown' })
  expect(h.send).toHaveBeenCalledTimes(1)
  const reopened = new AgentMuxFileAgentSessionStore(h.store.path)
  expect(await reopened.readPromptAdmission('recipient', key('unknown-native').expectedRun, 'unknown-native')).toEqual(first)
  await h.client.submitAgentPrompt(input('independent-native')); await expect.poll(async () => h.send.mock.calls.length).toBe(2); expect(h.send).toHaveBeenCalledTimes(2)
  expect(await h.client.inspectAgentPromptSubmission(key('unknown-native'))).toEqual(first)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('retains rejected exact-turn native receipt without PTY fallback and refuses another source on the same key', async () => {
  const h = await owner('not-applied')
  const request = { ...input('exact-native'), admissionIntent: { ...input('exact-native').admissionIntent, expectedTurnId: 'stale-original-turn' } }
  await h.client.submitAgentPrompt(request); await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('exact-native') }))?.status).toBe('not-applied')
  expect(await h.client.inspectAgentInput({ key: key('exact-native') })).toMatchObject({ status: 'not-applied', admission: { admission: { native: { plan: { expectedTurnId: 'stale-original-turn' }, outcome: 'not-applied', errorCode: -32600 } } } })
  expect(await h.client.submitAgentPrompt(request)).toMatchObject({ status: 'not-applied' }); expect(h.send).toHaveBeenCalledTimes(1)
  await expect(h.client.submitAgentPrompt({ ...request, admissionIntent: { ...request.admissionIntent, source: { ...target, nativeSessionId: 'another-source' } } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('rejects an unavailable selected native source without claiming input or taking away independent ordinary TTY input', async () => {
  const h = await owner()
  const wrong = { ...input('wrong-source'), admissionIntent: { kind: 'native-conversation' as const, source: { ...target, nativeSessionId: 'foreign-thread' } } }
  expect(await h.client.submitAgentPrompt(wrong)).toMatchObject({ status: 'waiting' })
  expect(await h.client.inspectAgentPromptSubmission(key('wrong-source'))).toBeNull(); expect(h.send).not.toHaveBeenCalled()
  const ordinary = { ...input('ordinary-terminal'), admissionIntent: { kind: 'manual-actor' as const } }
  await h.client.submitAgentPrompt(ordinary); await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('ordinary-terminal') }))?.status).toBe('terminal-confirmed')
  expect(h.inner.kernel.input).toHaveBeenCalledTimes(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps original old Runs without a native port usable and never exposes private launch credentials', async () => {
  const h = await owner()
  const stored = (await h.store.readMetadata('recipient'))!
  expect(cloneSession(stored)).not.toHaveProperty('nativeActor'); expect(() => parseRpcAgentSession(stored)).toThrow()
  const { nativeActor: _actor, ...oldRun } = stored
  await h.store.compareAndSwap(stored, oldRun); await h.inner.registry.load('local')
  expect(await h.client.submitAgentPrompt(input('old-no-port'))).toMatchObject({ status: 'waiting' })
  expect(h.prepare).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled()
  await h.client.submitAgentPrompt({ ...input('old-terminal'), admissionIntent: { kind: 'manual-actor' as const } }); await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('old-terminal') }))?.status).toBe('terminal-confirmed')
})

it('public RPC uses the exact explicit native intent and original message journal; source changes cannot borrow an existing receipt', async () => {
  const h = await owner(), rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const packet = { operationId: 'native-message-control', target: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, text: 'Original explicit message', execution: 'immediate' as const,
    admissionIntent: { ...input('unused').admissionIntent, expectedRun: key('unused').expectedRun } }
  const first: any = await rpc.call('agent.send', packet, { principal: { kind: 'user', id: 'user' } })
  expect(first.inputReceipt).toMatchObject({ key: { kind: 'message', messageId: first.messageId } })
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: first.inputReceipt.key }))?.status).toBe('admitted')
  expect(first.messageId).not.toBe(packet.operationId); expect(h.send).toHaveBeenCalledTimes(1)
  const again: any = await rpc.call('agent.send', packet, { principal: { kind: 'user', id: 'user' } })
  expect(again.inputReceipt?.status ?? again.delivery.state).toBe('admitted'); expect(h.send).toHaveBeenCalledTimes(1)
  await expect(rpc.call('agent.send', { ...packet, admissionIntent: { ...packet.admissionIntent, source: { ...target, nativeSessionId: 'other-native-source' } } }, { principal: { kind: 'user', id: 'user' } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('strict original intent codecs retain opaque targets and reject mixed caller conditions or unknown target fields', () => {
  const intent = { ...input('unused').admissionIntent, expectedRun: key('unused').expectedRun, expectedTurnId: 'opaque:turn/kept' }
  expect(validateAgentPromptAdmissionIntent(intent)).toEqual(intent)
  expect(validateAgentPromptInputBinding({ expectedRun: intent.expectedRun, admissionIntent: { kind: intent.kind, source: intent.source, expectedTurnId: intent.expectedTurnId } })).toMatchObject({ admissionIntent: { source: target } })
  for (const bad of [{ ...intent, afterSubmissionId: null }, { ...intent, source: { ...intent.source, actorId: 'caller-supplied-actor' } }, { ...intent, source: { ...target, nativeSessionId: '' } }]) expect(() => validateAgentPromptAdmissionIntent(bad)).toThrow()
})
