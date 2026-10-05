import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { readSessionHistoryTextResource, type SessionHistoryResourceReader } from '../src/session-history-content.js'
import type { AgentSessionHistoryContentPart } from '../src/types.js'

const source = { providerId: 'codex', nativeSessionId: 'original-native-history' }
const value = { kind: 'text' as const, text: 'Complete original native history without a Core SID' }
const data = Buffer.from(JSON.stringify(value)), sha256 = createHash('sha256').update(data).digest('hex')
const part: Extract<AgentSessionHistoryContentPart, { kind: 'resource' }> = { kind: 'resource', resourceType: 'text',
  reference: 'original-provider-issued-reference', content: { encoding: 'json-utf8', kind: 'text', byteLength: data.length, sha256 } }
const record = { source, recordId: 'original-record' }
function reader(first: string | undefined, second: string | undefined): SessionHistoryResourceReader {
  return async input => {
    const offsetBytes = input.offsetBytes ?? 0, end = offsetBytes ? data.length : 24, bytes = data.subarray(offsetBytes, end)
    const sid = offsetBytes ? second : first
    return { ...(sid === undefined ? {} : { agentSessionId: sid }), source, recordId: record.recordId,
      partIndex: 0, reference: input.expectedReference, result: { status: 'fragment', encoding: 'json-utf8',
        dataBase64: bytes.toString('base64'), byteLength: bytes.length, offsetBytes, totalBytes: data.length,
        sha256, nextOffsetBytes: end === data.length ? null : end } }
  }
}
it('consumes complete original native fragments while no Core SID exists', async () => {
  await expect(readSessionHistoryTextResource(part, 0, record, reader(undefined, undefined))).resolves.toEqual(value)
})
it('retains exact managed SID identity across the same complete source', async () => {
  await expect(readSessionHistoryTextResource(part, 0, record, reader('original-sid', 'original-sid'))).resolves.toEqual(value)
})
it.each([
  ['native gains SID', undefined, 'borrowed-sid'], ['managed loses SID', 'original-sid', undefined],
  ['managed changes SID', 'original-sid', 'other-sid']
])('refuses %s between original fragments', async (_name, first, second) => {
  await expect(readSessionHistoryTextResource(part, 0, record, reader(first, second))).rejects.toThrow('another recorded resource')
})
