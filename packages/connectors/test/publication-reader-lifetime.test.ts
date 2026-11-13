import { appendFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentConversationReadPage } from '@agentmux/core/conversation'
import { PublicationHost } from '../src/publication-host.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import type { PublicationAdapter } from '../src/publication-adapter.js'
import { roomBindingFixture, context } from './fixtures/room-binding.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const row = (id: string, text: string) => JSON.stringify({ sessionId: 'original-native', uuid: id, type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
const gate = () => { let open!: () => void; const promise = new Promise<void>(done => { open = done }); cleanup.push(open); return { promise, open } }

async function fixture() {
  const sent: string[] = []
  const publication: PublicationAdapter = { adapterId: 'sample', renderVersion: 'lifetime-v1', supportedRenderVersions: ['lifetime-v1'], fragmentBytes: 8192,
    prepare: operation => ({ adapterId: 'sample', renderVersion: 'lifetime-v1', requestKey: operation.operationId,
      request: { method: 'POST', path: '/messages', body: JSON.stringify(operation.payload) } }),
    dispatch: async request => { sent.push(request.requestKey); return { state: 'confirmed', mapping: { messageId: request.requestKey } } } }
  const f = await roomBindingFixture(true, { adapters: [{ adapterId: 'sample', publication,
    test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }] })
  cleanup.push(f.close)
  const port = createPublicationConversationPort(() => [{ hostId: 'local', client: f.client }])
  const bound = await f.bindings.bind(f.input, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Original publication Binding required')
  const release = vi.spyOn(port, 'release')
  let host = new PublicationHost({ connections: f.connections, bindings: f.bindings, conversation: port }); cleanup.push(() => host.close())
  const lanes = () => Reflect.get(host, 'lanes') as Map<string, { work?: Promise<void>; view?: string; viewId?: string; binding: { revision: number } }>
  const views = Reflect.get(Reflect.get(f.client, 'conversationReadState'), 'views') as Map<string, unknown>
  const idle = () => vi.waitFor(() => { expect(lanes().get(bound.binding.bindingId)?.work).toBeUndefined(); expect(lanes().get(bound.binding.bindingId)?.view).toBeTypeOf('string') })
  await idle()
  const unrelated = await f.client.readAgentConversation(f.reference)
  const untouched = () => {
    expect(views.has(unrelated.window.id), 'Releasing publication must preserve another consumer of this same Session').toBe(true)
    const kernel = Reflect.get(f.client, 'kernel')
    expect(['start', 'input', 'attach', 'stop', 'resize', 'status'].map(name => vi.mocked(Reflect.get(kernel, name)).mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  }
  return { ...f, port, get host() { return host }, sent, binding: bound.binding, get lanes() { return lanes() }, views, idle, release, untouched,
    restart() { host.close(); host = new PublicationHost({ connections: f.connections, bindings: f.bindings, conversation: port }) } }
}

/** A saved representation from before purpose qualification is rechecked through the actual exact-record consumer. */
async function pendingQualification(f: Awaited<ReturnType<typeof fixture>>, id: string, text: string) {
  const credential = vi.spyOn(f.connections, 'resolveCredential').mockResolvedValue(null)
  await appendFile(f.transcript, row(id, text)); f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding).some(operation => operation.payload.text?.includes(text.slice(0, 30)) && operation.state === 'pending')).toBe(true))
  await f.idle()
  f.host.close()
  const database = f.connections.database
  const rows = database.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='representation'").all()
  expect(rows.length).toBeGreaterThan(0)
  const write = database.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?')
  for (const row of rows) { const value = JSON.parse(String(row.decision_json)); delete value.purpose; write.run(JSON.stringify(value), row.rowid!) }
  credential.mockRestore(); f.restart()
}

it.each(['close', 'pause', 'revision'] as const)('the real publication %s releases its exact lane reader and preserves another consumer', async action => {
  const f = await fixture(), original = f.lanes.get(f.binding.bindingId)!, id = original.viewId!
  expect(f.views.has(id)).toBe(true)
  if (action === 'close') f.host.close()
  else if (action === 'pause') { await f.bindings.pause({ operationId: 'pause-lifetime', bindingId: f.binding.bindingId, expectedRevision: f.binding.revision }, context); f.host.refresh() }
  else {
    const revised = await f.bindings.relink({ ...f.input, operationId: 'revise-lifetime', expectedRevision: f.binding.revision, externalConversationId: 'revised-room' }, context)
    expect(revised.state).toBe('applied'); f.host.refresh(); await f.idle()
    expect(f.lanes.get(f.binding.bindingId)?.binding.revision).not.toBe(f.binding.revision)
  }
  await vi.waitFor(() => expect(f.views.has(id), 'Discarding a lane must release its Core window, not only its watch').toBe(false))
  expect(f.release).toHaveBeenCalled(); f.untouched()
})

it('a failed catch-up releases its accepted reader and can read the same durable cut again', async () => {
  const f = await fixture(), id = f.lanes.get(f.binding.bindingId)!.viewId!
  const failure = vi.spyOn(f.port, 'changes').mockRejectedValue(new Error('Controlled source observation failure'))
  f.host.refresh()
  await vi.waitFor(() => expect(f.lanes.get(f.binding.bindingId)?.view).toBeUndefined())
  expect(f.views.has(id)).toBe(false)
  failure.mockRestore(); f.host.refresh(); await f.idle()
  expect(f.lanes.get(f.binding.bindingId)!.viewId).not.toBe(id)
  f.untouched()
})

it('exact pending-record qualification releases its temporary reader after successful publication', async () => {
  const f = await fixture(), pages: AgentConversationReadPage[] = []
  const original = f.port.inspect.bind(f.port)
  vi.spyOn(f.port, 'inspect').mockImplementation(async (...args) => { const page = await original(...args); pages.push(page); return page })
  await pendingQualification(f, 'qualified-lifetime', 'Original reply remains independently publishable')
  await vi.waitFor(() => expect(f.host.store.list(f.binding).some(operation => operation.payload.text?.includes('Original reply remains') && operation.state === 'confirmed')).toBe(true))
  await f.idle()
  expect(pages.length).toBeGreaterThan(0)
  expect(pages.every(page => !f.views.has(page.window.id)), 'Completed exact qualification must not leave parked Core windows').toBe(true)
  f.untouched()
})

it('an incomplete exact qualification releases its replay window on failure', async () => {
  const f = await fixture(), original = f.port.inspect.bind(f.port), pages: AgentConversationReadPage[] = []
  vi.spyOn(f.port, 'inspect').mockImplementation(async (input, signal) => {
    if (input.cursor) throw Error('Controlled exact continuation failure')
    const page = await original(input, signal); pages.push(page); return page
  })
  await pendingQualification(f, 'fragmented-lifetime', 'Original long reply '.repeat(12_000))
  await vi.waitFor(() => expect(pages.some(page => !page.window.complete && page.window.view === null)).toBe(true))
  await vi.waitFor(() => expect(pages.every(page => !f.views.has(page.window.id)), 'Failed partial details must release the replay token when view is null').toBe(true))
  f.untouched()
})

it('a cancelled qualification releases a late original reply without publishing or stopping the Agent', async () => {
  const f = await fixture(), original = f.port.inspect.bind(f.port), held = gate()
  let delivered: AgentConversationReadPage | undefined
  vi.spyOn(f.port, 'inspect').mockImplementation(async (...args) => { delivered = await original(...args); await held.promise; return delivered })
  await pendingQualification(f, 'late-lifetime', 'Retained original late reply')
  await vi.waitFor(() => expect(delivered).toBeDefined())
  const sent = f.sent.length
  f.host.close(); held.open()
  await vi.waitFor(() => expect(f.views.has(delivered!.window.id), 'Late cancellation cleanup releases only its original returned window').toBe(false))
  expect(f.sent).toHaveLength(sent); f.untouched()
})

it('the actual resource-gap recovery releases each anchored detail reader', async () => {
  const f = await fixture(), original = f.port.inspect.bind(f.port), pages: AgentConversationReadPage[] = []
  vi.spyOn(f.port, 'resource').mockRejectedValue(new Error('Original resource observation is temporarily unavailable'))
  vi.spyOn(f.port, 'inspect').mockImplementation(async (...args) => { const page = await original(...args); if (args[0].anchor) pages.push(page); return page })
  // Physical escaped bytes cross the original native text-resource boundary.
  await appendFile(f.transcript, row('resource-gap-lifetime', '\0'.repeat(360_000))); f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.coverage(f.binding).gaps.some(gap => gap.reason === 'resource-unavailable')).toBe(true), { timeout: 5000 })
  await vi.waitFor(() => expect(pages.length).toBeGreaterThan(0), { timeout: 5000 })
  f.host.close()
  await vi.waitFor(() => expect(pages.every(page => !f.views.has(page.window.id)), 'Anchored recovery must release exact temporary readers even when the resource stays unavailable').toBe(true))
  f.untouched()
})
