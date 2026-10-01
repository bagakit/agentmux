import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentPromptSubmissionCoordinator } from '../src/prompt-submission.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'

const clients: AgentMuxClient[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
})

type Input = { operationId: string; expectedByte: number; data: string | Uint8Array }
type Ack = { run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number } }
type Internals = {
  connected: boolean
  registry: AgentMuxAgentSessionRegistry
  kernel: {
    isConnected(): boolean
    identity(): { daemonInstanceId: string }
    status(runId: string): Promise<CtxmuxAdapterRun>
    input(runId: string, input: Input): Promise<Ack>
  }
  promptSubmission: AgentPromptSubmissionCoordinator
  screenEvidence: AgentScreenEvidenceStore
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(singlePhase = false) {
  const template = new AgentProviderRegistry().get('codex')
  const generic = defineAgentProvider({
    catalog: { ...template.catalog, id: 'generic', label: 'Generic', executable: 'generic', expectedProcess: 'generic' },
    hook: template.hook,
    buildArgs: (_prompt, args) => [...args]
  })
  const providerId = singlePhase ? generic.id : 'codex'
  const store = new AgentMuxMemoryAgentSessionStore()
  const initial: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'bound-agent', providerId, executorId: providerId,
    hostId: 'local', workspacePath: '/repo', run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'bound-binding', hookToken: 'bound-token',
    createdAt: 1, updatedAt: 100,
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: 100, stateEnteredAt: 100 }
  }
  await store.compareAndSwap(null, initial)
  const cursors = new Map<string, number>()
  const accepted = new Map<string, Ack>()
  const writes: Array<{ runId: string } & Input> = []
  let beforeStatus: (() => Promise<void>) | undefined
  let beforeAck: (() => Promise<void>) | undefined
  const run = (runId: string): CtxmuxAdapterRun => ({
    nativeService: null,
    runId, lifecycleOperationId: null, program: 'codex', args: [], workspacePath: '/repo',
    pid: runId === 'original-run' ? 123 : 124, state: { type: 'running' }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursors.get(runId) ?? 0
  })
  const setup = async () => {
    const client = new AgentMuxClient({ store, ...(singlePhase ? { providers: [generic] } : {}) })
    clients.push(client)
    const inner = client as unknown as Internals
    await inner.registry.load('local')
    inner.connected = true
    inner.kernel.isConnected = () => true
    inner.kernel.identity = () => ({ daemonInstanceId: 'bound-daemon' })
    inner.kernel.status = async (runId) => {
      const snapshot = run(runId)
      await beforeStatus?.()
      return snapshot
    }
    inner.kernel.input = async (runId, input) => {
      const key = `${runId}:${input.operationId}`
      const prior = accepted.get(key)
      if (prior) return prior
      writes.push({ runId, ...input })
      const endByte = input.expectedByte + (typeof input.data === 'string' ? Buffer.byteLength(input.data) : input.data.byteLength)
      cursors.set(runId, endByte)
      const receipt = { run: run(runId), appliedByteRange: { startByte: input.expectedByte, endByte } }
      accepted.set(key, receipt)
      await beforeAck?.()
      return receipt
    }
    vi.spyOn(inner.screenEvidence, 'wait').mockResolvedValue(1)
    const events: AgentMuxClientEvent[] = []
    client.onEvent((event) => { events.push(event) })
    return { client, inner, events }
  }
  const current = await setup()
  const replace = async (newRunId = 'replacement-run', refreshRegistry = true) => {
    const previous = (await loadAgentSessions(store))[0]!
    const next = { ...initial, run: { runId: newRunId }, updatedAt: previous.updatedAt + 1 }
    await store.compareAndSwap(previous, next)
    if (refreshRegistry) await current.inner.registry.load('local')
  }
  const input = { ...agentPromptCondition(current.client.agentSession('bound-agent')), agentSessionId: 'bound-agent', expectedRun: { runId: 'original-run' }, operationId: 'bound-operation', prompt: 'hello' }
  return { ...current, store, run, writes, input, replace, freshClient: setup,
    beforeStatus: (callback?: () => Promise<void>) => { beforeStatus = callback },
    beforeAck: (callback?: () => Promise<void>) => { beforeAck = callback } }
}

describe('conditional exact Run prompt admission', () => {
  it.each([false, true])('rejects a stale bound target before planning, claim or input (single phase=%s)', async (singlePhase) => {
    const h = await fixture(singlePhase)
    await h.replace()
    expect(h.client.agentSession('bound-agent').run).toEqual({ runId: 'replacement-run' })
    expect(h.run('replacement-run').state).toEqual({ type: 'running' })
    const before = await h.store.load()
    const planning = vi.spyOn(h.client.providers.get(singlePhase ? 'generic' : 'codex'), 'planPromptInput')
    await expect(h.client.submitAgentPrompt(h.input)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(planning).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
    expect(await h.store.load()).toEqual(before)
    expect((await h.store.loadTimeline('bound-agent')).items).toEqual([])
  })

  it.each([false, true])('accepts the matching target and replays its acknowledged transaction without duplicate bytes (single phase=%s)', async (singlePhase) => {
    const h = await fixture(singlePhase)
    await h.client.submitAgentPrompt(h.input)
    expect(h.writes.map(({ runId, data }) => ({ runId, data }))).toEqual(singlePhase
      ? [{ runId: 'original-run', data: 'hello\r' }]
      : [{ runId: 'original-run', data: 'hello' }, { runId: 'original-run', data: '\r' }])
    const firstWrites = [...h.writes]
    const restored = await h.freshClient()
    await restored.client.submitAgentPrompt(h.input)
    expect(h.writes).toEqual(firstWrites)
    expect((await h.store.loadTimeline('bound-agent')).items.map(({ id, content }) => ({ id, content })))
      .toEqual([{ id: 'prompt:bound-operation', content: 'hello' }])
    await h.replace()
    await restored.inner.registry.load('local')
    await expect(restored.client.submitAgentPrompt(h.input)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(h.writes).toEqual(firstWrites)
    expect(restored.client.agentSession('bound-agent').promptCompletionAdmission).toBeUndefined()
  })

  it.each([false, true])('captures the current Run for a fresh Session-addressed operation (single phase=%s)', async (singlePhase) => {
    const h = await fixture(singlePhase)
    await h.replace()
    await h.client.submitAgentPrompt({ ...agentPromptCondition(h.client.agentSession('bound-agent')), agentSessionId: 'bound-agent', operationId: 'fresh-operation', prompt: 'fresh' })
    expect(h.writes.map(({ runId, data }) => ({ runId, data }))).toEqual(singlePhase
      ? [{ runId: 'replacement-run', data: 'fresh\r' }]
      : [{ runId: 'replacement-run', data: 'fresh' }, { runId: 'replacement-run', data: '\r' }])
  })

  it('retains the existing exact Run fence while a bound prompt waits behind actual raw input', async () => {
    const h = await fixture()
    const acknowledged = deferred()
    const release = deferred()
    h.beforeAck(async () => { acknowledged.resolve(); await release.promise })
    const first = h.client.writeAgent({ agentSessionId: 'bound-agent', expectedRun: h.client.agentSession('bound-agent').run, data: 'x', source: 'user' })
    await acknowledged.promise
    const second = h.client.submitAgentPrompt(h.input).then(() => null, (error: unknown) => error)
    await h.replace()
    h.beforeAck()
    release.resolve()
    await expect(first).resolves.toMatchObject({ runId: 'original-run', acceptedThroughByte: 1 })
    expect(await second).toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(h.writes.map(({ runId, data }) => ({ runId, data }))).toEqual([{ runId: 'original-run', data: 'x' }])
    expect(h.client.agentSession('bound-agent').promptCompletionAdmission).toBeUndefined()
  })

  it.each([false, true])('retains the durable CAS fence when a different owner changes the Run during native status (single phase=%s)', async (singlePhase) => {
    const h = await fixture(singlePhase)
    h.beforeStatus(async () => { h.beforeStatus(); await h.replace('replacement-run', false) })
    await expect(h.client.submitAgentPrompt(h.input)).rejects.toMatchObject({
      code: 'STALE_AGENT_SESSION'
    })
    expect(h.writes).toEqual([])
    const durable = (await loadAgentSessions(h.store))[0]!
    expect(durable.run).toEqual({ runId: 'replacement-run' })
    expect(durable.promptCompletionAdmission).toBeUndefined()
    expect(durable.semanticStatus?.stateEnteredAt).toBe(100)
  })

  it.each([false, true])('attributes history to the acknowledged original Run when continuity changes before history recording (single phase=%s)', async (singlePhase) => {
    const h = await fixture(singlePhase)
    const originalSubmit = h.inner.promptSubmission.submitInputPlan.bind(h.inner.promptSubmission)
    let acceptedSubmission: AgentMuxStoredAgentSession | undefined
    vi.spyOn(h.inner.promptSubmission, 'submitInputPlan').mockImplementation(async (...args) => {
      await originalSubmit(...args)
      acceptedSubmission = (await loadAgentSessions(h.store))[0]!
      await h.replace()
    })
    await expect(h.client.submitAgentPrompt(h.input)).resolves.toBeUndefined()
    if (singlePhase) expect(acceptedSubmission?.promptCompletionAdmission?.submissionId).toBe('bound-operation')
    else expect(acceptedSubmission?.terminalPromptSubmission?.submit.acknowledged).toBe(true)
    expect(h.client.agentSession('bound-agent').run).toEqual({ runId: 'replacement-run' })
    expect(h.writes.map(({ runId, data }) => ({ runId, data }))).toEqual(singlePhase
      ? [{ runId: 'original-run', data: 'hello\r' }]
      : [{ runId: 'original-run', data: 'hello' }, { runId: 'original-run', data: '\r' }])
    const history = h.events.filter((event) => event.type === 'agent-timeline')
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ evidence: { run: { runId: 'original-run' } },
      mutation: { type: 'append', item: { id: 'prompt:bound-operation', status: 'complete' } } })
    await expect(h.client.submitAgentPrompt(h.input)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(h.writes).toHaveLength(singlePhase ? 1 : 2)
  })
})
