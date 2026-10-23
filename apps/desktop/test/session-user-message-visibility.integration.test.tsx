// @vitest-environment happy-dom
import { act, startTransition, Suspense, useLayoutEffect, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import type { AgentSessionControl } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'

// Controlled typed native source leaves feed the original Core Reader, Unix RPC,
// Main/preload and mounted public hook/shared view. This is not a vendor-writer
// or SessionPane cover-command test; the actual host lifecycle has its own cases.
const controlA: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'visibility-alpha', run: { runId: 'original-page-fixture-run' } }
const controlB: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'visibility-beta', run: { runId: 'visibility-beta-run' } }
const sourceA = { providerId: 'claude', nativeSessionId: 'visibility-native-alpha' }
const sourceB = { providerId: 'claude', nativeSessionId: 'visibility-native-beta' }
type Reader = ReturnType<typeof useSessionUserMessages>
let host: HTMLDivElement, root: Root
const readers = new Map<string, Reader>(), closes: Array<() => unknown | Promise<unknown>> = []
const page = (text: string, ids = ['original'], control = controlA): AgentSessionHistoryPage => ({
  agentSessionId: control.agentSessionId, source: control.agentSessionId === controlA.agentSessionId ? sourceA : sourceB,
  items: ids.map((id, index) => ({ id, kind: 'user-message', startedAt: 10000 + index * 1000,
    contentParts: [{ kind: 'text', text }] })), nextCursor: null
})
const captured = (text: string): AgentTimelineItem => ({ id: 'original-captured', agentSessionId: controlA.agentSessionId,
  kind: 'user_message', status: 'complete', source: 'user', title: 'Original input', content: text, createdAt: 12000, updatedAt: 12000 })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); readers.clear()
})
afterEach(async () => {
  const failures: unknown[] = []
  try { await act(async () => root.unmount()) } catch (error) { failures.push(error) }
  host.remove(); window.getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  readers.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Original visibility fixture cleanup failed')
})
function Presenter({ control = controlA, enabled = true, name = 'one', onRender }: {
  control?: AgentSessionControl; enabled?: boolean; name?: string; onRender?: (control: AgentSessionControl) => void
}) {
  const reader = useSessionUserMessages(control, { enabled })
  onRender?.(control)
  useLayoutEffect(() => { readers.set(name, reader) }, [name, reader])
  const reading = reader.conversation.reading
  return <div data-consumer={name} data-messages-count={reader.messages.length} data-loading={reader.loading}>
    <ConversationView sessionId={control.agentSessionId} executionHostId={control.hostId} active={enabled}
      records={reading?.records ?? []} originalRecords={reading?.originalRecords ?? []}
      page={reading?.historyPage ?? null} timeline={reading?.captured} coverage={reading?.timeline.coverage ?? []} />
  </div>
}
const wait = (assertion: () => void) => vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); assertion() }, { timeout: 10000, interval: 10 })
const render = (node: ReactNode) => act(async () => root.render(node))
function reader(name = 'one') { const actual = readers.get(name); expect(actual, name).toBeDefined(); return actual! }
function scope(name = 'one') { const actual = host.querySelector<HTMLElement>(`[data-consumer="${name}"]`); expect(actual, name).not.toBeNull(); return actual! }
const bodies = (name = 'one') => [...scope(name).querySelectorAll<HTMLElement>('.log-turn__body')]
function selected(body: HTMLElement) {
  const text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.textContent!.length)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  return { body, text, range, selection, content: selection.toString() }
}
function unchanged(original: ReturnType<typeof selected>) {
  expect(original.body.isConnected).toBe(true); expect(original.text.isConnected).toBe(true)
  expect(original.body.querySelector('p')!.firstChild).toBe(original.text)
  expect(original.selection.getRangeAt(0)).toBe(original.range)
  expect(original.range.startContainer).toBe(original.text); expect(original.range.endContainer).toBe(original.text)
  expect(original.selection.toString()).toBe(original.content)
}
function clearSelection() { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }
async function ready(name = 'one', count = 1) {
  await wait(() => {
    expect(bodies(name)).toHaveLength(count)
    expect(reader(name).conversation.inspect()).toMatchObject({ loading: false, inFlight: false, dirty: false, error: null,
      watch: { bound: true, closed: false } })
  })
}
async function readOriginalSubmission() {
  await ready('one', 2)
  const original = scope().querySelector<HTMLElement>('[data-submission-id="original-captured"]')
  expect(original).not.toBeNull()
  expect(JSON.parse(original!.dataset.conversationItemRef!)).toMatchObject({ hostId: controlA.hostId,
    agentSessionId: controlA.agentSessionId, source: { kind: 'captured', recordId: 'original-captured' } })
  const disclosure = original!.querySelector<HTMLDetailsElement>('details.message-disclosure')!
  expect(disclosure).not.toBeNull(); expect(disclosure.open).toBe(false)
  const summary = disclosure.querySelector<HTMLElement>('summary')!
  expect(summary).not.toBeNull()
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  await ready('one', 3)
  expect(disclosure.open).toBe(true)
}
async function fixture(initial = page('Original frozen message')) {
  const originals = new Map([[controlA.agentSessionId, initial], [controlB.agentSessionId, page('Session B specific text', ['beta'], controlB)]])
  const revisions = new Map([[controlA.agentSessionId, 1], [controlB.agentSessionId, 1]])
  let readSource = async (id: string) => originals.get(id)!
  const f = await conversationPagePortFixture(controlA, sourceA, async id => readSource(id))
  closes.push(f.close)
  const originalSession = await f.client.readAgentSession(controlA.agentSessionId)
  if (!originalSession) throw new Error('Original visibility source Session is missing')
  expect(originalSession).toMatchObject({ hostId: controlA.hostId, agentSessionId: controlA.agentSessionId, run: controlA.run })
  await f.store.compareAndSwap(null, { ...originalSession, agentSessionId: controlB.agentSessionId, run: controlB.run,
    hookBindingId: 'visibility-beta-binding', hookToken: 'visibility-beta-token',
    nativeHandle: { kind: 'provider', providerId: sourceB.providerId, sessionId: sourceB.nativeSessionId } })
  expect(await f.client.readAgentSession(controlB.agentSessionId)).toMatchObject({ hostId: controlB.hostId,
    agentSessionId: controlB.agentSessionId, run: controlB.run, nativeHandle: { providerId: sourceB.providerId, sessionId: sourceB.nativeSessionId } })
  const source = (id: string) => originals.get(id)!.source
  const checkpoint = (id: string) => ({ agentSessionId: id, source: source(id), cursor: `visibility-cut-${revisions.get(id)}` })
  const nativePending: Promise<AgentSessionHistoryPage>[] = []
  f.nativeRead.mockImplementation((id) => {
    const currentCheckpoint = checkpoint(id)
    const pending = readSource(id).then(result => ({ ...result, changesCursor: currentCheckpoint.cursor }))
    nativePending.push(pending); return pending
  })
  f.nativeCheckpoint.mockImplementation(async id => ({ hostId: 'local', agentSessionId: id,
    source: source(id), items: [], checkpoint: checkpoint(id), more: false }))
  f.nativeChanges.mockImplementation(async id => ({ hostId: 'local', agentSessionId: id,
    source: source(id), items: [], checkpoint: checkpoint(id), more: false }))
  vi.mocked(f.client.observeSessionHistory).mockImplementation(async id => ({ source: source(id), dispose() {} }))
  await f.store.readCapturedHistory(controlA.agentSessionId, { limit: 1 })
  await f.store.readCapturedHistory(controlB.agentSessionId, { limit: 1 })
  const metadata = await f.store.loadMetadata()
  const capturedSnapshot = async () => Promise.all([controlA, controlB].map(async control => {
    const page = await f.store.readCapturedHistory(control.agentSessionId, { limit: 1 })
    return { stream: page.stream, records: page.records }
  }))
  let capturedOriginals = await capturedSnapshot()
  const gates: Array<() => void> = []
  closes.push(async () => {
    for (const release of gates.splice(0)) release()
    await Promise.allSettled(nativePending)
    // Core may persist private view/cursor bookkeeping in the same SQLite
    // container. Reading cannot change either original durable Session or source.
    expect(await f.store.loadMetadata()).toEqual(metadata)
    expect(await capturedSnapshot()).toEqual(capturedOriginals)
    expect(f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  })
  return { ...f, nativePending,
    replace: (next: AgentSessionHistoryPage) => { originals.set(next.agentSessionId, next); revisions.set(next.agentSessionId, revisions.get(next.agentSessionId)! + 1) },
    fail: (error: Error) => { readSource = async () => { throw error } },
    hold: (id = controlA.agentSessionId) => {
      let entered = false
      const originalRead = readSource
      readSource = async target => {
        if (target !== id) return originalRead(target)
        const response = await originalRead(target)
        entered = true
        return new Promise<AgentSessionHistoryPage>(resolve => gates.push(() => resolve(response)))
      }
      return { entered: () => entered, release: () => { readSource = originalRead; for (const release of gates.splice(0)) release() } }
    },
    publish: async (item: AgentTimelineItem) => { const stream = await f.publishCaptured([item]); capturedOriginals = await capturedSnapshot(); return stream }
  }
}

it('disabled original public consumer retains both native and captured bodies, TextNode and selected Range', async () => {
  const text = 'Identical prompt text across sources', f = await fixture(page(text, ['native-one', 'native-two']))
  await f.publish(captured(text)); await render(<Presenter />); await readOriginalSubmission()
  const originals = bodies(), selection = selected(originals[0]!)
  await render(<Presenter enabled={false} />)
  expect(bodies()).toEqual(originals); unchanged(selection)
  expect(reader().conversation.inspect()).toMatchObject({ loading: false, watch: { bound: false } })
})

it('an active independent consumer refresh and parent rerender cannot replace the paused consumer private frame or Range', async () => {
  const f = await fixture()
  const dual = (enabled: boolean, tick: number) => <div data-parent-tick={tick}>
    <Presenter key="one" enabled={enabled} /><Presenter key="two" name="two" />
  </div>
  await render(dual(true, 0)); await ready(); await ready('two')
  const original = bodies()[0]!, selection = selected(original), frame = reader().conversation.snapshot
  expect(frame!.window.id).not.toBe(reader('two').conversation.snapshot!.window.id)
  await render(dual(false, 1))
  f.replace(page('Brand new refreshed message', ['refreshed']))
  await act(async () => reader('two').refresh())
  await wait(() => expect(scope('two').textContent).toContain('Brand new refreshed message'))
  await render(dual(false, 2))
  expect(reader().conversation.snapshot).toBe(frame); expect(bodies()[0]).toBe(original)
  expect(scope().textContent).not.toContain('Brand new refreshed message'); unchanged(selection)
})

it('disabled callbacks do no original reads and a subsequent real source failure is honest while the connected body remains', async () => {
  const f = await fixture(page('Resilient stable body'))
  await render(<Presenter />); await ready()
  const original = bodies()[0]!
  await render(<Presenter enabled={false} />)
  const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  const changes = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  await act(async () => { await reader().refresh(); await reader().loadEarlier() })
  expect(api.conversation.readAgentConversation).toHaveBeenCalledTimes(reads)
  expect(api.conversation.readConversationChanges).toHaveBeenCalledTimes(changes)
  await render(<Presenter />); await ready()
  f.fail(new Error('Controlled original source unavailable'))
  await act(async () => reader().refresh())
  await wait(() => expect(reader().error).toMatchObject({ code: 'AGENT_CONVERSATION_SOURCE_READ_UNAVAILABLE' }))
  expect(reader().error!.message).toContain('Controlled original source unavailable')
  expect(bodies()[0]).toBe(original); expect(original.isConnected).toBe(true); expect(original.textContent).toContain('Resilient stable body')
})

it('paused and resumed pending source reads preserve all original nodes and Range until changed text is explicitly releasable', async () => {
  const text = 'Triple identical prompt text', f = await fixture(page(text, ['native-one', 'native-two']))
  await f.publish(captured(text)); await render(<Presenter />); await readOriginalSubmission()
  const originals = bodies(), selection = selected(originals[0]!)
  await render(<Presenter enabled={false} />)
  expect(bodies()).toEqual(originals); unchanged(selection)
  await render(<Presenter />); await ready('one', 3)
  f.replace(page('Refreshed native text', ['native-one', 'native-two']))
  const gate = f.hold()
  let refresh!: Promise<void>
  await act(async () => { refresh = reader().refresh() })
  await wait(() => expect(gate.entered()).toBe(true))
  expect(bodies()).toEqual(originals); unchanged(selection)
  await act(async () => { gate.release(); await refresh })
  expect(bodies()).toEqual(originals); unchanged(selection)
  await act(async () => clearSelection())
  await wait(() => expect(scope().textContent).toContain('Refreshed native text'))
  expect(bodies()).toHaveLength(3)
})

it('resume preserves the same connected body and revalidates only its retained original view', async () => {
  await fixture(page('Resume prompt text')); await render(<Presenter />); await ready()
  const original = bodies()[0]!, frame = reader().conversation.snapshot!
  await render(<Presenter enabled={false} />); expect(original.isConnected).toBe(true)
  const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await render(<Presenter />); await ready()
  expect(bodies()[0]).toBe(original)
  const resumed = vi.mocked(api.conversation.readAgentConversation).mock.calls.slice(reads)
  expect(resumed).toHaveLength(1)
  expect(resumed[0]![0]).toMatchObject({ hostId: controlA.hostId, agentSessionId: controlA.agentSessionId, view: frame.window.view })
  expect(reader().conversation.snapshot!.window.id).toBe(frame.window.id)
})

it('an original in-flight source result cannot render or commit after its consumer is paused', async () => {
  const f = await fixture(page('Late arriving query', ['late']))
  const gate = f.hold(); let renders = 0
  await render(<Presenter onRender={() => { renders++ }} />)
  await wait(() => expect(gate.entered()).toBe(true))
  await render(<Presenter enabled={false} onRender={() => { renders++ }} />)
  const paused = renders
  await act(async () => { gate.release(); await Promise.allSettled(f.nativePending) })
  expect(renders).toBe(paused); expect(bodies()).toHaveLength(0); expect(reader().conversation.snapshot).toBeNull()
})

it('switching the exact Session rejects an old source result and keeps the new Session frame and body', async () => {
  const f = await fixture(page('Session A specific text', ['alpha']))
  await render(<Presenter />); await ready()
  const gate = f.hold(); let oldRead!: Promise<void>
  await act(async () => { oldRead = reader().refresh() })
  await wait(() => expect(gate.entered()).toBe(true))
  await render(<Presenter control={controlB} />); await ready()
  const original = bodies()[0]!, frame = reader().conversation.snapshot!
  expect(scope().textContent).toContain('Session B specific text'); expect(scope().textContent).not.toContain('Session A specific text')
  expect(frame).toMatchObject({ hostId: controlB.hostId, agentSessionId: controlB.agentSessionId })
  await act(async () => { gate.release(); await oldRead; await Promise.allSettled(f.nativePending) })
  expect(reader().conversation.snapshot).toBe(frame); expect(bodies()[0]).toBe(original)
  expect(scope().textContent).not.toContain('Session A specific text')
})

it('each mounted public consumer owns its exact window and removing one releases only that window', async () => {
  await fixture(page('Original shared source'))
  const dual = (one: boolean, two: boolean) => <div>
    {one ? <Presenter key="one" /> : null}{two ? <Presenter key="two" name="two" /> : null}
  </div>
  await render(dual(true, true)); await ready(); await ready('two')
  const first = reader().conversation.snapshot!, second = reader('two').conversation.snapshot!, original = bodies('two')[0]
  expect(first.window.id).not.toBe(second.window.id)
  expect(api.conversation.readAgentConversation).toHaveBeenCalled()
  await render(dual(false, true))
  await wait(() => expect(vi.mocked(api.conversation.releaseConversationView).mock.calls.some(([input]) => input.view === first.window.view)).toBe(true))
  expect(reader('two').conversation.snapshot).toBe(second); expect(bodies('two')[0]).toBe(original)
  expect(vi.mocked(api.conversation.releaseConversationView).mock.calls.some(([input]) => input.view === second.window.view)).toBe(false)
  await render(dual(false, false))
  await wait(() => expect(vi.mocked(api.conversation.releaseConversationView).mock.calls.some(([input]) => input.view === second.window.view)).toBe(true))
  expect(host.querySelectorAll('.log-turn__body')).toHaveLength(0)
})

it('a real related captured publication updates the active consumer without waking the paused consumer', async () => {
  const f = await fixture(page('Steady prompt')); let hiddenRenders = 0
  const dual = (enabled: boolean) => <div><Presenter key="one" enabled={enabled} onRender={() => { hiddenRenders++ }} /><Presenter key="two" name="two" /></div>
  await render(dual(true)); await ready(); await ready('two')
  const original = bodies()[0]!, frame = reader().conversation.snapshot
  await render(dual(false)); const paused = hiddenRenders
  await act(async () => f.publish(captured('New content while hidden')))
  await wait(() => expect(scope('two').textContent).toContain('New content while hidden'))
  expect(hiddenRenders).toBe(paused); expect(reader().conversation.snapshot).toBe(frame); expect(bodies()).toEqual([original])
  expect(scope().textContent).not.toContain('New content while hidden')
  expect(reader().conversation.inspect()).toMatchObject({ loading: false, watch: { bound: false } })
})

it('a genuinely suspended uncommitted Session B render cannot erase committed paused A bodies or Range', async () => {
  const text = 'Identical prompt across aborted render', f = await fixture(page(text, ['native-one', 'native-two']))
  await f.publish(captured(text))
  const suspended = new Promise<void>(() => {}); let bRenders = 0, suspensions = 0
  function Sibling({ pending }: { pending: boolean }) { if (pending) { suspensions++; throw suspended } return <div data-ready>Ready</div> }
  function AbortHost({ control, enabled, pending }: { control: AgentSessionControl; enabled: boolean; pending: boolean }) {
    return <Suspense fallback={<div data-fallback>Pending</div>}>
      <Presenter control={control} enabled={enabled} onRender={actual => { if (actual.agentSessionId === controlB.agentSessionId) bRenders++ }} />
      <Sibling pending={pending} />
    </Suspense>
  }
  await render(<AbortHost control={controlA} enabled pending={false} />); await readOriginalSubmission()
  const originals = bodies(), selection = selected(originals[0]!), frame = reader().conversation.snapshot
  await act(async () => startTransition(() => root.render(<AbortHost control={controlB} enabled pending />)))
  expect(bRenders).toBeGreaterThan(0); expect(suspensions).toBeGreaterThan(0)
  expect(host.querySelector('[data-fallback]')).toBeNull()
  expect(f.nativeRead.mock.calls.filter(([id]) => id === controlB.agentSessionId)).toHaveLength(0)
  expect(bodies()).toEqual(originals); unchanged(selection)
  await render(<AbortHost control={controlA} enabled={false} pending={false} />)
  expect(reader().conversation.snapshot).toBe(frame); expect(bodies()).toEqual(originals); unchanged(selection)
})
