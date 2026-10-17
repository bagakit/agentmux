import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError, type AgentSessionHistoryPage } from '@agentmux/core'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { useSessionConversationWindow } from '../src/renderer/src/lib/session-conversation-window'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Private source-page retry cleanup failed')
})
const wait = (assertion: () => void) => vi.waitFor(async () => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); assertion()
}, { timeout: 7000, interval: 20 })

it.each([{ failedSource: 'native', phase: 'primitive' }, { failedSource: 'captured', phase: 'primitive' }, { failedSource: 'native', phase: 'qualification' }] as const)(
  'Desktop retries the original $failedSource source after $phase failure while the other source keeps its accepted EOF', async ({ failedSource, phase }) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const reference = { hostId: 'local', agentSessionId: 'original-source-page-retry' }, source = { providerId: 'claude', nativeSessionId: 'original-native' }
  const nativeRows: AgentSessionHistoryPage['items'] = Array.from({ length: 200 }, (_, index) => ({ id: `native-${index}`, kind: 'assistant-message', startedAt: _followupFixtureEpoch(0, 0, 1),
    contentParts: [{ kind: 'text', text: `Original native body ${index}` }] }))
  const f = await conversationPagePortFixture(reference, source, async (_id, input = {}) => ({ agentSessionId: reference.agentSessionId, source,
    items: input.cursor ? nativeRows.slice(0, 100) : nativeRows.slice(100), nextCursor: input.cursor ? null : 'original-older-page' }))
  closes.push(f.close)
  for (let index = 0; index < 200; index++) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: reference.agentSessionId,
    item: { id: `captured-${index}`, agentSessionId: reference.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete',
      title: 'Original captured answer', content: `Original captured body ${index}`, createdAt: index + 1, updatedAt: index + 1 } })
  const metadata = await f.store.readMetadata(reference.agentSessionId)
  const native = f.nativeRead.getMockImplementation()!, captured = f.store.readCapturedHistory.bind(f.store)
  let nativeAttempts = 0, capturedAttempts = 0
  f.nativeRead.mockImplementation(async (...args) => {
    nativeAttempts++
    if (failedSource === 'native' && nativeAttempts === 2) {
      if (phase === 'qualification') return { ...await native(...args), changesCursor: 'unaccepted-source-cut', nextCursor: null }
      throw new AgentMuxError('Exact native older page unavailable', 'AGENT_SESSION_HISTORY_UNAVAILABLE')
    }
    return native(...args)
  })
  vi.spyOn(f.store, 'readCapturedHistory').mockImplementation((id, input) => {
    if (input?.throughSequence !== undefined) {
      capturedAttempts++
      if (failedSource === 'captured' && capturedAttempts === 2) throw new AgentMuxError('Exact captured older page unavailable', 'AGENT_SESSION_HISTORY_UNAVAILABLE')
    }
    return captured(id, input)
  })
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  let current!: ReturnType<typeof useSessionConversationWindow>
  function Consumer() {
    current = useSessionConversationWindow({ reference, identity: 'original-reader', enabled: true }, () => true, Infinity)
    return <div>{current.projection?.records.map(record => <p key={record.id}>{record.content}</p>)}</div>
  }
  await act(async () => root.render(<Consumer />))
  await wait(() => { expect(current.error).toContain(phase === 'qualification' ? 'changed its frozen changes boundary' : `Exact ${failedSource} older page unavailable`); expect(current.loading).toBe(false) })
  const failed = current.snapshot!, failure = failed.coverage.find(row => row.source.kind === failedSource)!
  expect(failed.units.reduce((count, unit) => count + unit.records.length, 0)).toBe(300)
  expect(failed.window.checkpoint.frontier.cuts.find(cut => cut.kind === 'native')?.checkpoint.cursor).toBe('original-page-cut')
  expect(failure.current).toBe('unavailable'); expect(failure.gaps.some(gap => Boolean(gap.continuation))).toBe(true)
  expect(nativeAttempts).toBe(2); expect(capturedAttempts).toBe(2)
  const healthySource = failedSource === 'native' ? 'captured' : 'native'
  const healthy = failed.units.flatMap(unit => unit.records).filter(record => record.original.kind === healthySource).map(record => record.id)
  expect(healthy).toHaveLength(200)
  expect(host.textContent).toContain('Original native body 199'); expect(host.textContent).toContain('Original captured body 199')
  await act(async () => current.retry())
  await wait(() => expect(current.loading).toBe(false))
  expect(failedSource === 'native' ? nativeAttempts : capturedAttempts, 'Explicit source Retry must reach the original failed page rather than treating unavailable as EOF').toBe(3)
  expect(failedSource === 'native' ? capturedAttempts : nativeAttempts, 'The other source already reached its accepted EOF').toBe(2)
  expect(f.nativeRead.mock.calls.at(-1)![1]?.cursor).toBe('original-older-page')
  expect(current.snapshot!.window.checkpoint.frontier.cuts.find(cut => cut.kind === 'native')?.checkpoint.cursor).toBe('original-page-cut')
  expect(current.error).toBeNull(); expect(current.snapshot!.window.id).toBe(failed.window.id)
  expect(current.snapshot!.units.reduce((count, unit) => count + unit.records.length, 0)).toBe(400)
  expect(current.snapshot!.units.flatMap(unit => unit.records).filter(record => record.original.kind === healthySource).map(record => record.id)).toEqual(healthy)
  expect(current.snapshot!.coverage.find(row => row.source.kind === failedSource)!.current).not.toBe('unavailable')
  expect(await f.store.readMetadata(reference.agentSessionId)).toEqual(metadata)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
