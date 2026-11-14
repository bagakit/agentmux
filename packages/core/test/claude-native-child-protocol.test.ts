import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLAUDE_CHILD_ACTIVITY_EVENT, claudeNativeActivitySource } from '../src/providers/claude-native-activity.js'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'

type Handler = (api: unknown, event: Record<string, unknown>, next: (event: Record<string, unknown>) => unknown) => unknown
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

/** Execute the generated mod and send its real wire through the Provider and durable Core owner. */
async function nativeChild() {
  const h = await activityCertaintyClient('native-child-protocol', 'claude')
  const inflight = new Set<Promise<unknown>>()
  closes.push(async () => {
    do {
      await Promise.allSettled([...inflight])
      // Let the generated module start the next already-queued delivery before closing its owner.
      await new Promise(resolve => setImmediate(resolve))
    } while (inflight.size)
    await h.close()
  })
  const path = join(h.directory, 'register.mjs')
  await writeFile(path, claudeNativeActivitySource())
  const mod = await import(/* @vite-ignore */ pathToFileURL(path).href) as {
    register(on: (name: string, handler: Handler) => unknown): void
  }
  const handlers = new Map<string, Handler>()
  mod.register((name, handler) => { handlers.set(name, handler); return { catch() {} } })
  const payloads: Array<Record<string, unknown>> = [], errors: unknown[] = []
  const completed = new Set<unknown>()
  const api = {
    env: { get: async (name: string) => ({ AGENTMUX_ENV: '1', AGENTMUX_HOOK_NODE: 'original-node', AGENTMUX_HOOK_RUNNER: 'original-runner' } as Record<string, string>)[name] },
    session: { id: async () => 'native-main' }, ui: { log: async () => {} },
    process: { run: async (_argv: string[], input: { stdin: string }) => {
      const payload = JSON.parse(input.stdin) as Record<string, unknown>
      if (payload.hook_event_name === 'AgentMuxTurnEnd') return { exitCode: 0, stdout: '{}', stderr: '' }
      payloads.push(payload)
      const delivery = h.hook(String(payload.hook_event_name), `original-mod-observation-${payload.sequence}`, payload)
      inflight.add(delivery)
      try { await delivery; completed.add(payload.sequence) }
      catch (error) { errors.push(error); throw error }
      finally { inflight.delete(delivery) }
      return { exitCode: 0, stdout: '{}', stderr: '' }
    } }
  }
  const emit = async (name: string, event: Record<string, unknown>, observed = true) => {
    const before = new Set(payloads), result = { original: event }
    expect(await handlers.get(name)!(api, event, nextEvent => { expect(nextEvent).toBe(event); return result })).toBe(result)
    if (observed) await vi.waitFor(() => {
      expect(errors).toEqual([])
      const payload = payloads.find(value => !before.has(value) && (name === 'classic.PermissionRequest'
        ? value.hook_event_name === CLAUDE_CHILD_ACTIVITY_EVENT && value.reason === 'permission' && value.state !== 'working' && value.agent_id === event.agent_id
        : value.hook_event_name === name && value.turnId === event.turnId && value.agent_id === event.agentId))
      expect(payload).toBeDefined()
      expect(completed.has(payload!.sequence)).toBe(true)
    }, { timeout: 5000 })
  }
  await emit('session.start', {}, false)
  const invoke = (name: string, event: Record<string, unknown>, next: (event: Record<string, unknown>) => unknown) =>
    handlers.get(name)!(api, event, native => { expect(native).toBe(event); return next(native) })
  return { ...h, emit, payloads, invoke, completed }
}

async function idleMainWorkingChild() {
  const h = await nativeChild()
  await h.emit('turn.start', { turnId: 'main-turn', text: '' })
  await h.emit('turn.start', { turnId: 'child-turn', agentId: 'original-child', text: '' })
  await h.emit('turn.complete', { turnId: 'main-turn', reason: 'answer', isAborted: false })
  return h
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

async function childState(h: Awaited<ReturnType<typeof nativeChild>>, state: string, semantic: string) {
  await vi.waitFor(async () => {
    const status = await h.client.statusAgent('native-child-protocol')
    expect(status.session.nativeSubagents?.sessions[0]).toMatchObject({ state })
    expect(status.observation.semantic).toBe(semantic)
    expect(status.observation.mainSession?.semantic).toBe('idle')
    expect(status.session.pendingInteraction).toBeUndefined()
    const latest = h.payloads.filter(value => value.hook_event_name === CLAUDE_CHILD_ACTIVITY_EVENT).at(-1)
    if (latest) expect(h.completed.has(latest.sequence)).toBe(true)
  }, { timeout: 5000 })
}

async function permissionCall(h: Awaited<ReturnType<typeof nativeChild>>, id: string, command: string) {
  const done = deferred<{ result: string }>(), checked = deferred<void>()
  const event = { agentId: 'original-child', tool: 'Bash', tool_use_id: id, command }
  const result = h.invoke('tool.call', event, async () => {
    await h.invoke('tool.check', { agentId: event.agentId, tool: event.tool, tool_use_id: id, input: { command } }, () => ({ decision: 'ask' }))
    checked.resolve(); return await done.promise
  })
  await checked.promise
  const request = () => h.emit('classic.PermissionRequest', { session_id: 'native-main', agent_id: event.agentId, tool_name: event.tool, tool_input: { command } })
  return { done, result, request }
}

it('generated child events keep the main native identity and expose child-only execution', async () => {
  const h = await nativeChild()
  await h.emit('turn.start', { turnId: 'main-turn', text: 'Original main input' })
  await h.emit('turn.start', { turnId: 'child-turn', agentId: 'original-child', text: 'Private child instruction' })
  await h.emit('turn.complete', { turnId: 'main-turn', reason: 'answer', isAborted: false, answer: 'Private main answer' })
  const status = await h.client.statusAgent('native-child-protocol')
  expect(status.observation).toMatchObject({ semantic: 'active', mainSession: { semantic: 'idle' },
    subagentSessions: { nativeSessionId: 'native-main', sessions: [{ nativeAgentId: 'original-child', nativeTurnId: 'child-turn', state: 'working' }] } })
  expect(status.session.nativeHandle?.sessionId).toBe('native-main')
  expect(h.payloads[1]).toMatchObject({ session_id: 'native-main', agent_id: 'original-child', turnId: 'child-turn' })
  expect(JSON.stringify(h.payloads)).not.toContain('Private child instruction')
  expect(JSON.stringify(h.payloads)).not.toContain('Private main answer')
})

it.each(['answer', 'aborted', 'refusal', 'error'])('generated child end preserves the native %s reason without supplying main success', async reason => {
  const h = await nativeChild()
  await h.emit('turn.start', { turnId: 'main-turn', text: '' })
  await h.emit('turn.start', { turnId: 'child-turn', agentId: 'original-child', text: '' })
  await h.emit('turn.complete', { turnId: 'child-turn', agentId: 'original-child', reason, isAborted: reason === 'aborted', answer: 'Private child answer' })
  expect(h.payloads[2]).toMatchObject({ hook_event_name: 'turn.complete', session_id: 'native-main', agent_id: 'original-child',
    turnId: 'child-turn', reason, isAborted: reason === 'aborted' })
  const status = await h.client.statusAgent('native-child-protocol')
  expect(status.observation.mainSession?.semantic).toBe('active')
  expect(status.session.nativeSubagents?.sessions[0]).toMatchObject({ nativeAgentId: 'original-child', nativeTurnId: 'child-turn', phase: 'ended',
    state: reason === 'answer' ? 'done' : reason === 'error' ? 'error' : 'unknown',
    outcome: { answer: 'completed', aborted: 'interrupted', refusal: 'refused', error: 'failed' }[reason] })
  expect(status.session.nativeHandle?.sessionId).toBe('native-main')
  expect(JSON.stringify(h.payloads)).not.toContain('Private child answer')
})

it.each([
  { reason: 'answer', isAborted: true },
  { reason: 'aborted', isAborted: false },
  { reason: 'unrecognized', isAborted: false },
  { reason: 'answer' }
])('a malformed generated child ending cannot settle its live native turn (%j)', async ending => {
  const h = await nativeChild()
  await h.emit('turn.start', { turnId: 'main-turn', text: '' })
  await h.emit('turn.start', { turnId: 'child-turn', agentId: 'original-child', text: '' })
  await h.emit('turn.complete', { turnId: 'child-turn', agentId: 'original-child', ...ending })
  expect(h.client.agentSession('native-child-protocol').nativeSubagents?.sessions[0]).toMatchObject({
    nativeAgentId: 'original-child', nativeTurnId: 'child-turn', phase: 'running', state: 'working'
  })
})

it('a generated resumed child cannot be settled by its older turn end', async () => {
  const h = await nativeChild()
  await h.emit('turn.start', { turnId: 'main-turn', text: '' })
  await h.emit('turn.start', { turnId: 'child-old', agentId: 'original-child', text: '' })
  await h.emit('turn.start', { turnId: 'child-resumed', agentId: 'original-child', text: '' })
  await h.emit('turn.complete', { turnId: 'child-old', agentId: 'original-child', reason: 'answer', isAborted: false })
  expect(h.client.agentSession('native-child-protocol').nativeSubagents?.sessions).toEqual([
    expect.objectContaining({ nativeAgentId: 'original-child', nativeTurnId: 'child-resumed', phase: 'running', state: 'working' })
  ])
})

it('a child permission retains an unknown scoped observation until its exact native call settles', async () => {
  const h = await idleMainWorkingChild(), call = await permissionCall(h, 'original-permission-call', 'Private command')
  // The classifier may settle an ask. Its policy result alone cannot claim a human request.
  await childState(h, 'working', 'active')
  expect(h.payloads.filter(payload => payload.hook_event_name === CLAUDE_CHILD_ACTIVITY_EVENT)).toEqual([])
  await call.request()
  await childState(h, 'unknown', 'unknown')
  expect(h.client.agentSession('native-child-protocol').nativeSubagents?.sessions[0]).toMatchObject({ state: 'unknown', waitingFor: 'permission' })
  expect(h.payloads.at(-1)).toMatchObject({ hook_event_name: CLAUDE_CHILD_ACTIVITY_EVENT, agent_id: 'original-child',
    turnId: 'child-turn', tool_use_id: 'original-permission-call', state: 'unknown', reason: 'permission' })
  const original = { result: 'native decline result unchanged' }
  call.done.resolve(original); expect(await call.result).toBe(original)
  await childState(h, 'working', 'active')
  expect(JSON.stringify(h.payloads)).not.toContain('Private command')
})

it('a child typed question waits and an exact native failure releases only that question', async () => {
  const h = await idleMainWorkingChild(), done = deferred<void>(), failure = new Error('Original native question refusal')
  const question = Promise.resolve(h.invoke('tool.call', { agentId: 'original-child', tool: 'AskUserQuestion', tool_use_id: 'original-question',
    questions: [{ question: 'Private question' }] }, async () => { await done.promise; throw failure }))
  const failed = expect(question).rejects.toBe(failure)
  await childState(h, 'waiting', 'awaiting-input')
  expect(h.payloads.at(-1)).toMatchObject({ tool_use_id: 'original-question', state: 'waiting', reason: 'question' })
  done.resolve(); await failed
  await childState(h, 'working', 'active')
  expect(JSON.stringify(h.payloads)).not.toContain('Private question')
})

it('settling one of several child permission calls keeps the other original observation unknown', async () => {
  const h = await idleMainWorkingChild()
  const first = await permissionCall(h, 'first-permission', 'first command'), second = await permissionCall(h, 'second-permission', 'second command')
  await first.request(); await second.request()
  first.done.resolve({ result: 'first declined' }); await first.result
  await childState(h, 'unknown', 'unknown')
  expect(h.payloads.at(-1)).toMatchObject({ tool_use_id: 'second-permission', state: 'unknown' })
  second.done.resolve({ result: 'second allowed and settled' }); await second.result
  await childState(h, 'working', 'active')
})

it('ambiguous same-input requests become unknown until all original candidates settle', async () => {
  const h = await idleMainWorkingChild()
  const first = await permissionCall(h, 'ambiguous-first', 'same command'), second = await permissionCall(h, 'ambiguous-second', 'same command')
  await first.request()
  await childState(h, 'unknown', 'unknown')
  expect(h.payloads.at(-1)).toMatchObject({ state: 'unknown', reason: 'permission', turnId: 'child-turn' })
  first.done.resolve({ result: 'first ended' }); await first.result
  await childState(h, 'unknown', 'unknown')
  second.done.resolve({ result: 'second ended' }); await second.result
  await childState(h, 'working', 'active')
})

it('old-scope permission callbacks and tool finalizers cannot borrow a resumed child turn', async () => {
  const h = await idleMainWorkingChild(), old = await permissionCall(h, 'old-scope-call', 'same command')
  await h.emit('turn.start', { turnId: 'child-resumed', agentId: 'original-child', text: '' })
  const current = await permissionCall(h, 'current-scope-call', 'same command'), before = h.payloads.length
  // Both original calls are still open, so this native ask cannot be attributed to the resumed turn.
  await h.emit('classic.PermissionRequest', { session_id: 'native-main', agent_id: 'original-child', tool_name: 'Bash', tool_input: { command: 'same command' } }, false)
  expect(h.payloads).toHaveLength(before)
  old.done.resolve({ result: 'old native call settled' }); await old.result
  await childState(h, 'working', 'active')
  await current.request(); await childState(h, 'unknown', 'unknown')
  expect(h.payloads.at(-1)).toMatchObject({ turnId: 'child-resumed', tool_use_id: 'current-scope-call' })
  current.done.resolve({ result: 'current native call settled' }); await current.result
  await childState(h, 'working', 'active')
})

it('an ended child turn cannot be reopened by its question finalizer', async () => {
  const h = await idleMainWorkingChild(), done = deferred<{ result: string }>()
  const question = h.invoke('tool.call', { agentId: 'original-child', tool: 'AskUserQuestion', tool_use_id: 'ending-question' }, () => done.promise)
  await childState(h, 'waiting', 'awaiting-input')
  await h.emit('turn.complete', { turnId: 'child-turn', agentId: 'original-child', reason: 'aborted', isAborted: true })
  const before = h.payloads.length
  done.resolve({ result: 'native question interrupted' }); await question
  expect(h.payloads).toHaveLength(before)
  expect(h.client.agentSession('native-child-protocol').nativeSubagents?.sessions[0]).toMatchObject({ phase: 'ended', state: 'unknown', outcome: 'interrupted' })
})

it('a foreign classic permission and a missing child turn never manufacture a current child request', async () => {
  const h = await idleMainWorkingChild(), call = await permissionCall(h, 'original-scope-call', 'original command')
  const before = h.payloads.length
  await h.emit('classic.PermissionRequest', { session_id: 'foreign-native', agent_id: 'original-child', tool_name: 'Bash', tool_input: { command: 'original command' } }, false)
  const absent = { agentId: 'unobserved-child', tool: 'AskUserQuestion', tool_use_id: 'absent-scope-question' }
  await h.invoke('tool.call', absent, () => ({ result: 'Native path remains unchanged' }))
  expect(h.payloads).toHaveLength(before)
  await childState(h, 'working', 'active')
  call.done.resolve({ result: 'original call settled' }); await call.result
})

it('an unresolved permission observation does not hide another child with confirmed native work', async () => {
  const h = await idleMainWorkingChild()
  await h.emit('turn.start', { turnId: 'other-child-turn', agentId: 'other-child', text: '' })
  const call = await permissionCall(h, 'permission-with-other-work', 'original command')
  await call.request()
  const status = await h.client.statusAgent('native-child-protocol')
  expect(status.observation).toMatchObject({ semantic: 'active', mainSession: { semantic: 'idle' } })
  expect(status.session.nativeSubagents?.sessions).toEqual([
    expect.objectContaining({ nativeAgentId: 'original-child', state: 'unknown', waitingFor: 'permission' }),
    expect.objectContaining({ nativeAgentId: 'other-child', nativeTurnId: 'other-child-turn', state: 'working' })
  ])
  call.done.resolve({ result: 'original permission call settled' }); await call.result
})
