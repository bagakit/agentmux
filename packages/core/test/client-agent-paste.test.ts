import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxAgentPasteInput, AgentMuxClientEvent, AgentMuxRunInputData, AgentMuxStoredAgentSession } from '../src/index.js'

const clients: AgentMuxClient[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map(client => client.dispose()))
})

type Write = { operationId: string; expectedByte: number; data: AgentMuxRunInputData }
type Inner = {
  connected: boolean
  registry: AgentMuxAgentSessionRegistry
  kernel: {
    isConnected(): boolean
    identity(): { daemonInstanceId: string }
    status(runId: string): Promise<CtxmuxAdapterRun>
    input(runId: string, operation: Write): Promise<{ run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number } }>
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(providerId: 'codex' | 'claude' | 'generic' = 'codex', pending = false) {
  const template = new AgentProviderRegistry().get('codex')
  const generic = defineAgentProvider({
    catalog: { ...template.catalog, id: 'generic', label: 'Generic', executable: 'generic', expectedProcess: 'generic' },
    hook: template.hook,
    buildArgs: (_prompt, args) => [...args]
  })
  const store = new AgentMuxMemoryAgentSessionStore()
  const stored: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'paste-agent', providerId, executorId: providerId,
    hostId: 'local', workspacePath: '/synthetic', run: { runId: 'paste-run' }, retiredRuns: [],
    hookBindingId: 'paste-binding', hookToken: 'paste-token', createdAt: 1, updatedAt: 2,
    ...(pending ? { pendingInteraction: { request: {
      kind: 'permission' as const, id: 'permission', agentSessionId: 'paste-agent', title: 'Allow?',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' as const }],
      evidence: { source: 'native-hook' as const, observedAt: 2, run: { runId: 'paste-run' }, hookReceiptId: 'permission' }
    } } } : {})
  }
  await store.compareAndSwap(null, stored)
  const client = new AgentMuxClient({ store, ...(providerId === 'generic' ? { providers: [generic] } : {}) })
  clients.push(client)
  const inner = client as unknown as Inner
  await inner.registry.load('local')
  inner.connected = true
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'paste-daemon' })
  const cursors = new Map<string, number>([['paste-run', 31]])
  const run = (runId: string): CtxmuxAdapterRun => ({
    runId, lifecycleOperationId: null, program: providerId, args: [], workspacePath: '/synthetic',
    pid: 123, state: { type: 'running' }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursors.get(runId) ?? 0
  })
  inner.kernel.status = async runId => run(runId)
  const writes: Array<Write & { runId: string }> = []
  inner.kernel.input = async (runId, operation) => {
    expect(operation.expectedByte).toBe(cursors.get(runId) ?? 0)
    expect(operation.data.length).toBeGreaterThan(0)
    writes.push({ runId, ...operation })
    const endByte = operation.expectedByte + (typeof operation.data === 'string'
      ? Buffer.byteLength(operation.data) : operation.data.byteLength)
    cursors.set(runId, endByte)
    return { run: run(runId), appliedByteRange: { startByte: operation.expectedByte, endByte } }
  }
  const events: AgentMuxClientEvent[] = []
  client.onEvent(event => events.push(event))
  const input: AgentMuxAgentPasteInput = {
    agentSessionId: stored.agentSessionId, expectedRun: stored.run,
    text: '  first\nsecond  \n', terminalData: '  first\rsecond  \r'
  }
  const replace = async () => {
    const previous = (await loadAgentSessions(store))[0]!
    await store.compareAndSwap(previous, { ...previous, run: { runId: 'replacement-run' }, updatedAt: previous.updatedAt + 1 })
    await inner.registry.load('local')
  }
  return { client, inner, store, writes, events, input, replace }
}

describe('public Agent paste edits without submitting', () => {
  it.each(['codex', 'claude'] as const)('uses the real %s pre-submit payload once, preserving whitespace and ACK bytes', async providerId => {
    const h = await fixture(providerId)
    const expected = '\x1b[200~  first\nsecond  \n\x1b[201~'
    const ack = await h.client.pasteAgent(h.input)
    expect(h.writes.map(write => write.data)).toEqual([expected])
    expect(ack).toEqual({ runId: 'paste-run',
      appliedByteRange: { startByte: 31, endByte: 31 + Buffer.byteLength(expected) },
      acceptedThroughByte: 31 + Buffer.byteLength(expected) })
    const current = h.client.agentSession('paste-agent')
    expect(current.terminalPromptSubmission).toBeUndefined()
    expect(current.promptCompletionAdmission).toBeUndefined()
    expect((await h.store.loadTimeline('paste-agent')).items).toEqual([])
    expect(h.events.filter(event => event.type === 'agent-timeline')).toEqual([])
  })

  it('keeps CRLF and Unicode text and the existing ESC sanitization in the Provider payload', async () => {
    const h = await fixture()
    const expected = '\x1b[200~ 前\r\n␛[201~ 後 \x1b[201~'
    const ack = await h.client.pasteAgent({ ...h.input, text: ' 前\r\n\x1b[201~ 後 ', terminalData: 'not-selected' })
    expect(h.writes.map(write => write.data)).toEqual([expected])
    expect(ack.acceptedThroughByte).toBe(31 + Buffer.byteLength(expected))
  })

  it.each([' a\rb \r', '\x1b[200~ a\rb \r\x1b[201~'])('keeps the exact standard terminal encoding for a single-phase Provider: %j', async terminalData => {
    const h = await fixture('generic')
    expect(h.client.providers.get('generic').planPromptInput(h.input.text).kind).toBe('single-phase')
    await h.client.pasteAgent({ ...h.input, terminalData })
    expect(h.writes.map(write => write.data)).toEqual([terminalData])
    expect((await h.store.loadTimeline('paste-agent')).items).toEqual([])
  })

  it.each(['codex', 'generic'] as const)('returns a real zero-byte ACK for empty %s paste without a kernel write', async providerId => {
    const h = await fixture(providerId)
    const ack = await h.client.pasteAgent({ ...h.input, text: '', terminalData: '' })
    expect(ack).toEqual({ runId: 'paste-run', appliedByteRange: { startByte: 31, endByte: 31 }, acceptedThroughByte: 31 })
    expect(h.writes).toEqual([])
  })

  it('rejects an old bound Run before Provider planning or input', async () => {
    const h = await fixture()
    await h.replace()
    const before = await h.store.load()
    const plan = vi.spyOn(h.client.providers.get('codex'), 'planPromptInput')
    await expect(h.client.pasteAgent(h.input)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(plan).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
    expect(await h.store.load()).toEqual(before)
  })

  it('uses the existing raw input lane and accepted-byte cursor', async () => {
    const h = await fixture('generic')
    const entered = deferred(), release = deferred()
    const original = h.inner.kernel.input
    h.inner.kernel.input = async (runId, input) => {
      if (input.data === 'prior') { entered.resolve(); await release.promise }
      return await original(runId, input)
    }
    const prior = h.client.writeAgent('paste-agent', 'prior')
    await entered.promise
    const paste = h.client.pasteAgent({ ...h.input, terminalData: 'p\rq' })
    const following = h.client.writeAgent('paste-agent', 'z')
    try {
      expect(h.writes).toEqual([])
      release.resolve()
      await Promise.all([prior, paste, following])
      expect(h.writes.map(({ data, expectedByte }) => ({ data, expectedByte })))
        .toEqual([{ data: 'prior', expectedByte: 31 }, { data: 'p\rq', expectedByte: 36 }, { data: 'z', expectedByte: 39 }])
      expect(new Set(h.writes.map(write => write.operationId)).size).toBe(3)
    } finally { release.resolve(); await Promise.allSettled([prior, paste, following]) }
  })

  it('rechecks the original Run after a paste waits behind existing raw input', async () => {
    const h = await fixture()
    const entered = deferred(), release = deferred()
    const original = h.inner.kernel.input
    h.inner.kernel.input = async (runId, input) => {
      if (input.data === 'prior') { entered.resolve(); await release.promise }
      return await original(runId, input)
    }
    const prior = h.client.writeAgent('paste-agent', 'prior')
    await entered.promise
    const paste = h.client.pasteAgent(h.input).then(() => undefined, error => error)
    try {
      await h.replace()
      release.resolve()
      await prior
      expect(await paste).toMatchObject({ code: 'STALE_AGENT_SESSION' })
      expect(h.writes.map(({ runId, data }) => ({ runId, data }))).toEqual([{ runId: 'paste-run', data: 'prior' }])
    } finally { release.resolve(); await Promise.allSettled([prior, paste]) }
  })

  it('preserves the pending-interaction boundary without writing or recording a Prompt', async () => {
    const h = await fixture('codex', true)
    await expect(h.client.pasteAgent(h.input)).rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
    expect(h.writes).toEqual([])
    expect(h.client.agentSession('paste-agent').pendingInteraction?.request.id).toBe('permission')
    expect((await h.store.loadTimeline('paste-agent')).items).toEqual([])
  })

  it('surfaces a failed single input attempt without automatic retry', async () => {
    const h = await fixture()
    const input = vi.fn(async () => { throw new Error('private input failure') })
    h.inner.kernel.input = input
    await expect(h.client.pasteAgent(h.input)).rejects.toThrow('private input failure')
    expect(input).toHaveBeenCalledTimes(1)
    expect((await h.store.loadTimeline('paste-agent')).items).toEqual([])
  })
})
