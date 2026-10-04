import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import type { ComponentProps } from 'react'
import type { PastedImage } from '@agentmux/client-ui/pasted-images'
import type { AgentTimelineItem, AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'

vi.mock('../src/renderer/src/store', () => ({ useAppStore: (selector: (state: { timelines: Record<string, AgentTimelineSnapshot> }) => unknown) => selector({ timelines: {} }) }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { sessions: {
  historyPage: vi.fn(() => { throw new Error('No additional native read is permitted in this presenter test') }),
  historyResource: vi.fn(() => { throw new Error('Unexpected resource read') })
} } }))
const copies: string[] = []
const platform: ClientUiPlatform = { copyText: async text => { copies.push(text); return true }, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true,
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.close())); copies.length = 0 })
const raw = (uuid: string, content: string) => ({ sessionId: 'native-main', uuid, type: 'user', message: { role: 'user', content }, timestamp: _hygiene_fixtureIso(24257387486) })
const captured = (id: string, content: string, status: AgentTimelineItem['status'] = 'complete'): AgentTimelineItem => ({
  id, agentSessionId: 'private-agent', kind: 'user_message', source: 'user', status,
  createdAt: Date.parse(_hygiene_fixtureIso(24257380780)), updatedAt: Date.parse(_hygiene_fixtureIso(24257380780)), title: 'Submitted input', content
})
async function fixture(records: unknown[], receipts: AgentTimelineItem[] = []) {
  const f = await nativeHistoryFixture('claude', jsonl(records)); fixtures.push(f)
  for (const item of receipts) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'private-agent', item })
  const timeline = await f.client.sessionTimeline('private-agent')
  const page = await f.client.sessionHistoryPage('private-agent')
  return { ...f, timeline, page }
}
async function mount(page: AgentSessionHistoryPage | null, timeline: Awaited<ReturnType<typeof fixture>>['timeline'],
  run: (node: HTMLDivElement, update: (props?: Partial<ComponentProps<typeof ActivityView>>) => Promise<void>) => Promise<void>,
  extras: Partial<ComponentProps<typeof ActivityView>> = {}) {
  const node = document.createElement('div'); document.body.append(node)
  const root = createRoot(node)
  const props: ComponentProps<typeof ActivityView> = { sessionId: 'private-agent', executionHostId: 'local',
    items: timeline.items, nativeHistoryPage: page, capability: 'complete-events',
    userMessages: projectSessionUserMessages({ agentSessionId: 'private-agent', timeline, ...(page ? { historyPage: page } : {}) }), ...extras }
  const update = async (next: Partial<ComponentProps<typeof ActivityView>> = {}) => {
    Object.assign(props, next)
    await act(async () => { root.render(<ClientUiProvider platform={platform}><ActivityView {...props} /></ClientUiProvider>); for (let i = 0; i < 6; i++) await Promise.resolve() })
  }
  try { await update(); await run(node, update) }
  finally { await act(async () => root.unmount()); node.remove() }
}
const disclosure = (node: HTMLElement) => node.querySelector<HTMLDetailsElement>('.activity-feed__observations')!
async function toggle(node: HTMLElement, open: boolean) {
  await act(async () => { const details = disclosure(node); details.open = open; details.dispatchEvent(new Event('toggle')); await Promise.resolve() })
}
const visibleInputs = (node: HTMLElement) => [...node.querySelectorAll<HTMLElement>('.log-turn[data-speaker-role="human"]')]
  .filter(n => !n.closest('details:not([open])'))

it('one native launch body is primary; its distinct captured receipt stays closed, readable and exactly copyable', async () => {
  const body = 'same launch request'
  const f = await fixture([raw('native-launch', body)], [captured('capture-launch', body)])
  await mount(f.page, f.timeline, async node => {
    expect(disclosure(node).open).toBe(false)
    expect(visibleInputs(node).map(n => n.dataset.messageId)).toEqual(['native:claude:native-main:native-launch'])
    const receipt = node.querySelector<HTMLElement>('[data-message-id="captured:capture-launch"]')!
    expect(receipt).not.toBeNull()
    expect(receipt.dataset.messageBubble).toBeUndefined()
    await toggle(node, true)
    expect(receipt.querySelector('.log-turn__body')!.textContent).toBe(body)
    await act(async () => { (receipt.querySelector('[aria-label="Copy message"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(copies).toEqual([body])
    expect(node.querySelector('[data-message-id="captured:capture-launch"]')).toBe(receipt)
    f.controls.forEach(c => expect(c).not.toHaveBeenCalled())
  })
})

it('same-body native IDs and terminal-only speech stay visible; page-outside input projection remains native', async () => {
  const f = await fixture([raw('native-1', 'same input'), raw('native-2', 'same input')])
  const page = await f.client.sessionHistoryPage('private-agent', { limit: 1 })
  const messages = projectSessionUserMessages({ agentSessionId: 'private-agent', historyPage: f.page, timeline: f.timeline })
  expect(messages.every(m => m.author.kind === 'unknown' && m.source.kind === 'native')).toBe(true)
  await mount(page, f.timeline, async node => {
    expect(disclosure(node)).toBeNull()
    expect(visibleInputs(node).map(n => n.dataset.messageId)).toEqual(['native:claude:native-main:native-1', 'native:claude:native-main:native-2'])
    expect(visibleInputs(node).every(n => n.dataset.messageBubble === 'true')).toBe(true)
    expect(visibleInputs(node).map(n => n.querySelector('.log-turn__body')!.textContent)).toEqual(['same input', 'same input'])
  }, { userMessages: messages })
})

it('pending/failed summaries count only disclosed facts, including captured input projection without Timeline rows', async () => {
  const f = await fixture([raw('native', 'old native body')], [captured('failed', 'failed submission', 'failed'), captured('pending', 'pending submission', 'streaming')])
  const device: AgentTimelineItem = { id: 'device-operation:filtered', agentSessionId: 'private-agent', kind: 'system_message',
    source: 'agentmux', status: 'failed', createdAt: 1, updatedAt: 1, title: 'Diagnostic', content: 'not conversation' }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'private-agent', item: device })
  const full = await f.client.sessionTimeline('private-agent')
  await mount(f.page, full, async node => {
    expect(disclosure(node).querySelector('.activity-feed__observation-count')!.textContent).toBe('2')
    expect(disclosure(node).querySelector('summary')!.textContent).toContain('1 failed records')
    expect(disclosure(node).querySelector('summary')!.textContent).toContain('1 submissions unconfirmed')
    expect(node.textContent).not.toContain('not conversation')
    expect(visibleInputs(node)).toHaveLength(1)
    await toggle(node, true)
    expect(node.querySelector('[data-message-id="captured:failed"]')!.textContent).toContain('Failed')
    expect(node.querySelector('[data-message-id="captured:pending"]')!.textContent).toContain('Unverified')
  }, { items: [device] })
})

it('native unavailable keeps submitted original and Retry without implying native acceptance or Run control', async () => {
  const f = await fixture([], [captured('capture-only', 'submitted original')])
  await f.store.compareAndSwap(f.session, { ...f.session, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-main' } })
  let error: Error | null = null
  try { await f.client.sessionHistoryPage('private-agent') } catch (cause) { error = cause as Error }
  expect(error).not.toBeNull()
  const retry = vi.fn()
  await mount(null, f.timeline, async node => {
    expect(node.querySelector('.activity-feed__read-notice')!.textContent).toContain(error!.message)
    expect(node.querySelector('.activity-feed__observation-scope')!.textContent).toContain('native acceptance is separate')
    expect(visibleInputs(node)).toHaveLength(0)
    await toggle(node, true)
    const receipt = node.querySelector('[data-message-id="captured:capture-only"]')!
    expect(receipt.querySelector('.log-turn__body')!.textContent).toBe('submitted original')
    const button = [...node.querySelectorAll('button')].find(n => n.textContent === 'Retry')!
    await act(async () => button.click()); expect(retry).toHaveBeenCalledTimes(1)
    f.controls.forEach(c => expect(c).not.toHaveBeenCalled())
  }, { userMessageRead: { loading: false, error, hasMore: false, onRetry: retry, onReadEarlier: () => {} } })
})

it('secondary image reads are gated closed/hidden, native image reader stays independent and late bytes are discarded', async () => {
  const path = _hygiene_fixturePath("controlled/.agentmux/pasted/native.png"), next = _hygiene_fixturePath("controlled/.agentmux/pasted/new.png")
  const f = await fixture([raw('native-image', path)], [captured('capture-image', path)])
  const image: PastedImage = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' }
  const pending: Array<(value: PastedImage | null) => void> = []
  const reader = vi.fn((_path: string) => new Promise<PastedImage | null>(resolve => pending.push(resolve)))
  await mount(f.page, f.timeline, async (node, update) => {
    expect(reader.mock.calls).toEqual([[path]]) // native primary, despite secondary disclosure being closed
    const native = node.querySelector('[data-message-id="native:claude:native-main:native-image"]')!
    const body = native.querySelector('.log-turn__body')!
    await toggle(node, true); expect(reader.mock.calls).toEqual([[path], [path]])
    await toggle(node, false)
    await act(async () => { pending[0]!(image); pending[1]!(image); await Promise.resolve() })
    expect(native.querySelector('img')?.getAttribute('src')).toBe(image.dataUrl) // positive original reader control
    expect(disclosure(node).querySelector('img')).toBeNull() // nonempty old secondary response after close
    await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'private-agent', item: captured('new-image', next) })
    const timeline = await f.client.sessionTimeline('private-agent')
    await update({ items: timeline.items, userMessages: projectSessionUserMessages({ agentSessionId: 'private-agent', timeline, historyPage: f.page }) })
    expect(reader).toHaveBeenCalledTimes(2)
    await toggle(node, true); expect(reader.mock.calls.slice(2)).toEqual([[path], [next]])
    await update({ conversationReading: { reference: { hostId: 'local', agentSessionId: 'private-agent' }, identity: 'same-source', enabled: false } })
    expect(reader).toHaveBeenCalledTimes(4)
    await act(async () => { pending.slice(2).forEach(resolve => resolve(image)); await Promise.resolve() })
    expect(node.querySelector('[data-message-id="native:claude:native-main:native-image"]')).toBe(native)
    expect(native.querySelector('.log-turn__body')).toBe(body)
    expect(native.querySelector('img')?.getAttribute('src')).toBe(image.dataUrl)
    expect(disclosure(node).querySelector('img')).toBeNull() // nonempty old secondary responses after hidden gate
  }, { readPastedImage: reader })
})

it('exact captured reveal and ruler open their disclosure, preserving original native nodes and Range', async () => {
  const f = await fixture([raw('native', 'native selected body')], [captured('capture', 'submitted copy')])
  await mount(f.page, f.timeline, async (node, update) => {
    const native = node.querySelector('[data-message-id="native:claude:native-main:native"]')!
    const body = native.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 6)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    const target = node.querySelector<HTMLElement>('[data-message-id="captured:capture"]')!
    const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(cb => { cb(1); return 1 })
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 400, height: 100, top: 0, bottom: 100, left: 0, right: 400, toJSON() {} })
    const complete = vi.fn()
    try {
      await update({ revealRequest: { generation: 1, sourceKey: target.dataset.messageSourceKey!, isCurrent: () => true, complete } })
      expect(disclosure(node).open).toBe(true)
      expect(complete).toHaveBeenCalledWith(true)
      expect(document.activeElement).toBe(target)
      expect(node.querySelector('[data-message-id="native:claude:native-main:native"]')).toBe(native)
      expect(native.querySelector('.log-turn__body')).toBe(body)
      expect(range.startContainer).toBe(text); expect(range.toString()).toBe('native')
      await update({ revealRequest: null }); await toggle(node, false)
      const slider = node.querySelector<HTMLElement>('[role="slider"]')!
      await act(async () => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
      expect(disclosure(node).open).toBe(true)
      expect(native.querySelector('.log-turn__body')).toBe(body)
    } finally { frame.mockRestore(); vi.restoreAllMocks(); selection.removeAllRanges() }
  })
})
