import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxClient } from '../src/client.js'
import type { AgentHookServer } from '../src/hook-server.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentMuxStoredAgentSession, AgentTimelineItem, AgentTimelineMutation } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const execFileAsync = promisify(execFile)
const roots: string[] = []
const costObservations: unknown[] = []
const ownerId = 'synthetic-timeline-journal-owner'
const byteThreshold = 4 * 1024 * 1024
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytes = (value: string | Uint8Array) => typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength
const { tryLock } = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
function restoreIo(): void { vi.restoreAllMocks(); syncBuiltinESMExports() }

afterAll(async () => {
  const output = process.env.AGENTMUX_TIMELINE_COST_RECEIPT
  if (output) await fs.writeFile(output, JSON.stringify({ schema: 'agentmux.timeline-observed-cost.v1',
    scope: 'actual synthetic File Store I/O; no Runtime connected', observations: costObservations }, null, 2) + '\n')
})

afterEach(async () => {
  restoreIo()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

function item(id: string, body = ''): AgentTimelineItem {
  return { id, agentSessionId: ownerId, kind: 'tool_call', status: 'streaming', source: 'native-hook',
    createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1), title: 'SYNTHETIC original tool', toolName: 'shell', toolOutput: body }
}

async function fixture(items: AgentTimelineItem[], journal = '') {
  const root = await fs.mkdtemp(join(tmpdir(), 'agentmux-timeline-journal-'))
  roots.push(root)
  const path = join(root, 'agent-sessions.json'), store = new AgentMuxFileAgentSessionStore(path)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: ownerId, providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: root, run: { runId: 'synthetic-original-run' }, retiredRuns: [],
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'synthetic-original-native' },
    hookBindingId: 'synthetic-original-binding', hookToken: 'synthetic-token', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }
  await store.compareAndSwap(null, session)
  const directory = join(root, 'agent-timelines')
  await fs.mkdir(directory)
  const timelinePath = join(directory, createHash('sha256').update(ownerId).digest('base64url') + '.jsonl')
  const snapshot = JSON.stringify({ version: 3, agentSessionId: ownerId, revision: 100, items }) + '\n'
  await fs.writeFile(timelinePath, snapshot + journal)
  return { root, path, store, session, timelinePath, snapshot }
}

async function addOwner(f: Awaited<ReturnType<typeof fixture>>, id: string, items: AgentTimelineItem[]) {
  const session = { ...f.session, agentSessionId: id, run: { runId: 'synthetic-run-' + id },
    nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'synthetic-native-' + id }, hookBindingId: 'synthetic-binding-' + id }
  await f.store.compareAndSwap(null, session)
  const timelinePath = join(f.root, 'agent-timelines', createHash('sha256').update(id).digest('base64url') + '.jsonl')
  const snapshot = JSON.stringify({ version: 3, agentSessionId: id, revision: 100,
    items: items.map(entry => ({ ...entry, agentSessionId: id })) }) + '\n'
  await fs.writeFile(timelinePath, snapshot)
  return { session, timelinePath, snapshot }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** The worker only opens the original exact Store files, with all homes private before import. */
async function privateWorker(f: Awaited<ReturnType<typeof fixture>>, mutation?: AgentTimelineMutation) {
  const modulePath = join(f.root, 'store.mjs')
  if (!await fs.stat(modulePath).catch(() => null)) {
    await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(f.root, 'node_modules'), 'dir')
    const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/agent-session-store.ts', import.meta.url))],
      outfile: modulePath, bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true, logLevel: 'silent' })
    expect(Object.keys(compiled.metafile!.inputs).some(path => path.endsWith('/src/agent-session-store.ts'))).toBe(true)
  }
  const home = join(f.root, 'private-home')
  await fs.mkdir(home, { recursive: true })
  const program = `import {AgentMuxFileAgentSessionStore} from ${JSON.stringify(pathToFileURL(modulePath).href)};
const store=new AgentMuxFileAgentSessionStore(process.argv[1]);const mutation=JSON.parse(process.argv[3]);
const commit=mutation ? await store.applyTimelineMutation(mutation) : null;
console.log(JSON.stringify({pid:process.pid,home:process.env.HOME,session:await store.readMetadata(process.argv[2]),timeline:await store.loadTimeline(process.argv[2]),commit}));`
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', program, f.path, ownerId, JSON.stringify(mutation ?? null)],
    { timeout: 15_000, maxBuffer: 24 * 1024 * 1024, env: { ...process.env, HOME: home, CODEX_HOME: join(home, 'codex'),
      AGENTMUX_STATE_DIRECTORY: join(home, 'state'), AGENTMUX_RUNTIME_DIRECTORY: join(home, 'runtime'), AGENTMUX_AGENT_SESSION_STORE: f.path } })
  const receipt = JSON.parse(stdout)
  expect(receipt.pid).not.toBe(process.pid)
  expect(receipt.home).toBe(home)
  expect(receipt.session.run).toEqual(f.session.run)
  expect(receipt.session.nativeHandle).toEqual(f.session.nativeHandle)
  return receipt
}

/** Count actual delegated I/O, rather than treating a changed file size as bytes written. */
function observeTimelineIo(path: string) {
  const counts = { readCalls: 0, readBytes: 0, appendCalls: 0, appendBytes: 0, snapshotWriteCalls: 0, snapshotWriteBytes: 0 }
  const originalAppend = fs.appendFile, originalOpen = fs.open
  vi.spyOn(fs, 'appendFile').mockImplementation(async (...args: Parameters<typeof fs.appendFile>) => {
    if (String(args[0]) === path) { counts.appendCalls++; counts.appendBytes += bytes(args[1] as string | Uint8Array) }
    return originalAppend(...args)
  })
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args)
    if (String(args[0]) === path && args[1] === 'r') {
      const originalRead = handle.readFile.bind(handle)
      vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs: Parameters<typeof handle.readFile>) => {
        const value = await originalRead(...readArgs)
        counts.readCalls++; counts.readBytes += bytes(value)
        return value
      })
    }
    if (String(args[0]).startsWith(path + '.') && String(args[0]).endsWith('.tmp')) {
      const originalWrite = handle.writeFile.bind(handle)
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        counts.snapshotWriteCalls++; counts.snapshotWriteBytes += bytes(writeArgs[0] as string | Uint8Array)
        return originalWrite(...writeArgs)
      })
    }
    return handle
  })
  syncBuiltinESMExports()
  return counts
}

function shortMutation(itemId: string, index: number): AgentTimelineMutation {
  return { type: 'update', agentSessionId: ownerId, itemId, updatedAt: _historyFixtureEpoch(0, 1, 0) + index, title: 'SYNTHETIC short update ' + index }
}

/** Legal multibyte records reach the byte threshold before the independent 256-line threshold. */
function journalWithBytes(totalBytes: number) {
  const lines: string[] = []
  while (totalBytes > 0) {
    const targetBytes = Math.min(totalBytes, 120_000)
    const mutation = { type: 'update', agentSessionId: ownerId, itemId: 'target', updatedAt: _historyFixtureEpoch(0, 0, 10) + lines.length,
      title: 'SYNTHETIC Unicode journal ' + lines.length, toolOutput: '' }
    const bodyBytes = targetBytes - Buffer.byteLength(JSON.stringify(mutation) + '\n')
    mutation.toolOutput = '界🙂'.repeat(Math.floor(bodyBytes / 7)) + 'x'.repeat(bodyBytes % 7)
    const line = JSON.stringify(mutation) + '\n'
    expect(Buffer.byteLength(line)).toBe(targetBytes)
    lines.push(line); totalBytes -= targetBytes
  }
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.length).toBeLessThan(256)
  return { text: lines.join(''), lineCount: lines.length }
}

describe('Timeline compaction counts only appended journal bytes', () => {
  it('uses the same append boundary through authenticated native Hook ingress and the public Client Timeline', async () => {
    const f = await fixture(Array.from({ length: 200 }, (_, index) => item('tool-' + index, 'x'.repeat(25_000))))
    const client = new AgentMuxClient({ store: f.store })
    const inner = client as unknown as { registry: AgentMuxAgentSessionRegistry; hookServer: AgentHookServer
      hookNativeWitnesses: Map<string, unknown> }
    await inner.registry.load('local')
    // Only original process discovery is synthetic. Authentication, Provider normalization,
    // accepted Hook receipt, original File Store and the public read consumer remain real.
    inner.hookNativeWitnesses.set(f.session.run.runId, {
      candidate: JSON.stringify(f.session.nativeHandle!.sessionId), handle: f.session.nativeHandle
    })
    Object.defineProperty(inner.hookServer, 'port', { value: 0 })
    try {
      await inner.hookServer.start()
      const binding = inner.hookServer.createBinding(ownerId, 'codex')
      await binding.bindRun(f.session.run.runId)
      const counts = observeTimelineIo(f.timelinePath)
      const response = await fetch(binding.endpoint.url, { method: 'POST',
        headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ receiptId: 'synthetic-real-hook', eventName: 'PreToolUse', payload: {
          hook_event_name: 'PreToolUse', session_id: f.session.nativeHandle!.sessionId, turn_id: 'synthetic-turn',
          tool_use_id: 'synthetic-original-call', tool_name: 'Bash', tool_input: { command: 'SYNTHETIC no execution' }
        } }) })
      expect(response.status).toBe(204)
      expect(counts.appendCalls).toBeGreaterThan(0)
      expect(counts.appendBytes).toBeLessThan(10_000)
      expect(counts.readBytes).toBeGreaterThanOrEqual(Buffer.byteLength(f.snapshot))
      expect(counts.snapshotWriteCalls).toBe(0)
      restoreIo()
      expect(client.agentSession(ownerId).hookReceipt).toMatchObject({ id: 'synthetic-real-hook',
        subject: { kind: 'main' }, decision: { activityApplied: true } })
      const timeline = await client.sessionTimeline(ownerId)
      expect(timeline.items.some(entry => entry.toolInput?.includes('SYNTHETIC no execution'))).toBe(true)
      expect(timeline.items.some(entry => entry.activityState !== undefined)).toBe(true)
      expect(client.agentSession(ownerId).run).toEqual(f.session.run)
    } finally { restoreIo(); await client.dispose() }
  })

  it.each([{ name: 'small', count: 50, bodyBytes: 300 }, { name: 'large', count: 200, bodyBytes: 25_000 }])(
    'appends consecutive short mutations to the $name original snapshot with measured I/O', async ({ name, count, bodyBytes }) => {
      const f = await fixture(Array.from({ length: count }, (_, index) => item('tool-' + index, 'x'.repeat(bodyBytes))))
      if (name === 'large') expect(Buffer.byteLength(f.snapshot)).toBeGreaterThan(byteThreshold)
      const counts = observeTimelineIo(f.timelinePath)
      const mutations = Array.from({ length: 3 }, (_, index) => shortMutation('tool-' + (count - 1), index))
      for (const [index, mutation] of mutations.entries()) {
        await expect(f.store.applyTimelineMutation(mutation)).resolves.toMatchObject({ changed: true, revision: 101 + index })
      }
      const appended = mutations.map(mutation => JSON.stringify(mutation) + '\n')
      expect(counts).toEqual({ readCalls: 1,
        readBytes: Buffer.byteLength(f.snapshot),
        appendCalls: 3, appendBytes: Buffer.byteLength(appended.join('')), snapshotWriteCalls: 0, snapshotWriteBytes: 0 })
      restoreIo()
      expect(await fs.readFile(f.timelinePath, 'utf8')).toBe(f.snapshot + appended.join(''))
      const client = new AgentMuxClient({ store: f.store })
      let timeline
      try { timeline = await client.sessionTimeline(ownerId) } finally { await client.dispose() }
      expect(timeline).toMatchObject({ agentSessionId: ownerId, revision: 103 })
      expect(timeline.items).toHaveLength(count)
      expect(timeline.items.at(-1)?.title).toBe('SYNTHETIC short update 2')
      if (name === 'large') {
        // A fresh private process reads these same committed files; it never seeds replacement data.
        const reopened = await privateWorker(f)
        expect(reopened.session).toEqual(await f.store.readMetadata(ownerId))
        expect(digest(reopened.timeline)).toBe(digest(timeline))
      }
    })

  it.each([-1, 0])('keeps exact UTF-8 journal threshold semantics at threshold delta %i bytes', async delta => {
    const journal = journalWithBytes(byteThreshold + delta)
    expect(journal.text.length).toBeLessThan(byteThreshold)
    const f = await fixture([item('target')], journal.text)
    const counts = observeTimelineIo(f.timelinePath)
    await f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 0)))
    expect(counts.readBytes).toBe(Buffer.byteLength(f.snapshot) + byteThreshold + delta)
    expect(counts.snapshotWriteCalls).toBe(delta < 0 ? 0 : 1)
    expect(counts.appendCalls).toBe(delta < 0 ? 1 : 0)
    if (delta < 0) {
      await f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 1)))
      expect(counts.snapshotWriteCalls).toBe(1)
      expect(counts.appendCalls).toBe(1)
    }
    restoreIo()
    const saved = await fs.readFile(f.timelinePath, 'utf8')
    expect(saved.split('\n').filter(Boolean)).toHaveLength(1)
    const reopened = await new AgentMuxFileAgentSessionStore(f.path).loadTimeline(ownerId)
    expect(reopened.revision).toBe(100 + journal.lineCount + (delta < 0 ? 2 : 1))
    expect(reopened.items[0]?.title).toBe('SYNTHETIC short update ' + (delta < 0 ? 1 : 0))
  })

  it('recounts the original file after an external atomic snapshot replacement', async () => {
    const journal = journalWithBytes(byteThreshold)
    const f = await fixture([item('target')], journal.text)
    await expect(f.store.loadTimeline(ownerId)).resolves.toMatchObject({ revision: 100 + journal.lineCount })
    const replacementItems = Array.from({ length: 200 }, (_, index) => item(index ? 'external-' + index : 'target', '界🙂'.repeat(3600)))
    const replacement = JSON.stringify({ version: 3, agentSessionId: ownerId, revision: 500, items: replacementItems }) + '\n'
    expect(Buffer.byteLength(replacement)).toBeGreaterThan(byteThreshold)
    await fs.writeFile(f.timelinePath + '.external', replacement)
    await fs.rename(f.timelinePath + '.external', f.timelinePath)
    const counts = observeTimelineIo(f.timelinePath)
    const mutation = shortMutation('target', _historyFixtureEpoch(0, 0, 0))
    await expect(f.store.applyTimelineMutation(mutation)).resolves.toMatchObject({ changed: true, revision: 501 })
    expect(counts).toEqual({ readCalls: 1, readBytes: Buffer.byteLength(replacement), appendCalls: 1,
      appendBytes: Buffer.byteLength(JSON.stringify(mutation) + '\n'), snapshotWriteCalls: 0, snapshotWriteBytes: 0 })
    restoreIo()
    const reopened = await new AgentMuxFileAgentSessionStore(f.path).loadTimeline(ownerId)
    expect(reopened.items).toEqual(replacementItems.map((entry, index) => index ? entry : { ...entry, updatedAt: _historyFixtureEpoch(0, 1, 0), title: 'SYNTHETIC short update 0' }))
    expect(reopened.revision).toBe(501)
    expect((await f.store.readMetadata(ownerId))?.run).toEqual(f.session.run)
  })

  it.each(['append', 'compact'] as const)('retains original bytes and revision after a failed %s, then retries once', async mode => {
    const journal = mode === 'compact' ? journalWithBytes(byteThreshold).text : ''
    const f = await fixture([item('target')], journal)
    const before = await f.store.loadTimeline(ownerId), originalBytes = await fs.readFile(f.timelinePath)
    const error = Object.assign(new Error('SYNTHETIC bounded I/O failure'), { code: 'EIO' })
    if (mode === 'append') vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(error)
    else {
      const open = fs.open
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]).startsWith(f.timelinePath + '.') && String(args[0]).endsWith('.tmp')) throw error
        return open(...args)
      })
    }
    syncBuiltinESMExports()
    const mutation = shortMutation('target', _historyFixtureEpoch(0, 0, 0))
    await expect(f.store.applyTimelineMutation(mutation)).rejects.toThrow()
    restoreIo()
    expect(await fs.readFile(f.timelinePath)).toEqual(originalBytes)
    expect(await new AgentMuxFileAgentSessionStore(f.path).loadTimeline(ownerId)).toEqual(before)
    await expect(f.store.applyTimelineMutation(mutation)).resolves.toMatchObject({ changed: true, revision: before.revision + 1 })
    const reopened = await new AgentMuxFileAgentSessionStore(f.path).loadTimeline(ownerId)
    expect(reopened.revision).toBe(before.revision + 1)
    expect(reopened.items[0]?.title).toBe('SYNTHETIC short update 0')
    expect((await f.store.readMetadata(ownerId))?.nativeHandle).toEqual(f.session.nativeHandle)
  })
})

describe('Timeline physical-version reuse and original commit owner', () => {
  it('reads each large original once across two interleaved Sessions, including public defensive reads', async () => {
    const items = Array.from({ length: 200 }, (_, index) => item('tool-' + index, 'x'.repeat(25_000)))
    const f = await fixture(items), b = await addOwner(f, 'synthetic-owner-b', items)
    const aIo = observeTimelineIo(f.timelinePath), bIo = observeTimelineIo(b.timelinePath)
    for (let index = 0; index < 4; index++) {
      await f.store.applyTimelineMutation(shortMutation('tool-199', index))
      await f.store.applyTimelineMutation({ ...shortMutation('tool-199', index), agentSessionId: b.session.agentSessionId })
    }
    const publicRead = await f.store.loadTimeline(ownerId)
    publicRead.items[0]!.title = 'SYNTHETIC caller mutation'
    expect((await f.store.loadTimeline(ownerId)).items[0]!.title).toBe(items[0]!.title)
    expect(aIo).toMatchObject({ readCalls: 1, readBytes: Buffer.byteLength(f.snapshot), appendCalls: 4, snapshotWriteCalls: 0 })
    expect(bIo).toMatchObject({ readCalls: 1, readBytes: Buffer.byteLength(b.snapshot), appendCalls: 4, snapshotWriteCalls: 0 })
    expect(aIo.appendBytes + bIo.appendBytes).toBeLessThan(2000)
    costObservations.push({ kind: 'two-large-interleaved-sessions', mutationsPerSession: 4,
      a: { initialBytes: Buffer.byteLength(f.snapshot), ...aIo }, b: { initialBytes: Buffer.byteLength(b.snapshot), ...bIo } })
    restoreIo()
    expect((await privateWorker(f)).timeline).toEqual(await f.store.loadTimeline(ownerId))
  })

  it('lets unrelated metadata and Timeline commit while a cold history read is blocked, preserving same-Session order', async () => {
    const f = await fixture([item('target')]), b = await addOwner(f, 'synthetic-owner-b', [item('target')])
    const entered = deferred(), release = deferred(), originalOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === f.timelinePath && args[1] === 'r') {
        const read = handle.readFile.bind(handle)
        vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs: Parameters<typeof handle.readFile>) => {
          entered.resolve(); await release.promise; return read(...readArgs)
        })
      }
      return handle
    })
    syncBuiltinESMExports()
    const first = f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 0)))
    const second = f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 1)))
    await entered.promise
    try {
      const independent = (async () => {
        await f.store.compareAndSwapMetadata(b.session, { ...b.session, updatedAt: _historyFixtureEpoch(0, 0, 2) })
        return f.store.applyTimelineMutation({ ...shortMutation('target', _historyFixtureEpoch(0, 0, 0)), agentSessionId: b.session.agentSessionId })
      })()
      await expect(Promise.race([independent, new Promise((_, reject) => setTimeout(() => reject(new Error('B was held by A cold history')), 2000))]))
        .resolves.toMatchObject({ changed: true, revision: 101 })
      costObservations.push({ kind: 'cold-read-critical-section', aReadBlocked: true,
        bMetadataAndTimelineCommittedBeforeRelease: true, originalGlobalCommitOwner: 'unchanged kernel lock and SQLite transaction' })
    } finally { release.resolve(); await Promise.all([first, second]) }
    expect((await first).revision).toBe(101)
    expect((await second).revision).toBe(102)
    expect((await f.store.loadTimeline(ownerId)).items[0]!.title).toBe('SYNTHETIC short update 1')
  })

  it('revalidates original membership after cold preparation, without reintroducing a removed Session', async () => {
    const f = await fixture([item('target')]), entered = deferred(), release = deferred(), originalOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === f.timelinePath && args[1] === 'r') {
        const read = handle.readFile.bind(handle)
        vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs: Parameters<typeof handle.readFile>) => {
          entered.resolve(); await release.promise; return read(...readArgs)
        })
      }
      return handle
    })
    syncBuiltinESMExports()
    const pending = f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 0)))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    await entered.promise
    try { await f.store.compareAndSwap(f.session, null) } finally { release.resolve() }
    await rejected
    expect(await f.store.readMetadata(ownerId)).toBeNull()
  })

  it('keeps public Timeline reads behind the original metadata descriptor and rejects a removed original source', async () => {
    const f = await fixture([item('target')]), entered = deferred(), release = deferred(), originalOpen = fs.open
    const client = new AgentMuxClient({ store: f.store })
    let held = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (!held && String(args[0]) === f.path + '.lock') { held = true; entered.resolve(); await release.promise }
      return handle
    })
    syncBuiltinESMExports()
    const metadata = f.store.compareAndSwapMetadata(f.session, { ...f.session, updatedAt: _historyFixtureEpoch(0, 0, 2) })
    await entered.promise
    let observed = false
    const pendingRead = client.sessionTimeline(ownerId).then(value => { observed = true; return value })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(observed).toBe(false)
      release.resolve(); await metadata
      expect(await pendingRead).toMatchObject({ agentSessionId: ownerId, revision: 100 })
      restoreIo()
      const original = await f.store.readMetadata(ownerId)
      expect(original?.run).toEqual(f.session.run)
      await f.store.compareAndSwap(original, null)
      await expect(client.sessionTimeline(ownerId)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    } finally { release.resolve(); restoreIo(); await client.dispose() }
  })

  it.each(['public-read', 'aborted-mutation'])('takes one original locked observation after cooperative writer drift: %s', async mode => {
    const f = await fixture([item('target')]), writer = new AgentMuxFileAgentSessionStore(f.path), originalOpen = fs.open
    const controller = new AbortController()
    await writer.loadTimeline(ownerId)
    let reads = 0, pendingWrite: Promise<unknown> | undefined
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === f.timelinePath && args[1] === 'r') {
        const read = handle.readFile.bind(handle)
        vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs: Parameters<typeof handle.readFile>) => {
          const value = await read(...readArgs)
          reads += 1
          if (reads === 1) await writer.applyTimelineMutation(shortMutation('target', reads))
          else {
            const probe = await originalOpen(f.path + '.lock', 'a+', 0o600)
            let acquired: boolean
            try { acquired = tryLock(probe.fd) } finally { await probe.close() }
            expect(acquired).toBe(false)
            pendingWrite = writer.applyTimelineMutation(shortMutation('target', reads))
            if (mode === 'aborted-mutation') controller.abort()
          }
          return value
        })
      }
      return handle
    })
    syncBuiltinESMExports()
    if (mode === 'public-read') expect(await f.store.loadTimeline(ownerId)).toMatchObject({ revision: 101 })
    else await expect(f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 99)), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(reads).toBe(2)
    restoreIo()
    await pendingWrite
    expect((await f.store.loadTimeline(ownerId)).revision).toBe(102)
  })

  it.each(['same-inode-same-length', 'atomic-replacement', 'external-append', 'delete-recreate'] as const)(
    'reloads original bytes after %s rather than guessing append-only history', async mode => {
      const f = await fixture([item('target', 'original')])
      if (mode === 'same-inode-same-length') await fs.utimes(f.timelinePath, _historyFixtureEpoch(1, 0, 0) / 1000, _historyFixtureEpoch(1, 0, 0) / 1000)
      await f.store.loadTimeline(ownerId)
      const before = await fs.stat(f.timelinePath, { bigint: true })
      const replacement = f.snapshot.replace('"toolOutput":"original"', '"toolOutput":"external"')
      if (mode === 'same-inode-same-length') {
        await fs.writeFile(f.timelinePath, replacement)
        await fs.utimes(f.timelinePath, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9)
        const after = await fs.stat(f.timelinePath, { bigint: true })
        expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size)
        expect(after.mtimeNs).toBe(before.mtimeNs)
        expect(after.ctimeNs).not.toBe(before.ctimeNs)
      } else if (mode === 'external-append') {
        await fs.appendFile(f.timelinePath, JSON.stringify({ ...shortMutation('target', _historyFixtureEpoch(0, 0, 8)), toolOutput: 'external' }) + '\n')
      } else {
        if (mode === 'delete-recreate') {
          await fs.unlink(f.timelinePath)
          expect(await f.store.loadTimeline(ownerId)).toMatchObject({ revision: 0, items: [] })
        }
        await fs.writeFile(f.timelinePath + '.replacement', replacement)
        await fs.rename(f.timelinePath + '.replacement', f.timelinePath)
      }
      const counts = observeTimelineIo(f.timelinePath)
      expect(await f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 9)))).toMatchObject({ revision: mode === 'external-append' ? 102 : 101 })
      expect(counts.readCalls).toBe(1)
      restoreIo()
      expect((await f.store.loadTimeline(ownerId)).items[0]!.toolOutput).toBe('external')
    })

  it.each(['path-replacement', 'same-descriptor-rewrite'])('discards a changing generation during cold read: %s', async mode => {
    const f = await fixture([item('target', 'original')]), originalOpen = fs.open
    let swapped = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === f.timelinePath && args[1] === 'r' && !swapped) {
        const read = handle.readFile.bind(handle)
        vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs: Parameters<typeof handle.readFile>) => {
          const value = await read(...readArgs)
          swapped = true
          const replacement = f.snapshot.replace('"toolOutput":"original"', '"toolOutput":"external"').replace('"revision":100', '"revision":500')
          if (mode === 'path-replacement') {
            await fs.writeFile(f.timelinePath + '.replacement', replacement)
            await fs.rename(f.timelinePath + '.replacement', f.timelinePath)
          } else await fs.writeFile(f.timelinePath, replacement)
          return value
        })
      }
      return handle
    })
    syncBuiltinESMExports()
    expect(await f.store.loadTimeline(ownerId)).toMatchObject({ revision: 500, items: [{ toolOutput: 'external' }] })
    expect(await f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 0)))).toMatchObject({ revision: 501 })
    expect((await f.store.loadTimeline(ownerId)).items[0]!.toolOutput).toBe('external')
  })

  it('rebases after a second process writes while the prepared original waits for the commit lock', async () => {
    const f = await fixture([item('target')])
    await f.store.loadTimeline(ownerId)
    // Compile/read in a private process first. That process never reseeds this original Store.
    await privateWorker(f)
    const handle = await fs.open(f.path + '.lock', 'a+', 0o600)
    expect(tryLock(handle.fd)).toBe(true)
    const entered = deferred(), originalOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === f.path + '.lock') entered.resolve()
      return originalOpen(...args)
    })
    syncBuiltinESMExports()
    const pending = f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 1)))
    await entered.promise
    // Replace between completed preparation and commit. The independent writer
    // then acquires the same original lock and contributes another exact mutation.
    await fs.writeFile(f.timelinePath + '.replacement', f.snapshot.replace('"revision":100', '"revision":500'))
    await fs.rename(f.timelinePath + '.replacement', f.timelinePath)
    await handle.close()
    const child = await privateWorker(f, { type: 'append', agentSessionId: ownerId, item: item('second-process') })
    expect((await pending).revision).toBeGreaterThanOrEqual(501)
    expect(child.commit.changed).toBe(true)
    restoreIo()
    const timeline = await f.store.loadTimeline(ownerId)
    expect(timeline.revision).toBe(502)
    expect(timeline.items.map(entry => entry.id)).toEqual(['target', 'second-process'])
    expect(timeline.items[0]!.title).toBe('SYNTHETIC short update 1')
    expect((await privateWorker(f)).timeline).toEqual(timeline)
  })

  it('evicts only derived states by byte and entry budgets, while oversized valid history remains usable', async () => {
    const f = await fixture([item('target')])
    const ownerIds = [ownerId]
    for (let index = 0; index < 9; index++) ownerIds.push((await addOwner(f, 'bounded-' + index, [item('target')])).session.agentSessionId)
    for (const id of ownerIds) await f.store.loadTimeline(id)
    const counts = observeTimelineIo(f.timelinePath)
    expect((await f.store.loadTimeline(ownerId)).items).toHaveLength(1)
    expect(counts.readCalls).toBe(1)
    restoreIo()
    const large = Array.from({ length: 200 }, (_, index) => item('tool-' + index, 'x'.repeat(30_000)))
    for (let index = 0; index < 3; index++) {
      const owner = await addOwner(f, 'bytes-' + index, large)
      await f.store.loadTimeline(owner.session.agentSessionId)
    }
    const retained = f.store as unknown as { timelines: Map<string, unknown>; timelineSourceBytes: number }
    expect(retained.timelines.size).toBeLessThanOrEqual(8)
    expect(retained.timelineSourceBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    const oversized = await addOwner(f, 'oversized', Array.from({ length: 200 }, (_, index) => item('tool-' + index, '界'.repeat(30_000))))
    expect(Buffer.byteLength(oversized.snapshot)).toBeGreaterThan(16 * 1024 * 1024)
    expect((await f.store.loadTimeline('oversized')).items).toHaveLength(200)
    expect(retained.timelines.has('oversized')).toBe(false)
    expect(await f.store.applyTimelineMutation({ ...shortMutation('tool-199', _historyFixtureEpoch(0, 0, 0)), agentSessionId: 'oversized' })).toMatchObject({ changed: true, revision: 101 })
    expect((await new AgentMuxFileAgentSessionStore(f.path).loadTimeline('oversized')).revision).toBe(101)
    expect(retained.timelines.has('oversized')).toBe(false)
  })
})

describe('Timeline uncertain writes and torn-tail recovery', () => {
  it.each(['torn', 'torn-with-newline', 'valid-no-newline', 'snapshot-no-newline'] as const)(
    'durably repairs %s before acknowledging the next mutation across a private process reopen', async mode => {
      const journal = mode === 'snapshot-no-newline' ? '' : JSON.stringify(shortMutation('target', _historyFixtureEpoch(0, 0, 0))) + '\n'
      const f = await fixture([item('target')], journal)
      if (mode === 'snapshot-no-newline' || mode === 'valid-no-newline') {
        const bytes = await fs.readFile(f.timelinePath)
        await fs.truncate(f.timelinePath, bytes.byteLength - 1)
      } else await fs.appendFile(f.timelinePath, '{"type":' + (mode === 'torn-with-newline' ? '\n' : ''))
      const original = await f.store.loadTimeline(ownerId)
      const counts = observeTimelineIo(f.timelinePath)
      const commit = await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ownerId, item: item('after-torn-tail') })
      expect(commit).toMatchObject({ changed: true, revision: original.revision + 1 })
      restoreIo()
      const reopened = await privateWorker(f)
      expect(reopened.timeline.revision).toBe(commit.revision)
      expect(reopened.timeline.items.map((entry: AgentTimelineItem) => entry.id)).toEqual(['target', 'after-torn-tail'])
      expect(counts).toMatchObject({ snapshotWriteCalls: 1, appendCalls: 0 })
      expect((await fs.readFile(f.timelinePath, 'utf8')).trim().split('\n')).toHaveLength(1)
    })

  it.each(['partial', 'applied-but-unconfirmed', 'postwrite-version-unknown'] as const)('invalidates derived facts after %s append, then recovers original revision', async mode => {
    const f = await fixture([item('target')])
    await f.store.loadTimeline(ownerId)
    const append = fs.appendFile, mutation = shortMutation('target', _historyFixtureEpoch(0, 0, 0))
    if (mode === 'postwrite-version-unknown') {
      const originalStat = fs.stat
      let versions = 0
      vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
        if (String(args[0]) === f.timelinePath && ++versions === 3) throw Object.assign(new Error('SYNTHETIC postwrite unknown version'), { code: 'EIO' })
        return originalStat(...args)
      })
    } else vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args: Parameters<typeof fs.appendFile>) => {
        await append(args[0], mode === 'partial' ? String(args[1]).slice(0, 20) : args[1], args[2])
        throw Object.assign(new Error('SYNTHETIC unknown append receipt'), { code: 'EIO' })
      })
    syncBuiltinESMExports()
    await expect(f.store.applyTimelineMutation(mutation)).rejects.toThrow()
    restoreIo()
    const retry = await f.store.applyTimelineMutation(mutation)
    expect(retry).toMatchObject({ revision: 101, changed: mode === 'partial' })
    const reopened = await privateWorker(f)
    expect(reopened.timeline.revision).toBe(101)
    expect(reopened.timeline.items[0]!.title).toBe('SYNTHETIC short update 0')
  })

  it('cancels cold reads and releases their descriptor without a late commit or stale derived entry', async () => {
    const f = await fixture([item('target')]), entered = deferred(), release = deferred(), originalOpen = fs.open
    const controller = new AbortController()
    let closed = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === f.timelinePath && args[1] === 'r') {
        const read = handle.readFile.bind(handle), close = handle.close.bind(handle)
        vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs: Parameters<typeof handle.readFile>) => {
          entered.resolve(); await release.promise; return read(...readArgs)
        })
        vi.spyOn(handle, 'close').mockImplementation(async () => { closed = true; return close() })
      }
      return handle
    })
    syncBuiltinESMExports()
    const pending = f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 0)), controller.signal)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise; controller.abort(); release.resolve(); await rejection
    expect(closed).toBe(true)
    restoreIo()
    expect((await new AgentMuxFileAgentSessionStore(f.path).loadTimeline(ownerId)).revision).toBe(100)
    expect(await f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 0)))).toMatchObject({ changed: true, revision: 101 })
  })

  it('keeps a failed cold read retryable from original files with the original storage error', async () => {
    const f = await fixture([item('target')]), originalOpen = fs.open
    let failed = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === f.timelinePath && args[1] === 'r' && !failed) {
        failed = true
        vi.spyOn(handle, 'readFile').mockRejectedValueOnce(Object.assign(new Error('SYNTHETIC read failure'), { code: 'EIO' }))
      }
      return handle
    })
    syncBuiltinESMExports()
    await expect(f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 0)))).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE' })
    restoreIo()
    expect(await f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 0)))).toMatchObject({ changed: true, revision: 101 })
  })

  it('does not retain a new derived state when original lock cleanup is unconfirmed', async () => {
    const f = await fixture([item('target')]), originalOpen = fs.open
    await f.store.loadTimeline(ownerId)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === f.path + '.lock') {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await close(); throw Object.assign(new Error('SYNTHETIC close acknowledgment failure'), { code: 'EIO' })
        })
      }
      return handle
    })
    syncBuiltinESMExports()
    // Preserve the existing owner's warning/receipt contract; the optimization
    // cannot make that unconfirmed cleanup a retained decoded success.
    expect(await f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 0)))).toMatchObject({ changed: true, revision: 101 })
    const internals = f.store as unknown as { timelines: Map<string, unknown>; pendingLockRelease: unknown }
    expect(internals.pendingLockRelease).not.toBeNull()
    expect(internals.timelines.has(ownerId)).toBe(false)
    restoreIo()
    const counts = observeTimelineIo(f.timelinePath)
    expect((await f.store.loadTimeline(ownerId)).revision).toBe(101)
    expect(counts.readCalls).toBe(1)
    restoreIo()
    expect(await f.store.applyTimelineMutation(shortMutation('target', _historyFixtureEpoch(0, 0, 1)))).toMatchObject({ changed: true, revision: 102 })
    expect(internals.pendingLockRelease).toBeNull()
  })
})
