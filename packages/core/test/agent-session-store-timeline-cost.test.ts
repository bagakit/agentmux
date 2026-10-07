import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxClient } from '../src/client.js'
import type { AgentHookServer } from '../src/hook-server.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentMuxStoredAgentSession, AgentTimelineItem, AgentTimelineMutation } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const execFileAsync = promisify(execFile)
const roots: string[] = []
const ownerId = 'synthetic-timeline-journal-owner'
const byteThreshold = 4 * 1024 * 1024
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytes = (value: string | Uint8Array) => typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength
function restoreIo(): void { vi.restoreAllMocks(); syncBuiltinESMExports() }

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

/** Count actual delegated I/O, rather than treating a changed file size as bytes written. */
function observeTimelineIo(path: string) {
  const counts = { readCalls: 0, readBytes: 0, appendCalls: 0, appendBytes: 0, snapshotWriteCalls: 0, snapshotWriteBytes: 0 }
  const originalRead = fs.readFile, originalAppend = fs.appendFile, originalOpen = fs.open
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    const value = await originalRead(...args)
    if (String(args[0]) === path) { counts.readCalls++; counts.readBytes += bytes(value) }
    return value
  })
  vi.spyOn(fs, 'appendFile').mockImplementation(async (...args: Parameters<typeof fs.appendFile>) => {
    if (String(args[0]) === path) { counts.appendCalls++; counts.appendBytes += bytes(args[1] as string | Uint8Array) }
    return originalAppend(...args)
  })
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args)
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
      expect(counts).toEqual({ readCalls: 3,
        readBytes: 3 * Buffer.byteLength(f.snapshot) + 2 * Buffer.byteLength(appended[0]!) + Buffer.byteLength(appended[1]!),
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
        await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(f.root, 'node_modules'), 'dir')
        const modulePath = join(f.root, 'store.mjs')
        const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/agent-session-store.ts', import.meta.url))],
          outfile: modulePath, bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true, logLevel: 'silent' })
        expect(Object.keys(compiled.metafile!.inputs).some(path => path.endsWith('/src/agent-session-store.ts'))).toBe(true)
        const program = `import {createHash} from 'node:crypto'; import {AgentMuxFileAgentSessionStore} from ${JSON.stringify(pathToFileURL(modulePath).href)};
const store=new AgentMuxFileAgentSessionStore(process.argv[1]);const timeline=await store.loadTimeline(process.argv[2]);const session=await store.readMetadata(process.argv[2]);
console.log(JSON.stringify({pid:process.pid,session,timeline:{agentSessionId:timeline.agentSessionId,revision:timeline.revision,count:timeline.items.length,digest:createHash('sha256').update(JSON.stringify(timeline)).digest('hex')}}));`
        const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', program, f.path, ownerId], { timeout: 15_000 })
        const reopened = JSON.parse(stdout)
        expect(reopened.pid).not.toBe(process.pid)
        expect(reopened.session).toEqual(await f.store.readMetadata(ownerId))
        expect(reopened.session.run).toEqual(f.session.run)
        expect(reopened.session.nativeHandle).toEqual(f.session.nativeHandle)
        expect(reopened.timeline).toEqual({ agentSessionId: ownerId, revision: 103, count, digest: digest(timeline) })
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
