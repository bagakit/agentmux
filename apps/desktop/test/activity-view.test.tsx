// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { CapturedConversationMessage } from '@agentmux/client-ui/components/CapturedConversationMessage'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'
import { formatClock } from '@agentmux/client-ui/conversation-time'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { api } from '../src/renderer/src/lib/api'
import { activityReadingProps } from './helpers/activity-reading-props'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { readStyleSheet, stripCssComments } from './helpers/styles'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

const reference = { hostId: 'local', agentSessionId: 'activity-original' }
const source = { providerId: 'codex', nativeSessionId: 'activity-native' }
const beginning = fixtureEpoch(0, 0, 1)
let host: HTMLDivElement, root: Root
const fixtures: Awaited<ReturnType<typeof conversationPagePortFixture>>[] = []
const speaker = createSpeakerResolver({ currentSession: { id: reference.agentSessionId, label: 'Original Agent', providerId: 'codex' } })
function item(id: string, facts: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  return { id, agentSessionId: reference.agentSessionId, kind: 'tool_call', source: 'native-hook', title: id,
    status: 'complete', createdAt: beginning, updatedAt: beginning, ...facts }
}
const question = () => item('question', { kind: 'user_message', source: 'user', authorHuman: true, publicContent: 'confirmed', content: 'Original question' })
const answer = (facts: Partial<AgentTimelineItem> = {}) => item('answer', { kind: 'assistant_message', source: 'acp', authorAgentSessionId: reference.agentSessionId,
  content: 'Ordinary original answer', createdAt: beginning + 1000, updatedAt: beginning + 1000, ...facts })
const render = async (body: ReactNode) => act(async () => root.render(body))
const click = async (button: HTMLButtonElement | null) => { expect(button).not.toBeNull(); await act(async () => button!.click()) }
function projection(items: AgentTimelineItem[]) {
  return projectConversationReading({ agentSessionId: reference.agentSessionId, executionHostId: reference.hostId,
    timeline: { agentSessionId: reference.agentSessionId, sourceHostId: reference.hostId, revision: 1, items } })
}
async function reading(items: AgentTimelineItem[], options: { describe?: boolean; capability?: ComponentProps<typeof ActivityView>['capability'] } = {}) {
  const f = await conversationPagePortFixture(reference, source, async () => ({ agentSessionId: reference.agentSessionId, source, items: [], nextCursor: null }))
  fixtures.push(f)
  const stream = await f.publishCaptured(items)
  const { describeSpeaker: _describe, ...base } = activityReadingProps({ control: reference })
  await render(<ActivityView {...base} {...(options.describe === false ? {} : { describeSpeaker: speaker })} capability={options.capability ?? 'complete-events'} />)
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    expect(f.acceptedCaptured(stream)).toBe(true)
    const consumer = inspectConversationConsumers(reference).consumers[0]
    expect(consumer?.loading).toBe(false); expect(consumer?.inFlight).toBe(false)
  })
  return f
}
async function speech(items: AgentTimelineItem[], describe = true) {
  const p = projection(items)
  await render(<>{p.records.map(record => {
    if (record.original.kind !== 'captured') throw new Error('Original captured speech fixture changed source')
    return <CapturedConversationMessage key={record.id} item={record.original.item} record={record}
      {...(record.speaker ? { speaker: record.speaker } : {})} {...(describe ? { describeSpeaker: speaker } : {})}
      conversationSessionId={reference.agentSessionId} executionHostId={reference.hostId}
      {...(items[0] ? { origin: items[0].createdAt } : {})} />
  })}</>)
  return p
}
function card(id: string) {
  const key = conversationMessageSourceKey(reference.agentSessionId, { kind: 'captured', recordId: id })
  const rows = [...host.querySelectorAll<HTMLElement>('.log-turn')].filter(row => row.dataset.messageSourceKey === key)
  expect(rows).toHaveLength(1); return rows[0]!
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  const failures: unknown[] = []
  window.getSelection()?.removeAllRanges()
  try { await act(async () => root.unmount()) } catch (error) { failures.push(error) }
  host.remove()
  for (const f of fixtures.splice(0).reverse()) {
    try { f.controls.forEach(control => expect(control).not.toHaveBeenCalled()) } catch (error) { failures.push(error) }
    try { await f.close() } catch (error) { failures.push(error) }
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Original Activity fixture cleanup failed')
})

describe('Activity current public reading wiring', () => {
  it.each([false, true])('keeps accurate Participants and original process records without inventing speech for all-process=%s', async allProcess => {
    await reading(allProcess ? [item('first'), item('second', { createdAt: beginning + 1000, updatedAt: beginning + 1000 })]
      : [question(), item('tool', { createdAt: beginning + 250, updatedAt: beginning + 250 }), answer()])
    expect(host.querySelectorAll('.activity-feed')).toHaveLength(1)
    const marks = host.querySelectorAll('.conversation-axis__mark')
    expect(marks).toHaveLength(allProcess ? 0 : 2)
    if (allProcess) {
      expect(host.querySelector('.log-turn')).toBeNull(); expect(host.querySelector('.log-turn__body')).toBeNull()
      expect(host.querySelector('.log-fold__steps')?.textContent).toBe('2 条已加载记录')
      await click(host.querySelector('.wf-head'))
      expect([...host.querySelectorAll('[data-observation-step-id]')].map(row => row.getAttribute('data-observation-step-id'))).toEqual(['first', 'second'])
      expect(host.querySelector('.log-turn')).toBeNull()
    } else {
      expect(host.querySelector('[aria-label="Participants"]')).not.toBeNull()
      expect(host.querySelector('[aria-label="Speakers"], [aria-label="This agent"]')).toBeNull()
      expect(host.querySelector('.log-fold__steps')?.textContent).toBe('1 条已加载记录')
    }
  })
  it('omits the optional participant axis without a resolver while retaining the original ruler and message', async () => {
    await reading([answer()], { describe: false })
    expect(host.querySelector('.conversation-axis')).toBeNull()
    expect(host.querySelector('.activity-ruler')).not.toBeNull()
    expect(card('answer').querySelector('.log-turn__body')?.textContent).toBe('Ordinary original answer')
  })
  it('places the participant axis and ruler track in one coordinate box and selects the same original fraction', async () => {
    await reading([question(), item('tool', { createdAt: beginning + 250, updatedAt: beginning + 250 }), answer()])
    const stack = host.querySelector('.activity-ruler__stack')!, track = host.querySelector('.activity-ruler__track')!
    const participants = host.querySelector('.activity-ruler__participants')!
    expect(stack).not.toBeNull(); expect(track.parentElement).toBe(stack); expect(participants.parentElement).toBe(stack)
    const mark = host.querySelector<HTMLButtonElement>('.conversation-axis__mark[aria-label="Original Agent"]')!
    expect(mark).not.toBeNull(); expect(mark.style.left).toBe('100%')
    await click(mark)
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve() })
      expect(mark.hasAttribute('data-selected')).toBe(true)
      expect(host.querySelector<HTMLElement>('.activity-ruler__tick[data-selected]')?.style.left).toBe(mark.style.left)
    })
    expect(host.querySelectorAll('.activity-feed')).toHaveLength(1)
  })
  it.each(['complete-events', 'unavailable'] as const)('distinguishes an accepted empty window from unavailable capability=%s without inventing records', async capability => {
    await reading([], { capability })
    expect(host.querySelector('.log-turn, [data-conversation-process-key]')).toBeNull()
    expect(host.textContent).toContain('Terminal remains available')
    expect(host.textContent).toContain(capability === 'unavailable' ? 'does not provide structured activity' : 'No structured activity yet')
    if (capability === 'complete-events') expect(host.textContent).not.toContain('does not provide structured activity')
  })
  it.each(['temporal', 'ordinal'] as const)('keeps one focusable slider with honest original %s scale and accessible values', async axis => {
    const later = axis === 'temporal' ? beginning + 1000 : beginning
    await reading([question(), answer({ createdAt: later, updatedAt: later })])
    const sliders = host.querySelectorAll<HTMLElement>('[role="slider"]'); expect(sliders).toHaveLength(1)
    const slider = sliders[0]!
    expect(slider.tabIndex).toBe(0); expect(slider.dataset.axis).toBe(axis)
    expect(slider.getAttribute('aria-valuemin')).toBe('1'); expect(slider.getAttribute('aria-valuemax')).toBe('2')
    expect(slider.getAttribute('aria-label')).toBe(axis === 'temporal' ? 'Activity timeline, 2 events over 1.0s' : 'Activity timeline, 2 events in order')
    if (axis === 'ordinal') { expect(slider.getAttribute('aria-label')).not.toContain('over'); expect(host.textContent).toContain('Record order') }
    else {
      const span = host.querySelector<HTMLElement>('.activity-ruler__span')!
      expect(span.title).toContain('1.0s elapsed')
      expect(host.querySelector('.activity-ruler__span-elapsed')).toBeNull()
    }
  })
})

describe('Original Core projection through common cards', () => {
  it.each([false, true])('keeps author role, avatar and caption consistent with resolver=%s', async describe => {
    const p = await speech([question(), answer()], describe)
    expect(p.records.map(record => record.author?.kind)).toEqual(['human', 'agent'])
    for (const [id, role] of [['question', 'human'], ['answer', 'agent']] as const) {
      const node = card(id)
      expect(node.dataset.speakerRole).toBe(role)
      expect(node.querySelector('.conversation-avatar--' + role)).not.toBeNull()
      expect(node.querySelector('.log-turn__who')?.textContent?.trim()).toBeTruthy()
    }
    if (describe) expect(card('answer').querySelector('.log-turn__who')?.textContent).toBe('Original Agent')
  })
  it('keeps the original unknown author separate from the user display default on an actual user-message record', async () => {
    const p = await speech([item('input-source', { kind: 'user_message', source: 'user', content: 'Original interjection' })])
    expect(p.records[0]?.author).toEqual({ kind: 'unknown' })
    expect(p.records[0]?.role).toBe('message')
    const node = card('input-source')
    expect(node.dataset.speakerRole).toBe('human'); expect(node.querySelector('.conversation-avatar--human')).not.toBeNull()
    expect(node.querySelector('.log-turn__who')?.textContent).toBe('You')
    expect(node.querySelector('.log-turn__body')?.textContent).toBe('Original interjection')
    expect(host.querySelector('.log-row')).toBeNull()
  })
  it('retains a user-source lifecycle record as original process content without inventing speech or an author', async () => {
    const original = item('lifecycle-source', { kind: 'lifecycle', source: 'user', content: 'Original lifecycle content' })
    const p = projection([original]), copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
    expect(p.records[0]?.author).toEqual({ kind: 'unknown' }); expect(p.records[0]?.role).toBe('process')
    await render(<ConversationView sessionId={reference.agentSessionId} executionHostId={reference.hostId} records={p.records} originalRecords={p.originalRecords}
      renderProcess={props => <NativeProcessObservation {...props} compact />} />)
    await click(host.querySelector('.wf-head'))
    const row = host.querySelector<HTMLButtonElement>('[data-observation-step-id="lifecycle-source"]')!
    expect(row).not.toBeNull(); expect(row.hasAttribute('data-speaker-role')).toBe(false)
    expect(host.querySelector('.log-turn, .conversation-avatar')).toBeNull()
    await click(row)
    expect([...host.querySelectorAll('pre')].map(node => node.textContent)).toEqual([original.content])
    await click(host.querySelector('[aria-label="Copy recorded content"]')); expect(copy).toHaveBeenLastCalledWith(original.content)
  })
  it('keeps failed and complete original steps distinct, including empty audit details and output-only exact Copy', async () => {
    const output = 'Complete original output\nsecond line', copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
    const p = projection([item('failed', { status: 'failed' }), item('complete'), item('output-only', { toolOutput: output })])
    await render(<ConversationView sessionId={reference.agentSessionId} executionHostId={reference.hostId} records={p.records} originalRecords={p.originalRecords}
      renderProcess={props => <NativeProcessObservation {...props} compact />} />)
    const head = host.querySelector<HTMLButtonElement>('.wf-head')!
    expect(head).not.toBeNull()
    await click(head)
    const row = (id: string) => host.querySelector<HTMLButtonElement>(`[data-observation-step-id="${id}"]`)!
    expect(row('failed').dataset.status).toBe('failed'); expect(row('failed').querySelector('.log-row__chip--failed')?.textContent).toBe('Failed')
    expect(row('complete').dataset.status).toBe('complete'); expect(row('complete').querySelector('.log-row__chip--failed')).toBeNull()
    row('failed').focus(); expect(document.activeElement).toBe(row('failed'))
    expect(document.getElementById(row('failed').getAttribute('aria-controls')!)).not.toBeNull()
    await click(row('failed')); expect(row('failed').getAttribute('aria-expanded')).toBe('true')
    const audit = row('failed').parentElement!.querySelector<HTMLDetailsElement>('details')!
    await act(async () => { audit.open = true; audit.dispatchEvent(new Event('toggle')) })
    expect(JSON.parse(audit.querySelector('pre')!.textContent!)).toMatchObject({ id: 'failed', status: 'failed' })
    await click(row('output-only'))
    const payload = row('output-only').parentElement!
    expect(payload.querySelector('pre')?.textContent).toBe(output)
    await click(payload.querySelector('[aria-label="Copy tool output"]')); expect(copy).toHaveBeenLastCalledWith(output)
    expect(payload.querySelector('[aria-label="Copy tool input"]')).toBeNull()
    const complete = projection([item('only-complete')])
    await render(<ConversationView sessionId={reference.agentSessionId} executionHostId={reference.hostId} records={complete.records} originalRecords={complete.originalRecords}
      renderProcess={props => <NativeProcessObservation {...props} compact />} />)
    const completeHead = host.querySelector<HTMLButtonElement>('.wf-head')!
    expect(completeHead).not.toBeNull(); expect(completeHead.closest('[data-status="failed"]')).toBeNull()
    expect(completeHead.querySelector('.log-row__chip--failed')).toBeNull()
  })
  it('shows a speech record concrete clock with the supplied original offset, and its full unchanged body', async () => {
    await speech([question(), answer()])
    const time = card('answer').querySelector<HTMLElement>('.log-turn__time')!
    expect(time).not.toBeNull(); expect(time.textContent).toBe(formatClock(beginning + 1000))
    expect(time.title).toBe(`${formatClock(beginning + 1000)} · +1.0s from start`)
    expect(card('answer').querySelector('.log-turn__body')?.textContent).toBe('Ordinary original answer')
  })
  it('scopes failed and complete speech badges to their exact original cards without borrowing a machine failure or parsing prose', async () => {
    await speech([answer({ id: 'failed-speech', status: 'failed', content: 'Sure, let me look at that.' }), answer({ id: 'complete-speech' })])
    expect(host.querySelector('.log-row')).toBeNull()
    const failed = card('failed-speech'), complete = card('complete-speech')
    expect(failed.dataset.status).toBe('failed'); expect(failed.querySelector('.log-row__chip--failed')?.textContent).toBe('Failed')
    expect(complete.dataset.status).toBe('complete'); expect(complete.querySelector('.log-row__chip--failed')).toBeNull()
    expect(host.querySelectorAll('.log-row__chip--failed')).toHaveLength(1)
  })
  it('keeps the actual failed-message CSS color declaration, beyond merely naming its selector', () => {
    const rule = stripCssComments(readStyleSheet('@agentmux/client-ui/styles/conversation-message.css'))
      .match(/\.log-turn\[data-status='failed'\][^{]*\{([^}]*)\}/)
    expect(rule, 'Actual failed speech styling must contain its load-bearing declaration').not.toBeNull()
    expect(rule![1]).toMatch(/color\s*:/)
  })
})
