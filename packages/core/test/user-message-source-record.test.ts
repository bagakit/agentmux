import { fixtureIso as _tailFixtureIso } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentSessionHistoryReadPage } from '../src/session-history-reader.js'
import { conversationRevision } from '../src/conversation-stream.js'
import { projectConversationReading } from '../src/conversation.js'
import { projectSessionUserMessages } from '../src/session-user-messages.js'
import { createHistoryQueryFixture } from './helpers/session-history-query.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const body = '  <amux>authored context</amux>\n\n<amux:a2a from="authored-sender" msg-id="authored-message">\nneedle original <body> & text\n<reminder>authored reminder</reminder>\n</amux:a2a>\n  '
async function nativeFixture(provider: 'claude' | 'pi' = 'claude') {
  const f = await createHistoryQueryFixture(cleanups, provider, 0)
  const row = provider === 'claude'
    ? { type: 'user', sessionId: 'original-native', uuid: 'original-record', timestamp: _tailFixtureIso().replace('.000Z', 'Z'), message: { role: 'user', content: body } }
    : { type: 'message', id: 'original-record', parentId: null, timestamp: _tailFixtureIso().replace('.000Z', 'Z'), message: { role: 'user', content: body } }
  await appendFile(f.transcript, JSON.stringify(row) + '\n')
  const before = await readFile(f.transcript)
  return { ...f, before, input: { ...f.reference, source: 'native' as const, kind: 'user-message' as const, query: 'needle', limit: 1 },
    async unchanged() { expect(f.forbidden.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]); expect(await readFile(f.transcript)).toEqual(before) } }
}

it.each(['claude', 'pi'] as const)('returns the exact %s native source/version through public history without interpreting the body or author', async provider => {
  const f = await nativeFixture(provider)
  const originalPage = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 10 }), original = originalPage.items[0]!
  const raw = projectSessionUserMessages({ agentSessionId: f.session.agentSessionId, historyPage: originalPage })[0]!
  expect(raw.author).toEqual({ kind: 'unknown' }); expect(raw).not.toHaveProperty('sourceRecord')
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'source-record.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const page = await rpc.call('agent.history', f.input), message = page.userMessages![0]!
  expect(message).toEqual({ ...raw, sourceRecord: { record: { hostId: page.sourceHostId, agentSessionId: f.session.agentSessionId,
    source: { kind: 'native', providerId: provider, nativeSessionId: 'original-native', recordId: original.id } }, revision: conversationRevision(original) } })
  expect(message.content).toBe(body); expect(message.author).toEqual({ kind: 'unknown' })
  const reading = projectConversationReading({ agentSessionId: f.session.agentSessionId, routeHostId: 'other-route', historyPage: originalPage })
  expect(reading.originalRecords[0]!.input!.sourceRecord).toEqual(message.sourceRecord)
  expect(reading.originalRecords[0]!.input!.author).toEqual({ kind: 'unknown' })
  expect(originalPage.items[0]).toBe(original); expect(raw).not.toHaveProperty('sourceRecord')
  await f.unchanged()
})

it('uses the captured Store record revision without creating another version or changing the original input', async () => {
  const f = await createHistoryQueryFixture(cleanups)
  const originals = await f.store.readCapturedHistory(f.session.agentSessionId, { limit: 100 })
  const page = await f.client.readAgentSessionHistory({ ...f.reference, source: 'captured', kind: 'user-message', query: 'same', limit: 2 })
  expect(page.userMessages).toHaveLength(2)
  for (const message of page.userMessages!) {
    const original = originals.records.find(record => record.item.id === message.rawId)!
    expect(message.sourceRecord).toEqual({ record: { hostId: page.sourceHostId, agentSessionId: f.session.agentSessionId,
      source: { kind: 'captured', recordId: original.item.id } }, revision: original.revision })
    expect(message.author).toEqual({ kind: 'human' }); expect(message.content).toBe(original.item.content)
  }
  expect(await f.store.readCapturedHistory(f.session.agentSessionId, { limit: 100 })).toEqual(originals)
  await f.noControls()
})

it('strictly retains optional sourceRecord and rejects foreign Host, Session, source or malformed versions', async () => {
  const f = await nativeFixture(), page = await f.client.readAgentSessionHistory(f.input)
  expect(page.userMessages![0]!.sourceRecord).toBeDefined()
  expect(parseAgentSessionHistoryReadPage(page, f.input).userMessages![0]!.sourceRecord).toEqual(page.userMessages![0]!.sourceRecord)
  const routed = { ...page, hostId: 'client-route' }
  expect(parseAgentSessionHistoryReadPage(routed, { ...f.input, hostId: 'client-route' }).userMessages![0]!.sourceRecord!.record.hostId).toBe(page.sourceHostId)
  const missing = structuredClone(page); delete missing.userMessages![0]!.sourceRecord
  expect(parseAgentSessionHistoryReadPage(missing, f.input).userMessages![0]).not.toHaveProperty('sourceRecord')
  for (const change of [
    (p: typeof page) => { p.userMessages![0]!.sourceRecord!.record.hostId = 'another-source-host' },
    (p: typeof page) => { p.userMessages![0]!.sourceRecord!.record.agentSessionId = 'another-agent' },
    (p: typeof page) => { p.userMessages![0]!.sourceRecord!.record.source.recordId = 'another-record' },
    (p: typeof page) => { Object.assign(p.userMessages![0]!.sourceRecord!.record.source, { providerId: 'another-provider' }) },
    (p: typeof page) => { Object.assign(p.userMessages![0]!.sourceRecord!.record.source, { nativeSessionId: 'another-native' }) },
    (p: typeof page) => { p.userMessages![0]!.sourceRecord!.record.source = { kind: 'captured', recordId: 'original-record' } },
    (p: typeof page) => { p.userMessages![0]!.sourceRecord!.revision = 'a'.repeat(63) },
    (p: typeof page) => { p.userMessages![0]!.sourceRecord!.revision = 'G'.repeat(64) },
    (p: typeof page) => { Object.assign(p.userMessages![0]!.sourceRecord!, { authority: true }) },
    (p: typeof page) => { delete p.sourceHostId }
  ]) {
    const forged = structuredClone(page); change(forged)
    expect(() => parseAgentSessionHistoryReadPage(forged, f.input)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  }
  await f.unchanged()
})

it('keeps the conversation sourceRecord absent when the original Host reference is unknown', async () => {
  const f = await nativeFixture(), page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 10 })
  const { sourceHostId: _host, ...unknown } = page
  const reading = projectConversationReading({ agentSessionId: f.session.agentSessionId, historyPage: unknown })
  expect(reading.originalRecords[0]!.input!.author).toEqual({ kind: 'unknown' })
  expect(reading.originalRecords[0]!.input).not.toHaveProperty('sourceRecord')
  expect(reading.originalRecords[0]!.input!.content).toBe(body)
  await f.unchanged()
})
