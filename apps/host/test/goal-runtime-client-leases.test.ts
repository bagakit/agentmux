import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentMuxAgentRuntimeStatus, AgentMuxClientEvent, AgentMuxClientEventListener } from '@agentmux/core'
import { createGoalRuntime, type GoalExecutionClient } from '../src/goal-runtime.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function eventClient(runId: string) {
  const listeners = new Set<AgentMuxClientEventListener>(), registered = new Set<AgentMuxClientEventListener>()
  const session = { hostId: 'local', agentSessionId: 'shared-session-id', providerId: 'codex',
    workspacePath: '/private-goal-workspace', run: { runId } } as AgentMuxAgentSession
  const client = {
    onEvent(listener: AgentMuxClientEventListener) {
      listeners.add(listener); registered.add(listener)
      return () => { listeners.delete(listener) }
    },
    agentSession(id: string) { expect(id).toBe(session.agentSessionId); return session },
    async statusAgent(id: string) {
      expect(id).toBe(session.agentSessionId)
      return { session, run: { runId, state: 'running' } } as AgentMuxAgentRuntimeStatus
    }
  } as unknown as GoalExecutionClient
  return { client, listeners, emit(type: 'agent-session' | 'process-state' = 'agent-session', afterDispose = false) {
    const event = type === 'agent-session' ? { type, session } : { type, run: { runId }, state: 'running' }
    for (const listener of afterDispose ? registered : listeners) listener(event as AgentMuxClientEvent)
  } }
}

function fixture() {
  const local = eventClient('local-run'), firstRemote = eventClient('remote-original-run'), replacement = eventClient('remote-replacement-run')
  let clients = [{ hostId: 'local', client: local.client }]
  const listeners = new Set<() => void>(), events: Array<[string, string]> = []
  const runtime = createGoalRuntime({ clients: () => clients,
    subscribeClients: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    checkIn: async () => ({ known: false, reason: 'No check-in is requested by these event readers.' }) })
  const dispose = runtime.observeCoreEvents(['agent-session'], (hostId, event) => {
    if (event.type === 'agent-session') events.push([hostId, event.session.run.runId])
  })
  cleanup.push(dispose)
  return { local, firstRemote, replacement, runtime, events, listeners, dispose,
    change(remotes: Array<{ hostId: string; client: GoalExecutionClient }>) {
      clients = [{ hostId: 'local', client: local.client }, ...remotes]
      for (const listener of listeners) listener()
    } }
}

it('subscribes a later original remote lease and keeps the same Session ID scoped to its Host', async () => {
  const f = fixture()
  expect(f.local.listeners.size).toBe(1); expect(f.firstRemote.listeners.size).toBe(0)
  f.local.emit()
  f.change([{ hostId: 'remote', client: f.firstRemote.client }]); f.firstRemote.emit()
  expect(f.events).toEqual([['local', 'local-run'], ['remote', 'remote-original-run']])
  expect((await f.runtime.observeGoalAgent('remote', 'shared-session-id')).session.run.runId).toBe('remote-original-run')
  expect((await f.runtime.observeGoalAgent('local', 'shared-session-id')).session.run.runId).toBe('local-run')
  await expect(f.runtime.resolveGoalAgent('shared-session-id')).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect((await f.runtime.resolveGoalAgent('shared-session-id', 'remote')).status.session.run.runId).toBe('remote-original-run')
  expect((await f.runtime.resolveGoalAgent('shared-session-id', 'local')).status.session.run.runId).toBe('local-run')
})

it('replaces the exact remote client observer and ignores a queued event from the released lease', async () => {
  const f = fixture()
  f.change([{ hostId: 'remote', client: f.firstRemote.client }])
  f.change([{ hostId: 'remote', client: f.replacement.client }])
  expect(f.firstRemote.listeners.size).toBe(0); expect(f.replacement.listeners.size).toBe(1)
  expect(f.local.listeners.size).toBe(1)
  f.firstRemote.emit('agent-session', true); f.replacement.emit(); f.local.emit('process-state')
  expect(f.events).toEqual([['remote', 'remote-replacement-run']])
  expect((await f.runtime.observeGoalAgent('remote', 'shared-session-id')).session.run.runId).toBe('remote-replacement-run')
})

it('keeps an ambiguous remote lease unknown while preserving the independent local observer', async () => {
  const f = fixture()
  f.change([{ hostId: 'remote', client: f.firstRemote.client }, { hostId: 'remote', client: f.replacement.client }])
  expect(f.firstRemote.listeners.size).toBe(0); expect(f.replacement.listeners.size).toBe(0)
  await expect(f.runtime.observeGoalAgent('remote', 'shared-session-id')).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  f.local.emit(); expect(f.events).toEqual([['local', 'local-run']])
  f.change([{ hostId: 'remote', client: f.firstRemote.client }]); f.firstRemote.emit()
  expect(f.events.at(-1)).toEqual(['remote', 'remote-original-run'])
})

it('releases removed leases and every observer when this Goal owner closes', async () => {
  const f = fixture()
  f.change([{ hostId: 'remote', client: f.firstRemote.client }]); f.change([])
  expect(f.firstRemote.listeners.size).toBe(0)
  await expect(f.runtime.observeGoalAgent('remote', 'shared-session-id')).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  f.dispose(); expect(f.local.listeners.size).toBe(0); expect(f.listeners.size).toBe(0)
  f.change([{ hostId: 'remote', client: f.firstRemote.client }])
  f.local.emit('agent-session', true); f.firstRemote.emit('agent-session', true)
  expect(f.events).toEqual([]); expect(f.firstRemote.listeners.size).toBe(0)
})

it('rejects a late creation inspection after the exact Host lease changes without borrowing the same local SID', async () => {
  const f = fixture()
  let release!: (value: AgentMuxAgentSession) => void
  const inspect = vi.fn(() => new Promise<AgentMuxAgentSession>(resolve => { release = resolve }))
  Object.assign(f.firstRemote.client, { inspectAgentCreation: inspect })
  f.change([{ hostId: 'remote', client: f.firstRemote.client }])
  const pending = f.runtime.agentCreation('remote', 'shared-session-id')
  f.change([{ hostId: 'remote', client: f.replacement.client }])
  release(f.firstRemote.client.agentSession('shared-session-id'))
  await expect(pending).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(inspect).toHaveBeenCalledExactlyOnceWith('shared-session-id')
  expect((await f.runtime.observeGoalAgent('local', 'shared-session-id')).session.run.runId).toBe('local-run')
  expect((await f.runtime.observeGoalAgent('remote', 'shared-session-id')).session.run.runId).toBe('remote-replacement-run')
})

it('a planning requester with the same Session ID on another Host neither impersonates nor blocks the retained Supervisor', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { openDemandStore } = await import('@agentmux/demand'), { GoalPatrolOwner } = await import('../src/goal-patrol-owner.js')
  const directory = await mkdtemp(join(tmpdir(), 'goal-planning-address-'))
  const f = fixture(); f.change([{ hostId: 'remote', client: f.firstRemote.client }])
  const demands = openDemandStore({ root: directory })
  const read = vi.fn(async () => { throw Error('Planning must not synchronize unrelated execution history') })
  const owner = new GoalPatrolOwner(demands, f.runtime, read, () => {})
  try {
    await seedStoredDemand(demands, { id: 'goal', title: 'Original outcome', supervisorSessionId: 'shared-session-id', assigneeSessionIds: ['shared-session-id'] })
    await demands.proposeAlignment('goal', { summary: 'Original outcome', criteria: [{ id: 'result', text: 'Check the original result' }], openQuestions: [] })
    await demands.revisePlan('goal', { operationId: 'original-remote-plan', expectedRevision: 0, alignmentRevision: 1,
      nodes: [{ id: 'deliver', title: 'Deliver', outcome: 'Original outcome', criterionIds: ['result'], dependsOn: [], check: 'check original', executor: null }] },
    { kind: 'agent', id: 'shared-session-id', hostId: 'remote' })
    await owner.request('goal', 'local-namesake-request', {}, { actor: { kind: 'agent', id: 'shared-session-id' }, hostId: 'local', runId: 'local-run' }, 'plan')
    const request = (await demands.get('goal'))!.patrols![0]!
    expect(request.attempts[0]!.target).toMatchObject({ hostId: 'remote', agentSessionId: 'shared-session-id', runId: 'remote-original-run' })
    expect(JSON.parse(request.context).requester).toMatchObject({ hostId: 'local', runId: 'local-run' })
    expect(read).not.toHaveBeenCalled()
  } finally { owner.dispose(); await rm(directory, { recursive: true, force: true }) }
})
