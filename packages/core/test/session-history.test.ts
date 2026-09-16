import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentProviderSessionHistoryContext, AgentProviderSessionHistoryPage, AgentMuxStoredAgentSession } from '../src/types.js'

const source = { providerId: 'codex', nativeSessionId: 'main-native-id' }
const item = { id: 'one', kind: 'assistant-message' as const,
  contentParts: [{ kind: 'text' as const, text: '\n  exact 中 text\n' }] }
const page = (): AgentProviderSessionHistoryPage => ({ source: { ...source }, items: [structuredClone(item)], nextCursor: null })
const clients: AgentMuxClient[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(clients.splice(0).map((client) => client.dispose())) })

async function harness(reader?: AgentProvider['readSessionHistoryPage'], hasHandle = true) {
  const store = new AgentMuxMemoryAgentSessionStore()
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'main-session', providerId: 'codex',
    executorId: 'codex', hostId: 'local', workspacePath: '/synthetic', run: { runId: 'same-live-run' },
    retiredRuns: [], hookBindingId: 'synthetic-binding', hookToken: 'synthetic-token', outputCursorBytes: 123,
    createdAt: 1, updatedAt: 1, ...(hasHandle ? {
      nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: source.nativeSessionId,
        transcriptPath: '/synthetic/ignored-fork-locator.jsonl' }
    } : {}) }
  await store.compareAndSwap(null, session)
  const { readSessionHistoryPage: _builtin, ...base } = new AgentProviderRegistry().get('codex')
  const provider: AgentProvider = { ...base, ...(reader ? { readSessionHistoryPage: reader } : {}) }
  const client = new AgentMuxClient({ store, providers: [provider] })
  clients.push(client)
  const owner = client as unknown as { registry: AgentMuxAgentSessionRegistry; kernel: CtxmuxRunAdapter }
  await owner.registry.load('local')
  return { client, store, owner, session }
}

describe('public native Session history pages', () => {
  it('derives capability from the optional Provider contribution', () => {
    const providers = new AgentProviderRegistry()
    expect(providers.get('codex').readSessionHistoryPage).toBeTypeOf('function')
    expect(providers.get('claude').readSessionHistoryPage).toBeUndefined()
  })

  it('returns exact bodies and resource order using native identity, without Run controls', async () => {
    const result: AgentProviderSessionHistoryPage = { source, nextCursor: 'opaque-main-next', items: [{
      id: 'user-1', turnId: 'turn-1', kind: 'user-message', contentParts: [
        { kind: 'text', text: '\n  exact 中 text\n' },
        { kind: 'resource', resourceType: 'image', reference: '/synthetic/image.png' },
        { kind: 'text', text: 'after image ' },
        { kind: 'resource', resourceType: 'audio', reference: 'native-file-id', label: 'sound' }
      ] }] }
    const reader = vi.fn(async (_context: AgentProviderSessionHistoryContext) => result)
    const { client, store, owner, session } = await harness(reader)
    const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map((name) =>
      vi.spyOn(owner.kernel, name as 'start'))
    expect(await client.sessionHistoryPage(session.agentSessionId)).toEqual({ agentSessionId: session.agentSessionId, ...result })
    expect(reader).toHaveBeenCalledOnce()
    expect(reader.mock.calls[0]![0]).toMatchObject({ source, limit: 30 })
    for (const control of controls) expect(control).not.toHaveBeenCalled()
    expect(await store.load()).toEqual([session])
  })

  it('uses the existing executable resolver and forwards configured invocation at the durable workspace', async () => {
    const reader = vi.fn(async (_context: AgentProviderSessionHistoryContext) => page())
    const { client } = await harness(reader)
    await client.sessionHistoryPage('main-session', {
      commandOverride: '  /synthetic/configured-codex  ', args: ['--config', 'model="synthetic"'],
      env: { CODEX_HOME: '/synthetic/executor-home', REMOVE_ME: undefined }
    })
    expect(reader.mock.calls).toHaveLength(1)
    expect(reader.mock.calls[0]![0]).toMatchObject({ command: '/synthetic/configured-codex',
      args: ['--config', 'model="synthetic"'], env: { CODEX_HOME: '/synthetic/executor-home', REMOVE_ME: undefined },
      workspacePath: '/synthetic', source, limit: 30 })
    await client.sessionHistoryPage('main-session')
    expect(reader.mock.calls[1]![0]).toMatchObject({ command: 'codex', args: [], env: {}, workspacePath: '/synthetic' })
  })

  it('keeps an empty page continuation opaque and lets the next page continue', async () => {
    const reader = vi.fn(async (context: AgentProviderSessionHistoryContext) => context.cursor === undefined
      ? { source, items: [], nextCursor: 'same-native-empty-page-cursor' }
      : page())
    const { client } = await harness(reader)
    const first = await client.sessionHistoryPage('main-session', { limit: 5 })
    expect(first).toEqual({ agentSessionId: 'main-session', source, items: [], nextCursor: 'same-native-empty-page-cursor' })
    const second = await client.sessionHistoryPage('main-session', { limit: 5, cursor: first.nextCursor! })
    expect(second.items).toEqual([item])
    expect(reader.mock.calls[1]![0].cursor).toBe('same-native-empty-page-cursor')
  })

  it.each([0, -1, 101, 1.5, NaN, Infinity])('rejects invalid finite page limit %s before invoking the reader', async (limit) => {
    const reader = vi.fn(async () => page())
    const { client } = await harness(reader)
    await expect(client.sessionHistoryPage('main-session', { limit })).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_HISTORY_OPTIONS' })
    expect(reader).not.toHaveBeenCalled()
  })

  it('reports unsupported and missing main identity without adopting the transcript path', async () => {
    const unsupported = await harness()
    await expect(unsupported.client.sessionHistoryPage('main-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_UNSUPPORTED' })
    const reader = vi.fn(async () => page())
    const unbound = await harness(reader, false)
    await expect(unbound.client.sessionHistoryPage('main-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
    expect(reader).not.toHaveBeenCalled()
  })

  it('rejects another Provider or native source returned asynchronously', async () => {
    for (const wrong of [{ providerId: 'other-provider', nativeSessionId: source.nativeSessionId },
      { providerId: 'codex', nativeSessionId: 'child-native-id' }]) {
      const { client } = await harness(async () => ({ ...page(), source: wrong }))
      await expect(client.sessionHistoryPage('main-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    }
  })

  it('refuses a stale page when canonical main native identity changes during reading', async () => {
    let resolve!: (page: AgentProviderSessionHistoryPage) => void
    const { client, owner } = await harness(async () => new Promise((done) => { resolve = done }))
    const result = client.sessionHistoryPage('main-session')
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    const current = owner.registry.get('main-session')
    await owner.registry.update('main-session', current.run, (session) => ({ ...session,
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'new-main-native-id' } }))
    resolve(page())
    await expect(result).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  })

  it('bounds concurrent reads and frees the slot after completion', async () => {
    const resolutions: Array<(page: AgentProviderSessionHistoryPage) => void> = []
    const reader = vi.fn(async () => new Promise<AgentProviderSessionHistoryPage>((resolve) => { resolutions.push(resolve) }))
    const { client } = await harness(reader)
    const requests = Array.from({ length: 4 }, () => client.sessionHistoryPage('main-session'))
    await expect(client.sessionHistoryPage('main-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_BUSY' })
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(4))
    expect(reader).toHaveBeenCalledTimes(4)
    resolutions[0]!(page())
    expect((await requests[0]!).items).toEqual([item])
    const fifth = client.sessionHistoryPage('main-session')
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(5))
    expect(reader).toHaveBeenCalledTimes(5)
    resolutions.slice(1).forEach((resolve) => resolve(page()))
    await Promise.all([...requests, fifth])
  })

  it.each(['disconnect', 'dispose'] as const)('%s aborts outstanding read resources without waiting on the Provider', async (operation) => {
    let signal!: AbortSignal
    const { client } = await harness(async (context) => { signal = context.signal; return new Promise(() => {}) })
    const request = client.sessionHistoryPage('main-session')
    const rejection = expect(request).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_CANCELLED' })
    await vi.waitFor(() => expect(signal).toBeDefined())
    await client[operation]()
    await rejection
    expect(signal.aborted).toBe(true)
  })

  it('times out a nonresponding Provider without waiting for it', async () => {
    vi.useFakeTimers()
    const { client } = await harness(async () => new Promise(() => {}))
    const request = client.sessionHistoryPage('main-session')
    const rejection = expect(request).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
    vi.useRealTimers()
  })

  it.each(['timeout', 'disconnect'] as const)('keeps %s cancelled Provider operations within the physical concurrency bound', async (operation) => {
    vi.useFakeTimers()
    const resolutions: Array<(result: AgentProviderSessionHistoryPage) => void> = []
    const signals: AbortSignal[] = []
    const reader = vi.fn(async (context: AgentProviderSessionHistoryContext) => {
      signals.push(context.signal)
      // Further calls settle immediately, making an incorrect released slot an assertion failure.
      if (signals.length > 4) return page()
      return new Promise<AgentProviderSessionHistoryPage>((resolve) => { resolutions.push(resolve) })
    })
    const { client } = await harness(reader)
    const requests = Array.from({ length: 4 }, () => client.sessionHistoryPage('main-session'))
    const failures = requests.map((request) => expect(request).rejects.toMatchObject({
      code: operation === 'timeout' ? 'AGENT_SESSION_HISTORY_TIMEOUT' : 'AGENT_SESSION_HISTORY_CANCELLED'
    }))
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(4))
    if (operation === 'timeout') await vi.advanceTimersByTimeAsync(10_000)
    else client.disconnect()
    await Promise.all(failures)
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true, true])
    await expect(client.sessionHistoryPage('main-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_BUSY' })
    expect(reader).toHaveBeenCalledTimes(4)
    resolutions[0]!(page())
    await vi.advanceTimersByTimeAsync(0)
    expect((await client.sessionHistoryPage('main-session')).items).toEqual([item])
    expect(reader).toHaveBeenCalledTimes(5)
    resolutions.slice(1).forEach((resolve) => resolve(page()))
    vi.useRealTimers()
  })

  it.each(['initial', 'final'] as const)('keeps a timed-out %s durable Store read within the same physical concurrency bound', async (phase) => {
    vi.useFakeTimers()
    const reader = vi.fn(async () => page())
    const { client, store } = await harness(reader)
    const originalLoad = store.load.bind(store)
    const values = await originalLoad()
    const resolutions: Array<(values: readonly unknown[]) => void> = []
    const load = vi.spyOn(store, 'load').mockImplementation(async () => {
      if ((phase === 'initial' || load.mock.calls.length > 4) && resolutions.length < 4) {
        return await new Promise<readonly unknown[]>((resolve) => { resolutions.push(resolve) })
      }
      return await originalLoad()
    })
    const requests = Array.from({ length: 4 }, () => client.sessionHistoryPage('main-session'))
    const failures = requests.map((request) => expect(request).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TIMEOUT' }))
    await vi.waitFor(() => expect(resolutions).toHaveLength(4))
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all(failures)
    const expectedReads = phase === 'initial' ? 4 : 8
    expect(load).toHaveBeenCalledTimes(expectedReads)
    await expect(client.sessionHistoryPage('main-session')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_BUSY' })
    expect(load).toHaveBeenCalledTimes(expectedReads)
    resolutions[0]!(values)
    await vi.advanceTimersByTimeAsync(0)
    expect((await client.sessionHistoryPage('main-session')).items).toEqual([item])
    resolutions.slice(1).forEach((resolve) => resolve(values))
    load.mockRestore()
    vi.useRealTimers()
  })

  it('reads a reopened durable FileStore before Runtime connection and fences later durable identity changes', async () => {
    const root = await mkdtemp('/tmp/amxhs-')
    try {
      const { session } = await harness()
      const path = join(root, 'agent-sessions.json')
      await new AgentMuxFileAgentSessionStore(path).compareAndSwap(null, session)
      const original = await readFile(path)
      const reader = vi.fn(async () => page())
      const { readSessionHistoryPage: _builtin, ...provider } = new AgentProviderRegistry().get('codex')
      const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(path),
        providers: [{ ...provider, readSessionHistoryPage: reader }] })
      clients.push(client)
      const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
      const connect = vi.spyOn(kernel, 'connect').mockRejectedValue(new Error('Synthetic Runtime unavailable'))
      const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map((name) => vi.spyOn(kernel, name as 'start'))
      await expect(client.sessionHistoryPage(session.agentSessionId)).resolves.toEqual({ agentSessionId: session.agentSessionId, ...page() })
      expect(reader).toHaveBeenCalledOnce()
      expect(connect).not.toHaveBeenCalled()
      for (const control of controls) expect(control).not.toHaveBeenCalled()
      expect(await readFile(path)).toEqual(original)

      let settle!: (result: AgentProviderSessionHistoryPage) => void
      reader.mockImplementationOnce(async () => new Promise((resolve) => { settle = resolve }))
      const reading = client.sessionHistoryPage(session.agentSessionId)
      await vi.waitFor(() => expect(settle).toBeTypeOf('function'))
      await new AgentMuxFileAgentSessionStore(path).compareAndSwap(session, { ...session,
        nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'another-main-native-id' }, updatedAt: 2 })
      settle(page())
      await expect(reading).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
      expect(connect).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed, oversized or over-limit pages as reading failures', async () => {
    const malformed = { ...page(), items: [{ ...item, contentParts: [{ kind: 'resource', reference: 'file' }] }] }
    const oversized = { ...page(), items: [{ ...item, contentParts: [{ kind: 'text', text: 'x'.repeat(4 * 1024 * 1024) }] }] }
    const excessive = { ...page(), items: Array.from({ length: 31 }, (_, index) => ({ ...item, id: String(index) })) }
    for (const [value, code] of [[malformed, 'INVALID_AGENT_SESSION_HISTORY_PAGE'], [oversized, 'AGENT_SESSION_HISTORY_TOO_LARGE'],
      [excessive, 'INVALID_AGENT_SESSION_HISTORY_PAGE']] as const) {
      const { client } = await harness(async () => value as AgentProviderSessionHistoryPage)
      await expect(client.sessionHistoryPage('main-session')).rejects.toMatchObject({ code })
    }
  })
})
