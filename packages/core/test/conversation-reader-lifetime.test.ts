import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { consumeConversationWindowPage, type AgentConversationReadPage, type ConversationWindowAssembly } from '../src/conversation.js'
import { conversationReaderCli } from './helpers/conversation-reader-cli.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(body = 'Original complete body') {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'original', sessionId: 'native-main', message: { role: 'user', content: body } }]))
  closes.push(f.close)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  return { ...f, rpc, ref: { hostId: 'local', agentSessionId: f.session.agentSessionId } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function holdPages(f: Fixture) {
  // The selected native source enters this original logical reader, not the public convenience method.
  const reader = f.client as unknown as { readSessionHistoryPage: typeof f.client.sessionHistoryPage }
  const original = reader.readSessionHistoryPage.bind(f.client), gates: Array<{ resolve(): void; reject(error: Error): void }> = []
  const pending: Promise<unknown>[] = []
  const spy = vi.spyOn(reader, 'readSessionHistoryPage').mockImplementation(async (...args) => {
    // Delay delivery only after the actual Provider operation has completed.
    // Seventeen logical reads never bypass its physical read concurrency limit.
    const page = await original(...args), signal = args[1]?.signal
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal?.reason)
      const done = (error?: Error) => { signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
      signal?.addEventListener('abort', abort, { once: true })
      gates.push({ resolve: () => done(), reject: error => done(error) })
      if (signal?.aborted) abort()
    })
    return page
  })
  const start = (input: { limit?: number; maxBytes?: number } = {}) => { const promise = f.rpc.call('agent.conversation.inspect', { ...f.ref, limit: 100, ...input }); pending.push(promise); void promise.catch(() => {}); return promise }
  closes.push(async () => { spy.mockRestore(); for (const gate of gates) gate.resolve(); await Promise.allSettled(pending) })
  return { gates, spy, start, wait: (count: number) => vi.waitFor(() => expect(gates).toHaveLength(count), { timeout: 5000 }) }
}
const untouched = (f: Fixture) => expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
async function resume(f: Fixture, view: string) {
  const result = await f.rpc.call('agent.conversation.inspect', { ...f.ref, view }).then(page => ({ page, error: undefined }), error => ({ page: undefined, error }))
  expect(result.error?.code ?? null, 'The exact response view must survive its active read handoff').toBeNull()
  expect(result.page).toBeDefined(); return result.page!
}

it('a first public response remains resumable and observable while sixteen other original reads are still in flight', async () => {
  const f = await fixture(), hold = holdPages(f), requests: Promise<AgentConversationReadPage>[] = []
  for (let i = 0; i < 17; i++) { requests.push(hold.start()); await hold.wait(i + 1) }
  hold.gates[0]!.resolve()
  const first = await requests[0]!
  expect(first.window.complete).toBe(true); expect(first.window.itemCount).toBe(1)
  const repeated = await resume(f, first.window.view!)
  expect(repeated.window).toMatchObject({ id: first.window.id, revision: first.window.revision, checkpoint: first.window.checkpoint, complete: true }); expect(repeated.items).toEqual(first.items)
  const opening = vi.fn()
  const observation = await f.rpc.subscribe('agent.conversation.watch', { ...f.ref, view: first.window.view! }, { onInitial: opening, onEvent() {} })
  expect(opening).toHaveBeenCalledTimes(1); await observation.dispose()
  const released = await f.rpc.call('agent.conversation.release', { ...f.ref, view: first.window.view! })
  expect(released).toMatchObject({ viewId: first.window.id, released: true })
  await expect(f.rpc.call('agent.conversation.inspect', { ...f.ref, view: first.window.view! })).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_VIEW_EXPIRED' })
  untouched(f)
})

it('the last completing original becomes recent without expanding the genuinely parked window inventory', async () => {
  const f = await fixture(), hold = holdPages(f), requests: Promise<AgentConversationReadPage>[] = []
  for (let i = 0; i < 17; i++) { requests.push(hold.start()); await hold.wait(i + 1) }
  const parked: AgentConversationReadPage[] = []
  for (let i = 1; i < 17; i++) { hold.gates[i]!.resolve(); parked.push(await requests[i]!) }
  hold.gates[0]!.resolve(); const latest = await requests[0]!
  expect((await resume(f, latest.window.view!)).window.id).toBe(latest.window.id)
  await expect(f.rpc.call('agent.conversation.inspect', { ...f.ref, view: parked[0]!.window.view! })).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_VIEW_EXPIRED' })
  untouched(f)
})

it('cancelled and failed original reads return their qualification and explicit release never resurrects an in-flight view', async () => {
  const f = await fixture(), page = await f.client.readAgentConversation(f.ref)
  const controller = new AbortController()
  const reader = f.client as unknown as { nativeHistoryChangesPage: typeof f.client.readSessionHistoryChanges }
  const native = reader.nativeHistoryChangesPage.bind(f.client)
  let entered = false
  const changes = vi.spyOn(reader, 'nativeHistoryChangesPage').mockImplementation(async (...args) => {
    const result = await native(...args); entered = true
    await new Promise<void>((resolve, reject) => {
      const signal = args[1]!.signal!, abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })
    return result
  })
  const cancelled = f.client.readConversationChanges({ ...f.ref, checkpoint: page.window.checkpoint, view: page.window.view! }, { signal: controller.signal })
  void cancelled.catch(() => {}); await vi.waitFor(() => expect(entered).toBe(true)); controller.abort(new Error('Only this original reader was cancelled'))
  await expect(cancelled).rejects.toThrow('Only this original reader was cancelled'); changes.mockRestore()
  for (let i = 0; i < 17; i++) await f.client.readAgentConversation(f.ref)
  expect(await f.client.readAgentConversation({ ...f.ref, view: page.window.view! }).then(() => null, error => error.code)).toBe('AGENT_CONVERSATION_VIEW_EXPIRED')

  const failed = await f.client.readAgentConversation(f.ref)
  // A source refusal is isolated coverage; an actual wire-budget failure still
  // exits the complete reader operation after its lifetime has been acquired.
  await expect(f.client.readAgentConversation({ ...f.ref, view: failed.window.view!, maxBytes: 4096 })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_BUDGET' })
  for (let i = 0; i < 17; i++) await f.client.readAgentConversation(f.ref)
  await expect(f.client.readAgentConversation({ ...f.ref, view: failed.window.view! })).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_VIEW_EXPIRED' })

  const released = await f.client.readAgentConversation(f.ref)
  let ready = false, resume!: () => void
  const source = vi.spyOn(reader, 'nativeHistoryChangesPage').mockImplementation(async (...args) => {
    const result = await native(...args); ready = true
    await new Promise<void>(resolve => { resume = resolve })
    return result
  })
  const reading = f.client.readConversationChanges({ ...f.ref, checkpoint: released.window.checkpoint, view: released.window.view! })
  let readingError: unknown
  void reading.catch(error => { readingError = error })
  try {
    await vi.waitFor(() => expect(ready || Boolean(readingError)).toBe(true))
    expect(readingError).toBeUndefined(); expect(ready).toBe(true)
    expect(await f.client.releaseConversationView({ ...f.ref, view: released.window.view! })).toMatchObject({ released: true })
  } finally { resume?.(); await Promise.allSettled([reading]); source.mockRestore() }
  await expect(f.client.readAgentConversation({ ...f.ref, view: released.window.view! })).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_VIEW_EXPIRED' })
  expect((await f.bytes()).native).toEqual(f.before.native); expect(await f.store.load()).toEqual([expect.objectContaining({ agentSessionId: f.session.agentSessionId, run: f.session.run })])
  untouched(f)
})

it('fragment replay and exact release preserve the original frame without reviving released temporary state', async () => {
  const body = 'Original fragmented Unicode 中🙂. '.repeat(1800), f = await fixture(body)
  const input = { ...f.ref, maxBytes: 16 * 1024, limit: 1 }, hold = holdPages(f), requests: Promise<AgentConversationReadPage>[] = []
  for (let i = 0; i < 17; i++) { requests.push(hold.start(input)); await hold.wait(i + 1) }
  hold.gates[0]!.resolve(); const first = await requests[0]!

  expect(first.window.complete).toBe(false); expect(first.items).toHaveLength(1); expect(first.items[0]!.kind).toBe('fragment')
  const replay = await f.rpc.call('agent.conversation.inspect', { ...input, cursor: first.window.replay })
  expect(replay).toEqual(first)
  let page = first, assembly: ConversationWindowAssembly | undefined
  for (let i = 0; i < 60; i++) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(input.maxBytes)
    const result = consumeConversationWindowPage(page, assembly)
    if (result.kind === 'complete') {
      expect(result.snapshot.units).toHaveLength(1)
      expect(result.snapshot.units[0]!.records[0]!.original).toMatchObject({ item: { contentParts: [{ kind: 'text', text: body }] } })
      expect(result.snapshot.window.id).toBe(first.window.id); break
    }
    assembly = result.pending; expect(page.nextCursor).toBeTruthy()
    page = await f.rpc.call('agent.conversation.inspect', { ...input, cursor: page.nextCursor! })
  }
  expect(page.window.complete).toBe(true)
  const cli = await conversationReaderCli(f.root); closes.push(cli.close)
  const repeated = await cli.run(['agent', 'conversation', 'inspect', '--input', '-'], JSON.stringify({ ...f.ref, view: page.window.view!, maxBytes: 128 * 1024 }))
  expect(repeated.code, repeated.stderr).toBe(0)
  const output = JSON.parse(repeated.stdout)
  expect(output.operation).toBe('agent.conversation.inspect'); expect(output.result.window).toMatchObject({ id: first.window.id, revision: first.window.revision, complete: true })
  expect(consumeConversationWindowPage(output.result)).toMatchObject({ kind: 'complete' })
  const release = await f.rpc.call('agent.conversation.release', { ...f.ref, view: page.window.view! })
  expect(release.released).toBe(true)
  await expect(f.rpc.call('agent.conversation.inspect', { ...input, cursor: first.window.replay })).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_VIEW_EXPIRED' })
  untouched(f)
})
