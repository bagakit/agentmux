import { appendFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import type { AgentProviderSessionHistoryObservationContext, AgentSessionHistoryObservation, AgentSessionHistoryObservationHandle } from '../src/types.js'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'

const watched = vi.hoisted(() => ({ names: [] as string[], closes: [] as ReturnType<typeof vi.fn>[], statCount: 0,
  notify: [] as ((name: string) => void)[] }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, stat: (...args: Parameters<typeof original.stat>) => { watched.statCount++; return original.stat(...args) } }
})
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, watch: ((path: string, options: import('node:fs').WatchOptions, listener: import('node:fs').WatchListener<string>) => {
    const watcher = original.watch(path, options, (event, name) => {
      watched.names.push(name?.toString() ?? '<unknown>')
      listener(event, name)
    })
    const close = vi.fn(watcher.close.bind(watcher))
    watcher.close = close
    watched.closes.push(close)
    watched.notify.push(name => watcher.emit('change', 'change', name))
    return watcher
  }) }
})

type Fixture = Awaited<ReturnType<typeof nativeHistoryFixture>>
const fixtures: Fixture[] = []
const clients: AgentMuxClient[] = []
beforeEach(() => { watched.names = []; watched.closes = []; watched.statCount = 0; watched.notify = [] })
afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose()
  for (const fixture of fixtures.splice(0)) {
    expect(fixture.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
    const bytes = await fixture.bytes()
    expect(bytes.store).toEqual(fixture.before.store)
    await fixture.close()
  }
  vi.restoreAllMocks()
})

function row(provider: 'claude' | 'pi', id: string, parent: string | null, timed = true) {
  const timestamp = timed ? { timestamp: '2026-10-04T00:00:00.000Z' } : {}
  return provider === 'claude'
    ? { uuid: id, type: 'user', sessionId: 'native-main', message: { role: 'user', content: 'Identical body.' }, ...timestamp }
    : { id, type: 'message', parentId: parent, message: { role: 'user', content: [{ type: 'text', text: 'Identical body.' }] }, ...timestamp }
}
async function setup(provider: 'claude' | 'pi') {
  const fixture = await nativeHistoryFixture(provider, (root) => jsonl([
    ...(provider === 'pi' ? [{ type: 'session', version: 3, id: 'native-main', cwd: root }] : []),
    row(provider, 'initial', null)
  ]))
  fixtures.push(fixture)
  return fixture
}

for (const provider of ['claude', 'pi'] as const) {
  it(`${provider}: relevant durable append invalidates and public pages retain equal bodies as three distinct native IDs`, async () => {
    const fixture = await setup(provider)
    const events: AgentSessionHistoryObservation[] = []
    const handle = await fixture.client.observeSessionHistory('private-agent', event => events.push(event))
    expect(handle.source).toEqual({ providerId: provider, nativeSessionId: 'native-main' })
    const first = await fixture.client.sessionHistoryPage('private-agent', { limit: 30 })
    expect(first.items.map(item => item.id)).toEqual(['initial'])
    await appendFile(fixture.path, jsonl([row(provider, 'same-body-new', 'initial'), row(provider, 'untimed-new', 'same-body-new', false)]))
    await vi.waitFor(() => expect(events.filter(event => event.kind === 'invalidated').length).toBeGreaterThan(0))
    expect(events[0]).toEqual({ kind: 'invalidated', agentSessionId: 'private-agent', source: handle.source })
    const page = await fixture.client.sessionHistoryPage('private-agent', { limit: 30 })
    expect(page.items.map(item => item.id)).toEqual(['initial', 'same-body-new', 'untimed-new'])
    expect(page.items.map(item => item.startedAt === undefined)).toEqual([false, false, true])
    handle.dispose(); handle.dispose()
    expect(watched.closes).toHaveLength(1)
    expect(watched.closes.map(close => close.mock.calls.length)).toEqual([1])
  })

  it(`${provider}: real unrelated directory notification does not invalidate the exact target`, async () => {
    const fixture = await setup(provider)
    const events: AgentSessionHistoryObservation[] = []
    const handle = await fixture.client.observeSessionHistory('private-agent', event => events.push(event))
    await writeFile(join(fixture.root, 'unrelated-C.jsonl'), 'Actual unrelated bytes.\n')
    await vi.waitFor(() => expect(watched.names).toContain('unrelated-C.jsonl'))
    expect(events).toEqual([])
    handle.dispose()
  })
}

it('same-path inode replacement reports source change and closes the old observation without Runtime control', async () => {
  const fixture = await setup('claude')
  const events: AgentSessionHistoryObservation[] = []
  const handle = await fixture.client.observeSessionHistory('private-agent', event => events.push(event))
  const replacement = join(fixture.root, 'replacement.jsonl')
  await writeFile(replacement, jsonl([row('claude', 'replacement', null)]))
  await rename(replacement, fixture.path)
  await vi.waitFor(() => expect(events.some(event => event.kind === 'unavailable')).toBe(true))
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ kind: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', source: handle.source })
  expect(watched.closes.map(close => close.mock.calls.length)).toEqual([1])
  handle.dispose()
})

it('a Consumer abort releases an already acquired resource exactly once', async () => {
  const fixture = await setup('claude')
  const controller = new AbortController()
  const handle = await fixture.client.observeSessionHistory('private-agent', () => {}, { signal: controller.signal })
  expect(watched.closes).toHaveLength(1)
  controller.abort()
  handle.dispose()
  expect(watched.closes.map(close => close.mock.calls.length)).toEqual([1])
})

it('cancelled pending acquisition promptly rejects and still releases a Provider handle that arrives late', async () => {
  const fixture = await setup('claude')
  const native = fixture.client.providers.get('claude')
  let resolve!: (handle: AgentSessionHistoryObservationHandle) => void
  const acquire = vi.fn(() => new Promise<AgentSessionHistoryObservationHandle>(done => { resolve = done }))
  const client = new AgentMuxClient({ store: fixture.store, providers: [{ ...native, observeSessionHistory: acquire }] })
  clients.push(client)
  const controller = new AbortController()
  const result = client.observeSessionHistory('private-agent', () => {}, { signal: controller.signal })
  const rejected = result.then(() => { throw new Error('Cancelled acquisition unexpectedly succeeded') }, reason => reason)
  await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1))
  // Attach the exact rejection assertion after an actual explicit abort reason exists.
  const reason = new Error('Consumer left before ready')
  controller.abort(reason)
  expect(await rejected).toBe(reason)
  const dispose = vi.fn()
  resolve({ source: { providerId: 'claude', nativeSessionId: 'native-main' }, dispose })
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1))
})

it('Providers without the observation contribution are explicitly unsupported while ordinary page reading remains available', async () => {
  const fixture = await setup('claude')
  const { observeSessionHistory: _unused, ...native } = fixture.client.providers.get('claude')
  const client = new AgentMuxClient({ store: fixture.store, providers: [native] })
  clients.push(client)
  await expect(client.observeSessionHistory('private-agent', () => {})).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED' })
  expect((await client.sessionHistoryPage('private-agent', { limit: 30 })).items.map(item => item.id)).toEqual(['initial'])
  expect(watched.closes).toEqual([])
})

it('live observations do not consume the four Provider page-read slots', async () => {
  const fixture = await setup('claude')
  const handles: AgentSessionHistoryObservationHandle[] = []
  for (let count = 0; count < 5; count++) handles.push(await fixture.client.observeSessionHistory('private-agent', () => {}))
  expect(handles).toHaveLength(5)
  expect((await fixture.client.sessionHistoryPage('private-agent', { limit: 30 })).items.map(item => item.id)).toEqual(['initial'])
  for (const handle of handles) handle.dispose()
  expect(watched.closes.map(close => close.mock.calls.length)).toEqual([1, 1, 1, 1, 1])
})

it('ordinary Session updatedAt does not change a watch; a precise native binding change releases it', async () => {
  const fixture = await setup('claude')
  const events: AgentSessionHistoryObservation[] = []
  const handle = await fixture.client.observeSessionHistory('private-agent', event => events.push(event))
  const publisher = (fixture.client as unknown as { publisher: AgentMuxClientEventPublisher }).publisher
  publisher.publish({ type: 'agent-session', session: { ...fixture.session, updatedAt: 99 } })
  expect(events).toEqual([])
  expect(watched.closes.map(close => close.mock.calls.length)).toEqual([0])
  publisher.publish({ type: 'agent-session', session: { ...fixture.session,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'another-source', transcriptPath: fixture.path } } })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ kind: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect(watched.closes.map(close => close.mock.calls.length)).toEqual([1])
  handle.dispose()
})

it('a Provider cannot invalidate another source through a correctly acquired observation handle', async () => {
  const fixture = await setup('claude')
  let context!: AgentProviderSessionHistoryObservationContext
  const dispose = vi.fn()
  const native = fixture.client.providers.get('claude')
  const client = new AgentMuxClient({ store: fixture.store, providers: [{ ...native,
    observeSessionHistory: async value => { context = value; return { source: value.source, dispose } }
  }] })
  clients.push(client)
  const events: AgentSessionHistoryObservation[] = []
  const handle = await client.observeSessionHistory('private-agent', event => events.push(event))
  context.onChange({ kind: 'invalidated', source: { providerId: 'claude', nativeSessionId: 'other' } })
  expect(events).toEqual([{ kind: 'unavailable', agentSessionId: 'private-agent', source: handle.source,
    code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', message: 'Provider observed a different native history source. The existing window is retained.' }])
  expect(dispose).toHaveBeenCalledTimes(1)
  handle.dispose()
})

it('a buffered target notification with unchanged metadata does not invalidate the page', async () => {
  const fixture = await setup('claude')
  const events: AgentSessionHistoryObservation[] = []
  const handle = await fixture.client.observeSessionHistory('private-agent', event => events.push(event))
  expect(watched.notify).toHaveLength(1)
  const before = watched.statCount
  watched.notify[0]!(basename(fixture.path))
  await vi.waitFor(() => expect(watched.statCount).toBeGreaterThan(before))
  expect(events).toEqual([])
  handle.dispose()
})
