import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxClient } from '../src/client.js'
import { applyNormalizedTimelineMutation } from '../src/session-timeline-reducer.js'
import { applyAgentTimelineMutation, normalizeAgentTimeline } from '../src/session-timeline.js'
import type { AgentMuxStoredAgentSession, AgentTimelineItem, AgentTimelineMutation } from '../src/types.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const ownerId = 'synthetic-timeline-cost-session'
const title = 'SYNTHETIC timeline validation sentinel'
const body = `  SYNTHETIC output\n${'x'.repeat(3_000)}\n  `

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function item(id: string, kind: AgentTimelineItem['kind'] = 'tool_call'): AgentTimelineItem {
  return {
    id, agentSessionId: ownerId, kind, status: 'streaming', source: 'native-hook',
    createdAt: 10, updatedAt: 10, title,
    ...(kind === 'user_message' ? { content: `  input ${id}\n  ` } : {
      toolName: 'shell', toolInput: 'SYNTHETIC', toolOutput: body
    })
  }
}

function capacityFixture(): { snapshot: AgentTimelineItem[]; journal: AgentTimelineMutation[]; expected: AgentTimelineItem[] } {
  const users = Array.from({ length: 3 }, (_, index) => item(`user-${index}`, 'user_message'))
  const activity = Array.from({ length: 200 }, (_, index) => item(`old-${index}`))
  const recent = Array.from({ length: 31 }, (_, index) => item(`new-${index}`))
  const completed = recent.map((entry) => ({ ...entry, status: 'complete' as const, updatedAt: 20, toolOutput: `${body}done\n ` }))
  return {
    snapshot: [...users, ...activity],
    journal: [
      ...recent.map((entry): AgentTimelineMutation => ({ type: 'append', agentSessionId: ownerId, item: entry })),
      ...completed.map((entry): AgentTimelineMutation => ({ type: 'upsert', agentSessionId: ownerId, item: entry })),
      { type: 'upsert', agentSessionId: ownerId, item: { ...completed[30]!, createdAt: 25, updatedAt: 30 } }
    ],
    expected: [...users, ...activity.slice(31), ...completed]
  }
}

async function seed(snapshot: AgentTimelineItem[], journal: AgentTimelineMutation[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-timeline-cost-'))
  roots.push(root)
  const path = join(root, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(path)
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: ownerId, providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: '/synthetic', run: { runId: 'synthetic-run' }, retiredRuns: [],
    hookBindingId: 'synthetic-binding', hookToken: 'synthetic-token',
     createdAt: 1, updatedAt: 1
  }
  await store.compareAndSwap(null, session)
  const directory = join(root, 'agent-timelines')
  await mkdir(directory)
  const timelinePath = join(directory, `${createHash('sha256').update(ownerId).digest('base64url')}.jsonl`)
  const snapshotLine = JSON.stringify({ version: 3, agentSessionId: ownerId, revision: 100, items: snapshot })
  await writeFile(timelinePath, `${[snapshotLine, ...journal.map((entry) => JSON.stringify(entry))].join('\n')}\n`)
  return { path, store, timelinePath, snapshotLine }
}

async function throughClient(store: AgentMuxFileAgentSessionStore) {
  const client = new AgentMuxClient({ store })
  try {
    // Load the real Session registry; Timeline reading neither connects to nor operates a Run.
    await (client as unknown as { registry: { load(hostId: string): Promise<void> } }).registry.load('local')
    return await client.sessionTimeline(ownerId)
  } finally {
    await client.dispose()
  }
}

describe('File Timeline reconstruction cost and durable facts', () => {
  it('reads the real nonempty Client path with linear validation and no whole-array serialization', async () => {
    const fixture = capacityFixture()
    expect(fixture.snapshot).toHaveLength(203)
    expect(fixture.journal).toHaveLength(63)
    const { store } = await seed(fixture.snapshot, fixture.journal)
    const nativeTrim = String.prototype.trim
    const nativeStringify = JSON.stringify
    let titleValidations = 0
    let wholeArraySerializations = 0
    const trim = vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
      if (String(this) === title) titleValidations += 1
      return nativeTrim.call(this)
    })
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      if (Array.isArray(value) && value.length >= 150 && value[0]?.agentSessionId === ownerId) {
        wholeArraySerializations += 1
      }
      return nativeStringify(value, replacer as (string | number)[] | null | undefined, space)
    })
    let result
    try {
      result = await throughClient(store)
    } finally {
      trim.mockRestore()
      stringify.mockRestore()
    }
    expect(result).toEqual({ agentSessionId: ownerId, revision: 162, items: fixture.expected })
    expect(titleValidations).toBeGreaterThanOrEqual(266)
    expect(titleValidations).toBeLessThanOrEqual(2 * (203 + 63))
    expect(wholeArraySerializations).toBe(0)
  })

  it('keeps no-op bytes and revision, then appends one real update without altering earlier projections', async () => {
    const fixture = capacityFixture()
    const { store, path, timelinePath } = await seed(fixture.snapshot, fixture.journal)
    const prior = await throughClient(store)
    const bytes = await readFile(timelinePath)
    const metadata = await stat(timelinePath)
    const duplicate: AgentTimelineMutation = {
      type: 'upsert', agentSessionId: ownerId,
      item: { ...fixture.expected.at(-1)!, createdAt: 35, updatedAt: 40 }
    }
    const nativeStringify = JSON.stringify
    let wholeArraySerializations = 0
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      if (Array.isArray(value) && value.length >= 150 && value[0]?.agentSessionId === ownerId) {
        wholeArraySerializations += 1
      }
      return nativeStringify(value, replacer as (string | number)[] | null | undefined, space)
    })
    await expect(store.applyTimelineMutation(duplicate)).resolves.toMatchObject({ changed: false, revision: 162 })
    expect(await readFile(timelinePath)).toEqual(bytes)
    expect((await stat(timelinePath)).mtimeMs).toBe(metadata.mtimeMs)
    const mutation: AgentTimelineMutation = {
      type: 'update', agentSessionId: ownerId, itemId: 'new-30', updatedAt: 50,
      status: 'failed', toolOutput: '  exact final output\n  '
    }
    await expect(store.applyTimelineMutation(mutation)).resolves.toMatchObject({ changed: true, revision: 163 })
    stringify.mockRestore()
    expect(wholeArraySerializations).toBe(0)
    const expected = fixture.expected.map((entry) => entry.id === 'new-30'
      ? { ...entry, updatedAt: 50, status: 'failed' as const, toolOutput: '  exact final output\n  ' } : entry)
    expect(prior).toEqual({ agentSessionId: ownerId, revision: 162, items: fixture.expected })
    expect((await readFile(timelinePath, 'utf8')).split('\n').filter(Boolean)).toHaveLength(65)
    await expect(throughClient(new AgentMuxFileAgentSessionStore(path))).resolves.toEqual({
      agentSessionId: ownerId, revision: 163, items: expected
    })
  })

  it('compacts the existing journal boundary with the same exact projection and revision', async () => {
    const entry = item('retained')
    const duplicate: AgentTimelineMutation = { type: 'append', agentSessionId: ownerId, item: entry }
    const { store, path, timelinePath } = await seed([entry], Array.from({ length: 256 }, () => duplicate))
    await expect(store.applyTimelineMutation({
      type: 'update', agentSessionId: ownerId, itemId: entry.id, updatedAt: 15,
      status: 'complete', toolOutput: '  compaction result\n  '
    })).resolves.toMatchObject({ changed: true, revision: 101 })
    expect((await readFile(timelinePath, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
    await expect(new AgentMuxFileAgentSessionStore(path).loadTimeline(ownerId)).resolves.toEqual({
      agentSessionId: ownerId, revision: 101,
      items: [{ ...entry, updatedAt: 15, status: 'complete', toolOutput: '  compaction result\n  ' }]
    })
  })

  it('preserves prior reducer arrays, stale completion, timestamps and duplicate conflict semantics', () => {
    const initial = [item('target')]
    const original = structuredClone(initial)
    const changed = applyNormalizedTimelineMutation(initial, {
      type: 'upsert', agentSessionId: ownerId,
      item: { ...initial[0]!, createdAt: 15, updatedAt: 20, status: 'complete', toolOutput: '  done\n  ' }
    })
    expect(initial).toEqual(original)
    expect(changed).not.toBe(initial)
    expect(changed).toEqual([{ ...original[0]!, updatedAt: 20, status: 'complete', toolOutput: '  done\n  ' }])
    expect(applyNormalizedTimelineMutation(changed, {
      type: 'upsert', agentSessionId: ownerId, item: { ...changed[0]!, createdAt: 30, updatedAt: 30 }
    })).toBe(changed)
    expect(applyNormalizedTimelineMutation(changed, {
      type: 'upsert', agentSessionId: ownerId, item: { ...original[0]!, updatedAt: 15 }
    })).toBe(changed)
    expect(() => applyAgentTimelineMutation(changed, {
      type: 'append', agentSessionId: ownerId, item: { ...changed[0]!, title: 'conflicting identity' }
    })).toThrowError(expect.objectContaining({ code: 'AGENT_TIMELINE_ID_CONFLICT' }))
  })

  it('validates public input and every durable record, refusing middle corruption while retaining a torn final boundary', async () => {
    const entry = item('original')
    const append: AgentTimelineMutation = { type: 'append', agentSessionId: ownerId, item: entry }
    expect(() => applyAgentTimelineMutation([{ ...entry, kind: 'invalid' } as unknown as AgentTimelineItem], append))
      .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_TIMELINE' }))
    expect(() => applyAgentTimelineMutation([{ ...entry, agentSessionId: 'another-session' }], append))
      .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_TIMELINE' }))
    expect(() => normalizeAgentTimeline(ownerId, [{ ...entry, toolOutput: 'x'.repeat(128 * 1024) }]))
      .toThrowError(expect.objectContaining({ code: 'AGENT_TIMELINE_TOO_LARGE' }))
    expect(() => normalizeAgentTimeline(ownerId, [{ ...entry, agentSessionId: 'another-session' }]))
      .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_TIMELINE' }))
    const update: AgentTimelineMutation = {
      type: 'update', agentSessionId: ownerId, itemId: entry.id, updatedAt: 20, status: 'complete'
    }
    const { store, timelinePath, snapshotLine } = await seed([entry])
    await writeFile(timelinePath, `${snapshotLine}\n${JSON.stringify(update)}\n{"type":`)
    await expect(store.loadTimeline(ownerId)).resolves.toEqual({
      agentSessionId: ownerId, revision: 101, items: [{ ...entry, updatedAt: 20, status: 'complete' }]
    })
    await writeFile(timelinePath, `${snapshotLine}\n{"type":\n${JSON.stringify(update)}\n`)
    await expect(store.loadTimeline(ownerId))
      .rejects.toMatchObject({ code: 'INVALID_AGENT_TIMELINE_STORE' })
    const crossed = { ...update, agentSessionId: 'another-session' }
    await writeFile(timelinePath, `${snapshotLine}\n${JSON.stringify(crossed)}\n${JSON.stringify(update)}\n`)
    await expect(store.loadTimeline(ownerId))
      .rejects.toMatchObject({ code: 'INVALID_AGENT_TIMELINE_STORE' })
  })

  it('retains the public Client projection across a real second Node process', async () => {
    const fixture = capacityFixture()
    const { path, store } = await seed(fixture.snapshot, fixture.journal)
    const prior = await throughClient(store)
    const script = `
      import { createHash } from 'node:crypto';
      import { AgentMuxClient } from ${JSON.stringify(new URL('../dist/client.js', import.meta.url).href)};
      import { AgentMuxFileAgentSessionStore } from ${JSON.stringify(new URL('../dist/agent-session-store.js', import.meta.url).href)};
      const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(process.argv[1]) });
      try {
        await client.registry.load('local');
        const result = await client.sessionTimeline(process.argv[2]);
        console.log(JSON.stringify({ pid: process.pid, revision: result.revision, count: result.items.length,
          digest: createHash('sha256').update(JSON.stringify(result)).digest('hex') }));
      } finally { await client.dispose(); }
    `
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script, path, ownerId])
    const reopened = JSON.parse(stdout)
    expect(reopened.pid).not.toBe(process.pid)
    expect(prior).toEqual({ agentSessionId: ownerId, revision: 162, items: fixture.expected })
    expect(reopened).toMatchObject({ revision: 162, count: 203,
      digest: createHash('sha256').update(JSON.stringify(prior)).digest('hex') })
  })
})
