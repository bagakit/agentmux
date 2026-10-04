import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { readSessionHistoryTextResource } from '../src/session-history-content.js'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

it('public native tool JSON preserves one hundred thousand small fields without a call-stack limit', async () => {
  const input = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => ['field' + index, 'value']))
  const f = await nativeHistoryFixture('pi', root => jsonl([
    { type: 'session', version: 3, id: 'native-main', cwd: root },
    { type: 'message', id: 'wide-tool', parentId: null, message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'wide-call', name: 'inspect', arguments: input }
    ] } }
  ]))
  fixtures.push(f)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  const part = page.items[0]!.contentParts[0]!
  const complete = part.kind === 'resource' && part.resourceType === 'text'
    ? await readSessionHistoryTextResource(part, 0, { source: page.source, recordId: 'wide-tool' },
      request => f.client.sessionHistoryResource(f.session.agentSessionId, request)) : part
  expect(complete.kind).toBe('tool-call')
  if (complete.kind !== 'tool-call') throw new Error('Original tool semantics required')
  expect(complete.callId).toBe('wide-call')
  expect(complete.name).toBe('inspect')
  expect(digest(complete.input)).toBe(digest(JSON.stringify(input)))
  expect(Object.keys(JSON.parse(complete.input))).toHaveLength(100_000)
  const after = await f.bytes()
  expect(after.native.equals(f.before.native)).toBe(true)
  expect(after.store.equals(f.before.store)).toBe(true)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)
