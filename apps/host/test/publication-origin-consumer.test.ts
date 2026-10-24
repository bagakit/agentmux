import { appendFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import type { ConversationObservation, ConversationObservationHandle } from '@agentmux/core/conversation'
import { PublicationHost } from '../../../packages/connectors/src/publication-host.js'
import { createPublicationConversationPort } from '../../../packages/connectors/src/core-conversation-port.js'
import { roomBindingFixture, context as bindingContext } from '../../../packages/connectors/test/fixtures/room-binding.js'
import type { PublicationAdapter } from '../../../packages/connectors/src/publication-adapter.js'
import { MoteChatStore } from '../../../packages/connectors/src/mote-chat-store.js'
import { moteChatJourneyFixture } from '../../../packages/connectors/test/fixtures/mote-chat-journey.js'

const facts = (value: unknown) => { if (process.env.T042_FACTS) appendFileSync(process.env.T042_FACTS, JSON.stringify(value) + '\n') }

it('discovers a late original source after passive capture expires and publishes its first reply without another input', async () => {
  const f = await moteChatJourneyFixture(1, 60_000, 'headless')
  const client = f.client, provider = client.providers.get('claude')
  const discover = vi.mocked(provider.discoverNativeSession!), originalDiscovery = discover.getMockImplementation()!
  let available = false
  discover.mockImplementation(async input => available ? await originalDiscovery(input) : null)
  const observation = client.observeConversation.bind(client)
  const watches: Array<{ handle: ConversationObservationHandle; listener(value: ConversationObservation): void }> = []
  vi.spyOn(client, 'observeConversation').mockImplementation(async (input, listener, options) => {
    const handle = await observation(input, listener, options); watches.push({ handle, listener }); return handle
  })
  try {
    expect(await f.wire.post(f.message('delayed-origin'))).toBe(202)
    const incoming = await f.claimed('delayed-origin'), id = incoming.input!.agentSessionId
    const publication = () => f.services.connections.delivery!.list({ connectionId: 'original-bot', bindingId: new MoteChatStore(f.services.database!).generationBySession(id)!.binding!.bindingId, bindingRevision: 1 })
    await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: incoming.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
    const captures = (client as unknown as { nativeIdentityCaptures: Map<string, unknown> }).nativeIdentityCaptures
    expect(captures.has(id)).toBe(true)
    await vi.waitFor(() => expect(captures.has(id)).toBe(false), { timeout: 12_000 })
    expect((await client.readAgentSession(id))!.nativeHandle).toBeUndefined()
    const calls = discover.mock.calls.length
    const before = await client.conversationCheckpoint({ hostId: 'local', agentSessionId: id, nativePosition: 'beginning' })
    expect(before.checkpoint.frontier.cuts.some(c => c.kind === 'native')).toBe(false)
    expect(discover).toHaveBeenCalledTimes(calls)
    expect(before.coverage).toContainEqual(expect.objectContaining({ source: expect.objectContaining({ kind: 'captured' }), current: 'partial' }))
    expect(JSON.stringify(await client.readAgentConversation({ hostId: 'local', agentSessionId: id }))).toContain(f.message('delayed-origin').text)
    const binding = new MoteChatStore(f.services.database!).generationBySession(id)!.binding!
    expect(binding.sourceCheckpoints).toEqual([])
    expect(binding.publicationOrigin).toBeDefined()
    const run = f.start.mock.results[0]!.value
    const exactRun = await run, witness = await originalDiscovery({ processId: exactRun.pid!, command: 'claude', args: [], env: {}, workspacePath: exactRun.workspacePath, signal: new AbortController().signal })
    if (!witness?.handle || witness.handle.kind !== 'provider' || !witness.handle.transcriptPath) throw Error('The controlled original Run must have one exact Provider witness')
    const source = witness.handle
    await appendFile(source.transcriptPath!, JSON.stringify({ sessionId: source.sessionId, uuid: 'late-first-answer', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Original reply after late source birth' }] } }) + '\n')
    available = true
    facts({ phase: 'source-appeared', captureExpired: !captures.has(id), nativeHandleAbsent: true, checkpointNativeCuts: 0, capturedReadable: true, inputWrites: vi.mocked(f.inner.kernel.input as () => Promise<unknown>).mock.calls.length, createCount: f.start.mock.calls.length })
    try {
      await vi.waitFor(() => expect(f.wire.effects.filter(effect => effect.text === 'Original reply after late source birth')).toHaveLength(1), { timeout: 8_000 })
    } catch (error) {
      // Reproduction evidence: the existing public observer can discover the same source;
      // this diagnostic read is never a substitute for the failed automatic consumer.
      const count = discover.mock.calls.length
      const handle = await observation({ hostId: 'local', agentSessionId: id }, () => {})
      facts({ phase: 'failed-consumer-fresh-observe', effectsBeforeProbe: f.wire.effects.length, nativeDiscovered: handle.scope.sources.some(s => s.kind === 'native'), discoveryCallsAdded: discover.mock.calls.length - count, closed: handle.closed.aborted })
      handle.dispose(); throw error
    }
    await vi.waitFor(async () => expect((await publication()).observation?.state).toBe('ready'))
    const retained = (await publication()).sourceObservation!.checkpointKey
    expect(retained).not.toBeNull()
    expect(watches.some(w => w.handle.scope.sources.some(s => s.kind === 'native-unavailable'))).toBe(true)
    await vi.waitFor(() => {
      const lane = (f.services.publication as unknown as { lanes: Map<string, { work?: Promise<void>; dirty: boolean }> }).lanes.get(binding.bindingId)!
      expect(lane.work).toBeUndefined(); expect(lane.dirty).toBe(false)
    })
    const changes = vi.spyOn(client, 'readConversationChanges')
    await new Promise(resolve => setTimeout(resolve, 5_200))
    expect(changes).not.toHaveBeenCalled()
    expect(f.wire.effects.filter(effect => effect.text === 'Original reply after late source birth')).toHaveLength(1)
    expect(f.start).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
    expect((await f.services.ingress!.inspect({ ingressId: incoming.ingressId })).ingress).toMatchObject({ input: incoming.input })
    facts({ phase: 'late-origin-confirmed', effects: 1, checkpointRetained: true, inputWrites: 1, createCount: 1, healthyReadsAdded: 0, originalInputRetained: true, partialOpeningRecovered: true })
    await f.services.close(); expect(watches.every(w => w.handle.closed.aborted)).toBe(true)
  } finally { await f.services.close() }
})

it.each(['opening', 'beginning'] as const)('keeps the exact %s source failure and recovers the original first reply once', async phase => {
  const f = await moteChatJourneyFixture(1, 60_000, 'headless')
  const client = f.client, provider = client.providers.get('claude') as core.AgentProvider & Required<Pick<core.AgentProvider, 'observeSessionHistory' | 'readConversationChanges'>>
  let unavailable = true
  const code = phase === 'opening' ? 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' : 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
  const observe = provider.observeSessionHistory!.bind(provider), read = provider.readConversationChanges!.bind(provider)
  let native: { context: Parameters<typeof observe>[0]; handle: core.AgentSessionHistoryObservationHandle } | undefined
  vi.spyOn(provider, 'observeSessionHistory').mockImplementation(async context => {
    const handle = await observe(context); native = { context, handle }; return handle
  })
  const originalObservation = client.observeConversation.bind(client)
  vi.spyOn(client, 'observeConversation').mockImplementation(async (...args) => {
    const handle = await originalObservation(...args)
    if (phase === 'opening' && unavailable && native && handle.coverage.some(value => value.source.kind === 'native' && value.current === 'complete-through-cut')) {
      native.context.onChange({ kind: 'unavailable', source: native.context.source, code, message: 'The original native watcher failed after its opening snapshot.' })
      native.handle.dispose()
      facts({ phase: 'opening-snapshot-race', readySnapshot: handle.coverage.some(value => value.source.kind === 'native' && value.current === 'complete-through-cut'), partialHandleClosed: handle.closed.aborted })
    }
    return handle
  })
  vi.spyOn(provider, 'readConversationChanges').mockImplementation(async input => {
    if (phase === 'beginning' && unavailable && input.head) throw new core.AgentMuxError('The exact original beginning is temporarily unreadable.', code)
    return await read(input)
  })
  try {
    expect(await f.wire.post(f.message(`failed-${phase}`))).toBe(202)
    const input = await f.claimed(`failed-${phase}`), binding = new MoteChatStore(f.services.database!).generationBySession(input.input!.agentSessionId)!.binding!
    const listing = () => f.services.connections.delivery!.list({ connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: 1 })
    await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: input.ingressId })).inputReceipt?.status).toBe('terminal-confirmed'))
    await vi.waitFor(async () => expect((await listing()).sourceObservation).toMatchObject({ state: 'unavailable', code }))
    expect((await client.readAgentSession(binding.agentSessionId))!.nativeHandle).toBeDefined()
    expect(f.wire.effects).toHaveLength(0)
    const failure = (await listing()).sourceObservation
    facts({ phase: `typed-${phase}-failure`, sourceObservation: failure, effects: 0, inputWrites: vi.mocked(f.inner.kernel.input as () => Promise<unknown>).mock.calls.length })
    await f.reply(binding.agentSessionId, `answer-${phase}`, `Original first answer after ${phase} failure`)
    unavailable = false
    await vi.waitFor(() => expect(f.wire.effects.filter(effect => effect.text === `Original first answer after ${phase} failure`)).toHaveLength(1), { timeout: 8_000 })
    await vi.waitFor(async () => expect((await listing()).observation?.state).toBe('ready'))
    expect(f.start).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
    facts({ phase: `typed-${phase}-recovered`, effects: 1, inputWrites: 1, createCount: 1, typedCode: code })
  } finally { await f.services.close() }
})

it('ordinary groups retain their original native cut and never bootstrap a beginning or backfill earlier replies', async () => {
  const effects: string[] = []
  const adapter: PublicationAdapter = { adapterId: 'sample', renderVersion: 'original', supportedRenderVersions: ['original'], fragmentBytes: 8192,
    prepare: operation => ({ adapterId: 'sample', renderVersion: 'original', requestKey: operation.operationId,
      request: { method: 'POST', path: '/original', body: JSON.stringify(operation.payload) } }),
    dispatch: async request => { const payload = JSON.parse(request.request.body!); if (payload.text) effects.push(payload.text); return { state: 'confirmed', mapping: { messageId: request.requestKey } } } }
  const f = await roomBindingFixture(true, { adapters: [{ adapterId: 'sample', publication: adapter,
    test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }] })
  let host: PublicationHost | undefined
  try {
    const row = (id: string, text: string) => JSON.stringify({ sessionId: 'original-native', uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
    await appendFile(f.transcript, row('before-original-bind', 'Earlier reply must remain private'))
    const saved = await f.bindings.bind(f.input, bindingContext)
    expect(saved.state).toBe('applied'); if (saved.state !== 'applied') throw Error('Original group must be bound')
    expect(saved.binding.publicationOrigin).toBeUndefined()
    const originalCut = structuredClone(saved.binding.sourceCheckpoints), cuts = vi.spyOn(f.client, 'conversationCheckpoint')
    host = new PublicationHost({ connections: f.connections, bindings: f.bindings,
      conversation: createPublicationConversationPort(() => [{ hostId: 'local', client: f.client }]) })
    await vi.waitFor(async () => expect((await host!.list({ connectionId: saved.binding.connectionId, bindingId: saved.binding.bindingId, bindingRevision: 1 })).observation?.state).toBe('ready'))
    expect(effects).toEqual([])
    await appendFile(f.transcript, row('after-original-bind', 'Original future group reply'))
    await vi.waitFor(() => expect(effects).toEqual(['Original future group reply']))
    expect(cuts.mock.calls.some(([input]) => input.nativePosition === 'beginning')).toBe(false)
    expect(saved.binding.sourceCheckpoints).toEqual(originalCut)
    facts({ phase: 'ordinary-group-cut', earlierReplies: 0, futureReplies: 1, beginningRequests: 0, originalCutRetained: true })
  } finally { host?.close(); await f.close() }
})
