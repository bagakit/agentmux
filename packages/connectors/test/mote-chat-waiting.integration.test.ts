import { appendFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { moteChatDiagnosisKey } from '@agentmux/core/mote-chat'
import { moteChatJourneyFixture as fixture } from './fixtures/mote-chat-journey.js'

it('diagnoses the original Core wait and preparation reason through the default owner without rejoining or dispatching it', async () => {
  const f = await fixture(1, 60_000, 'headless')
  let connected = true, failure: AgentMuxError | undefined
  f.inner.kernel.isConnected = () => connected
  const originalStatus = f.inner.kernel.status as (id: string) => Promise<ReturnType<typeof f.run>>
  f.inner.kernel.status = async (id: string) => { if (failure) { const original = failure; failure = undefined; throw original }; return await originalStatus(id) }
  const originalSubmit = f.submission.getMockImplementation()!
  f.submission.mockImplementationOnce(async (...args) => { connected = false; return await originalSubmit(...args) })
  const rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  expect(await f.wire.post(f.message('retained-wait'))).toBe(202)
  const record = await f.claimed('retained-wait'), key = moteChatDiagnosisKey(f.target, record.ingressId)
  const runtimeWait = { phase: 'runtime', reason: 'runtime-unavailable', wake: 'runtime-restored' }
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt)
    .toMatchObject({ status: 'waiting', observation: 'owned', control: { state: 'enabled', waiting: runtimeWait } }))
  const report = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  const input = report.incoming!.rows.find(row => row.key === key)!.input
  if (process.env.T031_FACTS) appendFileSync(process.env.T031_FACTS, JSON.stringify({ phase: 'runtime-wait', input }) + '\n')
  expect(input).toEqual({ status: 'waiting', observation: 'observed', controlState: 'enabled', receiptObservation: 'owned', waiting: runtimeWait, preparationReason: null, failureCode: null })
  await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(rejoin).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.start).toHaveBeenCalledOnce()

  // The existing original owner explicitly rejoins; diagnosis itself never does this.
  connected = true
  failure = new AgentMuxError('Private exception body and source must stay private', 'AGENT_PROMPT_PREPARATION_FAILED', JSON.stringify({ preparationWait: {
    reason: 'context-compaction', retrySafe: true, agentSessionId: record.input!.agentSessionId, runId: record.input!.expectedRun.runId,
    operationId: record.input!.messageId, nativeSourceId: 'private-native-source', inputByte: 0
  } }))
  await f.services.ingress!.rejoin(record.ingressId)
  await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt)
    .toMatchObject({ status: 'waiting', observation: 'rejoin-needed', control: { waiting: { phase: 'input-environment', reason: 'original-input-unconfirmed' } } }))
  const preparation = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(preparation.incoming!.rows[0]!.input).toEqual({ status: 'waiting', observation: 'observed', controlState: 'enabled',
    receiptObservation: 'rejoin-needed', waiting: { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin' }, preparationReason: 'context-compaction', failureCode: null })
  expect(rejoin).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const serialized = JSON.stringify(preparation)
  for (const privateValue of [f.root, f.creator.userId, record.body, record.ingressId, record.input!.agentSessionId,
    record.input!.expectedRun.runId, record.input!.operationId, record.input!.messageId, 'private-native-source', 'Private exception body', 'retrySafe', 'inputByte'])
    expect(serialized).not.toContain(privateValue)

  await f.services.ingress!.rejoin(record.ingressId)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  await vi.waitFor(async () => expect((await f.sdk.call('space.mote.chat.diagnose', { target: f.target })).incoming!.rows[0]!.input)
    .toEqual({ status: 'terminal-confirmed', observation: 'observed', controlState: 'dispatch-authorized', receiptObservation: 'closed', waiting: null, preparationReason: null, failureCode: null }))
  expect((await f.records())[0]!.input).toEqual(record.input)
  expect(f.start).toHaveBeenCalledOnce(); expect(f.submission).toHaveBeenCalledOnce(); expect(rejoin).toHaveBeenCalledTimes(2)
  expect(f.wire.effects).toHaveLength(0)
  if (process.env.T031_FACTS) appendFileSync(process.env.T031_FACTS, JSON.stringify({ phase: 'original-recovered', originalInputRetained: true, createCount: f.start.mock.calls.length,
    originalSubmitCount: f.submission.mock.calls.length, explicitRejoins: rejoin.mock.calls.length, inputWrites: vi.mocked(f.inner.kernel.input as () => Promise<unknown>).mock.calls.length, platformEffects: f.wire.effects.length }) + '\n')
}, 20_000)
