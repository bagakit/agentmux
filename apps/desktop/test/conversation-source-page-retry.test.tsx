import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError, type AgentSessionHistoryPage } from '@agentmux/core'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { useSessionConversationWindow } from '../src/renderer/src/lib/session-conversation-window'
import type { AgentNativeSourceFacts } from '../src/shared/agent-native-source'

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

it('Desktop keeps an accepted source across same-target confirmation and requires navigation only after a different locator is accepted', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const reference = { hostId: 'local', agentSessionId: 'original-source-confirmation-reader' }
  const sourceA = { providerId: 'claude', nativeSessionId: 'original-native-a' }
  const sourceB = { ...sourceA, nativeSessionId: 'original-native-b' }
  const f = await conversationPagePortFixture(reference, sourceA, async (_id, _options, originalSource) => {
    const source = originalSource ?? sourceA
    return { agentSessionId: reference.agentSessionId, source, nextCursor: null, items: [{
      id: `${source.nativeSessionId}-answer`, kind: 'assistant-message',
      contentParts: [{ kind: 'text', text: `Original body ${source.nativeSessionId}` }]
    }] }
  })
  closes.push(f.close)
  const metadata = (await f.store.readMetadata(reference.agentSessionId))!
  const handleA = { kind: 'provider' as const, providerId: 'claude' as const, sessionId: sourceA.nativeSessionId,
    transcriptPath: `${metadata.workspacePath}/original-a.jsonl` }
  const handleB = { ...handleA, sessionId: sourceB.nativeSessionId, transcriptPath: `${metadata.workspacePath}/original-b.jsonl` }
  await f.store.compareAndSwap(metadata, { ...metadata, nativeHandle: handleA })
  let facts: AgentNativeSourceFacts = { nativeHandle: handleA }
  const checkpoint = (source: AgentSessionHistoryPage['source']) => ({ agentSessionId: reference.agentSessionId, source, cursor: 'original-page-cut' })
  f.nativeCheckpoint.mockImplementation(async (_id, _options, originalSource) => ({ ...reference, source: originalSource ?? sourceA,
    items: [], checkpoint: checkpoint(originalSource ?? sourceA), more: false }))
  f.nativeChanges.mockImplementation(async (_id, options, originalSource) => ({ ...reference, source: originalSource ?? options.checkpoint!.source,
    items: [], checkpoint: checkpoint(originalSource ?? options.checkpoint!.source), more: false }))
  vi.mocked(f.client.observeSessionHistory).mockImplementation(async () => {
    const current = (await f.store.readMetadata(reference.agentSessionId))!.nativeHandle!
    return { source: { providerId: sourceA.providerId, nativeSessionId: current.sessionId }, dispose() {} }
  })
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  let current!: ReturnType<typeof useSessionConversationWindow>
  function Consumer() {
    current = useSessionConversationWindow({ reference, identity: 'original-confirmation-window', enabled: true, nativeSourceFacts: facts }, () => true, 0)
    return <div>{current.projection?.records.map(record => <p key={record.id}>{record.content}</p>)}</div>
  }
  const select = async (handle: typeof handleA, operationId?: string) => {
    const before = (await f.store.readMetadata(reference.agentSessionId))!
    const observedAt = before.updatedAt + 1
    const next = { ...before, nativeHandle: handle, updatedAt: observedAt,
      nativeBinding: { source: operationId ? 'user-selected' as const : 'process-witness' as const, run: before.run, observedAt },
      ...(operationId ? { nativeConfirmation: { operationId, run: before.run, previousNativeHandle: before.nativeHandle!, nativeHandle: handle,
        candidateObservedAt: before.updatedAt, observedAt, basis: 'run-main-candidate' as const } } : {}) }
    await f.store.compareAndSwap(before, next)
    facts = next
    await act(async () => root.render(<Consumer />))
  }
  await select(handleA, 'first-confirmation')
  await wait(() => { expect(current.page?.source).toEqual(sourceA); expect(current.loading).toBe(false); expect(current.error).toBeNull() })
  const originalSnapshot = current.snapshot, originalNode = host.querySelector('p')!
  const selection = document.getSelection()!, range = document.createRange()
  range.setStart(originalNode.firstChild!, 0); range.setEnd(originalNode.firstChild!, 8)
  selection.removeAllRanges(); selection.addRange(range)
  closes.push(() => selection.removeAllRanges())
  const originalReads = f.nativeRead.mock.calls.length
  await select(handleA, 'same-target-upgrade')
  expect(current.historical, 'Confirming the same target must not turn its accepted source into historical reading').toBe(false)
  expect(current.error).toBeNull(); expect(current.snapshot).toBe(originalSnapshot)
  expect(host.querySelector('p')).toBe(originalNode); expect(selection.getRangeAt(0)).toBe(range)
  expect(f.nativeRead).toHaveBeenCalledTimes(originalReads)
  await select(handleB, 'choose-b-without-reading')
  expect(current.historical).toBe(true); expect(current.error).toContain('Native source changed')
  expect(current.snapshot).toBe(originalSnapshot); expect(host.querySelector('p')).toBe(originalNode)
  await select(handleA, 'return-to-unreplaced-a')
  expect(current.historical).toBe(false); expect(current.error).toBeNull()
  expect(current.snapshot).toBe(originalSnapshot); expect(host.querySelector('p')).toBe(originalNode)
  expect(selection.getRangeAt(0)).toBe(range); expect(f.nativeRead).toHaveBeenCalledTimes(originalReads)
  // A different locator is a source fact, not a legal same-ID confirmation receipt.
  await select({ ...handleA, transcriptPath: `${metadata.workspacePath}/different-a.jsonl` })
  expect(current.historical, 'The same native ID in another exact locator is still a source change').toBe(true)
  expect(current.error).toContain('Native source changed'); expect(host.querySelector('p')).toBe(originalNode)
  await select(handleB, 'choose-b-for-explicit-reading')
  await act(async () => current.showCurrentSource())
  await wait(() => { expect(current.page?.source).toEqual(sourceB); expect(current.loading).toBe(false); expect(current.error).toBeNull() })
  const acceptedB = current.snapshot, nodeB = host.querySelector('p')!
  expect(nodeB.textContent).toBe(`Original body ${sourceB.nativeSessionId}`)
  await select(handleA, 'return-after-accepting-b')
  expect(current.historical).toBe(true); expect(current.error).toContain('Native source changed')
  expect(current.snapshot).toBe(acceptedB); expect(host.querySelector('p')).toBe(nodeB)
  const read = f.client.readAgentConversation.bind(f.client)
  vi.spyOn(f.client, 'readAgentConversation').mockRejectedValueOnce(new AgentMuxError('The original Core view is unavailable', 'AGENT_CONVERSATION_VIEW_EXPIRED'))
    .mockImplementation(read)
  await act(async () => current.showCurrentSource())
  await wait(() => { expect(current.loading).toBe(false); expect(current.error).toContain('The original Core view is unavailable') })
  expect(current.snapshot).toBe(acceptedB); expect(host.querySelector('p')).toBe(nodeB)
  await select(handleA, 'same-target-with-core-error')
  expect(current.error, 'Source identity must not hide a real Core view failure').toContain('The original Core view is unavailable')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

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
