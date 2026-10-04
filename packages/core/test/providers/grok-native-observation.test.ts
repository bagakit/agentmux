import { appendFile, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { encodeCwdDirname } from '../../src/providers/grok-native-history.js'
import { projectSessionUserMessages } from '../../src/session-user-messages.js'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryObservation } from '../../src/types.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); vi.restoreAllMocks() })
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const user = (text = 'Equal native input.') => ({ type: 'user', content: [{ type: 'text', text }], synthetic_reason: 'human' })
const assistant = (text = 'Native answer.') => ({ type: 'assistant', content: text,
  tool_calls: [{ id: 'native-tool', name: 'read_file', arguments: { path: 'source.ts' } }] })

async function fixture(locator: 'id' | 'updates' = 'id', persisted = true) {
  const root = await mkdtemp(join(tmpdir(), 'grok-native-observe-'))
  const workspace = join(root, 'workspace')
  const directory = join(root, 'sessions', encodeCwdDirname(workspace), 'native-grok')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'chat_history.jsonl'), updates = join(directory, 'updates.jsonl')
  const summary = join(directory, 'summary.json'), storePath = join(root, 'store.json')
  if (persisted) await writeFile(path, jsonl([user(), assistant()]))
  await writeFile(updates, '')
  await writeFile(summary, JSON.stringify({ info: { id: 'native-grok', cwd: workspace } }))
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', providerId: 'grok', executorId: 'grok',
    agentSessionId: 'grok-original', hostId: 'local', workspacePath: workspace, run: { runId: 'grok-healthy' },
    retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: 'native-grok',
      ...(locator === 'updates' ? { transcriptPath: updates } : {}) } }
  await store.compareAndSwap(null, session)
  const durable = await readFile(storePath)
  const physical: Promise<unknown>[] = [], load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const p = load(); physical.push(p); return p })
  const clients: AgentMuxClient[] = []
  const newClient = () => {
    const client = new AgentMuxClient({ store }); clients.push(client)
    const kernel = Reflect.get(client, 'kernel')
    const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name =>
      vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('Read must not control a Run: ' + name) }))
    return { client, controls }
  }
  const first = newClient()
  cleanups.push(async () => {
    await Promise.all(clients.map(client => client.dispose()))
    await Promise.allSettled(physical)
    expect(await readFile(storePath)).toEqual(durable)
    await rm(root, { recursive: true, force: true })
  })
  return { ...first, root, path, updates, summary, session, newClient, options: { env: { GROK_HOME: root } } }
}

it.each(['id', 'updates'] as const)('Grok %s locator observes durable native user/assistant append through public Client and native input projection', async locator => {
  const f = await fixture(locator)
  const before = await f.client.sessionHistoryPage('grok-original', { ...f.options, limit: 1 })
  expect(before.items.map(item => item.kind)).toEqual(['assistant-message'])
  const events: AgentSessionHistoryObservation[] = []
  const handle = await f.client.observeSessionHistory('grok-original', event => events.push(event), f.options)
  await appendFile(f.updates, jsonl([{ timestamp: 1, method: 'session/update', params: { sessionId: 'native-grok' } }]))
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(events).toEqual([])
  // The native writer can retain its descriptor; observe the file rather than only its parent.
  const writer = await open(f.path, 'a')
  try { await writer.write(jsonl([user(), assistant('Second answer.')])) } finally { await writer.close() }
  await vi.waitFor(() => expect(events.some(event => event.kind === 'invalidated')).toBe(true))
  const fresh = await f.client.sessionHistoryPage('grok-original', f.options)
  const inputs = projectSessionUserMessages({ agentSessionId: 'grok-original', historyPage: fresh })
  expect(fresh.items.map(item => [item.kind, item.contentParts.filter(part => part.kind === 'text').map(part => part.text).join('\n')])).toEqual([
    ['user-message', 'Equal native input.'], ['assistant-message', 'Native answer.'],
    ['user-message', 'Equal native input.'], ['assistant-message', 'Second answer.']
  ])
  expect(new Set(fresh.items.map(item => item.id)).size).toBe(4)
  expect(inputs.map(input => input.content)).toEqual(['Equal native input.', 'Equal native input.'])
  expect(new Set(inputs.map(input => input.id)).size).toBe(2)
  expect(inputs[0]!.author).toEqual({ kind: 'unknown' })
  expect(fresh.items[1]!.contentParts.map(part => part.kind)).toEqual(['text', 'tool-call'])
  expect(fresh.items.map(item => item.startedAt)).toEqual([undefined, undefined, undefined, undefined])
  const older = await f.client.sessionHistoryPage('grok-original', { ...f.options, cursor: before.nextCursor!, limit: 1 })
  expect(older.items.map(item => item.kind)).toEqual(['user-message'])
  expect(older.nextCursor).toBeNull()
  handle.dispose()
  const received = events.length
  await appendFile(f.path, jsonl([user('Hidden late change.')]))
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(events).toHaveLength(received)
  await f.client.dispose()
  const restored = f.newClient()
  const restoredPage = await restored.client.sessionHistoryPage('grok-original', f.options)
  expect(restoredPage.source).toEqual({ providerId: 'grok', nativeSessionId: 'native-grok' })
  expect(restoredPage.items).toHaveLength(5)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
  expect(restored.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
})

it('Grok refuses a foreign summary for observation while retaining read-only Run capability', async () => {
  const f = await fixture('updates')
  await writeFile(f.summary, JSON.stringify({ info: { id: 'foreign', cwd: f.session.workspacePath } }))
  await expect(f.client.observeSessionHistory('grok-original', () => {}, f.options)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
})

it('Grok id-only source watches the exact file before its first durable conversation arrives', async () => {
  const f = await fixture('id', false)
  const events: AgentSessionHistoryObservation[] = []
  const handle = await f.client.observeSessionHistory('grok-original', event => events.push(event), f.options)
  await writeFile(f.path, jsonl([user(), assistant()]))
  await vi.waitFor(() => expect(events.some(event => event.kind === 'invalidated')).toBe(true))
  expect((await f.client.sessionHistoryPage('grok-original', f.options)).items.map(item => item.kind)).toEqual(['user-message', 'assistant-message'])
  handle.dispose()
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
})

it('Grok source replacement reports unavailable, preserves the old cut and releases cancellation', async () => {
  const f = await fixture()
  const page = await f.client.sessionHistoryPage('grok-original', { ...f.options, limit: 1 })
  const events: AgentSessionHistoryObservation[] = []
  const controller = new AbortController()
  const handle = await f.client.observeSessionHistory('grok-original', event => events.push(event), { ...f.options, signal: controller.signal })
  const replacement = join(f.root, 'replacement.jsonl')
  await writeFile(replacement, jsonl([user('replacement')]))
  await rename(replacement, f.path)
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })))
  await expect(f.client.sessionHistoryPage('grok-original', { ...f.options, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  controller.abort(); handle.dispose()
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
})
