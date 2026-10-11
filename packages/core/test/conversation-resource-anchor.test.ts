import { appendFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { consumeJsonReadEntry, type ConversationUnit, type JsonReadAssembly } from '../dist/conversation.js'
import { historyReaderFixture } from './fixtures/session-history-reader.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


it('a source-qualified exact native anchor preserves the original deferred resource reference and record revision', async () => {
  const f = await historyReaderFixture(true, false)
  try {
    const reference = { hostId: 'local', agentSessionId: f.session.agentSessionId }, originalSession = await f.store.readMetadata(f.session.agentSessionId)
    const start = await f.client.conversationCheckpoint(reference), text = '\0'.repeat(360_000) + '完整原始正文🙂'
    const row = (id: string, body: string) => JSON.stringify({ sessionId: 'original-native', uuid: id, type: 'assistant', timestamp: new Date(_historyFixtureEpoch(0, 0, 100)).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: body }] } }) + '\n'
    await appendFile(f.transcript, row('original-deferred', text) + row('independent-later', 'Unchanged independent body'))
    const units: ConversationUnit[] = []; let cursor: string | undefined, pending: JsonReadAssembly | undefined
    let page: Awaited<ReturnType<typeof f.client.readConversationChanges>>
    do {
      page = await f.client.readConversationChanges({ ...reference, checkpoint: start.checkpoint, maxBytes: 128 * 1024, ...(cursor ? { cursor } : {}) })
      for (const entry of page.items) {
        const read = consumeJsonReadEntry({ entry, scopeKey: JSON.stringify(start.checkpoint), ...(pending ? { pending } : {}), maxTotalBytes: 32 * 1024 * 1024 })
        if (read.kind === 'pending') pending = read.pending
        else { pending = undefined; units.push(read.value) }
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    const record = units.flatMap(unit => unit.records).find(record => record.reference?.source.recordId === 'original-deferred')!
    expect(record.original.kind).toBe('native')
    if (record.original.kind !== 'native') throw Error('Missing original native record')
    const resource = record.original.item.contentParts[0]!
    expect(resource.kind).toBe('resource')
    const anchor = { record: record.reference!, revision: record.revision, frontier: page!.checkpoint }
    const exact = await f.client.readAgentConversation({ ...reference, anchor, maxBytes: 128 * 1024 })
    expect(exact.coverage.flatMap(source => source.gaps)).not.toContainEqual(expect.objectContaining({ code: 'AGENT_CONVERSATION_VERSION_UNAVAILABLE' }))
    expect(exact.items).toHaveLength(1)
    const entry = exact.items[0]!
    expect(entry.kind).toBe('item')
    if (entry.kind !== 'item') throw Error('Unexpected resource unit fragmentation')
    const actual = entry.item.records.find(value => value.id === record.id)!
    expect(actual.revision).toBe(record.revision)
    expect(actual.original).toEqual(record.original)
    expect(actual.reference).toEqual(record.reference)
    expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(originalSession)
    expect(f.client.connect).not.toHaveBeenCalled()
  } finally { await f.close() }
}, 20_000)
