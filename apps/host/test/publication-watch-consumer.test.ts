import { appendFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import type { ConversationObservation, ConversationObservationHandle } from '@agentmux/core/conversation'
import { MoteChatStore } from '../../../packages/connectors/src/mote-chat-store.js'
import { moteChatJourneyFixture } from '../../../packages/connectors/test/fixtures/mote-chat-journey.js'

it.each(['opening', 'in-flight'] as const)('the original product publication recovers a native watch %s failure without another input or healthy-lane polling', async phase => {
  // This exercises the original Core/ConnectionServices/PublicationHost composition.
  // T035 separately owns default Executor/creation and the real payload + Enter plan.
  const f = await moteChatJourneyFixture(1, 60_000, 'headless')
  const client = f.client
  const watches: Array<{ handle: ConversationObservationHandle; closedAtOpen: boolean; listener(value: ConversationObservation): void; events: ConversationObservation[] }> = []
  let releaseRead: (() => void) | undefined
  try {
    const provider = client.providers.get('claude') as core.AgentProvider & Required<Pick<core.AgentProvider, 'observeSessionHistory'>>
    if (!provider.observeSessionHistory) throw Error('The original Provider must own native observation')
    const observeNative = provider.observeSessionHistory.bind(provider)
    const native: Array<{ context: Parameters<NonNullable<typeof provider.observeSessionHistory>>[0]; handle: core.AgentSessionHistoryObservationHandle }> = []
    let unavailable = phase === 'opening'
    vi.spyOn(provider, 'observeSessionHistory').mockImplementation(async context => {
      if (unavailable) throw new core.AgentMuxError('The original native watch is temporarily unavailable.', 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE')
      const handle = await observeNative(context); native.push({ context, handle }); return handle
    })
    const observe = client.observeConversation.bind(client)
    vi.spyOn(client, 'observeConversation').mockImplementation(async (input, listener, options) => {
      const events: ConversationObservation[] = []
      const handle = await observe(input, value => { events.push(value); listener(value) }, options)
      watches.push({ handle, closedAtOpen: handle.closed.aborted, listener, events }); return handle
    })
    const readChanges = client.readConversationChanges.bind(client)
    const changes = vi.spyOn(client, 'readConversationChanges')
    const adapter = f.wire.adapter.publication! as NonNullable<typeof f.wire.adapter.publication> & Required<Pick<NonNullable<typeof f.wire.adapter.publication>, 'inspect'>>
    const dispatch = adapter.dispatch.bind(adapter), inspect = adapter.inspect.bind(adapter)
    let allowInspect = phase === 'opening'
    const sends = vi.spyOn(adapter, 'dispatch').mockImplementation(async (...args) => {
      const receipt = await dispatch(...args)
      return phase === 'in-flight' ? { state: 'unknown', reason: 'effect-unconfirmed' } : receipt
    })
    const inspections = vi.spyOn(adapter, 'inspect').mockImplementation(async (...args) => allowInspect ? await inspect(...args) : null)
    await vi.waitFor(() => expect(f.wire.endpoint).toBeDefined())
    expect(await f.wire.post(f.message('original-watch-input'))).toBe(202)
    const services = f.services
    let input: import('@agentmux/core/connections').ConnectionIngressMessage | undefined
    await vi.waitFor(async () => {
      input = (await services.ingress!.list({ connectionId: 'original-bot' })).ingresses[0] as typeof input
      expect(input?.state).toBe('claimed')
      const receipt = (await services.ingress!.inspect({ ingressId: input!.ingressId })).inputReceipt
      if (receipt?.status !== 'terminal-confirmed' && process.env.T040_FACTS) appendFileSync(process.env.T040_FACTS, JSON.stringify({ phase: 'fixture-input', receipt }) + '\n')
      expect(receipt?.status).toBe('terminal-confirmed')
    })
    const saved = new MoteChatStore(services.database!).generationBySession(input!.input!.agentSessionId)!
    const binding = saved.binding!, session = (await client.readAgentSession(binding.agentSessionId))!
    const source = session.nativeHandle!
    if (source.kind !== 'provider' || !source.transcriptPath) throw Error('The exact original native reply source is required')
    const listing = () => services.connections.delivery!.list({ connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision })
    await vi.waitFor(() => expect(watches.length).toBeGreaterThanOrEqual(2))
    if (phase === 'opening') {
      const partial = watches[0]!
      if (process.env.T040_FACTS) appendFileSync(process.env.T040_FACTS, JSON.stringify({ phase: 'partial-opening', closed: partial.closedAtOpen, coverage: partial.handle.coverage }) + '\n')
      expect(partial.closedAtOpen).toBe(false)
      expect(partial.handle.coverage).toContainEqual(expect.objectContaining({ source: expect.objectContaining({ kind: 'native' }), current: 'unavailable' }))
      expect(partial.handle.coverage).toContainEqual(expect.objectContaining({ source: expect.objectContaining({ kind: 'captured' }), current: 'partial', gaps: [] }))
      const captured = await client.readAgentConversation({ hostId: 'local', agentSessionId: session.agentSessionId })
      expect(JSON.stringify(captured)).toContain(f.message('original-watch-input').text)
    } else {
      await vi.waitFor(async () => expect((await listing()).observation?.state).toBe('ready'))
      let entered!: () => void
      const entering = new Promise<void>(resolve => { entered = resolve })
      const gate = new Promise<void>(resolve => { releaseRead = resolve })
      changes.mockImplementationOnce(async (...args) => { entered(); await gate; return await readChanges(...args) })
      await appendFile(source.transcriptPath, JSON.stringify({ sessionId: source.sessionId, uuid: 'native-process-observation', type: 'system', message: { role: 'system', content: 'Private native process observation' } }) + '\n')
      await entering
      const original = native.at(-1)!
      unavailable = true
      original.context.onChange({ kind: 'unavailable', source: original.context.source, code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE', message: 'The original native watch ended.' })
      original.handle.dispose()
      releaseRead!(); releaseRead = undefined
    }
    // Readability cannot erase an unavailable accepted-source subscription.
    await vi.waitFor(async () => {
      const report = await listing()
      expect(report.observation).toEqual({ state: 'unavailable', reason: 'source-unconfirmed' })
      expect(report.sourceObservation).toMatchObject({ state: 'unavailable', reason: 'source-unconfirmed' })
    })
    const prior = watches.at(-1)!
    unavailable = false
    await appendFile(source.transcriptPath, JSON.stringify({ sessionId: source.sessionId, uuid: 'original-native-reply', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The original reply after native watch recovery' }] } }) + '\n')
    await vi.waitFor(() => expect(f.wire.effects.filter(effect => effect.text === 'The original reply after native watch recovery')).toHaveLength(1), { timeout: 8_000 })
    if (phase === 'in-flight') {
      await vi.waitFor(async () => expect((await listing()).deliveries[0]?.state).toBe('unknown'))
      const original = (await listing()).deliveries[0]!
      expect(sends).toHaveBeenCalledOnce()
      allowInspect = true
      await vi.waitFor(async () => expect((await listing()).deliveries[0]).toMatchObject({ operationId: original.operationId, state: 'confirmed' }), { timeout: 8_000 })
      expect(inspections.mock.calls.some(([prepared]) => prepared.requestKey === original.operationId)).toBe(true)
      expect(sends).toHaveBeenCalledOnce()
    }
    await vi.waitFor(async () => expect((await listing()).observation?.state).toBe('ready'))
    const healthy = watches.at(-1)!, reads = changes.mock.calls.length
    const failure = prior.events.find(value => value.kind === 'unavailable')!
    expect(failure).toBeDefined()
    prior.listener(failure)
    prior.listener({ ...failure, kind: 'invalidated' } as ConversationObservation)
    healthy.listener({ ...failure, sourceHostId: 'foreign-host' })
    healthy.listener({ ...failure, source: { kind: 'captured' } })
    expect((await listing()).observation?.state).toBe('ready')
    await new Promise(resolve => setTimeout(resolve, 5_200))
    expect(changes).toHaveBeenCalledTimes(reads)
    expect(f.wire.effects.filter(effect => effect.text === 'The original reply after native watch recovery')).toHaveLength(1)
    expect(sends).toHaveBeenCalledOnce()
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.inner.kernel.input).toHaveBeenCalledOnce()
    expect((await services.ingress!.inspect({ ingressId: input!.ingressId })).ingress).toMatchObject({ input: input!.input })
    if (process.env.T040_FACTS) appendFileSync(process.env.T040_FACTS, JSON.stringify({ phase, nativeCoverageUnavailable: true, capturedReadable: phase === 'opening', originalInputRetained: true,
      nativeReplyEffects: 1, inputWrites: 1, createCount: 1, healthyReadsAdded: changes.mock.calls.length - reads, oldWatchIgnored: true, unknownInspectedWithoutReplay: phase === 'in-flight' }) + '\n')
    await services.close()
    expect(watches.every(watch => watch.handle.closed.aborted)).toBe(true)
  } finally {
    releaseRead?.(); await f.services.close()
  }
})
