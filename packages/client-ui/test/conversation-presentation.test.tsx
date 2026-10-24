// @vitest-environment happy-dom
import { act, startTransition, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { projectConversationReading } from '../src/lib/conversation-records'
import { ConversationView } from '../src/components/ConversationView'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation'
import * as coreConversation from '@agentmux/core/conversation'
import * as sequenceModule from '../src/lib/conversation-record-sequence'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
import type { ConversationPresentationController } from '../src/lib/use-conversation-record-layout'

const source = { providerId: 'recorded-provider', nativeSessionId: 'original-native' }
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let root: Root, host: HTMLElement
const item = (id: string, kind: 'activity' | 'assistant-message' = 'assistant-message', text = id) => ({ id, kind, contentParts: [{ kind: 'text' as const, text }] })
const page = (...items: AgentSessionHistoryPage['items']): AgentSessionHistoryPage => ({ agentSessionId: 'session', sourceHostId: 'local', source, nextCursor: null, items })
const frame = (page: AgentSessionHistoryPage) => {
  const reading = projectConversationReading({ agentSessionId: 'session', executionHostId: 'local', historyPage: page })
  return { page, records: reading.records, originalRecords: reading.originalRecords, coverage: reading.timeline.coverage }
}
async function draw(props: ReturnType<typeof frame>, extra: Partial<ComponentProps<typeof ConversationView>> = {}) {
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationView {...props} sessionId="session" executionHostId="local"
    renderProcess={props => <NativeProcessObservation {...props} />} {...extra} /></ClientUiProvider>))
}
async function transition(props: ReturnType<typeof frame>, extra: Partial<ComponentProps<typeof ConversationView>>) {
  await act(async () => startTransition(() => root.render(<ClientUiProvider platform={platform}><ConversationView {...props} sessionId="session" executionHostId="local"
    renderProcess={props => <NativeProcessObservation {...props} />} {...extra} /></ClientUiProvider>)))
}
function select(node: Node) {
  const range = document.createRange(); range.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
  return range
}
function delaySelectionEvents() {
  const queued: Event[] = [], dispatch = document.dispatchEvent.bind(document)
  const interception = vi.spyOn(document, 'dispatchEvent').mockImplementation(event => {
    if (event.type === 'selectionchange') { queued.push(event); return true }
    return dispatch(event)
  })
  return { count: () => queued.length, release: async () => {
    interception.mockRestore()
    await act(async () => { for (const event of queued) dispatch(event) })
  } }
}
async function release() { await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }) }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('protects a direct-props selected record when a message splits its process parent', async () => {
  const a = item('first', 'activity'), b = item('selected', 'activity')
  await draw(frame(page(a, b)))
  await act(async () => host.querySelector<HTMLButtonElement>('[data-native-step-id="selected"] button')!.click())
  const text = host.querySelector('[data-native-record-id="selected"] .log-turn__body p')!.firstChild!
  const range = select(text)
  await draw(frame(page(a, item('between'), b)))
  expect(text.isConnected).toBe(true); expect(range.startContainer).toBe(text); expect(getSelection()!.toString()).toBe('selected')
  expect(host.querySelector('[data-native-record-id="between"]')).toBeNull()
  await release()
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(2)
  expect(host.querySelector('[data-native-step-id="selected"] button')?.getAttribute('aria-expanded')).toBe('true')
})

it('protects canonical role changes although the exact raw source and body are unchanged', async () => {
  const captured = { id: 'same-raw', agentSessionId: 'session', kind: 'assistant_message' as const, source: 'native-hook' as const,
    status: 'complete' as const, title: 'Original captured', content: 'Original selected body', createdAt: 1, updatedAt: 1 }
  const reading = projectConversationReading({ agentSessionId: 'session', executionHostId: 'local', timeline: { agentSessionId: 'session', sourceHostId: 'local', revision: 1, items: [captured] } })
  const initial = { page: page(), records: reading.records.map(record => ({ ...record, role: 'message' as const })), originalRecords: reading.originalRecords, coverage: reading.timeline.coverage }
  await draw(initial)
  const text = host.querySelector('.log-turn__body p')!.firstChild!, range = select(text)
  const records = initial.records.map(record => ({ ...record, role: 'interaction' as const }))
  await draw({ ...initial, records })
  expect(text.isConnected).toBe(true); expect(range.startContainer).toBe(text)
  expect(host.querySelector('[data-captured-process-id]')).toBeNull()
  await release(); expect(host.querySelector('[data-captured-process-id]')).not.toBeNull()
})

it('holds coverage and original contributors in the same frame, while independent actions stay current', async () => {
  const first = frame(page(item('record', 'assistant-message', 'selected version')))
  await draw(first, { renderRecordActions: () => <button>Old qualification</button> })
  const text = host.querySelector('.log-turn__body p')!.firstChild!; select(text)
  const next = frame(page(item('record', 'assistant-message', 'new version')))
  next.coverage = next.coverage.map(row => ({ ...row, gaps: [...row.gaps, { code: 'SOURCE_NEW', message: 'New frame coverage' }] }))
  await draw(next, { renderRecordActions: () => <button>Current qualification</button> })
  expect(text.isConnected).toBe(true); expect(host.textContent).toContain('selected version')
  expect(host.textContent).not.toContain('New frame coverage'); expect(host.textContent).not.toContain('new version')
  expect(host.textContent).toContain('Current qualification'); expect(host.textContent).not.toContain('Old qualification')
  await release(); expect(host.textContent).toContain('new version'); expect(host.textContent).toContain('New frame coverage')
})

it('retains the visible reading anchor without a selection when the candidate evicts it', async () => {
  const initial = frame(page(item('visible'), item('later')))
  await draw(initial)
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 900 } })
  host.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300)
  const visible = host.querySelector<HTMLElement>('[data-native-record-id="visible"]')!
  visible.getBoundingClientRect = () => new DOMRect(0, 30, 400, 120)
  await draw(frame(page(item('later'))))
  expect(visible.isConnected).toBe(true); expect(host.querySelector('[data-native-record-id="visible"]')).toBe(visible)
  // Moving the reader away permits the current candidate; no automatic read is issued.
  visible.getBoundingClientRect = () => new DOMRect(0, -400, 400, 120)
  await act(async () => host.dispatchEvent(new Event('scroll')))
  expect(host.querySelector('[data-native-record-id="visible"]')).toBeNull()
})

it('uses the newest candidate after release and never replays another Session frame', async () => {
  await draw(frame(page(item('record', 'assistant-message', 'old'))))
  select(host.querySelector('.log-turn__body p')!.firstChild!)
  await draw(frame(page(item('record', 'assistant-message', 'superseded'))))
  await draw(frame(page(item('record', 'assistant-message', 'current'))))
  await release(); expect(host.textContent).toContain('current'); expect(host.textContent).not.toContain('superseded')
  select(host.querySelector('.log-turn__body p')!.firstChild!)
  const anotherPage = { ...page(item('other', 'assistant-message', 'Other Session')), agentSessionId: 'other-session' }
  const reading = projectConversationReading({ agentSessionId: 'other-session', executionHostId: 'local', historyPage: anotherPage })
  await draw({ page: anotherPage, records: reading.records, originalRecords: reading.originalRecords, coverage: reading.timeline.coverage }, { sessionId: 'other-session' })
  expect(host.textContent).toContain('Other Session'); expect(host.textContent).not.toContain('current')
})


it.each(['crossing', 'unknown-intersection'])('retains actual selected records for a %s Range', async mode => {
  await draw(frame(page(item('first'), item('middle'), item('last'))))
  const first = host.querySelector('[data-native-record-id="first"] .log-turn__body p')!.firstChild!
  const middle = host.querySelector('[data-native-record-id="middle"]')!
  const last = host.querySelector('[data-native-record-id="last"] .log-turn__body p')!.firstChild!
  const range = document.createRange(); range.setStart(first, 1); range.setEnd(last, 2); getSelection()!.addRange(range)
  if (mode === 'unknown-intersection') vi.spyOn(range, 'intersectsNode').mockImplementation(() => { throw new DOMException('Intersection unavailable') })
  await draw(frame(page(item('first'), item('last'))))
  expect(middle.isConnected).toBe(true); expect(range.startContainer).toBe(first); expect(range.endContainer).toBe(last)
})

it('does no frame or geometry work for ordinary scrolling while watching selection release', async () => {
  const controller = { current: null }, released = vi.fn()
  await draw(frame(page(item('visible'))), { presentation: { controller, pending: false, watchSelection: true, onRelease: released } })
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 900 } })
  const projected = vi.spyOn(sequenceModule, 'projectConversationRecordSequence')
  const viewportRect = vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
  const recordRect = vi.spyOn(host.querySelector<HTMLElement>('[data-native-record-id="visible"]')!, 'getBoundingClientRect')
  await act(async () => { for (let index = 0; index < 30; index++) host.dispatchEvent(new Event('scroll')) })
  expect(viewportRect).not.toHaveBeenCalled(); expect(recordRect).not.toHaveBeenCalled(); expect(released).not.toHaveBeenCalled()
  await act(async () => document.dispatchEvent(new Event('selectionchange')))
  expect(released).toHaveBeenCalledOnce(); expect(projected).not.toHaveBeenCalled(); expect(viewportRect).not.toHaveBeenCalled(); expect(recordRect).not.toHaveBeenCalled()
})

it.each(['body', 'outside-composer'])('avoids protection scans with no selection and %s focus', async mode => {
  const controller: { current: ConversationPresentationController | null } = { current: null }
  const presentation = { controller, pending: false, onRelease: vi.fn() }
  const readingGeometry = { viewport: () => host, following: () => true, pinToBottom: vi.fn() }
  const initial = frame(page(item('original'))), next = frame(page(item('replacement')))
  await draw(initial, { presentation, readingGeometry })
  const composer = document.createElement('textarea'); document.body.append(composer)
  try {
    if (mode === 'outside-composer') composer.focus()
    else (document.activeElement as HTMLElement)?.blur()
    const focused = document.activeElement
    expect(focused).toBe(mode === 'outside-composer' ? composer : document.body)
    expect(host.querySelector('[data-conversation-layout-key]')).not.toBeNull()
    expect(getSelection()?.isCollapsed).toBe(true)
    const queries = vi.spyOn(Element.prototype, 'querySelectorAll')
    // The real precommit port runs protection alone; shell mounting and anchor
    // geometry are separate work and must not be mistaken for this scan.
    expect(controller.current).not.toBeNull()
    expect(controller.current!.canPresent(next)).toBe(true)
    expect(queries.mock.calls.filter(([selector]) => selector === '[data-conversation-layout-key]')).toEqual([])
    await draw(next, { presentation, readingGeometry })
    expect(host.querySelector('[data-native-record-id="replacement"]')).not.toBeNull()
    expect(host.querySelector('[data-native-record-id="original"]')).toBeNull()
    expect(document.activeElement).toBe(focused)
  } finally { composer.remove() }
})

it('still retains a changed record with local focus and releases after focus leaves', async () => {
  const controller: { current: ConversationPresentationController | null } = { current: null }
  const presentation = { controller, pending: false, onRelease: vi.fn() }
  const readingGeometry = { viewport: () => host, following: () => true, pinToBottom: vi.fn() }
  const renderRecordActions = () => <button>Original record action</button>
  const extra = { presentation, readingGeometry, renderRecordActions }
  await draw(frame(page(item('original'))), extra)
  const action = host.querySelector<HTMLButtonElement>('.log-turn button')!
  expect(action).not.toBeNull(); await act(async () => action.focus())
  const next = frame(page(item('replacement')))
  expect(controller.current!.canPresent(next)).toBe(false)
  await draw(next, extra)
  expect(action.isConnected).toBe(true); expect(document.activeElement).toBe(action)
  expect(host.querySelector('[data-native-record-id="replacement"]')).toBeNull()
  await act(async () => action.blur())
  expect(controller.current!.canPresent(next)).toBe(true)
  await draw(next, extra)
  expect(host.querySelector('[data-native-record-id="replacement"]')).not.toBeNull()
})

it('does not pull a new selection to the tail before its scroll event arrives', async () => {
  const initial = frame(page(item('selected'))), pinToBottom = vi.fn(() => { host.scrollTop = 900 })
  const readingGeometry = { viewport: () => host, following: () => true, pinToBottom }
  await draw(initial, { readingGeometry })
  // Browser selection and scroll position change synchronously; scroll delivery is later.
  host.scrollTop = 400
  const text = host.querySelector('.log-turn__body p')!.firstChild!
  await act(async () => { select(text) })
  expect(getSelection()!.anchorNode).toBe(text)
  expect(pinToBottom).not.toHaveBeenCalled()
  expect(host.scrollTop).toBe(400)
})

it('compares committed canonical revisions without hashing 300 unrelated original bodies', async () => {
  const initial = frame(page(...Array.from({ length: 300 }, (_, i) => item('record-' + i))))
  await draw(initial)
  const text = host.querySelector('[data-native-record-id="record-37"] .log-turn__body p')!.firstChild!
  const range = select(text)
  const next = frame(page(...initial.page.items.map((record, index) => index === 299 ? item(record.id, 'assistant-message', 'Independent new body') : record)))
  const revisions = vi.spyOn(coreConversation, 'conversationRevision')
  await draw(next)
  expect(host.textContent).toContain('Independent new body'); expect(text.isConnected).toBe(true)
  expect(getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('record-37')
  expect(revisions, 'Core has already supplied exact canonical event and contributor revisions').not.toHaveBeenCalled()
})

it('protects a visible process record even when its offscreen parent group remains mounted', async () => {
  await draw(frame(page(item('offscreen', 'activity'), item('visible-step', 'activity'))))
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 900 } })
  host.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300)
  host.querySelector<HTMLElement>('.conversation-record-process')!.getBoundingClientRect = () => new DOMRect(0, -600, 400, 900)
  host.querySelector<HTMLElement>('[data-native-record-id="offscreen"]')!.getBoundingClientRect = () => new DOMRect(0, -500, 400, 100)
  const visible = host.querySelector<HTMLElement>('[data-native-record-id="visible-step"]')!
  visible.getBoundingClientRect = () => new DOMRect(0, 30, 400, 100)
  await draw(frame(page(item('offscreen', 'activity'))))
  expect(visible.isConnected, 'A retained process shell cannot substitute for the current reading record').toBe(true)
})

it('keeps the selected original below a stable leading process header when earlier records arrive', async () => {
  host.setAttribute('data-workbench-reading-scroll', '')
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 400 }, scrollHeight: { configurable: true, value: 6000 } })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === host) return new DOMRect(0, 0, 600, 400)
    if (this.matches('.wf-head')) return new DOMRect(0, 30 - host.scrollTop, 600, 32)
    if (this.dataset.nativeRecordId === 'selected') return new DOMRect(0, 150 + (host.querySelector('[data-native-record-id="earlier"]') ? 1040 : 0) - host.scrollTop, 600, 80)
    return new DOMRect()
  })
  const header = item('leading', 'activity'), selected = item('selected')
  await draw(frame(page(header, selected)))
  const row = host.querySelector<HTMLElement>('[data-native-record-id="selected"]')!
  const text = row.querySelector('p')!.firstChild!, range = select(text)
  await draw(frame(page(header, item('earlier'), selected)))
  expect(host.querySelector('[data-native-record-id="earlier"]')).not.toBeNull()
  expect(row.getBoundingClientRect().top, 'The unchanged leading group is not the selected reading position').toBe(150)
  expect(host.scrollTop).toBe(1040)
  expect(host.querySelector('[data-native-record-id="selected"]')).toBe(row)
  expect(getSelection()!.getRangeAt(0)).toBe(range); expect(range.startContainer).toBe(text)
})

it.each(['new', 'moved'])('rechecks a %s selection established after candidate rendering without selectionchange', async mode => {
  const initial = frame(page(item('selected'), item('stable')))
  await draw(initial)
  const events = delaySelectionEvents()
  const text = host.querySelector('[data-native-record-id="selected"] p')!.firstChild!
  const priorRange = mode === 'moved' ? select(host.querySelector('[data-native-record-id="stable"] p')!.firstChild!) : null
  let selected = false
  const next = frame(page(item('stable')))
  await transition(next, { renderRecordActions: () => {
    if (!selected) {
      selected = true
      if (priorRange) priorRange.selectNodeContents(text)
      else select(text)
    }
    return null
  } })
  expect(selected, 'The range changes after the owner read its render snapshot').toBe(true)
  expect(events.count()).toBeGreaterThan(0)
  expect(text.isConnected, 'The precommit check must reject eviction of the actual selected original').toBe(true)
  expect(getSelection()!.toString()).toBe('selected')
  expect(getSelection()!.getRangeAt(0).startContainer).toBe(text)
  await events.release()
  await release()
  expect(host.querySelector('[data-native-record-id="selected"]')).toBeNull()
})

it('captures a late selected leaf immediately before prepending its neighbors', async () => {
  host.setAttribute('data-workbench-reading-scroll', '')
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 400 }, scrollHeight: { configurable: true, value: 6000 } })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === host) return new DOMRect(0, 0, 600, 400)
    if (this.matches('.wf-head')) return new DOMRect(0, 30 - host.scrollTop, 600, 32)
    if (this.dataset.nativeRecordId === 'selected') return new DOMRect(0, 150 + (host.querySelector('[data-native-record-id="earlier"]') ? 1040 : 0) - host.scrollTop, 600, 80)
    return new DOMRect()
  })
  const leading = item('leading', 'activity'), selected = item('selected')
  await draw(frame(page(leading, selected)))
  const events = delaySelectionEvents()
  const row = host.querySelector<HTMLElement>('[data-native-record-id="selected"]')!, text = row.querySelector('p')!.firstChild!
  let changed = false
  await transition(frame(page(leading, item('earlier'), selected)), { renderRecordActions: () => {
    if (!changed) { changed = true; select(text) }
    return null
  } })
  expect(changed).toBe(true)
  expect(events.count()).toBeGreaterThan(0)
  expect(row.getBoundingClientRect().top).toBe(150)
  expect(host.scrollTop).toBe(1040)
  expect(getSelection()!.getRangeAt(0).startContainer).toBe(text)
  await events.release()
})

it.each(['body', 'parent'])('retains the original when its %s changes after a late selection', async kind => {
  const selected = item('selected', kind === 'parent' ? 'activity' : 'assistant-message', 'Original selected body')
  const first = item('first', 'activity')
  await draw(frame(page(first, selected)))
  if (kind === 'parent') await act(async () => host.querySelector<HTMLButtonElement>('[data-native-step-id="selected"] button')!.click())
  const text = host.querySelector('[data-native-record-id="selected"] .log-turn__body p')!.firstChild!
  const events = delaySelectionEvents()
  let changed = false
  const next = frame(kind === 'body' ? page(first, item('selected', 'assistant-message', 'Revised selected body')) : page(first, item('between'), selected))
  await transition(next, { renderRecordActions: () => {
    if (!changed) { changed = true; select(text) }
    return null
  } })
  expect(changed).toBe(true); expect(events.count()).toBeGreaterThan(0)
  expect(text.isConnected).toBe(true)
  expect(getSelection()!.getRangeAt(0).startContainer).toBe(text)
  expect(getSelection()!.toString()).toBe('Original selected body')
  expect(host.textContent).not.toContain(kind === 'body' ? 'Revised selected body' : 'between')
  await events.release(); await release()
  expect(host.textContent).toContain(kind === 'body' ? 'Revised selected body' : 'between')
})

it.each(['visible', 'offscreen'])('anchors the visible selected leaf when a cross-record Range ends %s before observation', async endPosition => {
  host.setAttribute('data-workbench-reading-scroll', '')
  Object.defineProperties(host, { clientHeight: { configurable: true, value: 400 }, scrollHeight: { configurable: true, value: 6000 } })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === host) return new DOMRect(0, 0, 600, 400)
    if (this.matches('.wf-head')) return new DOMRect(0, 30 - host.scrollTop, 600, 32)
    if (this.dataset.nativeRecordId === 'start') return new DOMRect(0, -200 - host.scrollTop, 600, 80)
    if (this.dataset.nativeRecordId === 'end') return new DOMRect(0, 5000 - host.scrollTop, 600, 80)
    if (this.dataset.nativeRecordId === 'selected') return new DOMRect(0, 150 + (host.querySelector('[data-native-record-id="earlier"]') ? 1040 : 0) - host.scrollTop, 600, 80)
    return new DOMRect()
  })
  const start = item('start'), header = item('leading', 'activity'), selected = item('selected'), end = item('end')
  await draw(frame(page(start, header, selected, end)))
  const row = host.querySelector<HTMLElement>('[data-native-record-id="selected"]')!
  const first = host.querySelector('[data-native-record-id="start"] p')!.firstChild!
  const last = (endPosition === 'visible' ? row : host.querySelector('[data-native-record-id="end"]')!).querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(first, 1); range.setEnd(last, 3); getSelection()!.addRange(range)
  await draw(frame(page(start, header, item('earlier'), selected, end)))
  expect(host.querySelector('[data-native-record-id="earlier"]')).not.toBeNull()
  expect(row.getBoundingClientRect().top, 'The offscreen Range start cannot return ownership to the stable group').toBe(150)
  expect(host.scrollTop).toBe(1040); expect(getSelection()!.getRangeAt(0)).toBe(range)
  expect(range.startContainer).toBe(first); expect(range.endContainer).toBe(last)
})
