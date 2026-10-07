import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage } from '@agentmux/core'
import { ConversationView } from '../src/components/ConversationView.js'
import { ConversationNativeThread } from '../src/components/ConversationNativeThread.js'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { metricsPage, responsePage } from './fixtures/conversation-metrics.js'
import { projectConversationMetrics } from '../src/lib/conversation-metrics.js'

let root: Root, host: HTMLDivElement
const copy = vi.fn(async () => true)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); copy.mockClear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function show(page: AgentSessionHistoryPage, native = false) {
  const props = { page, sessionId: page.agentSessionId,
    renderProcess: (props: ComponentProps<typeof NativeProcessObservation>) => <NativeProcessObservation {...props} compact /> }
  await act(async () => root.render(<ClientUiProvider platform={platform}>
    {native ? <ConversationNativeThread {...props} /> : <ConversationView {...props} />}
  </ClientUiProvider>))
}
async function click(element: Element) { await act(async () => (element as HTMLElement).click()) }
function record(id: string) { const node = host.querySelector<HTMLElement>(`[data-native-record-id="${id}"]`); expect(node).not.toBeNull(); return node! }
function summaryHead() { const head = [...host.querySelectorAll<HTMLButtonElement>('.wf-head')].find(node => node.textContent?.includes('输出 127 tokens')); expect(head).toBeDefined(); return head! }

it('accumulates a full loaded window without repeatedly copying prior source IDs or mutating input and previous output', () => {
  const count = 1200
  const items: AgentSessionHistoryItem[] = Array.from({ length: count }, (_, index) => ({
    id: `cost-record:${index}`, turnId: 'one-original-turn', kind: 'activity', contentParts: [],
    metrics: { scope: 'turn', usage: { outputTokens: index } }
  }))
  for (const item of items) {
    Object.freeze(item.metrics!.usage); Object.freeze(item.metrics)
    Object.freeze(item.contentParts); Object.freeze(item)
  }
  Object.freeze(items)
  const originalIterator = Array.prototype[Symbol.iterator]
  let copiedIds = 0
  // Count actual prior-ID iteration, not elapsed time; a frozen input does not count.
  Array.prototype[Symbol.iterator] = function* () {
    const iterator = originalIterator.call(this)
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      if (typeof step.value === 'string' && step.value.startsWith('cost-record:')) copiedIds++
      yield step.value
    }
  }
  let projection: ReturnType<typeof projectConversationMetrics>
  try { projection = projectConversationMetrics(items) } finally { Array.prototype[Symbol.iterator] = originalIterator }
  const observed = projection.get(`cost-record:${count - 1}`)!
  expect(observed.recordIds).toEqual(items.map(item => item.id))
  expect(observed.metrics.usage?.outputTokens).toBe(count - 1)
  expect(copiedIds).toBeLessThanOrEqual(count * 2)
  projectConversationMetrics(items.slice(0, 100))
  expect(observed.recordIds).toHaveLength(count)
  expect(items[0]!.metrics!.usage!.outputTokens).toBe(0)
})

it('shows one exact cumulative turn report at its original process position, with public progress and final reply visible', async () => {
  await show(metricsPage())
  const head = summaryHead()
  expect(head.textContent).toContain('用时 13.0s')
  expect(head.textContent).toContain('1 条已加载记录')
  expect(host.querySelectorAll('.conversation-metrics__inline')).toHaveLength(1)
  expect(record('progress').textContent).toContain('版本和架构已经读到')
  expect(record('answer').textContent).toContain('系统版本 26.5.1')
  expect(record('answer').querySelector('[data-message-phase="final"]')).not.toBeNull()
  expect(head.getAttribute('aria-expanded')).toBe('false')
  await click(head)
  expect(head.getAttribute('aria-expanded')).toBe('true')
  const card = head.closest('.wf-card')!
  expect(card.textContent).toContain('727 tokens')
  expect(card.textContent).toContain('400 tokens')
  expect(card.textContent).toContain('turn-original')
  expect(card.textContent).toContain('usage-first')
  expect(card.textContent).toContain('usage-last')
  // Latest cumulative is 127, never 10 + 127. Original speech remains in source order.
  expect(card.textContent).not.toContain('137 tokens')
  for (const button of host.querySelectorAll<HTMLButtonElement>('.wf-head')) if (button.getAttribute('aria-expanded') === 'false') await click(button)
  expect([...host.querySelectorAll<HTMLElement>('[data-native-record-id]')].map(node => node.dataset.nativeRecordId)).toEqual(metricsPage().items.map(item => item.id))
})

it('keeps response scope, a real zero and missing duration distinct, and continuously exposes a metric failure without hiding the original record', async () => {
  await show(responsePage())
  const summary = host.querySelector('.conversation-metrics > summary')!
  expect(summary.textContent).toContain('本次响应记录')
  expect(summary.textContent).toContain('输出 0 tokens')
  expect(summary.textContent).toContain('耗时未记录')
  expect(host.querySelector('[role="status"]')?.textContent).toContain('原记录与 Agent 仍可使用')
  expect(record('response').textContent).toContain('单次响应')
  await act(async () => summary.parentElement!.setAttribute('open', ''))
  expect(summary.parentElement!.textContent).toContain('原生单次响应报告')
  expect(summary.parentElement!.textContent).toContain('42 tokens')
  const process = host.querySelector('.wf-head')!; await click(process)
  const step = record('unknown').querySelector('[data-observation-step-id]')!; await click(step)
  expect(record('unknown').textContent).toContain('Original record remains readable')
})

it('does not borrow another turn or a replaced source to fill a clipped window', async () => {
  const page = metricsPage(); page.items = page.items.filter(item => item.id === 'answer' || item.id === 'duration')
  await show(page)
  const head = host.querySelector('.wf-head')!
  expect(head.textContent).toContain('输出用量未记录')
  expect(head.textContent).toContain('用时 13.0s')
  await show({ ...page, source: { ...page.source, nativeSessionId: 'another-source' }, items: [
    { id: 'other-report', turnId: 'turn-original', kind: 'activity', contentParts: [{ kind: 'text', text: 'new source record' }], metrics: { scope: 'turn', usage: { outputTokens: 5 } } }
  ] })
  expect(host.textContent).toContain('输出 5 tokens')
  expect(host.textContent).toContain('耗时未记录')
  expect(host.textContent).not.toContain('13.0s')
})

it('retains read raw bodies, expansion and a real Range when metadata updates and the old process head is clipped', async () => {
  const page = metricsPage(); page.items = page.items.filter(item => item.id === 'usage-last' || item.id === 'duration')
  await show(page)
  const head = summaryHead(); await click(head)
  const original = record('duration'), step = original.querySelector('[data-observation-step-id]')!; await click(step)
  const body = original.querySelector('.log-turn__body')!
  const text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4)
  const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString()
  await click(head); expect(body.isConnected).toBe(true)
  await click(head); expect(original.querySelector('.log-turn__body')).toBe(body)
  await show({ ...page, items: [page.items[1]!] })
  expect(record('duration')).toBe(original)
  expect(original.querySelector('.log-turn__body')).toBe(body)
  expect(range.startContainer.isConnected).toBe(true)
  expect(selection.toString()).toBe(selected)
  expect(host.querySelector('.wf-head')?.getAttribute('aria-expanded')).toBe('true')
})

it('preserves interrupted and failed observations, original Copy, and the standalone NativeThread consumer', async () => {
  const page = metricsPage(); page.items = page.items.filter(item => item.id === 'answer' || item.id === 'duration')
  page.items[1] = { ...page.items[1]!, metrics: { scope: 'turn', status: 'interrupted', durationMs: 0 } }
  await show(page, true)
  expect(host.textContent).toContain('本轮已中断')
  expect(host.textContent).toContain('用时 0ms')
  const action = record('answer').querySelector('[aria-label="Copy message"]')!; await click(action)
  expect(copy).toHaveBeenCalledWith('系统版本 26.5.1，架构为 arm64。', expect.any(Function))
  page.items[1] = { ...page.items[1]!, metrics: { scope: 'turn', status: 'failed' } }
  await show(page, true)
  expect(host.textContent).toContain('本轮失败')
  expect(host.textContent).not.toContain('本轮已结束')
})

it('connects the actual Desktop Activity consumer without new reads or execution calls', async () => {
  const { ActivityView } = await import('../../../apps/desktop/src/renderer/src/components/ActivityView.js')
  const { api } = await import('../../../apps/desktop/src/renderer/src/lib/api.js')
  const reads = vi.spyOn(api.sessions, 'historyPage')
  const writes = vi.spyOn(api.sessions, 'write')
  try {
    const page = metricsPage()
    await act(async () => root.render(<ClientUiProvider platform={platform}>
      <ActivityView capability="complete-events" items={[]} userMessages={[]} sessionId={page.agentSessionId} nativeHistoryPage={page} />
    </ClientUiProvider>))
    const head = summaryHead()
    expect(record('answer').textContent).toContain('系统版本 26.5.1')
    await click(head)
    expect(head.closest('.wf-card')?.textContent).toContain('727 tokens')
    expect(reads).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
  } finally { reads.mockRestore(); writes.mockRestore() }
})

it('retains the same response body and Range when clipping changes the metric summary from multiple responses to one', async () => {
  const page = responsePage()
  page.items = ['response-a', 'response-b'].map((id, index) => ({ id, kind: 'activity' as const,
    contentParts: [{ kind: 'text' as const, text: `Original response process ${index ? 'B' : 'A'}` }],
    metrics: { scope: 'response' as const, usage: { outputTokens: index + 2 }, status: 'completed' as const } }))
  await show(page)
  await click(host.querySelector('.wf-head')!)
  const original = record('response-b'), step = original.querySelector('[data-observation-step-id]')!; await click(step)
  const body = original.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8)
  const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString()
  await show({ ...page, items: [page.items[1]!] })
  expect(record('response-b')).toBe(original)
  expect(original.querySelector('.log-turn__body')).toBe(body)
  expect(original.querySelector('[data-observation-step-id]')?.getAttribute('aria-expanded')).toBe('true')
  expect(selection.toString()).toBe(selected)
  expect(range.startContainer.isConnected).toBe(true)
  expect(host.textContent).toContain('原生响应已结束')
  expect(host.textContent).not.toContain('原生回合已结束')
})

it('keeps a recorded operation failure visible when the native turn itself has ended', async () => {
  const page = metricsPage()
  page.items = [{ id: 'failed-operation', turnId: 'turn-original', kind: 'activity',
    collaboration: { kind: 'operation', status: 'failed', receivers: [], agentStates: [] },
    contentParts: [{ kind: 'text', text: 'Original failed operation receipt' }] }, page.items.at(-1)!]
  await show(page)
  const head = host.querySelector('.wf-head')!
  expect(head.textContent).toContain('用时 13.0s')
  expect(head.querySelector('.log-row__chip--failed')?.textContent).toContain('Failed')
  expect(head.closest('.wf-card')?.getAttribute('data-status')).toBe('failed')
  await click(head)
  expect(record('failed-operation').textContent).toContain('Failed')
})
