import { projectConversationRecords } from '@agentmux/core/conversation'
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentTimelineItem } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const sid = 'chronological-session'
const source = { providerId: 'source-provider', nativeSessionId: 'original-source' }
const native = (id: string, time: number | undefined, text = id, kind: 'assistant-message' | 'activity' = 'assistant-message') => ({
  id, kind, ...(time === undefined ? {} : { startedAt: time }), contentParts: [{ kind: 'text' as const, text }]
})
const captured = (id: string, time: number, content = id, kind: 'user_message' | 'assistant_message' | 'tool_call' = 'user_message'): AgentTimelineItem => ({
  id, agentSessionId: sid, kind, source: kind === 'user_message' ? 'user' : 'native-hook', createdAt: time, updatedAt: time,
  content, title: id, status: 'complete', ...(kind === 'user_message' ? { authorHuman: true } : kind === 'tool_call' ? { toolName: 'Read', toolInput: content } : {})
})
let root: Root, host: HTMLDivElement
let items: AgentTimelineItem[], page: AgentSessionHistoryPage
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  items = [captured('input-a', _historyFixtureEpoch(0, 0, 200)), captured('input-b', _historyFixtureEpoch(0, 0, 400))]
  page = { agentSessionId: sid, sourceHostId:'local', source, nextCursor: null,
    items: [native('reply-a', _historyFixtureEpoch(0, 0, 100)), native('reply-b', _historyFixtureEpoch(0, 0, 300)), native('reply-c', _historyFixtureEpoch(0, 0, 500))] }
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(nativePage: AgentSessionHistoryPage | null = page, routeHostId = 'local') { await act(async () => root.render(<ActivityView sessionId={sid} executionHostId={routeHostId} capability="complete-events"
  items={items} timelineSnapshot={{agentSessionId:sid,sourceHostId:'local',revision:1,items}} nativeHistoryPage={nativePage} />)) }
function bodies() { return [...host.querySelectorAll('.log-turn__body')].map(node => node.textContent) }

it.each(['codex', 'claude'])('keeps complete captured bodies with null, empty and nonempty %s native pages', async providerId => {
  items = [captured('original-input', _historyFixtureEpoch(0, 0, 200), 'Original captured request'), captured('original-hook-reply', _historyFixtureEpoch(0, 0, 400), 'Original captured answer', 'assistant_message')]
  page = { ...page, source: { ...source, providerId }, items: [] }
  await render(null)
  expect(bodies()).toEqual(['Original captured request', 'Original captured answer'])
  await render()
  expect(bodies(), 'a valid empty source page cannot hide already accepted captured messages').toEqual(['Original captured request', 'Original captured answer'])
  const answer = host.querySelector<HTMLElement>('[data-message-id="original-hook-reply"] .log-turn__body')!
  expect(answer).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(answer); getSelection()!.addRange(range)
  page = { ...page, items: [native('later-native-answer', _historyFixtureEpoch(0, 0, 500))] }
  await render()
  expect(bodies()).toEqual(expect.arrayContaining(['Original captured request', 'Original captured answer', 'later-native-answer']))
  expect(host.querySelector('[data-message-id="original-hook-reply"] .log-turn__body')).toBe(answer)
  expect(getSelection()!.toString()).toBe('Original captured answer')
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(bodies()).toEqual(['Original captured request', 'Original captured answer', 'later-native-answer'])
  expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(1)
  expect(host.querySelectorAll('[data-segment-key]')).toHaveLength(2)
})

it('interleaves actual native replies and captured inputs by recorded time in the common message DOM', async () => {
  await render()
  expect(bodies()).toEqual(['reply-a', 'input-a', 'reply-b', 'input-b', 'reply-c'])
  const inputs = [...host.querySelectorAll('[data-segment-key]')]
  expect(inputs).toHaveLength(2)
  for (const input of inputs) expect(input.closest('[data-native-source]')).toBeNull()
  expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(3)
})

it('keeps both original source orders across backward clocks and equal text instead of sorting or deduplicating them', async () => {
  page.items = [native('n-a', _historyFixtureEpoch(0, 0, 300), 'same'), native('n-b', _historyFixtureEpoch(0, 0, 100), 'same'), native('n-c', _historyFixtureEpoch(0, 0, 500))]
  items = [captured('c-a', _historyFixtureEpoch(0, 0, 400), 'same'), captured('c-b', _historyFixtureEpoch(0, 0, 200), 'same')]
  await render()
  expect(bodies()).toEqual(['same', 'same', 'same', 'same', 'n-c'])
  expect([...host.querySelectorAll('[data-native-record-id]')].map(node => node.getAttribute('data-native-record-id'))).toEqual(['n-a', 'n-b', 'n-c'])
  expect([...host.querySelectorAll('[data-segment-key]')].map(node => JSON.parse(node.getAttribute('data-segment-key')!)[1])).toEqual(['c-a', 'c-b'])
  const ids = [...host.querySelectorAll('[data-message-id]')].map(node => node.getAttribute('data-message-id'))
  expect(new Set(ids).size).toBe(5)
})

it('retains unknown native times and inserts a new captured record without replacing existing native message bodies or Range', async () => {
  page.items = [native('unknown', undefined), native('reply-b', _historyFixtureEpoch(0, 0, 300)), native('reply-c', _historyFixtureEpoch(0, 0, 500))]
  await render()
  const body = host.querySelector('[data-native-record-id="reply-b"] .log-turn__body')!
  const text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(text); getSelection()!.addRange(range)
  items = [...items, captured('input-c', _historyFixtureEpoch(0, 0, 450))]
  await render()
  const ordered = projectConversationRecords({ agentSessionId: sid, executionHostId: 'local', historyPage: page, timeline: { agentSessionId: sid, revision: 0, items } })
  expect(ordered).toHaveLength(6)
  expect(bodies()).toEqual(ordered.map(record => record.content))
  expect(host.querySelector('[data-native-record-id="reply-b"] .log-turn__body')).toBe(body)
  expect(range.startContainer).toBe(text); expect(text.isConnected).toBe(true); expect(getSelection()!.toString()).toBe('reply-b')
  expect(page.items[0]!.startedAt).toBeUndefined()
})

it('folds interleaved native and captured steps once, visits internal slots and leaves real speech outside', async () => {
  page.items = [native('process-a', _historyFixtureEpoch(0, 0, 100), 'native process a', 'activity'), native('process-b', _historyFixtureEpoch(0, 0, 300), 'native process b', 'activity'), native('reply', _historyFixtureEpoch(0, 0, 500))]
  items = [captured('step-a', _historyFixtureEpoch(0, 0, 50), 'captured step a', 'tool_call'), captured('step-b', _historyFixtureEpoch(0, 0, 200), 'captured step b', 'tool_call'), captured('input', _historyFixtureEpoch(0, 0, 400))]
  await render()
  expect([...host.querySelectorAll('[data-native-record-ids]')].map(node => JSON.parse(node.getAttribute('data-native-record-ids')!))).toEqual([['process-a', 'process-b']])
  const group = host.querySelector<HTMLButtonElement>('.conversation-record-process .wf-head')!
  expect(group.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelectorAll('[data-observation-step-id]')).toHaveLength(0)
  expect(bodies()).toEqual(['input', 'reply'])
  await act(async () => group.click())
  expect([...host.querySelectorAll('[data-observation-step-id]')].map(node => node.getAttribute('data-observation-step-id'))).toEqual(['step-a', 'process-a', 'step-b', 'process-b'])
  expect(group.textContent).toContain('4 条已加载记录')
  expect(host.querySelectorAll('[data-segment-key]')).toHaveLength(3)
  expect(bodies()).toEqual(['input', 'reply'])
})

it('keeps an expanded native process Range mounted while a captured input would split that parent, then places it on selection release', async () => {
  page.items = [native('process-a', _historyFixtureEpoch(0, 0, 100), 'selected process', 'activity'), native('process-b', _historyFixtureEpoch(0, 0, 300), 'other process', 'activity'), native('reply', _historyFixtureEpoch(0, 0, 500))]
  items = []
  await render()
  const button = host.querySelector<HTMLButtonElement>('.conversation-record-process .wf-head')!
  await act(async () => button.click())
  const step = host.querySelector<HTMLButtonElement>('[data-native-step-id="process-b"] .wf-tool-row')!
  expect(step).not.toBeNull()
  await act(async () => step.click())
  const body = host.querySelector('[data-native-record-id="process-b"] .log-turn__body')!
  expect(body).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(body); getSelection()!.addRange(range)
  items = [captured('new-input', _historyFixtureEpoch(0, 0, 200))]
  await render()
  expect(host.querySelector('[data-native-record-id="process-b"] .log-turn__body')).toBe(body)
  expect(body.isConnected).toBe(true); expect(range.toString()).toContain('other process')
  expect(host.textContent).toContain('保留选区')
  expect(host.querySelector('[data-message-id="new-input"]')).toBeNull()
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(host.querySelectorAll('[data-native-record-ids]')).toHaveLength(2)
  expect(bodies()).toContain('new-input')
  expect(host.querySelector('[data-native-step-id="process-b"] .wf-tool-row')?.getAttribute('aria-expanded')).toBe('true')
})

it('review: captured step Range survives a native append that splits the captured Run', async () => {
  page.items = [native('reply', _historyFixtureEpoch(0, 0, 500))]
  items = [captured('step-a', _historyFixtureEpoch(0, 0, 50), 'captured a', 'tool_call'), captured('step-b', _historyFixtureEpoch(0, 0, 150), 'captured b', 'tool_call'), captured('step-c', _historyFixtureEpoch(0, 0, 250), 'selected captured c', 'tool_call')]
  await render()
  const group = host.querySelector<HTMLButtonElement>('.conversation-record-process .wf-head')!
  expect(group).not.toBeNull()
  await act(async () => group.click())
  const steps = [...host.querySelectorAll<HTMLButtonElement>('[data-segment-key] .wf-tool-row')]
  expect(steps).toHaveLength(3)
  await act(async () => steps[2]!.click())
  const selected = [...host.querySelectorAll<HTMLElement>('.conversation-tool-trace__payload')].find(node => node.textContent?.includes('selected captured c'))!
  expect(selected).not.toBeUndefined()
  const range = document.createRange(); range.selectNodeContents(selected); getSelection()!.addRange(range)
  const before = getSelection()!.toString()
  page = { ...page, items: [native('new-native', _historyFixtureEpoch(0, 0, 200)), ...page.items] }
  await render()
  expect(selected.isConnected).toBe(true)
  expect(getSelection()!.toString()).toBe(before)
  expect(host.textContent).toContain('保留选区')
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(host.querySelectorAll('[data-segment-key]')).toHaveLength(3)
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(2)
  expect(host.textContent).toContain('selected captured c')
  const finalStep = [...host.querySelectorAll('[data-segment-key]')].find(node => node.getAttribute('data-segment-key') === JSON.stringify(['item', 'step-c']))!
  expect(finalStep.querySelector('.wf-tool-row')?.getAttribute('aria-expanded')).toBe('true')
})

it.each(['local', 'remote-route'])('holds the selected original captured DOM through a late exact canonical relation and applies it on release with the real question card over %s', async routeHostId => {
  const original = captured('late-original', _historyFixtureEpoch(0, 0, 200), 'Selected complete original contribution', 'assistant_message')
  items = [original]
  await render(null, routeHostId)
  const body = host.querySelector('[data-message-id="late-original"] .log-turn__body')!
  const text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(text); getSelection()!.addRange(range)
  const canonical = { ...native('exact-canonical', _historyFixtureEpoch(0, 0, 300), 'Native canonical question body'), turnId: 'exact-turn',
    questionRequest: { delivery: 'async' as const, questions: [{ id: 'exact-question', prompt: 'Keep the original selected work?', options: [{ id: 'keep', label: 'Keep' }], acceptsText: true }] } }
  page = { ...page, items: [canonical] }
  items = [{ ...original, conversation: { sameEvent: { hostId: 'local', agentSessionId: sid,
    source: { kind: 'native', ...source, recordId: canonical.id } } } }]
  await render(page, routeHostId)
  expect(host.querySelector('[data-message-id="late-original"] .log-turn__body')).toBe(body)
  expect(text.isConnected).toBe(true); expect(getSelection()!.getRangeAt(0)).toBe(range)
  expect(getSelection()!.toString()).toBe(original.content)
  expect(host.textContent).toContain('取消选择后更新已确认的消息关系')
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(host.querySelector('[data-native-record-id="exact-canonical"] .log-turn__body')?.textContent).toContain('Native canonical question body')
  expect(host.querySelector('[aria-label="Native asynchronous question"] [data-question-id="exact-question"]')).not.toBeNull()
  const contribution = host.querySelector<HTMLDetailsElement>('[data-original-contribution]')!
  expect(contribution.dataset.messageSourceKey).toBe(JSON.stringify([sid, 'captured', original.id]))
  await act(async () => { contribution.querySelector('summary')!.click(); contribution.open = true; contribution.dispatchEvent(new Event('toggle')) })
  expect(contribution.textContent).toContain(original.content)
  expect(host.querySelectorAll('[data-native-record-id="exact-canonical"]')).toHaveLength(1)
})

it('shows exact Core coverage gaps once in the common reading scope without guessing an author or hiding original content', async () => {
  const missing = { hostId: 'local', agentSessionId: sid, source: { kind: 'native' as const, ...source, recordId: 'unread-canonical' } }
  items = [{ ...captured('unread-original', _historyFixtureEpoch(0, 0, 100), 'Original readable contribution', 'assistant_message'), conversation: { sameEvent: missing } }]
  await render(null)
  expect(host.querySelectorAll('[data-conversation-coverage]')).toHaveLength(1)
  const gap = host.querySelector('[data-conversation-gap="CONVERSATION_ANCHOR_UNREAD"]')!
  expect(gap).not.toBeNull(); expect(gap.querySelector('[data-conversation-gap-reference]')?.textContent).toBe(JSON.stringify(missing))
  expect(bodies()).toContain('Original readable contribution')
  expect(JSON.parse(host.querySelector('.log-turn')!.getAttribute('data-conversation-author')!)).toEqual({kind:'unknown'})
  const canonical = { id: 'native-input', kind: 'user-message' as const, contentParts: [{kind:'text' as const,text:'Original native input'}] }
  page = {...page,items:[canonical]}
  const sameEvent = { hostId:'local',agentSessionId:sid,source:{kind:'native' as const,...source,recordId:canonical.id} }
  items = [{...captured('explicit-human',_historyFixtureEpoch(0, 0, 100)),authorHuman:true,conversation:{sameEvent}},
    {...captured('explicit-agent',_historyFixtureEpoch(0, 0, 200)),authorAgentSessionId:'exact-other-author',conversation:{sameEvent}}]
  await render()
  expect(host.querySelectorAll('[data-conversation-coverage]')).toHaveLength(1)
  expect(host.querySelectorAll('[data-conversation-gap="CONVERSATION_AUTHOR_CONFLICT"]')).toHaveLength(2)
  expect(bodies()).toContain('Original native input')
  expect(JSON.parse(host.querySelector('.log-turn')!.getAttribute('data-conversation-author')!)).toEqual({kind:'unknown'})
})

it('retains a real empty scope coverage surface without manufacturing a message', async () => {
  items=[];page={...page,items:[]}
  await act(async()=>root.render(<ActivityView sessionId={sid} executionHostId="local" capability="complete-events" items={items} nativeHistoryPage={page}
    timelineSnapshot={{agentSessionId:sid,revision:5,items,stream:{epoch:'original-scope',sequence:5,revision:5,origin:'retained-prefix',positions:[],gaps:[{code:'ORIGINAL_PREFIX_UNKNOWN',message:'Original earlier prefix is unknown.'}]}}}/>))
  expect(host.querySelectorAll('[data-conversation-coverage]')).toHaveLength(1)
  expect(host.querySelector('[data-conversation-gap="ORIGINAL_PREFIX_UNKNOWN"]')?.textContent).toContain('Original earlier prefix is unknown.')
  expect(host.querySelectorAll('.log-turn')).toHaveLength(0)
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(0)
})
