// @vitest-environment happy-dom
import { act } from 'react'
import { appendFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import type { ConversationWindowSnapshot, ConversationObservationHandle } from '../../../packages/core/src/conversation'
import { parseReadingDiagnosticRecord, type ReadingDiagnosticRecord } from '../../../packages/core/src/reading-diagnostic'
import { useConversationView } from '../../../packages/client-ui/src/lib/use-conversation-view'
import { conversationDiagnosticFrame } from '../../../packages/client-ui/src/lib/conversation-reading-diagnostics'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'

const closes: Array<() => unknown | Promise<unknown>> = []
// Only this isolated test engine is affected; no App or Runtime is attached.
// A separate context exposes the actual collector even without runner flags.
setFlagsFromString('--expose_gc')
const collectGarbage: () => void = runInNewContext('gc')
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Observation retention cleanup failed')
})
const row = (id: string) => ({ type: 'user', uuid: id, sessionId: 'native-main', message: { role: 'user', content: id } })
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const wait = (assertion: () => void) => vi.waitFor(async () => { await pause(); assertion() }, { timeout: 7000, interval: 20 })
function weakFrame(snapshot: ConversationWindowSnapshot) {
  expect(snapshot.units.length).toBeGreaterThan(0)
  return { snapshot: new WeakRef(snapshot), units: new WeakRef(snapshot.units), unit: new WeakRef(snapshot.units[0]!),
    frame: conversationDiagnosticFrame(snapshot), view: snapshot.window.view }
}
async function collected(frame: ReturnType<typeof weakFrame>) {
  expect(typeof collectGarbage, 'The direct reachability oracle requires the actual engine collector').toBe('function')
  let alive = [true, true, true]
  for (let attempt = 0; attempt < 4; attempt++) {
    // deref keeps the object alive until this job ends; never collect in that job.
    await setImmediate(); collectGarbage(); await setImmediate()
    alive = [frame.snapshot.deref() !== undefined, frame.units.deref() !== undefined, frame.unit.deref() !== undefined]
    if (alive.every(value => !value)) break
  }
  return alive
}
async function fixture() {
  const f = await nativeHistoryFixture('claude', jsonl([row('original-body')]))
  closes.push(f.close)
  await desktopConversationReadBridge(f, closes)
  const handles: ConversationObservationHandle[] = [], records: ReadingDiagnosticRecord[] = []
  const observe = vi.mocked(api.conversation.observeConversation).getMockImplementation()!
  vi.mocked(api.conversation.observeConversation).mockImplementation(async (...args) => {
    const handle = await observe(...args); handles.push(handle); return handle
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  let mounted = true, view!: ReturnType<typeof useConversationView>, original: ReturnType<typeof weakFrame> | undefined, hold = false
  const reference = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const reporting = { ownerInstanceId: 'original-renderer', producerBuildId: null, consumerKind: 'conversation-pane' as const,
    publish: (record: ReadingDiagnosticRecord) => { records.push(parseReadingDiagnosticRecord(record)) } }
  const beforeCommit = (snapshot: ConversationWindowSnapshot) => { original ??= weakFrame(snapshot); return !hold }
  function Consumer({ tick }: { tick: number }) {
    view = useConversationView(api.conversation, reference, true, { diagnostics: reporting, beforeCommit })
    return <output data-tick={tick}>{JSON.stringify(view.reading?.records)}</output>
  }
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); host.remove() } }
  closes.push(unmount)
  await act(async () => root.render(<Consumer tick={0} />))
  const settle = () => wait(() => { expect(view.loading).toBe(false); expect(view.inspect().dirty).toBe(false); expect(view.inspect().inFlight).toBe(false) })
  await settle()
  expect(host.textContent).toContain('original-body')
  expect(handles).toHaveLength(1)
  return { f, host, handles, records, original: original!, view: () => view, unmount,
    hold: (value: boolean) => { hold = value }, settle,
    async advance(id: string) {
      await act(async () => appendFile(f.path, jsonl([row(id)])))
      await wait(() => expect(view.inspect().pending ? JSON.stringify(view.inspect().pending!.units) : host.textContent).toContain(id))
      await settle()
    },
    async discardTestRoots() {
      // Move both React Fibers past the first accepted frame without unmounting
      // the original consumer, changing its effect dependencies or its watch.
      await act(async () => root.render(<Consumer tick={1} />))
      await act(async () => root.render(<Consumer tick={2} />))
      for (const name of ['readAgentConversation', 'readConversationChanges', 'observeConversation', 'releaseConversationView'] as const)
        vi.mocked(api.conversation[name]).mockClear()
    }
  }
}

it('collects a replaced binding frame and its detached unit while the same original observer remains live', async () => {
  const x = await fixture()
  await x.advance('first-new-body'); await x.advance('latest-new-body')
  expect(x.view().snapshot!.window.id).toBe(x.original.frame.windowId)
  expect(x.view().snapshot!.window.revision).toBeGreaterThan(x.original.frame.windowRevision!)
  expect(x.view().snapshot!.units).not.toContain(x.original.unit.deref())
  const current = weakFrame(x.view().snapshot!)
  await x.discardTestRoots()
  expect(await collected(x.original), 'The obsolete observer-only frame, units array and detached unit must be collectible').toEqual([false, false, false])
  expect(await collected(current), 'The accepted current body remains strongly owned').toEqual([true, true, true])
  expect(x.handles).toHaveLength(1); expect(x.handles[0]!.closed.aborted).toBe(false)
  expect(x.view().inspect().watch).toMatchObject({ binding: false, bound: true, closed: false, windowId: x.original.frame.windowId })
  expect(x.host.textContent).toContain('latest-new-body')
  expect(x.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('keeps original binding diagnostics, held bodies and exact release identity as current revisions advance', async () => {
  const x = await fixture()
  await x.advance('first-new-body'); await x.advance('second-new-body')
  const invalidations = x.records.flatMap(record => record.events).filter(event => event.phase === 'invalidation-received')
  expect(invalidations.length).toBeGreaterThan(0)
  for (const event of invalidations) expect(event).toMatchObject(x.original.frame)
  const held = weakFrame(x.view().snapshot!)
  x.hold(true); await x.advance('held-pending-body')
  expect(x.host.textContent).not.toContain('held-pending-body')
  expect(x.view().held).toBe(true)
  const pending = weakFrame(x.view().inspect().pending!)
  await x.discardTestRoots()
  expect(await collected(held)).toEqual([true, true, true]); expect(await collected(pending)).toEqual([true, true, true])
  x.hold(false); await act(async () => x.view().acceptHeld())
  await wait(() => expect(x.host.textContent).toContain('held-pending-body'))
  const releasedView = x.view().snapshot!.window.view
  await x.unmount()
  const closed = x.records.flatMap(record => record.events).filter(event => event.phase === 'watch-closed' && event.reason === 'disposed')
  expect(closed.length).toBeGreaterThan(0)
  for (const event of closed) expect(event).toMatchObject(x.original.frame)
  expect(api.conversation.releaseConversationView).toHaveBeenCalledWith({ hostId: 'local', agentSessionId: x.f.session.agentSessionId, view: releasedView })
  expect(x.handles[0]!.closed.aborted).toBe(true)
  expect(x.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('closes with original binding facts and recovers the same current view before releasing it on new-window navigation', async () => {
  const x = await fixture()
  await x.advance('new-current-body'); await x.advance('latest-current-body')
  const currentView = x.view().snapshot!.window.view
  await act(async () => x.handles[0]!.dispose())
  const ended = x.records.flatMap(record => record.events).filter(event => event.phase === 'watch-closed' && event.reason === 'source-unavailable')
  expect(ended.length).toBeGreaterThan(0)
  for (const event of ended) expect(event).toMatchObject(x.original.frame)
  await wait(() => { expect(x.handles).toHaveLength(2); expect(x.view().observationError).toBeNull(); expect(x.view().loading).toBe(false) })
  expect(api.conversation.readAgentConversation).toHaveBeenCalledWith(expect.objectContaining({ view: currentView }), expect.anything())
  expect(x.view().snapshot!.window.id).toBe(x.original.frame.windowId)
  expect(x.host.textContent).toContain('latest-current-body')
  const replacementView = x.view().snapshot!.window.view
  await act(async () => x.view().refresh())
  await x.settle()
  expect(x.view().snapshot!.window.id).not.toBe(x.original.frame.windowId)
  expect(api.conversation.releaseConversationView).toHaveBeenCalledWith({ hostId: 'local', agentSessionId: x.f.session.agentSessionId, view: replacementView })
  expect(x.handles[1]!.closed.aborted).toBe(true)
  expect(x.handles[2]!.closed.aborted).toBe(false)
  expect(x.host.textContent).toContain('latest-current-body')
  expect(x.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
