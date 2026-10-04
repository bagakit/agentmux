import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHost, TopicSearchRecord } from '@agentmux/core'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { TopicSearchHistoryOwner as SourceHistory } from '../src/main/topic-search-history'
import { TopicKnowledgeOwner as SourceOwner } from '../src/main/topic-knowledge'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { TopicSpatialOwner } from '../src/main/topic-spatial-owner'
import { FileReadOwner } from '../src/main/file-read-owner'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { WorkspaceRecord } from '../src/shared/contracts'

const History: typeof SourceHistory = process.env.AGENTMUX_TEST_TOPIC_SEARCH_HISTORY_SOURCE
  ? (await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_TOPIC_SEARCH_HISTORY_SOURCE).href)).TopicSearchHistoryOwner : SourceHistory
const Owner: typeof SourceOwner = process.env.AGENTMUX_TEST_TOPIC_SEARCH_OWNER_SOURCE
  ? (await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_TOPIC_SEARCH_OWNER_SOURCE).href)).TopicKnowledgeOwner : SourceOwner
const writerProbe = vi.hoisted(() => ({ fail: null as 'before' | 'after' | null }))
vi.mock('@agentmux/core', async importOriginal => {
  const original = await importOriginal<typeof import('@agentmux/core')>()
  return { ...original, durableWriteFile: async (...args: Parameters<typeof original.durableWriteFile>) => {
    if (writerProbe.fail === 'before') throw new original.DurableWriteError(args[0], 'before-replace', new Error('storage unavailable'))
    await original.durableWriteFile(...args)
    if (writerProbe.fail === 'after') throw new original.DurableWriteError(args[0], 'after-replace', new Error('directory ACK unavailable'))
  } }
})
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('Search history does not decode avatars.') } } }))
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); writerProbe.fail = null; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function directory() { const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-topic-search-history-'))); roots.push(root); return root }
function record(topicId: string | null = 'view:history', query = '磁盘'): TopicSearchRecord {
  return { searchId: randomUUID(), query, topicId, limit: 32, startedAt: 100, finishedAt: 125, durationMs: 25, outcome: 'complete',
    counters: { topicsVisited: 1, candidates: 1, readBytes: 20, chargedBytes: 20, unconfirmedReads: 0, entryMatches: 0, documentMatches: 1 },
    stopReason: null, issues: [], omittedIssueCount: 0 }
}
async function fixture(historyPath?: (root: string) => string, withHistory = true) {
  const root = await directory(), path = join(root, 'scratch'); await mkdir(path)
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path, kind: 'folder' }
  const scratch = new ScratchTopics(), files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost))
  const state = new AgentMuxSpatialStateStore(join(root, 'spatial.json')), history = new History(historyPath?.(root) ?? join(root, 'history.json'))
  const owner = new Owner(scratch, files, () => workspace, withHistory ? history : undefined)
  owner.setSpatialPort(new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => owner.listTopicSnapshots(),
    categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
  const publicFiles = new FileReadOwner({ files, workspace: id => id === workspace.id ? workspace : undefined,
    topicForDirectory: (w, path) => scratch.readForDirectory(w, path),
    catalog: async () => { const current = await state.read(); return current ? spatialCatalog(current.graph) : null } })
  owner.setFileReadPort(publicFiles)
  const { topic } = await owner.call('topic.create', { topicId: 'view:history', title: '历史测试' })
  await writeFile(join(topic.directoryPath, 'outcome', 'report.md'), '原始正文独有词：磁盘权限。不能进入查询回执的秘密正文。')
  return { root, scratch, files, owner, publicFiles, history, topic, workspace }
}

describe('durable bounded Topic query observations', () => {
  it('retains concurrent records across a fresh owner, with exact filters, truthful trimming and private permissions', async () => {
    const root = await directory(), path = join(root, 'history.json'), history = new History(path)
    const rows = Array.from({ length: 140 }, (_, index) => record(index % 2 ? 'view:other' : 'view:history', index % 3 ? '磁盘' : ' 磁盘 '))
    expect((await Promise.all(rows.map(row => history.record(row)))).every(result => result.history === 'saved')).toBe(true)
    const fresh = new History(path), all = await fresh.read({ limit: 100 })
    expect(all.records).toHaveLength(100); expect(all.hasMore).toBe(true)
    expect(all.retention).toEqual({ maxRecords: 128, maxBytes: 1048576, prunedRecords: 12 })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const scoped = await fresh.read({ topicId: 'view:history', query: ' 磁盘 ', limit: 100 })
    expect(scoped.records.length).toBeGreaterThan(0)
    expect(scoped.records.every(row => row.topicId === 'view:history' && row.query === ' 磁盘 ')).toBe(true)
    const exact = await fresh.read({ searchId: rows.at(-1)!.searchId })
    expect(exact.records).toEqual([rows.at(-1)!])
    expect(await fresh.read({ searchId: rows[0]!.searchId })).toMatchObject({ records: [], retention: { prunedRecords: 12 } })
    const global = record(null); await history.record(global)
    expect((await fresh.read({ topicId: 'view:history', limit: 100 })).records.some(row => row.searchId === global.searchId)).toBe(false)
  })
  it('bounds serialized bytes by pruning complete records rather than cutting query or issue identities', async () => {
    const root = await directory(), path = join(root, 'history.json'), history = new History(path)
    const rows = Array.from({ length: 10 }, () => ({ ...record(), outcome: 'partial' as const,
      issues: Array.from({ length: 32 }, () => ({ code: 'TOPIC_SCOPE_UNCONFIRMED', source: 's'.repeat(4096) })) }))
    for (const row of rows) expect((await history.record(row)).history).toBe('saved')
    const saved = await history.read({ limit: 100 })
    expect(saved.records.length).toBeGreaterThan(0); expect(saved.records.length).toBeLessThan(rows.length)
    expect((await stat(path)).size).toBeLessThanOrEqual(1048576)
    expect(saved.retention.prunedRecords).toBe(rows.length - saved.records.length)
    expect(saved.records[0]).toEqual(rows.at(-1))
  })
  it('keeps corrupt, oversized and symlink bytes intact, and retries after explicit repair', async () => {
    const root = await directory(), path = join(root, 'history.json'), history = new History(path), corrupt = '{"secret":"body must stay private"'
    await writeFile(path, corrupt)
    expect(await history.record(record())).toMatchObject({ history: 'unavailable', unavailable: [{ code: 'TOPIC_SEARCH_HISTORY_UNAVAILABLE' }] })
    expect(await readFile(path, 'utf8')).toBe(corrupt)
    expect(JSON.stringify(await history.read({}))).not.toContain('body must stay private')
    await writeFile(path, 'x'.repeat(1048577))
    expect((await history.record(record())).history).toBe('unavailable'); expect((await stat(path)).size).toBe(1048577)
    await rm(path); const original = join(root, 'original'); await writeFile(original, corrupt); await symlink(original, path)
    expect((await history.record(record())).history).toBe('unavailable'); expect(await readFile(original, 'utf8')).toBe(corrupt)
    await rm(path); const repaired = record()
    expect((await history.record(repaired)).history).toBe('saved'); expect((await history.read({})).records).toEqual([repaired])
  })
  it('reloads the actual replacement after an unconfirmed directory ACK instead of losing it to old cache', async () => {
    const root = await directory(), path = join(root, 'history.json'), history = new History(path), first = record(), uncertain = record(), later = record()
    expect((await history.record(first)).history).toBe('saved')
    writerProbe.fail = 'after'; expect((await history.record(uncertain)).history).toBe('unavailable')
    writerProbe.fail = null; expect((await history.record(later)).history).toBe('saved')
    expect((await new History(path).read({})).records).toEqual([later, uncertain, first])
  })
  it('records real original-file searches with confirmed costs, excludes bodies, and never logs listings', async () => {
    const f = await fixture(), costs: number[] = [], read = f.files.read.bind(f.files)
    vi.spyOn(f.files, 'read').mockImplementation((w, p, budget) => read(w, p, budget ? { ...budget,
      onReadCost: cost => { costs.push(cost.payloadBytes); budget.onReadCost?.(cost) } } : budget))
    await f.owner.call('topic.knowledge.ls', { topicId: f.topic.topicId })
    expect((await f.owner.call('topic.knowledge.history', {})).records).toEqual([])
    const found = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '磁盘' })
    expect(found.documents).toHaveLength(1); expect(found.unavailable).toEqual([])
    expect(found.observation).toMatchObject({ history: 'saved', unavailable: [], record: { topicId: f.topic.topicId, query: '磁盘', outcome: 'complete', stopReason: null,
      counters: { topicsVisited: 1, entryMatches: 0, documentMatches: 1, readBytes: costs.reduce((a, b) => a + b, 0), unconfirmedReads: 0 } } })
    expect(found.observation.record.counters.chargedBytes).toBe(found.observation.record.counters.readBytes)
    expect((await new History(join(f.root, 'history.json')).read({})).records).toEqual([found.observation.record])
    const persisted = await readFile(join(f.root, 'history.json'), 'utf8')
    expect(persisted).not.toContain('秘密正文'); expect(persisted).not.toContain('snippet'); expect(persisted).not.toContain('磁盘权限')
  })
  it('keeps healthy search results when history is absent or writing fails, then exposes a successful retry', async () => {
    const absent = await fixture(undefined, false), f = await fixture()
    for (const owner of [absent.owner, f.owner]) {
      writerProbe.fail = 'before'
      const result = await owner.call('topic.knowledge.search', { topicId: 'view:history', query: '磁盘' })
      expect(result.documents).toHaveLength(1); expect(result.unavailable).toEqual([])
      expect(result.observation).toMatchObject({ history: 'unavailable', record: { outcome: 'complete' }, unavailable: [{ code: 'TOPIC_SEARCH_HISTORY_UNAVAILABLE' }] })
    }
    writerProbe.fail = null
    const retried = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '磁盘' })
    expect(retried.observation.history).toBe('saved')
    expect((await f.owner.call('topic.knowledge.history', {})).records).toEqual([retried.observation.record])
  })
  it('records result, candidate, byte and deadline partial stops without calling conservative reservations measured reads', async () => {
    const f = await fixture()
    const limited = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '磁盘', limit: 1 })
    expect(limited.observation.record).toMatchObject({ outcome: 'partial', stopReason: 'result-limit', counters: { documentMatches: 1 } })
    const request = { zoneId: f.topic.zoneId, path: '.', limit: 512,
      expectedResource: { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.workspace.path } }, listing = await f.publicFiles.list(request)
    if (listing.result.status !== 'listed') throw Error('The original listing must exist')
    vi.spyOn(f.publicFiles, 'list').mockResolvedValue({ ...listing, result: { status: 'listed', files: Array.from({ length: 512 }, (_, index) => `ignored-${index}.bin`), complete: false, omitted: 'none', partialReason: 'limit' } })
    const candidates = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: 'nothing' })
    expect(candidates.observation.record).toMatchObject({ outcome: 'partial', stopReason: 'candidate-limit', counters: { candidates: 512, readBytes: 0 } })
    vi.restoreAllMocks()
    const originalRead = f.publicFiles.read.bind(f.publicFiles)
    vi.spyOn(f.publicFiles, 'read').mockImplementation((p, context) => {
      if (!context) return originalRead(p)
      const { onReadCost, ...unobserved } = context
      return originalRead(p, unobserved)
    })
    const unknown = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '磁盘' })
    expect(unknown.observation.record.counters.readBytes).toBe(0)
    expect(unknown.observation.record.counters.chargedBytes).toBeGreaterThan(0)
    expect(unknown.observation.record.counters.unconfirmedReads).toBeGreaterThan(0)
    for (let index = 0; index < 34; index++) await writeFile(join(f.topic.directoryPath, 'refs', `cost-${index}.md`), '不匹配的原始正文')
    const conservative = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: 'never-matches' })
    expect(conservative.observation.record).toMatchObject({ outcome: 'partial', stopReason: 'byte-limit',
      counters: { readBytes: 0, chargedBytes: 4194304, unconfirmedReads: 32 } })
    vi.restoreAllMocks()
    const deadline = new AbortController(); deadline.abort(new DOMException('Expired', 'TimeoutError'))
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const timed = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '磁盘' })
    expect(timed.observation.record).toMatchObject({ outcome: 'partial', stopReason: 'deadline', counters: { readBytes: 0 } })
  })
  it('does not count failed UUID entries as matches, bounds issue receipts and never persists parse-error excerpts', async () => {
    const f = await fixture(); await mkdir(join(f.topic.directoryPath, 'knowledge'))
    for (let index = 0; index < 40; index++) await writeFile(join(f.topic.directoryPath, 'knowledge', randomUUID() + '.json'), '{"secret":"must-never-enter-history"')
    const searched = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '磁盘', limit: 100 })
    expect(searched.entries).toHaveLength(40)
    expect(searched.observation.record).toMatchObject({ outcome: 'partial', counters: { entryMatches: 0, documentMatches: 1 }, omittedIssueCount: 8 })
    expect(searched.observation.record.issues).toHaveLength(32)
    expect(await readFile(join(f.root, 'history.json'), 'utf8')).not.toContain('must-never-enter-history')
    expect(searched.observation.history).toBe('saved')
  })
  it('keeps healthy results when cost callbacks are negative, nonfinite, fractional, oversized or duplicated', async () => {
    const f = await fixture(), originalRead = f.publicFiles.read.bind(f.publicFiles)
    for (const invalid of [-1, NaN, Infinity, 1.5, 131073, 'duplicate'] as const) {
      const spy = vi.spyOn(f.publicFiles, 'read').mockImplementation((p, context) => originalRead(p, context ? { ...context,
        onReadCost: cost => {
          if (invalid === 'duplicate') { context.onReadCost?.(cost); context.onReadCost?.(cost) }
          else context.onReadCost?.({ payloadBytes: invalid })
        }
      } : context))
      const searched = await f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '磁盘' })
      expect(searched.documents).toHaveLength(1); expect(searched.unavailable).toEqual([])
      expect(searched.observation).toMatchObject({ history: 'saved', record: { outcome: 'complete', counters: { readBytes: 0 } } })
      expect(searched.observation.record.counters.chargedBytes).toBe(spy.mock.calls.length * 131072)
      expect(searched.observation.record.counters.unconfirmedReads).toBe(spy.mock.calls.length)
      spy.mockRestore()
    }
  })
  it('keeps final cancelled, missing exact scope and Mote rejection facts while history remains readable without source rescans', async () => {
    const f = await fixture(), cancelled = new AbortController(); cancelled.abort()
    await expect(f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '取消查询' }, { signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const active = new AbortController(), originalRead = f.publicFiles.read.bind(f.publicFiles)
    const readSpy = vi.spyOn(f.publicFiles, 'read').mockImplementation(async (p, context) => { const result = await originalRead(p, context); active.abort(); return result })
    await expect(f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '读取后取消' }, { signal: active.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(readSpy).toHaveBeenCalledTimes(1); readSpy.mockRestore()
    await expect(f.owner.call('topic.knowledge.search', { topicId: 'view:missing', query: '不存在' })).rejects.toMatchObject({ code: 'TOPIC_NOT_FOUND' })
    const mote = await f.scratch.ensureMote(f.workspace, 'view:private-mote')
    await expect(f.owner.call('topic.knowledge.search', { topicId: mote.id, query: '私有请求' })).rejects.toMatchObject({ code: 'TOPIC_TARGET_IS_MOTE' })
    vi.spyOn(f.scratch, 'read').mockRejectedValue(new Error('Do not rescan sources to read history'))
    const history = await f.owner.call('topic.knowledge.history', {})
    expect(history.records).toHaveLength(4)
    expect(history.records.find(row => row.query === '取消查询')).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled', counters: { topicsVisited: 0, candidates: 0 } })
    expect(history.records.find(row => row.query === '读取后取消')).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled', counters: { topicsVisited: 1, candidates: 2, unconfirmedReads: 0 } })
    expect(history.records.find(row => row.query === '读取后取消')!.counters.readBytes).toBeGreaterThan(0)
    expect(history.records.find(row => row.query === '不存在')).toMatchObject({ topicId: 'view:missing', outcome: 'error', issues: [{ code: 'TOPIC_NOT_FOUND', source: 'view:missing' }] })
    expect(history.records.find(row => row.query === '私有请求')).toMatchObject({ topicId: mote.id, outcome: 'error', issues: [{ code: 'TOPIC_TARGET_IS_MOTE', source: mote.id }] })
  })
  it('preserves the original cancellation reason when a microtask cancels after real scan completion', async () => {
    const f = await fixture(), controller = new AbortController(), reason = new DOMException('Cancelled after scan', 'AbortError')
    const seam = f.owner as unknown as { collectKnowledge: (...args: unknown[]) => Promise<void> }
    const collect = seam.collectKnowledge.bind(f.owner)
    vi.spyOn(seam, 'collectKnowledge').mockImplementation(async (...args) => {
      await collect(...args)
      queueMicrotask(() => controller.abort(reason))
    })
    await expect(f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '磁盘' }, { signal: controller.signal })).rejects.toBe(reason)
    const history = await f.owner.call('topic.knowledge.history', { topicId: f.topic.topicId, query: '磁盘' })
    expect(history.records).toHaveLength(1)
    expect(history.records[0]).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled', counters: { documentMatches: 1 } })
    expect(history.records[0]!.counters.readBytes).toBeGreaterThan(0)
  })
  it('preserves late caller cancellation after durable recording without rewriting completed scan facts', async () => {
    const f = await fixture(), controller = new AbortController(), reason = new DOMException('Cancelled during history save', 'AbortError')
    const save = f.history.record.bind(f.history)
    vi.spyOn(f.history, 'record').mockImplementation(async row => {
      const observation = await save(row)
      controller.abort(reason)
      return observation
    })
    await expect(f.owner.call('topic.knowledge.search', { topicId: f.topic.topicId, query: '磁盘' }, { signal: controller.signal })).rejects.toBe(reason)
    const history = await f.owner.call('topic.knowledge.history', { topicId: f.topic.topicId, query: '磁盘' })
    expect(history.records).toHaveLength(1)
    expect(history.records[0]).toMatchObject({ outcome: 'complete', stopReason: null, counters: { documentMatches: 1 } })
    expect(history.records[0]!.counters.readBytes).toBeGreaterThan(0)
  })

})
