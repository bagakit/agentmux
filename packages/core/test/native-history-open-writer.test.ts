import { appendFileSync, writeSync } from 'node:fs'
import { mkdtemp, open, readFile, rename, rm, truncate, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryObservation } from '../src/types.js'

const observed = vi.hoisted(() => ({
  stats: [] as string[],
  watches: [] as { path: string; close: ReturnType<typeof vi.fn>; notify: () => void }[],
  parentCallbacks: [] as string[],
  suppressParent: false,
  beforeWatch: undefined as ((path: string) => void) | undefined
}))
vi.mock('node:fs/promises', async originalImport => {
  const original = await originalImport<typeof import('node:fs/promises')>()
  return { ...original, stat: (...args: Parameters<typeof original.stat>) => {
    observed.stats.push(String(args[0]))
    return original.stat(...args)
  } }
})
vi.mock('node:fs', async originalImport => {
  const original = await originalImport<typeof import('node:fs')>()
  return { ...original, watch: (path: string, options: import('node:fs').WatchOptions, listener: import('node:fs').WatchListener<string>) => {
    observed.beforeWatch?.(path)
    const watcher = original.watch(path, options, (event, name) => {
      const isParent = !path.endsWith('.jsonl')
      if (isParent) observed.parentCallbacks.push(name?.toString() ?? '<unknown>')
      // Explicit fault injection reproduces the actual live directory-notification gap.
      // The real exact-file watcher and the held-open writer are never substituted.
      if (!(isParent && observed.suppressParent)) listener(event, name?.toString() ?? null)
    })
    const close = vi.fn(watcher.close.bind(watcher))
    watcher.close = close
    observed.watches.push({ path, close, notify: () => watcher.emit('change', 'change', basename(path)) })
    return watcher
  } }
})

const SID = 'private-open-writer', NATIVE = 'private-open-writer-native'
const SOURCE = { providerId: 'codex', nativeSessionId: NATIVE }
const row = (id: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', id,
  role: 'user', content: [{ type: 'input_text', text: 'Original private writer text.\n    Spaces remain.' }] } }) + '\n'
const initial = JSON.stringify({ type: 'session_meta', payload: { id: NATIVE } }) + '\n' + row('initial')
type Fixture = {
  root: string
  path: string
  storePath: string
  storeBefore: Buffer
  client: AgentMuxClient
  controls: { mock: { calls: unknown[][] } }[]
  reads: Promise<unknown>[]
  writers: FileHandle[]
}
const fixtures: Fixture[] = []

beforeEach(() => {
  observed.stats = []; observed.watches = []; observed.parentCallbacks = []
  observed.suppressParent = false; observed.beforeWatch = undefined
})
afterEach(async () => {
  observed.beforeWatch = undefined
  for (const f of fixtures.splice(0)) {
    expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(await readFile(f.storePath)).toEqual(f.storeBefore)
    await f.client.dispose()
    await Promise.allSettled(f.reads)
    for (const writer of f.writers) await writer.close()
    await rm(f.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

/** Real built-in Codex/public Client/FileStore; controlled files are not a vendor writer. */
async function fixture(missing = false): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'native-history-open-writer-'))
  const path = join(root, 'native.jsonl'), storePath = join(root, 'sessions.json')
  if (!missing) await writeFile(path, initial)
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: SID, providerId: 'codex',
    executorId: 'codex', hostId: 'local', workspacePath: root, run: { runId: 'private-unopened-run' },
    retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: NATIVE, transcriptPath: path } }
  await store.compareAndSwap(null, session)
  const storeBefore = await readFile(storePath), reads: Promise<unknown>[] = [], load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const result = load(); reads.push(result); return result })
  const client = new AgentMuxClient({ store }), kernel = Reflect.get(client, 'kernel') as CtxmuxRunAdapter
  const controls = (['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'] as const).map(name =>
    vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('Forbidden Runtime control: ' + name) }))
  const writers: FileHandle[] = []
  const result = { root, path, storePath, storeBefore, client, controls, reads, writers }
  fixtures.push(result)
  return result
}
const targetStats = (f: Fixture) => observed.stats.filter(path => path === f.path).length

it('builtin Codex invalidates a held-open writer append while unrelated growth makes zero target stats', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = []
  const writer = await open(f.path, 'a'); f.writers.push(writer)
  observed.suppressParent = true
  const handle = await f.client.observeSessionHistory(SID, event => events.push(event))
  await vi.waitFor(() => expect(targetStats(f)).toBeGreaterThanOrEqual(2))
  const bytes = await writer.stat(), count = targetStats(f)
  const unrelated = join(f.root, 'unrelated.jsonl'), other = await open(unrelated, 'a'); f.writers.push(other)
  await other.appendFile(row('unrelated-open-writer')); await other.sync()
  expect((await other.stat()).size).toBeGreaterThan(0)
  await new Promise(resolve => setTimeout(resolve, 35))
  expect(events).toEqual([])
  expect(targetStats(f)).toBe(count)
  await writer.appendFile(row('held-open-new')); await writer.sync()
  await vi.waitFor(() => expect(events.filter(event => event.kind === 'invalidated').length).toBeGreaterThan(0), { timeout: 1500 })
  expect((await writer.stat()).size).toBeGreaterThan(bytes.size) // FD is still open at the oracle.
  expect(events[0]).toEqual({ kind: 'invalidated', agentSessionId: SID, source: SOURCE })
  expect(observed.watches.map(watch => watch.path)).toEqual([f.path])
  expect(await readFile(f.path, 'utf8')).toBe(initial + row('held-open-new'))
  handle.dispose(); handle.dispose()
  expect(observed.watches.map(watch => watch.close.mock.calls.length)).toEqual([1])
})

it('missing exact source waits for its basename then transfers to one file watcher and closes the setup gap', async () => {
  const f = await fixture(true), events: AgentSessionHistoryObservation[] = []
  const handle = await f.client.observeSessionHistory(SID, event => events.push(event))
  await vi.waitFor(() => expect(targetStats(f)).toBeGreaterThanOrEqual(2))
  expect(observed.watches.map(watch => watch.path)).toEqual([dirname(f.path)])
  const count = targetStats(f)
  const unrelated = join(f.root, 'unrelated.jsonl')
  await writeFile(unrelated, row('unrelated-created'))
  await vi.waitFor(() => expect(observed.parentCallbacks).toContain(basename(unrelated)))
  expect(targetStats(f)).toBe(count)
  expect(events).toEqual([])
  let setupGapWrites = 0
  observed.beforeWatch = path => {
    if (path === f.path) { appendFileSync(path, row('creation-setup-gap')); setupGapWrites++ }
  }
  const writer = await open(f.path, 'ax'); f.writers.push(writer)
  await writer.appendFile(initial); await writer.sync()
  await vi.waitFor(() => expect(observed.watches.map(watch => watch.path)).toEqual([dirname(f.path), f.path]))
  await vi.waitFor(() => expect(events.filter(event => event.kind === 'invalidated').length).toBeGreaterThan(0))
  expect(setupGapWrites).toBe(1)
  expect(observed.watches.map(watch => watch.close.mock.calls.length)).toEqual([1, 0])
  expect(await readFile(f.path, 'utf8')).toContain(row('creation-setup-gap'))
  const beforeAppend = events.length
  observed.beforeWatch = undefined
  await writer.appendFile(row('still-open-after-transfer')); await writer.sync()
  await vi.waitFor(() => expect(events.length).toBeGreaterThan(beforeAppend))
  expect((await writer.stat()).size).toBeGreaterThan(0)
  handle.dispose()
  expect(observed.watches.map(watch => watch.close.mock.calls.length)).toEqual([1, 1])
})

it('exact replacement and truncation remain unavailable and release their own single file watch', async () => {
  for (const change of ['replace', 'truncate'] as const) {
    const f = await fixture(), events: AgentSessionHistoryObservation[] = []
    const handle = await f.client.observeSessionHistory(SID, event => events.push(event))
    if (change === 'replace') {
      const replacement = join(f.root, 'replacement.jsonl')
      await writeFile(replacement, initial + row('replacement'))
      await rename(replacement, f.path)
    } else await truncate(f.path, 4)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ kind: 'unavailable', agentSessionId: SID, source: SOURCE,
      code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    expect(events[0]?.kind === 'unavailable' ? events[0].message : '').toContain('existing window is retained')
    handle.dispose()
  }
  expect(observed.watches.map(watch => watch.close.mock.calls.length)).toEqual([1, 1])
})

it('abort disposes the exact watch once and late callbacks or held-open appends do not stat or notify', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = [], controller = new AbortController()
  const writer = await open(f.path, 'a'); f.writers.push(writer)
  const handle = await f.client.observeSessionHistory(SID, event => events.push(event), { signal: controller.signal })
  await vi.waitFor(() => expect(targetStats(f)).toBeGreaterThanOrEqual(2))
  expect(observed.watches.map(watch => watch.path)).toEqual([f.path])
  controller.abort(); handle.dispose()
  const count = targetStats(f)
  writeSync(writer.fd, row('after-abort'))
  observed.watches[0]!.notify()
  await new Promise(resolve => setTimeout(resolve, 35))
  expect(targetStats(f)).toBe(count)
  expect(events).toEqual([])
  expect((await writer.stat()).size).toBeGreaterThan(Buffer.byteLength(initial))
  expect(observed.watches.map(watch => watch.close.mock.calls.length)).toEqual([1])
})
