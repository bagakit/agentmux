// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { MoteConversationBrowser } from '../src/renderer/src/components/MoteConversationBrowser'
import { MoteSessionConversation } from '../src/renderer/src/components/MoteSessionConversation'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { normalizeAgentTimelineItem, type AgentTimelineItem } from '@agentmux/core'
import { recordedToolEdit } from '../../../packages/core/test/fixtures/recorded-tool-edits'
import { markProgrammaticReadingScroll } from '@agentmux/client-ui/reading-scroll'

const closes: Array<() => unknown | Promise<unknown>> = []
let host: HTMLDivElement, root: Root, core: Awaited<ReturnType<typeof nativeHistoryFixture>>, active: boolean
let height: number, extent: number, rowHeight: number, footerHeight: number, rows: unknown[], capturedRows: AgentTimelineItem[]
const observers = new Map<Element, ResizeObserverCallback>()
const disposedWatches = vi.fn()
let invalidate: (() => void) | undefined
const row = (id: number, content = `Original answer ${id}`) => ({ uuid: `message-${id}`, type: id === 0 ? 'user' : 'assistant', sessionId: 'native-main', timestamp: new Date((id + 1) * 1000).toISOString(), message: { role: id === 0 ? 'user' : 'assistant', content } })
const viewport = () => host.querySelector<HTMLDivElement>('.mote-session-conversation__scroll')!
const latest = () => host.querySelector<HTMLButtonElement>('.mote-session-conversation__latest')
const settle = () => act(async () => { await new Promise(done => setTimeout(done, 20)) })
const wait = (assert: () => void) => vi.waitFor(async () => { await settle(); assert() }, { timeout: 10000 })
async function render() {
  await act(async () => root.render(<MoteConversationBrowser active={active} choices={[{ id: 'exact-original', title: 'Original reader', row: 'Original reader',
    conversation: visible => <MoteSessionConversation hostId="local" agentSessionId={core.session.agentSessionId} identity="original-member" active={visible} /> }]} />))
}
async function scroll(top: number) { await act(async () => { viewport().scrollTop = top; viewport().dispatchEvent(new Event('scroll')) }) }
async function publish(next: unknown[], nextExtent = extent + 120) {
  rows = next; extent = nextExtent
  await writeFile(core.path, jsonl(rows))
  await act(async () => invalidate?.())
}
async function refresh() {
  const button = [...viewport().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === '重读原对话')!
  await wait(() => expect(button.disabled).toBe(false)); await act(async () => button.click())
}
async function resize(nextHeight: number, nextRowHeight = rowHeight) {
  extent = extent / rowHeight * nextRowHeight; rowHeight = nextRowHeight
  height = nextHeight
  await act(async () => { for (const callback of new Set(observers.values())) callback([], {} as ResizeObserver) })
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  height = 300; rowHeight = 120; footerHeight = 240; extent = 1440; active = true; invalidate = undefined; observers.clear(); disposedWatches.mockClear()
  vi.stubGlobal('ResizeObserver', class { constructor(readonly cb: ResizeObserverCallback) {} observe(node: Element) { observers.set(node, this.cb) } unobserve(node: Element) { observers.delete(node) } disconnect() { for (const [node, cb] of observers) if (cb === this.cb) observers.delete(node) } })
  vi.stubGlobal('IntersectionObserver', class { constructor(readonly cb: IntersectionObserverCallback) {} observe(target: Element) { this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) } unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('mote-session-conversation__scroll') ? height : 0 })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('mote-session-conversation__scroll') ? extent + footerHeight : 0 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('mote-session-conversation__scroll')) return new DOMRect(0, 0, 1000, height)
    if (this.hasAttribute('data-mote-conversation-tail')) return new DOMRect(0, extent - (viewport()?.scrollTop ?? 0), 1000, 0)
    const record = this.closest<HTMLElement>('[data-native-record-id]')
    if (record) return new DOMRect(0, Number(record.dataset.nativeRecordId?.replace('message-', '')) * rowHeight - (viewport()?.scrollTop ?? 0), 1000, rowHeight)
    const layout = this.closest<HTMLElement>('[data-conversation-layout-key]')
    if (layout && viewport()?.contains(layout)) return new DOMRect(0, [...viewport().querySelectorAll('[data-conversation-layout-key]')].indexOf(layout) * rowHeight - viewport().scrollTop, 1000, rowHeight)
    return new DOMRect(0, 0, 1000, 700)
  })
  Element.prototype.scrollIntoView = vi.fn()
})
async function mount(kind: 'native' | 'captured' = 'native', count = 12) {
  extent = count * rowHeight
  rows = Array.from({ length: count }, (_, id) => row(id))
  core = await nativeHistoryFixture('claude', kind === 'native' ? jsonl(rows) : ''); closes.push(core.close)
  capturedRows = []
  if (kind === 'captured') for (let id = 0; id < 12; id++) {
    const item = normalizeAgentTimelineItem({ id: `captured-${id}`, agentSessionId: core.session.agentSessionId, kind: id ? 'assistant_message' : 'user_message', source: id ? 'native-hook' : 'user', status: 'complete', title: id ? 'Original assistant' : 'Original user', content: `Original captured answer ${id}`, ...(id === 0 ? { publicContent: 'confirmed' } : {}), createdAt: id * 1000 + 1, updatedAt: id * 1000 + 1 })
    capturedRows.push(item); await core.store.applyTimelineMutation({ type: 'upsert', agentSessionId: core.session.agentSessionId, item })
  }
  const observe = core.client.observeSessionHistory.bind(core.client)
  vi.spyOn(core.client, 'observeSessionHistory').mockImplementation((id, listener, options?) => {
    invalidate = () => listener({ agentSessionId: id, source: { providerId: 'claude', nativeSessionId: 'native-main' }, kind: 'invalidated' })
    return observe(id, listener, options)
  })
  const bridge = await desktopConversationReadBridge(core, closes)
  vi.mocked(api.conversation.observeConversation).mockImplementation(async (...args) => {
    const observed = await bridge.observeConversation(...args)
    return { ...observed, dispose: () => { disposedWatches(); observed.dispose() } }
  })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  await render(); await wait(() => expect(host.textContent).toContain(kind === 'native' ? `Original answer ${count - 1}` : 'Original captured answer 11'))
  await wait(() => expect(viewport().scrollTop).toBe(extent - height))
}
afterEach(async () => { getSelection()?.removeAllRanges(); for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('uses one actual Session viewport, follows native append, and preserves a detached anchor across growth and resize', async () => {
  await mount()
  expect(host.querySelector('.mote-conversation-browser__reading')?.hasAttribute('data-workbench-reading-scroll')).toBe(false)
  expect(host.querySelectorAll('[data-workbench-reading-scroll]')).toHaveLength(1)
  expect(viewport().scrollTop).toBe(extent - height); expect(latest()).toBeNull()
  await publish([...rows, row(12)])
  await wait(() => expect(host.textContent).toContain('Original answer 12'))
  expect(viewport().scrollTop).toBe(extent - height)
  await scroll(480); expect(latest()).toBeTruthy()
  const anchor = host.querySelector<HTMLElement>('[data-native-record-id="message-4"]')!, offset = anchor.getBoundingClientRect().top
  await publish([...rows, row(13)])
  await wait(() => expect(host.textContent).toContain('Original answer 13'))
  expect(anchor.isConnected).toBe(true); expect(anchor.getBoundingClientRect().top).toBe(offset); expect(viewport().scrollTop).toBe(480)
  await resize(500)
  expect(viewport().scrollTop).toBe(480); expect(latest()).toBeTruthy()
  // A programmatic restore or a layout clamp landing at bottom never grants following.
  await act(async () => { viewport().scrollTop = extent - height; markProgrammaticReadingScroll(viewport()); viewport().dispatchEvent(new Event('scroll')) })
  expect(latest()).toBeNull()
  await resize(700)
  expect(latest()).toBeTruthy()
  await scroll(extent - height)
  expect(latest()).toBeNull()
  await publish([...rows, row(14)])
  await wait(() => expect(host.textContent).toContain('Original answer 14'))
  expect(viewport().scrollTop).toBe(extent - height)
  await scroll(480)
  await act(async () => latest()!.click())
  await wait(() => expect(latest()).toBeNull())
  expect(viewport().scrollTop).toBe(extent - height)
  for (const control of core.controls) expect(control).not.toHaveBeenCalled()
})

it('keeps selection and detached reading during source updates, then resumes only from explicit latest or a manual bottom scroll', async () => {
  await mount()
  await scroll(480)
  const record = host.querySelector<HTMLElement>('[data-native-record-id="message-4"]')!, body = record.querySelector('.conversation-message__body') ?? record
  const range = document.createRange(); range.selectNodeContents(body)
  await act(async () => { getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange')) })
  expect(latest()).toBeTruthy()
  await publish([...rows, row(12, 'New original while selected')])
  await wait(() => expect(host.textContent).toContain('保留选区，取消选择后更新原对话。'))
  expect(host.textContent).not.toContain('New original while selected'); expect(range.startContainer.isConnected).toBe(true)
  await resize(450)
  expect(getSelection()!.getRangeAt(0)).toBe(range); expect(record.isConnected).toBe(true)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  await wait(() => expect(host.textContent).toContain('New original while selected'))
  expect(latest()).toBeTruthy(); expect(viewport().scrollTop).toBe(480)
  await scroll(extent - height); expect(latest()).toBeNull()
  await publish([...rows, row(13)])
  await wait(() => expect(host.textContent).toContain('Original answer 13'))
  expect(viewport().scrollTop).toBe(extent - height)
  const watches = vi.mocked(api.conversation.observeConversation).mock.calls.length
  const disposals = disposedWatches.mock.calls.length
  active = false; await render()
  await wait(() => expect(disposedWatches).toHaveBeenCalledTimes(disposals + 1))
  await publish([...rows, row(14)])
  await settle(); expect(vi.mocked(api.conversation.observeConversation)).toHaveBeenCalledTimes(watches)
  expect(host.textContent).not.toContain('Original answer 14')
  active = true; await render(); await wait(() => expect(host.textContent).toContain('Original answer 14'))
  for (const control of core.controls) expect(control).not.toHaveBeenCalled()
})


it('follows a real captured in-place upsert and retains a captured-only anchor when detached', async () => {
  await mount('captured')
  const publishItem = async (id: number, text: string) => {
    extent += 120
    const previous = capturedRows[id] ?? capturedRows.at(-1)!
    const item = normalizeAgentTimelineItem({ ...previous, id: `captured-${id}`, content: text, updatedAt: previous.updatedAt + 1 })
    capturedRows[id] = item
    await core.store.applyTimelineMutation({ type: 'upsert', agentSessionId: core.session.agentSessionId, item })
    await refresh()
    await wait(() => expect(host.textContent).toContain(text))
  }
  await publishItem(11, 'Original captured answer grew in place')
  expect(viewport().scrollTop).toBe(extent - height)
  await scroll(480)
  const anchor = viewport().querySelectorAll<HTMLElement>('[data-conversation-layout-key]')[4]!, offset = anchor.getBoundingClientRect().top
  await publishItem(12, 'A later captured message')
  expect(anchor.isConnected).toBe(true); expect(anchor.getBoundingClientRect().top).toBe(offset)
  expect(viewport().scrollTop).toBe(480); expect(latest()).toBeTruthy()
  await resize(500, 180)
  expect(anchor.getBoundingClientRect().top).toBe(offset)
  expect(viewport().scrollTop).toBe(720); expect(latest()).toBeTruthy()
  for (const control of core.controls) expect(control).not.toHaveBeenCalled()
})


it('shows the real captured process summary collapsed in the Session consumer and retains an explicitly disclosed process', async () => {
  await mount('captured')
  const item = { ...recordedToolEdit(core.session.agentSessionId), status: 'failed' as const }
  extent += 120
  await core.store.applyTimelineMutation({ type: 'upsert', agentSessionId: core.session.agentSessionId, item })
  await refresh()
  await wait(() => expect(host.querySelector('.wf-card--observation')).toBeTruthy())
  const card = host.querySelector('.wf-card--observation')!, head = card.querySelector<HTMLButtonElement>('.wf-head')!
  expect(head.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('[data-captured-process-id]')).toBeNull()
  expect(card.textContent).toContain('标记为失败')
  await act(async () => head.click())
  expect(head.getAttribute('aria-expanded')).toBe('true')
  await wait(() => expect(card.querySelector('button[data-expandable]')).toBeTruthy())
  const originalHead = head
  active = false; await render(); active = true; await render()
  expect(card.isConnected).toBe(true); expect(card.querySelector('.wf-head')).toBe(originalHead)
  expect(head.getAttribute('aria-expanded')).toBe('true')
  for (const control of core.controls) expect(control).not.toHaveBeenCalled()
})


it('an explicit latest clears only its own viewport selection and preserves another pane’s range', async () => {
  await mount()
  await scroll(480)
  const own = document.createRange(); own.selectNodeContents(host.querySelector('[data-native-record-id="message-4"]')!)
  await act(async () => { getSelection()!.addRange(own); document.dispatchEvent(new Event('selectionchange')) })
  expect(latest()).toBeTruthy()
  await act(async () => latest()!.click())
  await wait(() => expect(latest()).toBeNull())
  expect(getSelection()!.isCollapsed).toBe(true); expect(viewport().scrollTop).toBe(extent - height)
  const otherPane = document.createElement('p'); otherPane.textContent = 'Other pane selection'; document.body.append(otherPane)
  closes.push(() => otherPane.remove())
  const other = document.createRange(); other.selectNodeContents(otherPane)
  await act(async () => { getSelection()!.addRange(other); document.dispatchEvent(new Event('selectionchange')) })
  await scroll(480)
  await act(async () => latest()!.click())
  await wait(() => expect(latest()).toBeNull())
  expect(getSelection()!.rangeCount).toBe(1)
  expect(getSelection()!.getRangeAt(0)).toBe(other)
  expect(viewport().scrollTop).toBe(extent - height)
  for (const control of core.controls) expect(control).not.toHaveBeenCalled()
})


it('an Earlier read detaches and preserves its original row, and a manual return to bottom resumes the current original source', async () => {
  await mount('native', 320)
  const original = host.querySelector<HTMLElement>('[data-native-record-id="message-317"]')!, offset = original.getBoundingClientRect().top
  const originalCount = host.querySelectorAll('[data-native-record-id]').length
  const earlier = [...viewport().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '更早的消息')!
  expect(earlier).toBeTruthy(); await wait(() => expect(earlier.disabled).toBe(false)); await act(async () => earlier.click())
  await wait(() => expect(host.querySelectorAll('[data-native-record-id]').length, JSON.stringify({ disabled: earlier.disabled, notices: [...host.querySelectorAll('[role=status]')].map(node => node.textContent), calls: vi.mocked(api.conversation.readAgentConversation).mock.calls.map(([input]) => input) })).toBeGreaterThan(originalCount))
  expect(host.querySelector('[data-native-record-id="message-317"]')).toBe(original)
  expect(original.getBoundingClientRect().top).toBe(offset)
  await publish([...rows, row(320, 'Original new tail while reading Earlier')])
  await wait(() => expect(host.textContent).toContain('Original new tail while reading Earlier'))
  expect(original.getBoundingClientRect().top).toBe(offset); expect(viewport().scrollTop).not.toBe(extent - height)
  await scroll(480); await scroll(extent - height)
  await wait(() => expect(host.textContent).toContain('Original new tail while reading Earlier'))
  expect(latest()).toBeNull(); expect(viewport().scrollTop).toBe(extent - height)
  for (const control of core.controls) expect(control).not.toHaveBeenCalled()
})


it('targets the message tail before a tall metadata footer and a programmatic return to that tail never grants following', async () => {
  await mount()
  footerHeight = 1800
  const details = [...viewport().querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === '原会话来源')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  await scroll(extent + footerHeight - height)
  expect(latest()).toBeTruthy()
  await act(async () => latest()!.click())
  await wait(() => expect(latest()).toBeNull())
  expect(viewport().scrollTop).toBe(extent - height)
  expect(viewport().scrollTop).not.toBe(viewport().scrollHeight - height)
  await scroll(480)
  await act(async () => { viewport().scrollTop = extent - height; markProgrammaticReadingScroll(viewport()); viewport().dispatchEvent(new Event('scroll')) })
  expect(latest()).toBeNull()
  const restoredTop = viewport().scrollTop
  await publish([...rows, row(12, 'Later original after programmatic restore')], extent + 600)
  await wait(() => expect(host.textContent).toContain('Later original after programmatic restore'))
  expect(viewport().scrollTop).toBe(restoredTop); expect(viewport().scrollTop).not.toBe(extent - height); expect(latest()).toBeTruthy()
  for (const control of core.controls) expect(control).not.toHaveBeenCalled()
})

it('a pure resize can reveal the message tail and hide latest without granting follow to a later original append', async () => {
  await mount()
  await scroll(0); expect(latest()).toBeTruthy()
  await resize(2000)
  expect(latest()).toBeNull()
  await publish([...rows, row(12, 'Later original after resize')], 2600)
  await wait(() => expect(host.textContent).toContain('Later original after resize'))
  expect(viewport().scrollTop).toBe(0); expect(latest()).toBeTruthy()
  for (const control of core.controls) expect(control).not.toHaveBeenCalled()
})


it('a manual physical bottom resumes following when the message tail is still visible above a short footer', async () => {
  await mount()
  await scroll(480)
  await scroll(extent + footerHeight - height)
  expect(host.querySelector('[data-mote-conversation-tail]')!.getBoundingClientRect().top).toBeGreaterThan(0)
  expect(latest()).toBeNull()
  await publish([...rows, row(12, 'Original answer after a visible-footer return')])
  await wait(() => expect(host.textContent).toContain('Original answer after a visible-footer return'))
  expect(viewport().scrollTop).toBe(extent - height)
  for (const control of core.controls) expect(control).not.toHaveBeenCalled()
})
