import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { AgentMuxError } from '../../../packages/core/src/errors'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  window.getSelection()?.removeAllRanges()
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Private observation cleanup failed')
})
const row = (id: string) => ({ type: 'user', uuid: id, sessionId: 'native-main', message: { role: 'user', content: id } })
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const wait = (assertion: () => void) => vi.waitFor(async () => { await pause(); assertion() }, { timeout: 7000, interval: 20 })
async function fixture() {
  const f = await nativeHistoryFixture('claude', jsonl([row('first-original'), row('last-original')]))
  closes.push(f.close)
  const native = f.client.observeSessionHistory.bind(f.client)
  const streams: Array<{ end(): void; closed: AbortSignal }> = [], order: string[] = []
  let rejectNext = false, closeNext = false
  vi.spyOn(f.client, 'observeSessionHistory').mockImplementation(async (...args) => {
    if (rejectNext) { rejectNext = false; throw new AgentMuxError('The exact native observer is still unavailable.', 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE') }
    const handle = await native(...args), controller = new AbortController()
    const index = streams.length
    order.push(`native-open-${index}`)
    const dispose = () => { handle.dispose(); if (!controller.signal.aborted) controller.abort(new Error('Private native observation ended')) }
    streams.push({ closed: controller.signal, end: dispose })
    if (closeNext) { closeNext = false; dispose() }
    return { ...handle, closed: controller.signal, dispose }
  })
  const observe = f.client.observeConversation.bind(f.client)
  vi.spyOn(f.client, 'observeConversation').mockImplementation(async (...args) => {
    const handle = await observe(...args), index = order.filter(value => value.startsWith('unified-open')).length
    order.push(`unified-open-${index}`)
    return { ...handle, dispose() { order.push(`unified-dispose-${index}`); handle.dispose() } }
  })
  await desktopConversationReadBridge(f, closes)
  const callbacks: Array<Parameters<typeof api.conversation.observeConversation>[1]> = []
  const publicObserve = vi.mocked(api.conversation.observeConversation).getMockImplementation()!
  vi.mocked(api.conversation.observeConversation).mockImplementation((input, listener, options) => {
    callbacks.push(listener); return publicObserve(input, listener, options)
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  let view!: ReturnType<typeof useConversationView>
  function Consumer() {
    view = useConversationView(api.conversation, ref, true)
    const reading = view.reading
    return <><output data-observation-error>{view.observationError?.message}</output>{reading ? <ConversationView sessionId={ref.agentSessionId} executionHostId="local" active page={reading.historyPage} timeline={reading.timeline} records={reading.records} originalRecords={reading.originalRecords} coverage={reading.timeline.coverage} /> : null}</>
  }
  await act(async () => root.render(<Consumer />))
  await wait(() => { expect(view.snapshot).toBeTruthy(); expect(view.loading).toBe(false); expect(view.inspect().dirty).toBe(false); expect(host.textContent).toContain('last-original') })
  return { f, host, order, streams, callbacks, closeNext: () => { closeNext = true }, view: () => view, rejectNext: () => { rejectNext = true } }
}
async function captured(x: Awaited<ReturnType<typeof fixture>>, id: string) {
  await Reflect.get(x.f.client, 'persistAndPublishTimeline').call(x.f.client,
    { type: 'append', agentSessionId: x.f.session.agentSessionId, item: { id, agentSessionId: x.f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', title: id, content: id, createdAt: _followupFixtureEpoch(0, 0, 1), updatedAt: _followupFixtureEpoch(0, 0, 1) } },
    { source: 'agentmux', observedAt: _followupFixtureEpoch(0, 0, 1) }, 'local')
}
it('observation-only Retry resumes the exact anchored view and replaces its failed native watcher after opening the replacement', async () => {
  const x = await fixture(), view = x.view
  const record = view().snapshot!.units.flatMap(unit => unit.records)[0]!
  const anchor = { record: record.reference!, revision: record.revision, frontier: view().snapshot!.window.checkpoint }
  await act(async () => { await view().reveal(anchor) })
  await wait(() => expect(view().loading).toBe(false))
  const accepted = view().snapshot!, stream = x.streams.at(-1)!, before = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await act(async () => stream.end())
  await wait(() => expect(view().observationError).toBeTruthy())
  const count = x.streams.length
  await act(async () => { await view().retry() })
  await wait(() => { expect(view().loading).toBe(false); expect(view().observationError, 'A qualified replacement must clear only its original observation failure').toBeNull() })
  expect(x.streams).toHaveLength(count + 1)
  const retry = vi.mocked(api.conversation.readAgentConversation).mock.calls.slice(before)
  expect(retry).toHaveLength(1); expect(retry[0]![0].view, 'Observation Retry must not replace the original anchor with latest').toBe(accepted.window.view)
  expect(view().snapshot!.window.id).toBe(accepted.window.id); expect(view().snapshot!.window.anchor).toEqual(anchor); expect(view().historical).toBe(true)
  const lastOpen = x.order.findLastIndex(value => value.startsWith('unified-open'))
  expect(x.order.findIndex((value, index) => index > lastOpen && value.startsWith('unified-dispose')), 'Replacement opening precedes releasing the old aggregate').toBeGreaterThan(lastOpen)
  expect(x.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
it('unrelated captured progress keeps a native observation failure until exact recovery and later native-only changes wake the same view', async () => {
  const x = await fixture(), accepted = x.view().snapshot!, before = x.streams.length
  await act(async () => x.streams.at(-1)!.end())
  await wait(() => expect(x.view().observationError).toBeTruthy())
  await act(async () => captured(x, 'captured-while-native-observer-failed'))
  await wait(() => expect(x.host.textContent).toContain('captured-while-native-observer-failed'))
  expect(x.view().observationError, 'Captured success cannot certify native watch recovery').toBeTruthy(); expect(x.streams).toHaveLength(before)
  await act(async () => { await x.view().retry() })
  await wait(() => expect(x.view().observationError).toBeNull())
  await act(async () => appendFile(x.f.path, jsonl([row('native-after-watch-recovery')])))
  await wait(() => expect(x.host.textContent).toContain('native-after-watch-recovery'))
  expect(x.view().snapshot!.window.id).toBe(accepted.window.id)
  expect(x.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
it('a failed replacement leaves the original captured watcher usable and exposes native opening failure in the public handle', async () => {
  const x = await fixture()
  await act(async () => x.streams.at(-1)!.end())
  await wait(() => expect(x.view().observationError).toBeTruthy())
  const disposes = x.order.filter(value => value.startsWith('unified-dispose')).length
  x.rejectNext()
  await act(async () => { await x.view().retry() })
  await wait(() => expect(x.view().loading).toBe(false))
  expect(x.view().observationError, 'An unavailable replacement cannot settle the original failed resource').toBeTruthy()
  expect(x.order.filter(value => value.startsWith('unified-dispose'))).toHaveLength(disposes + 1)
  await act(async () => captured(x, 'captured-after-replacement-failure'))
  await wait(() => expect(x.host.textContent).toContain('captured-after-replacement-failure'))
  expect(x.view().observationError).toBeTruthy()
  await act(async () => { await x.view().retry() })
  await wait(() => expect(x.view().observationError).toBeNull())
  expect(x.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('the public opening reports startup failure and an already closed native observer without closing captured observation', async () => {
  const x = await fixture(), snapshot = x.view().snapshot!
  for (const [index, fail] of [x.rejectNext, x.closeNext].entries()) {
    fail()
    const events: Array<{ kind: string }> = []
    const handle = await api.conversation.observeConversation({ hostId: 'local', agentSessionId: x.f.session.agentSessionId, view: snapshot.window.view! }, event => events.push(event))
    closes.push(() => handle.dispose())
    expect(handle.coverage.find(source => source.source.kind === 'native')!.current, 'Startup failure must be present in the returned public opening').toBe('unavailable')
    expect(events.some(event => event.kind === 'unavailable')).toBe(true)
    expect(handle.closed.aborted).toBe(false)
    await act(async () => captured(x, `captured-startup-${index}`))
    await wait(() => expect(events.some(event => event.kind === 'invalidated')).toBe(true))
    handle.dispose()
  }
})
it('checkpoint coverage cannot revoke a successfully recovered observer and disposed callbacks cannot poison its generation', async () => {
  const x = await fixture(), old = x.callbacks.at(-1)!, snapshot = x.view().snapshot!, source = snapshot.scope.sources.find(source => source.kind === 'native')!
  await act(async () => x.streams.at(-1)!.end())
  await wait(() => expect(x.view().observationError).toBeTruthy())
  vi.spyOn(x.f.client, 'sessionHistoryCheckpoint').mockRejectedValueOnce(new AgentMuxError('Original checkpoint temporarily unavailable.', 'AGENT_SESSION_HISTORY_UNAVAILABLE'))
  await act(async () => { await x.view().retry() })
  await wait(() => expect(x.view().observationError).toBeNull())
  const count = x.streams.length
  await act(async () => old({ hostId: 'local', agentSessionId: x.f.session.agentSessionId, sourceHostId: 'local', source, kind: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', message: 'Late original callback' }))
  expect(x.view().observationError, 'A released generation cannot poison a qualified replacement').toBeNull()
  await act(async () => appendFile(x.f.path, jsonl([row('native-with-checkpoint-gap')])))
  await wait(() => expect(x.host.textContent).toContain('native-with-checkpoint-gap'))
  expect(x.streams).toHaveLength(count)
})

it('the opening retains checkpoint failure together with the current native observation failure', async () => {
  const x = await fixture()
  vi.spyOn(x.f.client, 'sessionHistoryCheckpoint').mockRejectedValueOnce(new AgentMuxError('Exact checkpoint failure.', 'AGENT_SESSION_HISTORY_UNAVAILABLE'))
  x.rejectNext()
  const handle = await api.conversation.observeConversation({ hostId: 'local', agentSessionId: x.f.session.agentSessionId, view: x.view().snapshot!.window.view! }, () => {})
  closes.push(() => handle.dispose())
  expect(handle.coverage.find(value => value.source.kind === 'native')!.gaps.map(gap => gap.code)).toEqual(['AGENT_SESSION_HISTORY_UNAVAILABLE', 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE'])
  expect(handle.closed.aborted).toBe(false)
})

it('unsupported automatic observation retains accurate capability coverage and the readable native body', async () => {
  const x = await fixture()
  vi.mocked(x.f.client.observeSessionHistory).mockRejectedValueOnce(new AgentMuxError('Automatic observation is unsupported.', 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED'))
  const handle = await api.conversation.observeConversation({ hostId: 'local', agentSessionId: x.f.session.agentSessionId, view: x.view().snapshot!.window.view! }, () => {})
  closes.push(() => handle.dispose())
  expect(handle.coverage.find(value => value.source.kind === 'native')!.current).toBe('unsupported')
  expect(handle.closed.aborted).toBe(false)
  await act(async () => { await x.view().changes() })
  expect(x.host.textContent).toContain('last-original')
  expect(x.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
