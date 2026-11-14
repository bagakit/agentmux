import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { AGENTMUX_SCHEDULE_CLI_COMMANDS } from '../src/schedule-cli.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import type { ContinuousProgressLoop } from '../src/continuous-progress-scheduler.js'
import type { AgentFuturePromptIntent, AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentMuxRpcCallContext } from '../src/public-rpc-service.js'
import { parseScheduleRpcParams, validateScheduleRpcResult, type ScheduleHistoryQuery } from '../src/public-rpc-schedules.js'
import { ContinuousProgressLoopManager } from '../../../apps/host/src/continuous-progress-loop-manager.js'
import { createGoalRuntime } from '../../../apps/host/src/goal-runtime.js'
import { readOriginalScheduledHistory } from '../../../apps/host/src/scheduled-input-source.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const releases: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })
const person: AgentMuxRpcCallContext = { principal: { kind: 'user', id: 'original-user' } }
const source = { sourceId: 'original-mote', revision: 'original-role' }
const scope = { scheduleId: 'heartbeat-row', from: 60_000, to: 240_000, limit: 1 } satisfies ScheduleHistoryQuery
const base = { intentId: 'initial-schedule-definition', operationId: 'schedule-create' }
const updated = { intentId: 'published-guidance', operationId: 'schedule-adopt', baseIntentId: base.intentId, guidanceRevision: 'guidance' }
const unpublished = { ...updated, intentId: 'unpublished-guidance', operationId: 'prepared-adoption' }

function frozen(definition: typeof base): AgentFuturePromptIntent {
  const prompt = definition.intentId === base.intentId ? 'Original daily review' : 'Updated daily review'
  return { operationId: definition.operationId, active: false, continuitySource: source, prompt,
    message: { userContent: prompt, systemContext: 'private definition ' + definition.operationId } }
}

async function fixture(kind: 'memory' | 'file', initialPrompt?: string) {
  const definitionFor = (definition: typeof base) => {
    const original = frozen(definition)
    if (initialPrompt !== undefined && definition.intentId === base.intentId) {
      original.prompt = initialPrompt
      original.message.userContent = initialPrompt
    }
    return original
  }
  const root = await mkdtemp(join(tmpdir(), 'sh-')), path = join(root, 'sessions.json')
  releases.push(() => rm(root, { recursive: true, force: true }))
  const store: AgentMuxAgentSessionStore = kind === 'file' ? new AgentMuxFileAgentSessionStore(path) : new AgentMuxMemoryAgentSessionStore()
  const newAgent = (agentSessionId: string): AgentMuxStoredAgentSession => ({
    kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: agentSessionId + '-run' }, retiredRuns: [], hookBindingId: agentSessionId + '-binding',
    hookToken: 'test bound secret', createdAt: 1, updatedAt: 1,
    futurePromptIntents: Object.fromEntries([base, updated, unpublished].map(definition => [definition.intentId, definitionFor(definition)]))
  })
  const input = async (session: AgentMuxStoredAgentSession, operationId: string, definition: typeof base, occurrenceAt: number, content = definitionFor(definition).message, acknowledged = true) => {
    const next: AgentMuxStoredAgentSession = { ...session, updatedAt: session.updatedAt + 1,
      promptCompletionAdmission: {
        submissionId: operationId, operationId, transport: 'pty', startByte: 0, endByte: 16, acknowledged,
        inputKey: { kind: 'prompt', agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: operationId },
        futureIntent: { intentId: definition.intentId, occurrenceAt },
        intent: { run: session.run, ownerInstanceId: 'private input owner', prompt: 'private input prompt',
          plan: { kind: 'single-phase', data: 'private input\r' }, message: content }
      } }
    await store.compareAndSwapMetadata(session, next)
    return (await store.readMetadata(session.agentSessionId))!
  }
  await store.compareAndSwap(null, newAgent('selected-session'))
  await store.compareAndSwap(null, newAgent('foreign-session'))
  const first = (await store.readMetadata('selected-session'))!, foreign = (await store.readMetadata('foreign-session'))!
  let current = await input(first, 'previous-run-input', base, scope.from)
  const replaced: AgentMuxStoredAgentSession = { ...current, run: { runId: 'continuation-run' }, retiredRuns: [current.run], updatedAt: current.updatedAt + 1 }
  delete replaced.promptCompletionAdmission
  await store.compareAndSwapMetadata(current, replaced)
  current = await input((await store.readMetadata(replaced.agentSessionId))!, 'current-run-input', updated, 120_000)
  current = await input(current, 'pending-guidance-input', unpublished, 200_000)
  current = await input(current, 'right-exclusive-input', updated, scope.to)
  await input(foreign, 'foreign-input', updated, 210_000)
  const client = new AgentMuxClient({ store: kind === 'file' ? new AgentMuxFileAgentSessionStore(path) : store })
  releases.push(() => client.dispose())
  const loop: ContinuousProgressLoop = {
    loopId: scope.scheduleId, agentSessionId: first.agentSessionId, hostId: 'local', providerId: first.providerId, workspacePath: root,
    prompt: 'private schedule prompt', intervalMs: 60_000, everyMs: 60_000, nextCheckAt: 60_000, status: 'stopped', revision: 4,
    managedSource: source, futureIntentId: updated.intentId, creationOperationId: base.operationId, currentDefinition: updated,
    guidanceAdoptions: [
      { operationId: updated.operationId, expectedRevision: 2, requestDigest: 'a'.repeat(64), actor: person.principal!, oldDefinition: base,
        newDefinition: updated, guidance: 'updated guidance', preparedAt: 30_000, publishedAt: 30_001, state: 'adopted', issue: null },
      { operationId: unpublished.operationId, expectedRevision: 4, requestDigest: 'b'.repeat(64), actor: person.principal!, oldDefinition: { intentId: updated.intentId, operationId: updated.operationId },
        newDefinition: unpublished, guidance: 'unpublished guidance', preparedAt: 45_000, state: 'prepared', issue: null }
    ]
  }
  const sessions = { load: vi.fn(async () => [loop]), save: vi.fn(async () => {}) }
  const runtime = createGoalRuntime({ clients: () => [{ hostId: loop.hostId, client }],
    checkIn: async () => { throw Error('History never reads live check-in state.') } })
  const tick = vi.fn(async () => 'sent' as const), future = vi.spyOn(runtime, 'saveFutureIntent')
  const ownRead = vi.spyOn(runtime, 'readHistory')
  const manager = new ContinuousProgressLoopManager(sessions as never, tick, () => 180_000,
    async () => { throw Error('History never probes Runtime activity.') }, runtime)
  releases.push(() => manager.stop())
  return { manager, source: sessions, tick, future, ownRead, loop, root, path, client, async recordMinuteInputs(from: number, count: number) {
    for (let index = 0; index < count; index++) current = await input(current, 'minute-' + index, updated, from + index * 60_000)
  }, async addSummaryInputs() {
    current = await input(current, 'second-confirmed', updated, 140_000)
    current = await input(current, 'unconfirmed-delivery', updated, 141_000, frozen(updated).message, false)
  }, async corruptMessage() {
    await input(current, 'mismatched-frozen-input', updated, 190_000, { userContent: 'a different producer', systemContext: 'private context' })
  } }
}

it.each(['memory', 'file'] as const)('%s Host schedule history reads earlier input across Runs and excludes unrelated candidates', async kind => {
  const f = await fixture(kind)
  await expect(f.manager.call('schedule.history', scope, person)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.source.load).not.toHaveBeenCalled()
  await f.manager.start()
  f.source.save.mockClear()
  const socketPath = join(f.root, 'schedule.sock')
  const server = new AgentMuxControlServer({ socketPath, schedules: f.manager })
  await server.start()
  releases.push(() => server.stop())
  const endpoint = { transport: 'unix' as const, path: server.path }
  const rpc = await connectAgentMuxRpc({ endpoint })
  releases.push(() => rpc.dispose())
  const first = await rpc.call('schedule.history', scope)
  expect(first).toEqual({ scheduleId: scope.scheduleId, from: scope.from, to: scope.to, executionScope: 'connected-host',
    coverage: 'recorded-inputs', entries: [{ operationId: 'current-run-input', occurrenceAt: 120_000, runId: 'continuation-run', recap: { text: 'Updated daily review', truncated: false }, delivery: 'terminal-confirmed', nativeResult: { state: 'unsupported' } }],
    nextCursor: expect.any(String) })
  const previous = await rpc.call('schedule.history', { ...scope, cursor: first.nextCursor! })
  expect(previous).toMatchObject({ entries: [{ operationId: 'previous-run-input', occurrenceAt: scope.from, runId: 'selected-session-run', recap: { text: 'Original daily review', truncated: false }, delivery: 'terminal-confirmed' }], nextCursor: null })
  for (const invalidScope of [{ ...scope, from: scope.from + 1 }, { ...scope, to: scope.to + 1 }])
    await expect(rpc.call('schedule.history', { ...invalidScope, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(rpc.call('schedule.history', { ...scope, scheduleId: 'another-schedule' })).rejects.toMatchObject({ code: 'UNKNOWN_SCHEDULE' })
  const empty = await rpc.call('schedule.history', { ...scope, from: scope.from + 1, to: 120_000 })
  expect(empty).toMatchObject({ coverage: 'recorded-inputs', entries: [], nextCursor: null })
  await f.corruptMessage()
  const partial = await rpc.call('schedule.history', { ...scope, limit: 3 })
  expect(partial).toMatchObject({ coverage: 'unconfirmed', entries: [{ operationId: 'current-run-input' }, { operationId: 'previous-run-input' }] })
  expect(JSON.stringify(partial)).not.toContain('private')
  expect(f.manager.inspectLoop(scope.scheduleId)).toEqual(f.loop)
  expect(f.source.save).not.toHaveBeenCalled()
  expect(f.tick).not.toHaveBeenCalled()
  expect(f.future).not.toHaveBeenCalled()
  if (process.env.AGENTMUX_TEST_OBJECT_CLI) {
    const cli = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'schedule', 'history', '--data', '-'],
      objectCliEnvironment(f.root, { AGENTMUX_TEST_OBJECT_CLI: process.env.AGENTMUX_TEST_OBJECT_CLI }), JSON.stringify({ ...scope, limit: 3 }))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, operation: 'schedule.history', result: partial })
  }
})

it.each(['memory', 'file'] as const)('%s public history summarizes only the same recorded inputs shown in a period', async kind => {
  const f = await fixture(kind)
  await f.manager.start()
  await f.addSummaryInputs()
  const endpoint = { transport: 'unix' as const, path: join(f.root, 'summary.sock') }
  const server = new AgentMuxControlServer({ socketPath: endpoint.path, schedules: f.manager })
  await server.start()
  releases.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint })
  releases.push(() => rpc.dispose())
  const query = { scheduleId: scope.scheduleId, from: scope.from, to: scope.to, bucketStarts: [scope.from, 120_000, 160_000] }
  const summary = await rpc.call('schedule.history', query)
  const sent = { delivery: 'terminal-confirmed', nativeState: 'unsupported' }
  expect(summary).toEqual({ executionScope: 'connected-host', scheduleId: query.scheduleId, from: query.from, to: query.to,
    coverage: 'recorded-inputs', entries: [], nextCursor: null, buckets: [
      { from: scope.from, to: 120_000, groups: [{ ...sent, firstAt: scope.from, lastAt: scope.from, count: 1, originalLabel: 'Original daily review' }] },
      { from: 120_000, to: 160_000, groups: [
        { delivery: 'unconfirmed', nativeState: 'unsupported', firstAt: 141_000, lastAt: 141_000, count: 1, originalLabel: 'Updated daily review' },
        { ...sent, firstAt: 120_000, lastAt: 140_000, count: 2, originalLabel: 'Updated daily review' }
      ] }
    ] })
  const acrossRevisions = await rpc.call('schedule.history', { ...query, bucketStarts: [scope.from] })
  expect(acrossRevisions.buckets![0]!.groups.find(group => group.delivery === 'terminal-confirmed')).toMatchObject({ count: 3, originalLabel: null })
  expect(JSON.stringify(acrossRevisions)).not.toContain(f.loop.prompt)
  const original = await rpc.call('schedule.history', { scheduleId: query.scheduleId, from: 120_000, to: 160_000 })
  expect(original.entries.map(row => row.occurrenceAt)).toEqual([141_000, 140_000, 120_000])
  const first = await rpc.call('schedule.history', { ...query, limit: 2 })
  expect(first.buckets!.map(bucket => bucket.from)).toEqual([120_000])
  expect(first.nextCursor).toEqual(expect.any(String))
  const second = await rpc.call('schedule.history', { ...query, cursor: first.nextCursor!, limit: 2 })
  expect(second.nextCursor).toBeNull()
  expect(second.buckets!.map(bucket => bucket.groups.map(group => group.firstAt))).toEqual([[scope.from], [120_000]])
  for (const other of [undefined, [scope.from, 130_000]]) {
    const different: ScheduleHistoryQuery = { scheduleId: query.scheduleId, from: query.from, to: query.to, cursor: first.nextCursor! }
    if (other) different.bucketStarts = other
    await expect(rpc.call('schedule.history', different)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  }
  await f.corruptMessage()
  const partial = await rpc.call('schedule.history', query)
  expect(partial).toEqual({ ...summary, coverage: 'unconfirmed' })
  if (process.env.AGENTMUX_TEST_OBJECT_CLI) {
    const cli = await runCompiledObjectCli(['--endpoint', `unix:${endpoint.path}`, 'schedule', 'history', '--data', '-'],
      objectCliEnvironment(f.root, { AGENTMUX_TEST_OBJECT_CLI: process.env.AGENTMUX_TEST_OBJECT_CLI }), JSON.stringify(query))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result).toEqual(partial)
  }
})

it('one-minute inputs across a day return exact hourly totals in bounded pages', async () => {
  const f = await fixture('memory')
  const from = scope.to + 60_000
  const hours = Array.from({ length: 24 }, (_, hour) => from + hour * 3_600_000)
  await f.recordMinuteInputs(from, 1440)
  await f.manager.start()
  const query: ScheduleHistoryQuery = { scheduleId: scope.scheduleId, from, to: from + 86_400_000, bucketStarts: hours }
  const counts = new Map<number, number>()
  let pages = 0
  do {
    const page = await f.manager.call('schedule.history', query, person)
    expect(page.coverage).toBe('recorded-inputs')
    expect(page.entries).toEqual([])
    let occurrences = 0
    for (const bucket of page.buckets!) {
      expect(bucket.groups).toHaveLength(1)
      const count = bucket.groups[0]!.count
      counts.set(bucket.from, (counts.get(bucket.from) ?? 0) + count)
      occurrences += count
    }
    expect(occurrences).toBe(page.nextCursor ? 256 : 160)
    pages++
    if (page.nextCursor) query.cursor = page.nextCursor
    else delete query.cursor
  } while (query.cursor && pages < 7)
  expect(pages).toBe(6)
  expect(hours.map(hour => counts.get(hour))).toEqual(Array(24).fill(60))
})

it('bucket labels preserve just a bounded first line of the original input across later edits', async () => {
  const expected = 'a'.repeat(79)
  const f = await fixture('memory', '\n  ' + expected + '🪴 original instruction\nAdditional details')
  const page = await readOriginalScheduledHistory(f.loop, { ...scope, to: 120_000, bucketStarts: [scope.from] }, f.client)
  expect(page.buckets?.[0]?.groups[0]?.originalLabel).toBe(expected)
  expect(page.entries).toEqual([])
  const serialized = JSON.stringify(page)
  for (const privateText of ['Additional details', 'original instruction', 'private definition', f.loop.prompt])
    expect(serialized).not.toContain(privateText)
})

it('each SQLite summary page seeks the original definition range and loads bodies only after selecting positions', async () => {
  const f = await fixture('file')
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
  let sql: string | undefined
  try {
    const query = { ...scope, bucketStarts: [scope.from] }
    const page = await readOriginalScheduledHistory(f.loop, query, f.client)
    await readOriginalScheduledHistory(f.loop, { ...query, cursor: page.nextCursor! }, f.client)
    sql = prepare.mock.calls.map(([statement]) => statement).find(statement => statement.includes('AS occurrence') && statement.includes('<(?,?,?)'))
  } finally { prepare.mockRestore() }
  expect(sql).toBeDefined()
  const db = new DatabaseSync(f.path, { readOnly: true })
  try {
    const plans = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(f.loop.agentSessionId, base.intentId, scope.from, scope.to, 120_000, 'original', 'key', 2)
    expect(plans.map(row => row.detail)).toEqual([expect.stringMatching(/SEARCH prompt_admissions USING (?:COVERING )?INDEX scheduled_input_occurrence/)])
  } finally { db.close() }
})

it('a failed optional index upgrade preserves the actual write and recovers on the next write', async () => {
  const f = await fixture('file')
  const previous = new DatabaseSync(f.path)
  previous.exec('DROP INDEX scheduled_input_occurrence')
  previous.close()
  const exec = DatabaseSync.prototype.exec
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
  const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql.startsWith('CREATE INDEX IF NOT EXISTS scheduled_input_occurrence')) throw Error('SQLITE_FULL')
    return exec.call(this, sql)
  })
  const query = { ...scope, limit: 16, bucketStarts: [scope.from] }
  try {
    await f.addSummaryInputs()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('SQLITE_FULL'), { code: 'SCHEDULE_HISTORY_INDEX_UNAVAILABLE' })
    const after = await readOriginalScheduledHistory(f.loop, query, f.client)
    expect(after.coverage).toBe('recorded-inputs')
    expect(after.buckets![0]!.groups.reduce((total, group) => total + group.count, 0)).toBe(4)
  } finally { fault.mockRestore(); warning.mockRestore() }
  await f.corruptMessage()
  const db = new DatabaseSync(f.path, { readOnly: true })
  try { expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='scheduled_input_occurrence'").get()).toBeTruthy() }
  finally { db.close() }
})

it('declines Agent and unknown principal before opening the original owner and keeps unavailable reads unknown', async () => {
  const f = await fixture('memory')
  for (const context of [undefined, { ...person, caller: { agentSessionId: f.loop.agentSessionId, capability: 'agent-only' } }]) {
    for (const query of [scope, { ...scope, bucketStarts: [scope.from] }])
      await expect(f.manager.call('schedule.history', query, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  }
  expect(f.ownRead).not.toHaveBeenCalled()
  expect(f.source.load).not.toHaveBeenCalled()
  await f.manager.start()
  f.ownRead.mockRejectedValueOnce(new Error('Disconnected original Session Store'))
  expect(await f.manager.call('schedule.history', scope, person)).toMatchObject({ coverage: 'unconfirmed', entries: [], nextCursor: null })
})

it('a committed SQLite read creates no file or schema and preserves the exact stored bytes', async () => {
  const f = await fixture('file')
  const before = await readFile(f.path), directory = await readdir(f.root)
  const read = await readOriginalScheduledHistory(f.loop, scope, f.client)
  expect(read.coverage).toBe('recorded-inputs')
  expect(await readFile(f.path)).toEqual(before)
  expect(await readdir(f.root)).toEqual(directory)
})

it('history CLI discovery and the strict result codec preserve the exact selectable scope', async () => {
  const command = AGENTMUX_SCHEDULE_CLI_COMMANDS['schedule history']!
  expect(command.method).toBe('schedule.history')
  expect(command.details).toContain('original nextCursor')
  expect(command.details).toContain('bucketStarts')
  await expect(command.parse([])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  expect(() => parseScheduleRpcParams('schedule.history', { ...scope, to: scope.from + 172_800_001 })).toThrow()
  expect(() => parseScheduleRpcParams('schedule.history', { ...scope, agentSessionId: 'foreign' })).toThrow()
  const page = { ...scope, executionScope: 'connected-host', coverage: 'recorded-inputs', entries: [], nextCursor: null }
  delete (page as Partial<typeof page>).limit
  const query = { ...scope, bucketStarts: [scope.from] }
  for (const starts of [[], [0], [scope.from, scope.to], [scope.from, scope.from], [scope.from, NaN]])
    expect(() => parseScheduleRpcParams('schedule.history', { ...scope, bucketStarts: starts })).toThrow()
  expect(() => parseScheduleRpcParams('schedule.history', { ...query, to: scope.from + 44 * 86_400_000 })).toThrow()
  expect(() => validateScheduleRpcResult('schedule.history', page, query)).toThrow()
  expect(() => validateScheduleRpcResult('schedule.history', { ...page, buckets: [] }, scope)).toThrow()
  const group = { delivery: 'terminal-confirmed', nativeState: 'unsupported', count: 1, originalLabel: 'Original daily review', firstAt: scope.from, lastAt: scope.from }
  const bucket = { from: scope.from, to: scope.to, groups: [group] }
  for (const bad of [{ ...bucket, from: scope.from + 1 }, { ...bucket, groups: [group, group] }, { ...bucket, groups: [{ ...group, nativeState: 'completed' }] }])
    expect(() => validateScheduleRpcResult('schedule.history', { ...page, buckets: [bad] }, query)).toThrow()
  expect(() => validateScheduleRpcResult('schedule.history', { ...page, scheduleId: 'different' }, scope)).toThrow()
  expect(() => validateScheduleRpcResult('schedule.history', { ...page, entries: [{ operationId: 'exact', occurrenceAt: scope.to, delivery: 'terminal-confirmed', nativeResult: { state: 'unknown' } }] }, scope)).toThrow()
})
