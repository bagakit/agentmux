import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
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
const visibleInputs = (node: HTMLElement) => [...node.querySelectorAll<HTMLElement>('.log-turn[data-speaker-role="human"]')]
  .filter(n => !n.closest('details:not([open])'))

it('native and distinct captured bodies are immediately readable and exactly copyable', async () => {
  const body = 'same launch request'
  const f = await fixture([raw('native-launch', body)], [captured('capture-launch', body)])
  await mount(f.page, f.timeline, async node => {
    expect(disclosure(node)).toBeNull()
    expect(visibleInputs(node).map(n => n.dataset.messageId)).toEqual(['native:claude:native-main:native-launch', 'captured:capture-launch'])
    const receipt = node.querySelector<HTMLElement>('[data-message-id="captured:capture-launch"]')!
    expect(receipt).not.toBeNull()
    expect(receipt.closest('details:not([open])')).toBeNull()
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
    expect(visibleInputs(node).map(n => n.dataset.messageId).sort()).toEqual(['native:claude:native-main:native-1', 'native:claude:native-main:native-2'])
    expect(visibleInputs(node).every(n => n.dataset.messageBubble === 'true')).toBe(true)
    expect(visibleInputs(node).map(n => n.querySelector('.log-turn__body')!.textContent)).toEqual(['same input', 'same input'])
  }, { userMessages: messages })
})

it('failed and unverified input states are visible beside their original bodies without Timeline duplicates', async () => {
  const f = await fixture([raw('native', 'old native body')], [captured('failed', 'failed submission', 'failed'), captured('pending', 'pending submission', 'streaming')])
  const device: AgentTimelineItem = { id: 'device-operation:filtered', agentSessionId: 'private-agent', kind: 'system_message',
    source: 'agentmux', status: 'failed', createdAt: 1, updatedAt: 1, title: 'Diagnostic', content: 'not conversation' }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'private-agent', item: device })
  const full = await f.client.sessionTimeline('private-agent')
  await mount(f.page, full, async node => {
    expect(disclosure(node)).toBeNull()
    expect(node.textContent).not.toContain('not conversation')
    expect(visibleInputs(node)).toHaveLength(3)
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
    expect(disclosure(node)).toBeNull()
    expect(visibleInputs(node)).toHaveLength(1)
    const receipt = node.querySelector('[data-message-id="captured:capture-only"]')!
    expect(receipt.querySelector('.log-turn__body')!.textContent).toBe('submitted original')
    const button = [...node.querySelectorAll('button')].find(n => n.textContent === 'Retry')!
    await act(async () => button.click()); expect(retry).toHaveBeenCalledTimes(1)
    f.controls.forEach(c => expect(c).not.toHaveBeenCalled())
  }, { userMessageRead: { loading: false, error, hasMore: false, onRetry: retry, onReadEarlier: () => {} } })
})

it('visible captured images read immediately and hidden late bytes are discarded without hiding body', async () => {
  const path = _hygiene_fixturePath("controlled/.agentmux/pasted/native.png"), next = _hygiene_fixturePath("controlled/.agentmux/pasted/new.png")
  const f = await fixture([raw('native-image', path)], [captured('capture-image', path)])
  const image: PastedImage = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' }
  const pending: Array<(value: PastedImage | null) => void> = []
  const reader = vi.fn((_path: string) => new Promise<PastedImage | null>(resolve => pending.push(resolve)))
  await mount(f.page, f.timeline, async (node, update) => {
    expect(reader.mock.calls).toEqual([[path], [path]])
    const native = node.querySelector('[data-message-id="native:claude:native-main:native-image"]')!
    const capturedNode = node.querySelector('[data-message-id="captured:capture-image"]')!
    const body = capturedNode.querySelector('.log-turn__body')!
    await update({ conversationReading: { reference: { hostId: 'local', agentSessionId: 'private-agent' }, identity: 'same-source', enabled: false } })
    await act(async () => { pending.forEach(resolve => resolve(image)); await Promise.resolve() })
    expect(native.querySelector('img')?.getAttribute('src')).toBe(image.dataUrl)
    expect(capturedNode.querySelector('img')).toBeNull()
    await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'private-agent', item: captured('new-image', next) })
    const timeline = await f.client.sessionTimeline('private-agent')
    await update({ items: timeline.items, userMessages: projectSessionUserMessages({ agentSessionId: 'private-agent', timeline, historyPage: f.page }) })
    expect(reader).toHaveBeenCalledTimes(2)
    expect(node.querySelector('[data-message-id="captured:capture-image"]')).toBe(capturedNode)
    expect(capturedNode.querySelector('.log-turn__body')).toBe(body)
    await update({ conversationReading: undefined })
    expect(reader.mock.calls.slice(2)).toEqual([[path], [next]])
    await act(async () => { pending.slice(2).forEach(resolve => resolve(image)); await Promise.resolve() })
    expect(capturedNode.querySelector('img')?.getAttribute('src')).toBe(image.dataUrl)
    expect(capturedNode.closest('details')).toBeNull()
  }, { readPastedImage: reader })
})

it('exact captured reveal and ruler target the visible body, preserving original native nodes and Range', async () => {
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
      expect(disclosure(node)).toBeNull()
      expect(complete).toHaveBeenCalledWith(true)
      expect(document.activeElement).toBe(target)
      expect(node.querySelector('[data-message-id="native:claude:native-main:native"]')).toBe(native)
      expect(native.querySelector('.log-turn__body')).toBe(body)
      expect(range.startContainer).toBe(text); expect(range.toString()).toBe('native')
      await update({ revealRequest: null })
      const slider = node.querySelector<HTMLElement>('[role="slider"]')!
      await act(async () => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
      expect(disclosure(node)).toBeNull()
      expect(native.querySelector('.log-turn__body')).toBe(body)
    } finally { frame.mockRestore(); vi.restoreAllMocks(); selection.removeAllRanges() }
  })
})

it('Hook replies stay readable beside native history and original tool input/output use the shared payload reader', async () => {
  const input = '{"path":"a.ts", "n":1}', output = '{"ok":false, "error":"original failure"}'
  const f = await fixture([raw('old-native', 'old native input')], [
    { ...captured('step-a', ''), kind: 'tool_call', source: 'native-hook', title: 'Read', toolName: 'Read', toolInput: input, toolOutput: output, status: 'failed' },
    { ...captured('step-b', ''), kind: 'tool_call', source: 'native-hook', title: 'Check', toolName: 'Check', status: 'streaming' },
    { ...captured('hook-reply', 'latest Hook reply'), kind: 'assistant_message', source: 'native-hook' }
  ])
  await mount(f.page, f.timeline, async node => {
    const reply = node.querySelector('[data-message-id="hook-reply"]')!
    expect(reply.querySelector('.log-turn__body')!.textContent).toBe('latest Hook reply')
    expect(reply.closest('details')).toBeNull()
    await act(async () => (reply.querySelector('[aria-label="Message details"]') as HTMLButtonElement).click())
    expect(reply.textContent).toContain('Record sourcenative-hook')
    const process = node.querySelector('.wf-card--observation')!
    expect(process.textContent).toContain('执行过程')
    expect(process.querySelector('.wf-observation__summary')).toBeNull()
    const head = process.querySelector('.wf-head')!
    expect(head.getAttribute('title')).toContain(' – ')
    expect(head.getAttribute('aria-description')).toBe(head.getAttribute('title'))
    await act(async () => (process.querySelector('.wf-head') as HTMLButtonElement).click())
    await act(async () => (process.querySelector('[data-observation-step-id="step-a"]') as HTMLButtonElement).click())
    const payloads = [...process.querySelectorAll('pre')].map(p => p.textContent)
    expect(payloads).toEqual([input, output])
    await act(async () => { (process.querySelector('[aria-label="Copy tool output"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(copies).toEqual([output])
    await act(async () => (process.querySelector('[aria-label="Format JSON"]') as HTMLButtonElement).click())
    expect([...process.querySelectorAll('pre')][0]!.textContent).toContain('\n')
    await act(async () => { (process.querySelector('[aria-label="Copy tool input"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(copies).toEqual([output, input])
    f.controls.forEach(c => expect(c).not.toHaveBeenCalled())
  })
})

it('edit previews retain the complete raw input and shared exact Copy instead of truncating the source to the diff', async () => {
  const input = JSON.stringify({ file_path: _historyFixturePath("private/work/a.ts"), old_string: 'const n = 1', new_string: 'const n = 2' })
  const f = await fixture([], [{ ...captured('edit-source', ''), kind: 'tool_call', source: 'native-hook', title: 'Edit', toolName: 'Edit', toolInput: input }])
  await mount(f.page, f.timeline, async node => {
    await act(async () => (node.querySelector('[data-observation-step-id="edit-source"]') as HTMLButtonElement).click())
    expect(node.querySelector('.log-diff')!.textContent).toContain('const n = 1')
    expect(node.querySelector('.log-diff')!.textContent).toContain('const n = 2')
    const original = [...node.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent === 'Original tool input')!
    expect(original).toBeDefined()
    await act(async () => { original.open = true; original.dispatchEvent(new Event('toggle')) })
    expect(original.querySelector('pre')!.textContent).toBe(input)
    await act(async () => { (original.querySelector('[aria-label="Copy tool input"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(copies).toEqual([input])
  })
})

it('keeps distinct native supplement and captured raw-ID collisions in separate stable DOM identities', async () => {
  const rawId = 'native:claude:native-main:native-1'
  const f = await fixture([raw('native-1', 'original native input'), raw('native-2', 'current native input')],
    [{ ...captured(rawId, 'independent Hook answer'), kind: 'assistant_message', source: 'native-hook' }])
  const page = await f.client.sessionHistoryPage('private-agent', { limit: 1 })
  const messages = projectSessionUserMessages({ agentSessionId: 'private-agent', historyPage: f.page, timeline: f.timeline })
  await mount(page, f.timeline, async (node, update) => {
    const log = node.querySelector('.activity-log')!
    const cards = [...log.querySelectorAll<HTMLElement>('.log-turn')]
    expect(cards).toHaveLength(2)
    expect(cards[0]!.dataset.messageSourceKey).not.toBe(cards[1]!.dataset.messageSourceKey)
    expect(new Set([...log.children].map(n => (n as HTMLElement).dataset.segmentKey)).size).toBe(2)
    const originalBodies = cards.map(card => card.querySelector('.log-turn__body')!)
    expect(originalBodies.map(n => n.textContent).sort()).toEqual(['independent Hook answer', 'original native input'])
    await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'private-agent', item:
      { ...captured('another-answer', 'another original answer'), kind: 'assistant_message', source: 'native-hook' } })
    const timeline = await f.client.sessionTimeline('private-agent')
    await update({ items: timeline.items })
    expect(originalBodies.every(n => n.isConnected)).toBe(true)
    expect(originalBodies.map(n => n.textContent).sort()).toEqual(['independent Hook answer', 'original native input'])
    expect(new Set([...log.children].map(n => (n as HTMLElement).dataset.segmentKey)).size).toBe(3)
    f.controls.forEach(c => expect(c).not.toHaveBeenCalled())
  }, { userMessages: messages })
})
