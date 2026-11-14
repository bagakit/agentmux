import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentProvider } from '../src/agent-provider.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function original(initialized: boolean, native: boolean) {
  const f = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: 'grok', executorId: 'grok' })); closes.push(f.close)
  const inner = f.client as any, run = { runId: 'run-recipient' }
  inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), pid: 1234 }))
  const before = (await f.store.readMetadata('recipient'))!
  await f.store.compareAndSwapMetadata(before, { ...before, creation: { createOperationId: 'original-create', createdRun: run, initialPrompt: 'not-requested' },
    ...(initialized ? {} : { nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: 'original-native' } }) })
  await inner.registry.refresh('recipient', run)
  if (initialized) {
    await inner.acceptHookEvent({ agentSessionId: 'recipient', providerId: 'grok', runId: run.runId, receiptId: 'original-main-native-start',
      eventName: 'session_start', payload: { hookEventName: 'session_start', sessionId: 'original-native', cwd: f.root } }, AbortSignal.timeout(5000))
    expect((await f.store.readMetadata('recipient'))!.nativeBinding).toMatchObject({ source: 'native-hook', run })
  }
  const provider = f.client.providers.get('grok')
  const discover = vi.fn(async () => { throw new AgentMuxError('Current native history observation is unavailable.', 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE') })
  const read = vi.fn(async () => { throw new AgentMuxError('Retained native history is unavailable.', 'AGENT_SESSION_HISTORY_UNAVAILABLE') })
  const send = vi.fn(async () => ({ outcome: 'admitted' as const, turnId: 'original-native-turn' }))
  const prepare: NonNullable<AgentProvider['prepareNativeInput']> = async (context, target) => {
    expect(context.processId).toBe(1234); expect(target).toMatchObject({ providerId: 'grok', nativeSessionId: 'original-native' })
    return { plan: { kind: 'native-rpc', protocolId: 'original-native-channel', actorId: 'original-actor', threadId: target.nativeSessionId,
      sourceId: JSON.stringify([target.providerId, target.nativeSessionId]), operation: 'start-or-steer' },
      assertCurrent: async () => { expect((await f.client.readAgentSession('recipient'))!.nativeHandle?.sessionId).toBe('original-native') }, send, dispose: async () => {} }
  }
  f.client.providers.replace({ ...provider, discoverNativeSession: discover, readSessionHistoryPage: read,
    ...(native ? { prepareNativeInput: prepare } : {}) })
  const submit = (id: string) => f.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: run, operationId: id,
    prompt: 'Original logical Query ' + id, admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
  const key = (id: string) => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: run, submissionId: id })
  return { ...f, inner, run, discover, read, send, submit, key }
}

it.each([false, true])('an actual failed history read cannot revoke the same confirmed main binding or native=%s input', async native => {
  const f = await original(true, native), before = (await f.store.readMetadata('recipient'))!
  await expect(f.client.sessionHistoryPage('recipient', { refreshNativeSource: true })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_UNAVAILABLE' })
  expect(f.discover).toHaveBeenCalled(); expect(f.read).toHaveBeenCalled()
  const observed = (await f.store.readMetadata('recipient'))!
  expect(observed.nativeSourceObservation).toMatchObject({ state: 'unknown', run: f.run })
  expect(observed.nativeHandle).toEqual(before.nativeHandle); expect(observed.nativeBinding).toEqual(before.nativeBinding)
  await f.submit('after-history-read')
  await f.inner.inputWaitingRecipients.get('recipient')?.pending
  if (native) expect(f.send).toHaveBeenCalledTimes(1)
  else expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: f.key('after-history-read') }))?.status).toBe(native ? 'admitted' : 'terminal-confirmed'))
  if (native) { expect(f.send).toHaveBeenCalledTimes(1); expect(f.inner.kernel.input).not.toHaveBeenCalled() }
  else { expect(f.inner.kernel.input).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled() }
  await f.client.writeAgent({ agentSessionId: 'recipient', expectedRun: f.run, data: 'Explicit original terminal action', source: 'user' })
  expect(f.rawInput).toHaveBeenCalledTimes(1)
  const after = (await f.store.readMetadata('recipient'))!
  expect(after.nativeSourceObservation).toEqual(observed.nativeSourceObservation); expect(after.nativeBinding).toEqual(before.nativeBinding)
})

it('the same history failure does not initialize a Run without a native start fact', async () => {
  const f = await original(false, false)
  await expect(f.client.sessionHistoryPage('recipient', { refreshNativeSource: true })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_UNAVAILABLE' })
  expect((await f.store.readMetadata('recipient'))!.nativeSourceObservation).toMatchObject({ state: 'unknown' })
  expect((await f.store.readMetadata('recipient'))!.nativeBinding).toBeUndefined()
  await f.submit('before-native-start')
  await f.inner.inputWaitingRecipients.get('recipient')?.pending
  expect(await f.client.inspectAgentPromptSubmission(f.key('before-native-start'))).toBeNull()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
})

it('a genuinely changed native target remains refused by its original input owner', async () => {
  const f = await original(true, true)
  f.discover.mockImplementation(async () => ({ handle: { kind: 'provider', providerId: 'grok', sessionId: 'different-native' }, assertCurrent: async () => {} }) as never)
  await expect(f.client.sessionHistoryPage('recipient', { refreshNativeSource: true })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_UNAVAILABLE' })
  const observed = (await f.store.readMetadata('recipient'))!
  expect(observed.nativeSourceObservation).toMatchObject({ state: 'changed' })
  await f.submit('different-target-refused')
  await f.inner.inputWaitingRecipients.get('recipient')?.pending
  expect(await f.client.inspectAgentPromptSubmission(f.key('different-target-refused'))).toBeNull()
  expect(f.send).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
