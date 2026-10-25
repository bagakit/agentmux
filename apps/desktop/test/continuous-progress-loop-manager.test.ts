import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { AGENTMUX_AGENT_MESSAGING_ENTRY, observeAgent } from '@agentmux/core'
import { parseAgentProgressParams } from '../../../packages/core/src/agent-progress.js'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ContinuousProgressLoopStore } from '@agentmux/host/continuous-progress-loop-store'
import { ContinuousProgressLoopManager } from '@agentmux/host/continuous-progress-loop-manager'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


describe('ContinuousProgressLoopManager', () => {
  it.each([1, 100, 1000])('checks its real scheduler without copying %i unrelated saved prompts', async (count) => {
    const dir = await mkdtemp(join(_hygiene_fixturePath('tmp'), 'agentmux-idle-clock-'))
    const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
    const onTick = vi.fn(async () => 'sent' as const)
    const observe = vi.fn(observedDone)
    const manager = new ContinuousProgressLoopManager(store, onTick, () => 100, observe)
    let restoreClone: (() => void) | undefined
    try {
      await store.save(Array.from({ length: count }, (_, n) => ({ loopId: `idle-${n}`, hostId: 'local',
        agentSessionId: `a-${n}`, providerId: 'codex', workspacePath: _hygiene_fixturePath('w'), intervalMs: 10,
        prompt: 'Retained prompt '.repeat(128), nextCheckAt: _historyFixtureEpoch(0, 1, 0),
        status: (['paused', 'stopped', 'active'] as const)[n % 3]! })))
      await manager.start()
      const clone = vi.spyOn(globalThis, 'structuredClone')
      restoreClone = () => clone.mockRestore()
      await manager.check(100)
      await manager.check(101)
      expect(clone).not.toHaveBeenCalled()
      expect(observe).not.toHaveBeenCalled()
      expect(onTick).not.toHaveBeenCalled()
      expect((await store.load()).map(loop => loop.loopId)).toEqual(Array.from({ length: count }, (_, n) => `idle-${n}`))
    } finally {
      restoreClone?.()
      await manager.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('claims a completed turn once without screen readiness, including after restart', async () => {
    const dir = await mkdtemp(join(_hygiene_fixturePath("tmp"), 'agentmux-completion-'))
    const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
    let now = _historyFixtureEpoch(0, 0, 0), completedAt = _historyFixtureEpoch(0, 0, 1), calls = 0
    const observe = async (_loop: unknown, tickId: string) => ({
      session: { agentSessionId: 'a', hostId: 'local', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"),
        run: { runId: 'r' }, semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: completedAt } },
      inputByte: 0, inputOccupied: false, observation: observeAgent({ process: 'running', status: { state: 'done', source: 'native-hook', observedAt: completedAt }, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now),
      tickId, now
    })
    const send = async () => {
      expect((await store.load())[0]?.pendingCompletion).toMatchObject({
        id: JSON.stringify(['r', completedAt]), prompt: 'next', agentMuxNote: AGENTMUX_AGENT_MESSAGING_ENTRY
      })
      calls++
      return 'sent' as const
    }
    const manager = new ContinuousProgressLoopManager(store, send, () => now, observe)
    const restarted = new ContinuousProgressLoopManager(store, send, () => now, observe)
    try {
      await store.save([{ loopId: 'l', hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"), intervalMs: 10, prompt: 'next', nextCheckAt: _historyFixtureEpoch(0, 0, 0), status: 'active' }])
      await manager.start(); await manager.check()
      expect(calls).toBe(1)
      now = _historyFixtureEpoch(0, 0, 10); await manager.check(); expect(calls).toBe(1)
      await manager.stop(); await restarted.start()
      now = _historyFixtureEpoch(0, 0, 20); await restarted.check(); expect(calls).toBe(1)
      completedAt = _historyFixtureEpoch(0, 0, 2); now = _historyFixtureEpoch(0, 0, 30); await restarted.check(); expect(calls).toBe(2)
    } finally {
      await manager.stop(); await restarted.stop(); await rm(dir, { recursive: true, force: true })
    }
  })
  it('loads durable loops and never retries an unknown tick', async () => {
    const dir = await mkdtemp(join(_hygiene_fixturePath("tmp"), 'agentmux-manager-')); const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
    let now = _historyFixtureEpoch(0, 0, 0); let calls = 0
    const seed = new ContinuousProgressLoopManager(store, async () => 'unknown', () => now, observedDone)
    // seed through the public scheduler-independent store contract
    await store.save([{ loopId: 'l', hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"), intervalMs: 10, prompt: 'x', nextCheckAt: _historyFixtureEpoch(0, 0, 0), status: 'active' }])
    const manager = new ContinuousProgressLoopManager(store, async () => { calls++; return 'unknown' }, () => now, observedDone)
    await manager.start(); await manager.check(now); await manager.check(now)
    expect(calls).toBe(1); await manager.stop(); await seed.stop(); await rm(dir, { recursive: true, force: true })
  })
})

  it('persists the claim before a slow handler and pauses unknown outcomes', async () => {
    const dir = await mkdtemp(join(_hygiene_fixturePath("tmp"), 'agentmux-manager-')); const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
    let now = _historyFixtureEpoch(0, 0, 0); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve })
    let didEnter!: () => void; const entered = new Promise<void>((resolve) => { didEnter = resolve })
    const manager = new ContinuousProgressLoopManager(store, async () => { didEnter(); await gate; return 'unknown' }, () => now, observedDone)
    await store.save([{ loopId: 'l', hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"), intervalMs: 10, prompt: 'x', nextCheckAt: _historyFixtureEpoch(0, 0, 0), status: 'active' }])
    await manager.start(); const pending = manager.check(now)
    await entered
    const persisted = await store.load(); expect(persisted[0]?.lastTickId).toBeTruthy(); expect(persisted[0]?.nextCheckAt).toBe(10)
    now = _historyFixtureEpoch(0, 0, 100); const concurrent = manager.check(now); expect(concurrent).toBeInstanceOf(Promise); release(); await pending; await concurrent
    expect(manager.list()[0]?.status).toBe('paused'); expect(manager.list()[0]?.lastOutcome).toBe('unknown')
    await manager.stop(); await rm(dir, { recursive: true, force: true })
  })

const observedDone = async (_loop: unknown, tickId: string) => ({
  session: { agentSessionId: 'a', hostId: 'local', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"),
    run: { runId: 'r' }, semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: _historyFixtureEpoch(0, 0, 1) } },
  inputByte: 0, inputOccupied: false, observation: observeAgent({ process: 'running', status: { state: 'done', source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 1) }, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, _historyFixtureEpoch(0, 0, 0)),
  tickId, now: _historyFixtureEpoch(0, 0, 0)
})
it('restores an interrupted claim as unknown and resumes using the original operation identity', async () => {
  const dir = await mkdtemp(join(_hygiene_fixturePath("tmp"), 'agentmux-interrupted-loop-'))
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  const operations: string[] = []
  let now = _historyFixtureEpoch(0, 0, 0)
  const manager = new ContinuousProgressLoopManager(store, async (_loop, operationId) => {
    operations.push(operationId)
    if (operations.length === 1) throw new Error('connection unavailable before confirmation')
    return 'sent'
  }, () => now, observedDone)
  try {
    await store.save([{ loopId: 'l', hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"), intervalMs: 10, prompt: 'next', nextCheckAt: _historyFixtureEpoch(0, 0, 0),
      status: 'active', pendingCompletion: { inputByte: 0, id: '["r",1]', operationId: 'original-operation' } }])
    await manager.start(); await manager.check()
    expect(manager.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
    expect(operations).toEqual([])
    await manager.resume('l'); now = _historyFixtureEpoch(0, 0, 10); await manager.check()
    expect(manager.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
    await manager.resume('l'); now = _historyFixtureEpoch(0, 0, 20); await manager.check()
    expect(operations).toEqual(['original-operation', 'original-operation'])
    expect(manager.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'sent', lastCompletionId: '["r",1]' })
    expect(manager.list()[0]?.pendingCompletion).toBeUndefined()
    now = _historyFixtureEpoch(0, 0, 30); await manager.check(); expect(operations).toHaveLength(2)
  } finally { await manager.stop(); await rm(dir, { recursive: true, force: true }) }
})
it.each(['pause', 'stopLoop'] as const)('does not send after %s while observation is pending', async (action) => {
  const dir = await mkdtemp(join(_hygiene_fixturePath("tmp"), 'agentmux-pause-loop-'))
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  let release!: () => void, enter!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { enter = resolve })
  let calls = 0
  const manager = new ContinuousProgressLoopManager(store, async () => { calls++; return 'sent' }, () => 0,
    async (loop, tickId) => { enter(); await gate; return observedDone(loop, tickId) })
  try {
    await store.save([{ loopId: 'l', hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"), intervalMs: 10, prompt: 'next', nextCheckAt: _historyFixtureEpoch(0, 0, 0), status: 'active' }])
    await manager.start(); const checking = manager.check(); await entered
    await manager[action]('l'); release(); await checking
    expect(calls).toBe(0)
    expect(manager.list()[0]?.status).toBe(action === 'pause' ? 'paused' : 'stopped')
  } finally { release(); await manager.stop(); await rm(dir, { recursive: true, force: true }) }
})

it('propagates pause cancellation to an already queued Core submission', async () => {
  const dir = await mkdtemp(join(_hygiene_fixturePath("tmp"), 'agentmux-abort-loop-')); const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((r) => { enter = r }); const gate = new Promise<void>((r) => { release = r })
  let bytes = 0
  const manager = new ContinuousProgressLoopManager(store, async (_loop, _id, _current, signal) => {
    enter(); await gate
    if (!signal.aborted) bytes++
    return 'skipped'
  }, () => 0, observedDone)
  try {
    await store.save([{ loopId: 'l', hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"), intervalMs: 10, prompt: 'next', nextCheckAt: _historyFixtureEpoch(0, 0, 0), status: 'active' }])
    await manager.start(); const checking = manager.check(); await entered
    await manager.pause('l'); release(); await checking
    expect(bytes).toBe(0)
  } finally { release(); await manager.stop(); await rm(dir, { recursive: true, force: true }) }
})

it('retains one original Goal start through durable Manager reload and reconciles only its saved initial operation', async () => {
  const { openDemandStore } = await import('@agentmux/demand')
  const dir = await mkdtemp(join(_hygiene_fixturePath("tmp"), 'agentmux-goal-loop-'))
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json')), goals = openDemandStore({ root: join(dir, 'goals') })
  await goals.create({ id: 'original-goal', title: 'Original work', sessionIds: ['a'], assigneeSessionIds: ['a'], supervisorSessionId: 'a' })
  await goals.proposeAlignment('original-goal', { summary: 'Original scope', criteria: [{ id: 'criterion', text: 'Observable result' }], openQuestions: [] })
  await goals.confirmAlignment('original-goal', 1)
  let receipt: 'confirmed' | 'pending' | 'unconfirmed' = 'unconfirmed', sends = 0
  const owner = { read: (id: string) => goals.get(id), inspectInitial: async () => receipt }
  const manager = new ContinuousProgressLoopManager(store, async () => { sends++; return 'sent' }, () => 0, observedDone, undefined, owner)
  const restored = new ContinuousProgressLoopManager(store, async () => { sends++; return 'sent' }, () => 0, observedDone, undefined, owner)
  const target = { hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath("w") }
  const input = { ...target, goalId: 'original-goal', alignmentRevision: 1, intervalMs: 10, operationId: 'original-start', prompt: 'Original work' }
  try {
    const prepared = await manager.prepareGoal(input)
    expect((await store.load())[0]).toMatchObject({ loopId: prepared.loopId, status: 'paused', initialDelivery: { operationId: 'original-start', state: 'prepared' } })
    await manager.initialGoalInput(target, prepared.loopId, 'original-start', 'begin')
    await manager.stop(); await restored.start()
    expect(await restored.prepareGoal(input)).toMatchObject({ loopId: prepared.loopId, initialDelivery: { operationId: 'original-start', state: 'unknown' } })
    await expect(restored.initialGoalInput(target, prepared.loopId, 'original-start', 'begin')).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    receipt = 'confirmed'
    expect(await restored.initialGoalInput(target, prepared.loopId, 'original-start', 'confirm')).toMatchObject({ status: 'active', initialDelivery: { state: 'confirmed' } })
    await expect(restored.prepareGoal({ ...input, prompt: 'Different work' })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    expect((await restored.listGoals(input.goalId))).toHaveLength(1)
    expect(sends).toBe(0)
  } finally { await manager.stop(); await restored.stop(); await rm(dir, { recursive: true, force: true }) }
})

it('cancels original Goal initial admission when its real source owner becomes blocked, keeping the saved loop and execution identity', async () => {
  const { openDemandStore } = await import('@agentmux/demand')
  const dir = await mkdtemp(join(_hygiene_fixturePath("tmp"), 'agentmux-goal-source-'))
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json')), goals = openDemandStore({ root: join(dir, 'goals') })
  await goals.create({ id: 'original-goal', title: 'Original work', sessionIds: ['a'], assigneeSessionIds: ['a'], supervisorSessionId: 'a' })
  await goals.proposeAlignment('original-goal', { summary: 'Original scope', criteria: [{ id: 'criterion', text: 'Observable result' }], openQuestions: [] })
  await goals.confirmAlignment('original-goal', 1)
  const manager = new ContinuousProgressLoopManager(store, async () => 'sent', () => 0, observedDone, undefined, {
    read: id => goals.get(id), inspectInitial: async () => 'unconfirmed', subscribe: listener => goals.subscribe(snapshot => listener(snapshot.demands))
  })
  try {
    const prepared = await manager.prepareGoal({ hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"), goalId: 'original-goal', alignmentRevision: 1, intervalMs: 10, operationId: 'original-start', prompt: 'Original work' })
    let entered = false
    const sending = manager.submitGoalInitial({ hostId: 'local', agentSessionId: 'a' }, 'original-goal', prepared.loopId, 'original-start', prepared.initialDelivery!.prompt, prepared.initialDelivery!.condition,
      async (isCurrent, signal) => {
        entered = true
        await goals.update('original-goal', { status: 'blocked' })
        expect(signal.aborted).toBe(true)
        expect(isCurrent()).toBe(false)
        signal.throwIfAborted()
      })
    await expect(sending).rejects.toMatchObject({ name: 'AbortError' })
    expect(entered).toBe(true)
    expect(await manager.listGoals('original-goal')).toMatchObject([{ loopId: prepared.loopId, hostId: 'local', agentSessionId: 'a', status: 'paused', initialDelivery: { operationId: 'original-start', state: 'unknown' } }])
    expect((await goals.get('original-goal'))?.sessionIds).toEqual(['a'])
  } finally { await manager.stop(); await rm(dir, { recursive: true, force: true }) }
})

it('updates the original loop, protects an unknown save and rejects stale or conflicting operations', async () => {
  const dir = await mkdtemp(join(_hygiene_fixturePath('tmp'), 'progress-update-'))
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  const send = vi.fn(async () => 'sent' as const)
  const manager = new ContinuousProgressLoopManager(store, send, () => 100, observedDone)
  const target = { hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath('w') }
  const context = { principal: { kind: 'user' as const, id: 'person' } }
  try {
    const loop = await manager.create({ ...target, intervalMs: 60_000, prompt: 'before' })
    const original = { target, loopId: loop.loopId, expectedLoop: loop, intervalMs: 120_000, prompt: 'after', operationId: 'update-one' }
    const save = vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk unconfirmed'))
    await expect(manager.callProgress('agent.progress.update', original, context)).rejects.toThrow('disk unconfirmed')
    expect(manager.list()[0]).toMatchObject({ loopId: loop.loopId, status: 'active', nextCheckAt: loop.nextCheckAt, prompt: 'after', revision: 1 })
    expect((await store.load())[0]?.prompt).toBe('before')
    const result = await manager.callProgress('agent.progress.update', original, context)
    expect(result).toMatchObject({ diskDurability: 'confirmed', loop: { prompt: 'after', intervalMs: 120_000, revision: 1, lastMutation: { operationId: 'update-one', action: 'update', expectedRevision: 0 } } })
    expect((await store.load())[0]?.prompt).toBe('after')
    await expect(manager.callProgress('agent.progress.update', { ...original, prompt: 'different' }, context)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    const reverted = await manager.callProgress('agent.progress.update', { ...original, operationId: 'update-two', expectedLoop: result.loop, intervalMs: 60_000, prompt: 'before' }, context)
    expect(reverted.loop.revision).toBe(2)
    await expect(manager.callProgress('agent.progress.update', { ...original, operationId: 'stale' }, context)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    await expect(manager.callProgress('agent.progress.update', original, context)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    await expect(manager.callProgress('agent.progress.update', { ...original, target: { ...target, providerId: 'other' }, expectedLoop: reverted.loop, operationId: 'foreign' }, context)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    await expect(manager.callProgress('agent.progress.update', { ...original, expectedLoop: reverted.loop, operationId: 'agent' }, { caller: {} as never, principal: { kind: 'agent', id: 'other' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(send).not.toHaveBeenCalled()
    save.mockRestore()
  } finally { await manager.stop(); await rm(dir, { recursive: true, force: true }) }
})

it('keeps an already claimed tick and pending input while saving the next configuration', async () => {
  const dir = await mkdtemp(join(_hygiene_fixturePath('tmp'), 'progress-claim-update-'))
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  let now = 0, release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), claimed = new Promise<void>(resolve => { entered = resolve })
  const prompts: string[] = [], observed: string[] = []
  const manager = new ContinuousProgressLoopManager(store, async loop => { prompts.push(loop.pendingCompletion!.prompt!); return 'sent' }, () => now,
    async (loop, tick) => { observed.push(loop.prompt); return observedDone(loop, tick) })
  const target = { hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath('w') }
  const context = { principal: { kind: 'user' as const, id: 'person' } }
  try {
    await store.save([{ ...target, loopId: 'original-loop', intervalMs: 60_000, prompt: 'old prompt', nextCheckAt: 0, status: 'active' }])
    await manager.start()
    const initial = manager.list()[0]!
    const save = vi.spyOn(store, 'save'); const realSave = save.getMockImplementation() ?? ContinuousProgressLoopStore.prototype.save.bind(store)
    let first = true
    save.mockImplementation(async loops => { await realSave(loops); if (first) { first = false; entered(); await gate } })
    const tick = manager.check(0); await claimed
    const result = await manager.callProgress('agent.progress.update', { target, loopId: initial.loopId, expectedLoop: initial, intervalMs: 120_000, prompt: 'new prompt', operationId: 'update-during-claim' }, context)
    expect(result.loop.nextCheckAt).toBe(60_000)
    release(); await tick
    expect(prompts).toEqual(['old prompt'])
    expect((await store.load())[0]).toMatchObject({ loopId: initial.loopId, prompt: 'new prompt', intervalMs: 120_000, nextCheckAt: 60_000 })
    now = 60_000; await manager.check(now)
    expect(observed).toEqual(['old prompt', 'new prompt'])
    expect(manager.list()[0]?.nextCheckAt).toBe(180_000)
    save.mockRestore()
  } finally { release(); await manager.stop(); await rm(dir, { recursive: true, force: true }) }
})

it('retains the paused original pending operation and its frozen prompt across update and restart', async () => {
  const dir = await mkdtemp(join(_hygiene_fixturePath('tmp'), 'progress-pending-update-'))
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  const send = vi.fn(async () => 'sent' as const)
  const target = { hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath('w') }
  const pendingCompletion = { id: 'completion-original', operationId: 'tick-original', prompt: 'frozen prompt', inputByte: 0 }
  const manager = new ContinuousProgressLoopManager(store, send, () => 0, observedDone)
  const restarted = new ContinuousProgressLoopManager(store, send, () => 0, observedDone)
  const context = { principal: { kind: 'user' as const, id: 'person' } }
  try {
    await store.save([{ ...target, loopId: 'original-loop', intervalMs: 60_000, prompt: 'old prompt', nextCheckAt: 50, status: 'paused', lastOutcome: 'unknown', pendingCompletion }])
    await manager.start(); const original = manager.list()[0]!
    const request = { target, loopId: original.loopId, expectedLoop: original, intervalMs: 120_000, prompt: 'future prompt', operationId: 'save-original' }
    const result = await manager.callProgress('agent.progress.update', request, context)
    expect(result.loop).toMatchObject({ status: 'paused', nextCheckAt: 50, pendingCompletion, lastOutcome: 'unknown', prompt: 'future prompt' })
    await manager.stop(); await restarted.start()
    expect(restarted.list()[0]).toMatchObject({ loopId: original.loopId, status: 'paused', pendingCompletion, prompt: 'future prompt' })
    expect((await restarted.callProgress('agent.progress.update', request, context)).loop.pendingCompletion).toEqual(pendingCompletion)
    expect(send).not.toHaveBeenCalled()
  } finally { await manager.stop(); await restarted.stop(); await rm(dir, { recursive: true, force: true }) }
})

it('edits a paused ordinary loop without touching its source and rejects other loop kinds', async () => {
  const target = { hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath('w') }
  const taskSource = { kind: 'feature' as const, root: '/private-fixture', ownerId: 'feature-original', readerPath: '/private-fixture/read' }
  const original = { ...target, loopId: 'ordinary', intervalMs: 60_000, prompt: 'old', nextCheckAt: 300, status: 'paused' as const, taskSource }
  const goal = { ...original, loopId: 'goal', taskSource: { kind: 'goal' as const, goalId: 'goal-original', alignmentRevision: 1 } }
  const schedule = { ...original, loopId: 'schedule', taskSource: undefined, afterMs: 1000 }
  const ended = { ...original, loopId: 'ended', status: 'stopped' as const }
  const store = { load: async () => [original, goal, schedule, ended], save: async () => {} }
  const manager = new ContinuousProgressLoopManager(store as never, async () => { throw new Error('Unexpected delivery') }, () => 0, observedDone)
  const context = { principal: { kind: 'user' as const, id: 'person' } }
  try {
    await manager.start()
    const request = { target, loopId: original.loopId, expectedLoop: original, intervalMs: 120_000, prompt: 'new', operationId: 'edit' }
    const { loop } = await manager.callProgress('agent.progress.update', request, context)
    expect(loop).toMatchObject({ loopId: original.loopId, status: 'paused', nextCheckAt: original.nextCheckAt, taskSource, prompt: 'new' })
    for (const candidate of [goal, schedule, ended]) {
      await expect(manager.callProgress('agent.progress.update', { ...request, loopId: candidate.loopId, expectedLoop: candidate, operationId: `edit-${candidate.loopId}` }, context)).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    }
    expect(manager.list().find(item => item.loopId === goal.loopId)).toEqual(goal)
    expect(manager.list().find(item => item.loopId === schedule.loopId)).toEqual(schedule)
    expect(manager.list().find(item => item.loopId === ended.loopId)).toEqual(ended)
  } finally { await manager.stop() }
})

it('rejects an unrepresentable update prompt before changing the original loop', () => {
  const target = { hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath('w') }
  const expectedLoop = { ...target, loopId: 'original', intervalMs: 60_000, prompt: 'old', nextCheckAt: 1, status: 'paused' as const }
  const request = { target, loopId: 'original', expectedLoop, intervalMs: 60_000, prompt: 'new', operationId: 'original-update' }
  for (const prompt of ['x\0y', 'x'.repeat(65537)]) expect(() => parseAgentProgressParams('agent.progress.update', { ...request, prompt })).toThrow()
  expect(parseAgentProgressParams('agent.progress.create', { target, intervalMs: 60_000, prompt: 'x'.repeat(65537), operationId: 'create' }).prompt).toHaveLength(65537)
})
