import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

async function fixture(kind: 'memory' | 'file') {
  const root = await mkdtemp(join(tmpdir(), 'sh-')), path = join(root, 'sessions.json')
  releases.push(() => rm(root, { recursive: true, force: true }))
  const store: AgentMuxAgentSessionStore = kind === 'file' ? new AgentMuxFileAgentSessionStore(path) : new AgentMuxMemoryAgentSessionStore()
  const newAgent = (agentSessionId: string): AgentMuxStoredAgentSession => ({
    kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: agentSessionId + '-run' }, retiredRuns: [], hookBindingId: agentSessionId + '-binding',
    hookToken: 'test bound secret', createdAt: 1, updatedAt: 1,
    futurePromptIntents: Object.fromEntries([base, updated, unpublished].map(definition => [definition.intentId, frozen(definition)]))
  })
  const input = async (session: AgentMuxStoredAgentSession, operationId: string, definition: typeof base, occurrenceAt: number, content = frozen(definition).message) => {
    const next: AgentMuxStoredAgentSession = { ...session, updatedAt: session.updatedAt + 1,
      promptCompletionAdmission: {
        submissionId: operationId, operationId, transport: 'pty', startByte: 0, endByte: 16, acknowledged: true,
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
  return { manager, source: sessions, tick, future, ownRead, loop, root, path, client, async corruptMessage() {
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

it('declines Agent and unknown principal before opening the original owner and keeps unavailable reads unknown', async () => {
  const f = await fixture('memory')
  for (const context of [undefined, { ...person, caller: { agentSessionId: f.loop.agentSessionId, capability: 'agent-only' } }]) {
    await expect(f.manager.call('schedule.history', scope, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
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
  await expect(command.parse([])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  expect(() => parseScheduleRpcParams('schedule.history', { ...scope, to: scope.from + 172_800_001 })).toThrow()
  expect(() => parseScheduleRpcParams('schedule.history', { ...scope, agentSessionId: 'foreign' })).toThrow()
  const page = { ...scope, executionScope: 'connected-host', coverage: 'recorded-inputs', entries: [], nextCursor: null }
  delete (page as Partial<typeof page>).limit
  expect(() => validateScheduleRpcResult('schedule.history', { ...page, scheduleId: 'different' }, scope)).toThrow()
  expect(() => validateScheduleRpcResult('schedule.history', { ...page, entries: [{ operationId: 'exact', occurrenceAt: scope.to, delivery: 'terminal-confirmed', nativeResult: { state: 'unknown' } }] }, scope)).toThrow()
})
