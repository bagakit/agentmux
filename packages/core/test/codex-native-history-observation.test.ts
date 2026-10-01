import { appendFile, mkdir, mkdtemp, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryObservation } from '../src/types.js'

const watched = vi.hoisted(() => ({ names: [] as string[], closes: [] as ReturnType<typeof vi.fn>[], stats: [] as string[] }))
vi.mock('node:fs/promises', async (originalImport) => {
  const original = await originalImport<typeof import('node:fs/promises')>()
  return { ...original, stat: (...args: Parameters<typeof original.stat>) => {
    watched.stats.push(String(args[0]))
    return original.stat(...args)
  } }
})
vi.mock('node:fs', async (originalImport) => {
  const original = await originalImport<typeof import('node:fs')>()
  return { ...original, watch: (path: string, options: import('node:fs').WatchOptions, listener: import('node:fs').WatchListener<string>) => {
    const watcher = original.watch(path, options, (event, name) => {
      watched.names.push(name?.toString() ?? '<unknown>')
      listener(event, name?.toString() ?? null)
    })
    const close = vi.fn(watcher.close.bind(watcher))
    watcher.close = close
    watched.closes.push(close)
    return watcher
  } }
})

const SID = 'private-codex-agent', NATIVE = 'private-codex-native'
const SOURCE = { providerId: 'codex', nativeSessionId: NATIVE }
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const header = { type: 'session_meta', payload: { id: NATIVE } }
const row = (id: string) => ({ type: 'response_item', payload: { type: 'message', id, role: 'user',
  content: [{ type: 'input_text', text: 'Identical private source body.' }] } })
type Fixture = {
  directory: string
  path: string
  storePath: string
  storeBefore: Buffer
  client: AgentMuxClient
  controls: { mock: { calls: unknown[][] } }[]
  physicalReads: Promise<unknown>[]
  history: MockInstance<AgentMuxClient['sessionHistoryPage']>
}
const fixtures: Fixture[] = []

beforeEach(() => { watched.names = []; watched.closes = []; watched.stats = [] })
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(await readFile(f.storePath)).toEqual(f.storeBefore)
    await f.client.dispose()
    await Promise.allSettled(f.physicalReads)
    await rm(f.directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

/** Controlled filesystem input, never a vendor writer or a fabricated user DTO. */
async function fixture(locator: 'file' | 'absent' | 'directory' = 'file'): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-native-observation-'))
  const path = join(directory, 'pinned.jsonl'), storePath = join(directory, 'sessions.json')
  await writeFile(path, jsonl([header, row('writer-original')]))
  const invalidPath = join(directory, 'not-a-file')
  await mkdir(invalidPath)
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: SID, providerId: 'codex',
    executorId: 'codex', hostId: 'local', workspacePath: directory, run: { runId: 'private-run-not-connected' },
    retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: NATIVE,
      ...(locator === 'absent' ? {} : { transcriptPath: locator === 'file' ? path : invalidPath }) } }
  await store.compareAndSwap(null, session)
  const storeBefore = await readFile(storePath)
  const physicalReads: Promise<unknown>[] = [], load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => {
    const read = load(); physicalReads.push(read); return read
  })
  const client = new AgentMuxClient({ store })
  const kernel = Reflect.get(client, 'kernel') as CtxmuxRunAdapter
  const controls = (['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'] as const).map(name =>
    vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('Forbidden Runtime control: ' + name) }))
  const history = vi.spyOn(client, 'sessionHistoryPage')
  const value = { directory, path, storePath, storeBefore, client, controls, physicalReads, history }
  fixtures.push(value)
  return value
}

async function observe(f: Fixture, events: AgentSessionHistoryObservation[], signal?: AbortSignal) {
  const pending = f.client.observeSessionHistory(SID, event => events.push(event), signal ? { signal } : {})
  await expect(pending).resolves.toMatchObject({ source: SOURCE })
  return await pending
}

it('builtin Codex public observation ignores a real unrelated notification, invalidates exact append and disposes once', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = []
  const handle = await observe(f, events)
  expect(watched.closes).toHaveLength(1)
  await vi.waitFor(() => expect(watched.stats.filter(path => path === f.path).length).toBeGreaterThanOrEqual(2))
  const targetStats = watched.stats.filter(path => path === f.path).length
  await writeFile(join(f.directory, 'unrelated-source.jsonl'), jsonl([header, row('unrelated')]))
  await vi.waitFor(() => expect(watched.names).toContain('unrelated-source.jsonl'))
  expect(events).toEqual([])
  expect(watched.stats.filter(path => path === f.path)).toHaveLength(targetStats)
  await appendFile(f.path, jsonl([row('writer-same-body-new'), row('writer-untimed-new')]))
  await vi.waitFor(() => expect(events.filter(event => event.kind === 'invalidated').length).toBeGreaterThan(0))
  expect(events).toEqual([{ kind: 'invalidated', agentSessionId: SID, source: SOURCE }])
  expect(watched.names).toContain(basename(f.path))
  expect(await readFile(f.path, 'utf8')).toBe(jsonl([header, row('writer-original'), row('writer-same-body-new'), row('writer-untimed-new')]))
  expect(f.history.mock.calls).toEqual([])
  handle.dispose(); handle.dispose()
  expect(watched.closes.map(close => close.mock.calls.length)).toEqual([1])
})

it('builtin Codex same-path replacement reports unavailable and releases its actual watcher', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = []
  const handle = await observe(f, events)
  expect(watched.closes).toHaveLength(1)
  const replacement = join(f.directory, 'replacement.jsonl')
  await writeFile(replacement, jsonl([header, row('writer-replacement')]))
  await rename(replacement, f.path)
  await vi.waitFor(() => expect(events).toHaveLength(1))
  expect(events[0]).toMatchObject({ kind: 'unavailable', agentSessionId: SID, source: SOURCE, code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect(events[0]?.kind === 'unavailable' ? events[0].message : '').toContain('existing window is retained')
  handle.dispose()
  expect(watched.closes.map(close => close.mock.calls.length)).toEqual([1])
  expect(f.history.mock.calls).toEqual([])
})

it('builtin Codex truncation is unavailable; explicit reacquisition and consumer abort release only their own watchers', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = []
  const handle = await observe(f, events)
  await truncate(f.path, 4)
  await vi.waitFor(() => expect(events).toHaveLength(1))
  expect(events[0]).toMatchObject({ kind: 'unavailable', source: SOURCE, code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect(watched.closes.map(close => close.mock.calls.length)).toEqual([1])
  handle.dispose()
  await writeFile(f.path, jsonl([header, row('writer-reopened')]))
  const controller = new AbortController(), reopened: AgentSessionHistoryObservation[] = []
  const next = await observe(f, reopened, controller.signal)
  expect(watched.closes).toHaveLength(2)
  controller.abort(); next.dispose()
  expect(watched.closes.map(close => close.mock.calls.length)).toEqual([1, 1])
  expect(reopened).toEqual([])
  expect(f.history.mock.calls).toEqual([])
})

it('builtin Codex missing locator and non-file source fail honestly without acquiring a watch or changing durable facts', async () => {
  const missing = await fixture('absent'), invalid = await fixture('directory')
  const events: AgentSessionHistoryObservation[] = []
  await expect(missing.client.observeSessionHistory(SID, event => events.push(event))).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE' })
  await expect(invalid.client.observeSessionHistory(SID, event => events.push(event))).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' })
  expect(await readFile(missing.path, 'utf8')).toBe(jsonl([header, row('writer-original')]))
  expect(await readFile(invalid.path, 'utf8')).toBe(jsonl([header, row('writer-original')]))
  expect(watched.closes).toEqual([])
  expect(events).toEqual([])
  expect([missing.history.mock.calls.length, invalid.history.mock.calls.length]).toEqual([0, 0])
})
