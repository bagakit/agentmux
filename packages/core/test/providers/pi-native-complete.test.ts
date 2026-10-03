import { fixtureClock, fixtureDay } from '../helpers/fixture-values.js'
import { appendFile, open, readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { nativeHistoryFixture, jsonl } from '../fixtures/native-history-session.js'
import { projectSessionUserMessages } from '../../src/session-user-messages.js'
import type { AgentSessionHistoryObservation } from '../../src/types.js'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
const extraClients: AgentMuxClient[] = []
afterEach(async () => {
  await Promise.all(extraClients.splice(0).map(client => client.dispose()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
  vi.restoreAllMocks()
})
const message = (id: string, parentId: string | null, role: string, content: unknown) => ({
  type: 'message', id, parentId, timestamp: fixtureDay(1) + "T" + fixtureClock(1, 2, 3, "000") + "Z", message: { role, content }
})
async function fixture() {
  const f = await nativeHistoryFixture('pi', root => jsonl([
    { type: 'session', version: 3, id: 'native-main', cwd: root },
    message('original-user', null, 'user', [{ type: 'text', text: 'Equal native input.' }]),
    message('original-assistant', 'original-user', 'assistant', [{ type: 'text', text: 'Original answer.' }])
  ]))
  fixtures.push(f); return f
}

it('Pi finalized user/assistant append invalidates the exact native source and preserves native conversation messages', async () => {
  const f = await fixture()
  const olderCut = await f.client.sessionHistoryPage('private-agent', { limit: 1 })
  expect(olderCut.items.map(item => item.id)).toEqual(['original-assistant'])
  const events: AgentSessionHistoryObservation[] = []
  const observation = await f.client.observeSessionHistory('private-agent', event => events.push(event))
  const writer = await open(f.path, 'a')
  try {
    await writer.write(jsonl([
      message('second-user', 'original-assistant', 'user', [{ type: 'text', text: 'Equal native input.' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }]),
      message('second-assistant', 'second-user', 'assistant', [
        { type: 'thinking', thinking: 'Native reasoning.', thinkingSignature: 'native-signature' },
        { type: 'text', text: 'Second answer.' },
        { type: 'toolCall', id: 'native-call', name: 'read', arguments: { path: 'source.ts' } }
      ])
    ]))
  } finally { await writer.close() }
  await vi.waitFor(() => expect(events.some(event => event.kind === 'invalidated')).toBe(true))
  const page = await f.client.sessionHistoryPage('private-agent')
  const inputs = projectSessionUserMessages({ agentSessionId: 'private-agent', historyPage: page })
  expect(page.items.map(item => [item.id, item.kind, item.contentParts.filter(part => part.kind === 'text').map(part => part.text).join('\n')])).toEqual([
    ['original-user', 'user-message', 'Equal native input.'], ['original-assistant', 'assistant-message', 'Original answer.'],
    ['second-user', 'user-message', 'Equal native input.'], ['second-assistant', 'assistant-message', 'Second answer.']
  ])
  expect(new Set(page.items.map(item => item.id)).size).toBe(4)
  expect(inputs.map(input => input.content)).toEqual(['Equal native input.', 'Equal native input.'])
  expect(new Set(inputs.map(input => input.id)).size).toBe(2)
  expect(inputs[1]!.author).toEqual({ kind: 'unknown' })
  expect(page.items[2]!.contentParts.map(part => part.kind)).toEqual(['text', 'resource'])
  expect(page.items[3]!.contentParts.map(part => part.kind)).toEqual(['reasoning', 'text', 'tool-call'])
  const older = await f.client.sessionHistoryPage('private-agent', { cursor: olderCut.nextCursor!, limit: 1 })
  expect(older.items.map(item => item.id)).toEqual(['original-user'])
  expect(older.nextCursor).toBeNull()
  observation.dispose()
  const beforeHidden = events.length
  await appendFile(f.path, jsonl([message('hidden-user', 'second-assistant', 'user', 'Late hidden input.')]))
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(events).toHaveLength(beforeHidden)
  await f.client.dispose()
  // The next consumer reads the original durable store; no new Session, cache or Run is created.
  const restored = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(f.storePath) })
  extraClients.push(restored)
  const kernel = Reflect.get(restored, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name))
  const restoredPage = await restored.sessionHistoryPage('private-agent')
  expect(restoredPage.source).toEqual({ providerId: 'pi', nativeSessionId: 'native-main' })
  expect(restoredPage.items.map(item => item.id)).toEqual(['original-user', 'original-assistant', 'second-user', 'second-assistant', 'hidden-user'])
  const restoredObserver = await restored.observeSessionHistory('private-agent', () => {})
  restoredObserver.dispose()
  expect(await readFile(f.storePath)).toEqual(f.before.store)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  expect(controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
})

it('Pi wrong native identity rejects only that read and cancellation preserves the original stored Session', async () => {
  const f = await fixture()
  await writeFile(f.path, jsonl([{ type: 'session', version: 3, id: 'foreign', cwd: f.root },
    message('foreign-record', null, 'assistant', 'Foreign response.')]))
  await expect(f.client.sessionHistoryPage('private-agent')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  const controller = new AbortController(); controller.abort()
  await expect(f.client.observeSessionHistory('private-agent', () => {}, { signal: controller.signal })).rejects.toThrow()
  expect(await readFile(f.storePath)).toEqual(f.before.store)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
