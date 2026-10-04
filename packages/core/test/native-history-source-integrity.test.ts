import { appendFile, open } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { readSessionHistoryTextResource } from '../src/session-history-content.js'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
const body = 'original '.repeat(300_000)
async function fixture() {
  const f = await nativeHistoryFixture('claude', jsonl([{ sessionId: 'native-main', uuid: 'original', type: 'user', message: { content: body } }]))
  fixtures.push(f)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  const part = page.items[0]!.contentParts[0]!
  if (part.kind !== 'resource' || part.resourceType !== 'text') throw new Error('Expected signed original content')
  const request = { source: page.source, recordId: 'original', partIndex: 0, expectedReference: part.reference }
  return { f, part, request }
}

it('rejects a same-inode same-size middle rewrite before returning that block', async () => {
  const { f, part, request } = await fixture()
  const encoded = part.reference.slice('amux-native-content:'.length).split('.')[0]!
  const reference = JSON.parse(Buffer.from(encoded, 'base64url').toString())
  const ranges = reference.segments.filter((segment: { literal?: string }) => segment.literal === undefined)
  const target = ranges[Math.floor(ranges.length / 2)]
  let offsetBytes = 0
  for (const segment of reference.segments) {
    if (segment === target) break
    offsetBytes += 'literal' in segment ? Buffer.byteLength(segment.literal) : segment.byteLength
  }
  const file = await open(f.path, 'r+')
  const before = await file.stat()
  try { await file.write(Buffer.from('X'), 0, 1, target.start + 10) } finally { await file.close() }
  const current = await open(f.path, 'r')
  try {
    const after = await current.stat()
    expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size)
  } finally { await current.close() }
  await expect(f.client.sessionHistoryResource(f.session.agentSessionId, { ...request, offsetBytes, maxBytes: 128 * 1024 }))
    .rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('allows a legitimate append while original content and block digests stay unchanged', async () => {
  const { f, part, request } = await fixture()
  await appendFile(f.path, jsonl([{ sessionId: 'native-main', uuid: 'later', type: 'assistant', message: { content: 'later answer' } }]))
  expect(await readSessionHistoryTextResource(part, 0, request,
    input => f.client.sessionHistoryResource(f.session.agentSessionId, input))).toEqual({ kind: 'text', text: body })
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('verifies both original blocks that contribute a Base64 boundary quartet', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const f = await nativeHistoryFixture('droid', jsonl([{ type: 'session_start', id },
    { type: 'message', id: 'document', message: { role: 'user', content: [
      { type: 'document', source: { type: 'text', data: body } }
    ] } }]), { nativeSessionId: id })
  fixtures.push(f)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  const part = page.items[0]!.contentParts[1]!
  if (part.kind !== 'resource' || part.resourceType !== 'text') throw new Error('Expected original document content')
  const reference = JSON.parse(Buffer.from(part.reference.slice('amux-native-content:'.length).split('.')[0]!, 'base64url').toString())
  const target = reference.segments.find((segment: { literal?: string; sourceBlocks?: unknown[] }) => segment.sourceBlocks?.length === 2)
  expect(target).toBeDefined()
  let offsetBytes = 0
  for (const segment of reference.segments) {
    if (segment === target) break
    offsetBytes += 'literal' in segment ? Buffer.byteLength(segment.literal) : segment.byteLength
  }
  const file = await open(f.path, 'r+')
  try { await file.write(Buffer.from('X'), 0, 1, target.sourceBlocks[0].start + 10) } finally { await file.close() }
  await expect(f.client.sessionHistoryResource(f.session.agentSessionId, {
    source: page.source, recordId: 'document', partIndex: 1, expectedReference: part.reference, offsetBytes, maxBytes: 4
  })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
