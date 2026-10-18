// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import type { AgentTimelineItem } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { activityReadingProps } from './helpers/activity-reading-props'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'


let container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
let source: Awaited<ReturnType<typeof conversationPagePortFixture>>
const reference = { hostId: 'local', agentSessionId: 'reading-cost' }
const nativeSource = { providerId: 'codex', nativeSessionId: 'reading-cost-native' }
const originalItems: AgentTimelineItem[] = [
  { id: 'original-input', agentSessionId: 'reading-cost', kind: 'user_message', status: 'complete', source: 'user',
    createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1), title: 'Original input', content: 'Original reading remains here.' },
  { id: 'original-reply', agentSessionId: 'reading-cost', kind: 'assistant_message', status: 'streaming', source: 'native-hook',
    createdAt: _historyFixtureEpoch(0, 0, 2), updatedAt: _historyFixtureEpoch(0, 0, 2), title: 'Original reply', content: 'The current reply.' }
]
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container)
  root = createClientUiRoot(container)
  source = await conversationPagePortFixture(reference, nativeSource, async () => ({ agentSessionId: reference.agentSessionId,
    source: nativeSource, items: [], nextCursor: null }))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.getSelection()?.removeAllRanges()
  await source.close(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function render(items: AgentTimelineItem[]) {
  const stream = await source.publishCaptured(items)
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control: reference })} />))
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    expect(source.acceptedCaptured(stream), 'The original Reader must accept the exact persisted captured cut').toBe(true)
    const consumer = inspectConversationConsumers(reference).consumers.find(value => value.accepted?.checkpoint.frontier.cuts.some(cut =>
      cut.kind === 'captured' && cut.epoch === stream.epoch && cut.sequence === stream.sequence))
    expect(consumer).toMatchObject({ loading: false, inFlight: false, dirty: false, watch: { binding: false, bound: true } })
  }, { timeout: 3000, interval: 10 })
}
function geometry() {
  const feed = container.querySelector<HTMLElement>('.activity-feed')!
  const tail = feed.querySelector<HTMLElement>('[data-conversation-reading-tail]')!
  expect(feed).not.toBeNull(); expect(tail).not.toBeNull()
  let height = 1000, top = 600
  const writes: number[] = []
  Object.defineProperties(feed, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(value, height - 400)); writes.push(top) } }
  })
  feed.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400)
  const tailRect = vi.spyOn(tail, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, height - top, 600, 0))
  const scroll = async (position: number) => {
    await act(async () => { feed.scrollTop = position; feed.dispatchEvent(new Event('scroll')) })
  }
  return { feed, tail, tailRect, writes, scroll, grow() { height += 200 } }
}
function revised(revision: number, content = originalItems[1]!.content) {
  return originalItems.map(item => ({ ...item, updatedAt: revision, ...(item.id === 'original-reply' ? { content } : {}) }))
}

it('does not measure the reading tail for replacement facts with an unchanged content signature', async () => {
  await render(originalItems)
  const view = geometry()
  for (let revision = 3; revision < 15; revision++) await render(revised(revision))
  expect(view.tailRect, 'Unchanged content must not force reading layout before the signature decision').not.toHaveBeenCalled()
  expect(view.writes).toHaveLength(0)
  expect(container.querySelector('.activity-feed')).toBe(view.feed)
})

it('still measures and pins an actual growing tail while the original reader is following', async () => {
  await render(originalItems)
  const view = geometry(); view.grow()
  await render(revised(_historyFixtureEpoch(0, 0, 3), 'The current reply grows in place.'))
  expect(view.tailRect.mock.calls.length).toBeGreaterThan(0)
  expect(view.feed.scrollTop).toBe(800)
  expect(view.writes).toContain(800)
  expect(container.querySelector('.activity-feed')).toBe(view.feed)
})

it('measures a growing loaded tail after Find stops following, then leaves later detached layout unmeasured', async () => {
  await render(originalItems)
  const view = geometry()
  const find = container.querySelector<HTMLButtonElement>('[aria-label="Find in loaded conversation"]')
  expect(find).not.toBeNull()
  await act(async () => find!.click())
  expect(container.querySelector('input[type="search"]')).not.toBeNull()
  view.tailRect.mockClear(); view.writes.length = 0; view.grow()
  await render(revised(_historyFixtureEpoch(0, 0, 3), 'The reply grows after Find opens.'))
  expect(view.tailRect.mock.calls.length, 'A reader that was still at the loaded tail needs one real layout update').toBeGreaterThan(0)
  expect(view.writes).toHaveLength(0); expect(view.feed.scrollTop).toBe(600)
  expect(container.querySelector('[data-message-tool-control="jump-to-latest"]')).not.toBeNull()
  view.tailRect.mockClear(); view.grow()
  await render(revised(_historyFixtureEpoch(0, 0, 4), 'The detached reply keeps growing while Find is open.'))
  expect(view.tailRect, 'Once detached from the loaded tail, later layout needs no unused tail measurement').not.toHaveBeenCalled()
  expect(view.writes).toHaveLength(0); expect(view.feed.scrollTop).toBe(600)
})

it('keeps an upward reader and original selection without measuring on continuing output', async () => {
  await render(originalItems)
  const disclosure = container.querySelector<HTMLDetailsElement>('[data-submission-id="original-input"] .message-disclosure')
  expect(disclosure).not.toBeNull()
  await act(async () => { disclosure!.open = true; disclosure!.dispatchEvent(new Event('toggle')) })
  const view = geometry()
  // Consume the original programmatic mark, then deliver a real upward scroll.
  await view.scroll(600); await view.scroll(100)
  const body = view.feed.querySelector<HTMLElement>('.log-turn__body, .log-row__prose')!
  expect(body).not.toBeNull()
  const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!
  const selection = document.getSelection()!, range = document.createRange()
  range.setStart(text, 1); range.setEnd(text, 5); selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString(); expect(selected.length).toBeGreaterThan(0)
  view.tailRect.mockClear(); view.writes.length = 0; view.grow()
  for (let revision = 3; revision < 15; revision++) await render(revised(revision, 'The reply continues. '.repeat(revision)))
  expect(view.tailRect, 'Detached content updates must not force unused reading layout').not.toHaveBeenCalled()
  expect(view.writes).toHaveLength(0); expect(view.feed.scrollTop).toBe(100)
  expect(container.querySelector('.activity-feed')).toBe(view.feed)
  expect(selection.anchorNode).toBe(text); expect(selection.toString()).toBe(selected)
  expect(view.feed.querySelector('.log-turn__body, .log-row__prose')).toBe(body)
})
