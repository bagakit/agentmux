import { appendFile, rename, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentProviderSessionHistoryObservationContext, AgentSessionHistoryObservation } from '../src/types.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { hostedTestFence, logicalHostedEvents } from './helpers/hosted-runtime-port.js'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, watch: vi.fn(original.watch) }
})
beforeEach(() => { vi.mocked(watch).mockClear() })

type Fixture = Awaited<ReturnType<typeof nativeHistoryFixture>>
const fixtures: Fixture[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  for (const f of fixtures.splice(0)) {
    expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
    expect((await f.bytes()).store).toEqual(f.before.store)
    await f.close()
  }
  vi.restoreAllMocks()
})
const row = (id: string) => ({ uuid: id, type: 'assistant', sessionId: 'native-main',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Original reply' }] } })
async function fixture() {
  const f = await nativeHistoryFixture('claude', jsonl([row('initial')]))
  fixtures.push(f)
  const provider = f.client.providers.get('claude')
  const native = provider.observeSessionHistory!
  const watch = vi.spyOn(provider, 'observeSessionHistory')
  return { ...f, watch, native }
}

it('shares the actual Provider watch while Consumers independently abort and release', async () => {
  const f = await fixture(), first = new AbortController(), second = new AbortController()
  const eventsA: AgentSessionHistoryObservation[] = [], eventsB: AgentSessionHistoryObservation[] = []
  const [a, b] = await Promise.all([
    f.client.observeSessionHistory('private-agent', event => eventsA.push(event), { signal: first.signal }),
    f.client.observeSessionHistory('private-agent', event => eventsB.push(event), { signal: second.signal })
  ])
  expect(f.watch).toHaveBeenCalledTimes(1)
  const providerHandle = await f.watch.mock.results[0]!.value
  const release = vi.spyOn(providerHandle, 'dispose')
  first.abort(new Error('First Consumer left')); a.dispose()
  expect(release).not.toHaveBeenCalled()
  await appendFile(f.path, jsonl([row('next')]))
  await vi.waitFor(() => expect(eventsB.some(event => event.kind === 'invalidated')).toBe(true))
  expect(eventsA).toEqual([])
  expect((await f.client.sessionHistoryPage('private-agent')).items.map(item => item.id)).toEqual(['initial', 'next'])
  second.abort(); b.dispose()
  expect(release).toHaveBeenCalledTimes(1)
  const reopened = await f.client.observeSessionHistory('private-agent', () => {})
  expect(f.watch).toHaveBeenCalledTimes(2)
  reopened.dispose()
})

it('does not cancel a pending shared acquisition when one Consumer leaves', async () => {
  const f = await fixture(), controller = new AbortController()
  let ready!: () => void, context!: AgentProviderSessionHistoryObservationContext
  const held = new Promise<void>(resolve => { ready = resolve })
  f.watch.mockImplementationOnce(async value => { context = value; await held; return await f.native(value) })
  const first = f.client.observeSessionHistory('private-agent', () => {}, { signal: controller.signal }).catch(error => error)
  const second = f.client.observeSessionHistory('private-agent', () => {})
  await vi.waitFor(() => expect(f.watch).toHaveBeenCalledTimes(1))
  const reason = new Error('Only the first Consumer cancelled')
  controller.abort(reason)
  expect(await first).toBe(reason)
  expect(context.signal.aborted).toBe(false)
  ready()
  const handle = await second
  expect(handle.source.nativeSessionId).toBe('native-main')
  expect(f.watch).toHaveBeenCalledTimes(1)
  handle.dispose()
})

it('cancellation racing Provider admission rejects only the departing Consumer', async () => {
  const f = await fixture(), controller = new AbortController(), reason = new Error('First Consumer left at admission')
  f.watch.mockImplementationOnce(async context => {
    const handle = await f.native(context)
    controller.abort(reason)
    return handle
  })
  const first = f.client.observeSessionHistory('private-agent', () => {}, { signal: controller.signal }).catch(error => error)
  const second = f.client.observeSessionHistory('private-agent', () => {})
  expect(await first).toBe(reason)
  const handle = await second
  expect(f.watch).toHaveBeenCalledTimes(1)
  expect(f.watch.mock.calls[0]![0].signal.aborted).toBe(false)
  handle.dispose()
})

it('keys invocation overrides by value without merging distinct Executor inputs', async () => {
  const f = await fixture()
  const handles = await Promise.all([
    f.client.observeSessionHistory('private-agent', () => {}, { env: { A: 'a', B: 'b' }, args: ['first'] }),
    f.client.observeSessionHistory('private-agent', () => {}, { args: ['first'], env: { B: 'b', A: 'a' } }),
    f.client.observeSessionHistory('private-agent', () => {}, { env: { A: 'a', B: 'b' }, args: ['second'] }),
    f.client.observeSessionHistory('private-agent', () => {}),
    f.client.observeSessionHistory('private-agent', () => {}, { args: [] })
  ])
  expect(f.watch).toHaveBeenCalledTimes(4)
  for (const handle of handles) handle.dispose()
})

it('retires a changed native source and lets a notification Consumer acquire its replacement', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = []
  let replacement: ReturnType<typeof f.client.observeSessionHistory> | undefined
  const a = await f.client.observeSessionHistory('private-agent', event => {
    events.push(event)
    if (event.kind === 'unavailable') replacement = f.client.observeSessionHistory('private-agent', () => {})
  })
  const b = await f.client.observeSessionHistory('private-agent', () => {})
  const next = join(f.root, 'replacement.jsonl')
  await writeFile(next, jsonl([row('replacement')]))
  await rename(next, f.path)
  await vi.waitFor(() => expect(replacement).toBeDefined())
  const acquired = await replacement!
  expect(events).toMatchObject([{ kind: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' }])
  expect(f.watch).toHaveBeenCalledTimes(2)
  a.dispose(); b.dispose()
  expect(f.watch.mock.calls[1]![0].signal.aborted).toBe(false)
  acquired.dispose()
})

it('observation uncertainty retains the original watch, records and Run capabilities', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = []
  let context!: AgentProviderSessionHistoryObservationContext
  f.watch.mockImplementationOnce(async value => { context = value; return await f.native(value) })
  const a = await f.client.observeSessionHistory('private-agent', event => events.push(event))
  context.onChange({ kind: 'unavailable', code: 'OBSERVATION_UNCERTAIN', message: 'Native observation is temporarily unavailable.' })
  const b = await f.client.observeSessionHistory('private-agent', () => {})
  expect(f.watch).toHaveBeenCalledTimes(1)
  expect(events).toMatchObject([{ kind: 'unavailable', code: 'OBSERVATION_UNCERTAIN' }])
  expect(context.signal.aborted).toBe(false)
  expect((await f.client.sessionHistoryPage('private-agent')).items.map(item => item.id)).toEqual(['initial'])
  a.dispose(); b.dispose()
})

it('a truly stopped JSONL watch closes its Consumers and the next reader acquires a live watch', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = []
  const a = await f.client.observeSessionHistory('private-agent', event => events.push(event))
  const b = await f.client.observeSessionHistory('private-agent', () => {})
  const watcher = vi.mocked(watch).mock.results[0]!.value
  watcher.emit('error', new Error('Native file watch stopped'))
  expect(events).toMatchObject([{ kind: 'unavailable', code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE' }])
  expect(a.closed?.aborted).toBe(true)
  expect(b.closed?.aborted).toBe(true)
  const fresh = await f.client.observeSessionHistory('private-agent', () => {})
  expect(f.watch).toHaveBeenCalledTimes(2)
  expect(fresh.closed?.aborted).toBe(false)
  a.dispose(); b.dispose()
  expect(fresh.closed?.aborted).toBe(false)
  fresh.dispose()
})

it('a failed acquisition does not poison the next Consumer and Core disposal releases its own watch', async () => {
  const f = await fixture()
  f.watch.mockRejectedValueOnce(new Error('Native watch could not be opened'))
  await expect(f.client.observeSessionHistory('private-agent', () => {})).rejects.toThrow('could not be opened')
  const a = await f.client.observeSessionHistory('private-agent', () => {})
  const b = await f.client.observeSessionHistory('private-agent', () => {})
  expect(f.watch).toHaveBeenCalledTimes(2)
  const release = vi.spyOn(await f.watch.mock.results[1]!.value, 'dispose')
  await f.client.dispose()
  expect(release).toHaveBeenCalledTimes(1)
  a.dispose(); b.dispose()
  expect(release).toHaveBeenCalledTimes(1)
  await expect(f.client.observeSessionHistory('private-agent', () => {})).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_CANCELLED' })
})

it('the production Hosted history service shares the same Core watch and releases only its Consumer', async () => {
  const f = await fixture(), local = vi.fn(), remote: unknown[] = []
  const service = new AgentMuxHostedRuntimeService(f.client, f.storePath, () => ({ ...hostedTestFence,
    protocolVersion: 2, processId: 123, availability: 'unverified', ctxmux: null }))
  cleanups.push(() => service.dispose())
  const original = await f.client.observeSessionHistory('private-agent', local)
  const hosted = await service.subscribe('runtime.history-watch', { fence: hostedTestFence,
    consumerId: 'remote-reader', agentSessionId: 'private-agent', options: {} }, logicalHostedEvents(event => { remote.push(event) }))
  await hosted.start?.()
  expect(f.watch).toHaveBeenCalledTimes(1)
  await appendFile(f.path, jsonl([row('hosted')]))
  await vi.waitFor(() => expect(remote.length).toBeGreaterThan(0))
  expect(local).toHaveBeenCalled()
  await hosted.dispose()
  expect(f.watch.mock.calls[0]![0].signal.aborted).toBe(false)
  original.dispose()
  expect(f.watch.mock.calls[0]![0].signal.aborted).toBe(true)
})
