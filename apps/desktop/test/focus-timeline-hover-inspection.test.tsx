// @vitest-environment happy-dom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import * as UserMessages from '@agentmux/core/session-user-messages'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import type { AgentFocusHistoryEntry } from '../src/renderer/src/lib/agent-focus'
import { HOUR_MS } from '../src/renderer/src/lib/focus-time-window'
import { composerDOM } from './helpers/composer-dom-fixture'

const producer = JSON.parse(readFileSync('apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/public-producer.json', 'utf8')) as {
  schema: string; captured: AgentTimelineSnapshot; nativePage: AgentSessionHistoryPage; sessions: SessionSnapshot[]
  config: AppConfig; sessionId: string; senderId: string; now: number; agentNames: Record<string, string>
}
const dom = composerDOM(), NOW = producer.now, ID = producer.sessionId
const BODY = producer.captured.items[0]!.content!
const marker = (role = 'human') => dom.container.querySelector<HTMLButtonElement>(`.recent-focus__message[data-message-author="${role}"]`)!
const preview = () => document.querySelector<HTMLElement>('.recent-focus__message-preview')
const tooltip = () => document.querySelector<HTMLElement>('.recent-focus__message-preview[role="tooltip"]')
const contextPreview = () => document.querySelector<HTMLElement>('.recent-focus__context-preview')
const wait = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const enter = async (node: HTMLElement) => act(async () => node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
const leave = async (node: HTMLElement, relatedTarget: EventTarget | null = null) => act(async () => node.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget })))
const click = async (node: HTMLElement) => act(async () => node.click())
const controls = () => [...dom.container.querySelectorAll<HTMLButtonElement>('[data-focus-window-control]')].filter(node => node.tagName === 'BUTTON')
let page: MockInstance<typeof api.sessions.historyPage>, catalog: MockInstance<typeof api.sessions.historySources>, timeline: MockInstance<typeof api.sessions.timeline>, projector: MockInstance<typeof UserMessages.projectSessionUserMessages>, image: MockInstance<typeof api.ui.readPastedImage>
const onSelect = vi.fn()
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(NOW)
  expect(producer.schema).toBe('agentmux.focus-author-public-producer.v1')
  const projected = UserMessages.projectSessionUserMessages({ agentSessionId: ID, timeline: producer.captured, historyPage: producer.nativePage })
  expect(projected.map(item => item.author.kind)).toEqual(['unknown', 'unknown', 'human', 'agent', 'unknown'])
  expect(new Set(projected.map(item => item.id)).size).toBe(5)
  page = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(producer.nativePage)
  catalog = vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  timeline = vi.spyOn(api.sessions, 'timeline').mockResolvedValue(producer.captured)
  image = vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue(null)
  projector = vi.spyOn(UserMessages, 'projectSessionUserMessages')
  onSelect.mockClear()
  useAppStore.setState({ config: producer.config, sessions: producer.sessions, agentNames: producer.agentNames,
    timelines: { [ID]: producer.captured }, agentComposerDrafts: { [ID]: 'Keep this draft' }, agentFocus: { execution: { sessionId: ID, history: [] }, pmo: { sessionId: null } } })
})
// Restoring real time happens after composerDOM unmount has cancelled local timers.
afterEach(() => vi.useRealTimers())
async function render(entries: AgentFocusHistoryEntry[] = [], currentId: string | null = ID) {
  const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts.map(context => ({ ...context, detail: context.id === ID ? 'Reviewing the timeline interaction' : context.detail }))
  const lanes = deriveFocusProjectLanes(contexts, producer.config).map(lane => ({ ...lane, summary: 'Topic summary from the already-read snapshot' }))
  await dom.render(<><input aria-label="Late active input" defaultValue="Keep input" /><RecentFocusTimeline entries={entries} currentSessionId={currentId} contexts={contexts} lanes={lanes} onSelect={onSelect} /></>)
  await wait(1)
  expect(dom.container.querySelectorAll('.recent-focus__message').length).toBeGreaterThan(0)
}
function selectedBody() {
  const body = preview()!.querySelector<HTMLElement>('.recent-focus__message-body')!
  expect(body).not.toBeNull()
  const text = body.querySelector('.log-turn__text')!.firstChild!
  const range = document.createRange(); range.selectNodeContents(text)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  expect(document.getSelection()!.toString()).toBe(BODY)
  return { body, range }
}
const counts = () => [page.mock.calls.length, catalog.mock.calls.length, timeline.mock.calls.length, projector.mock.calls.length]

it('replaces only Focus avatar disclosure with the current Context/task/Topic facts and keeps default Executor disclosure', async () => {
  await render()
  const avatar = dom.container.querySelector<HTMLElement>(`[data-focus-timeline-id="${ID}"] .agent-avatar`)!
  expect(avatar).not.toBeNull()
  await act(async () => avatar.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  expect(contextPreview()).toBeNull(); await wait(181)
  expect(contextPreview()!.textContent).toContain('Author project')
  expect(contextPreview()!.textContent).toContain('Reviewing the timeline interaction')
  expect(contextPreview()!.textContent).toContain('Topic summary from the already-read snapshot')
  expect(contextPreview()!.getAttribute('role')).toBe('tooltip')
  expect(document.querySelectorAll('.agent-identity-popover')).toHaveLength(1)
  expect(contextPreview()!.querySelectorAll('button, a, input')).toHaveLength(0)
  expect(avatar.getAttribute('aria-describedby')).toBe(contextPreview()!.id)
  await dom.render(<AgentAvatar label="Default consumer" providerId="claude" />)
  await dom.hover('.agent-avatar')
  expect(document.querySelector('[role="dialog"][aria-label="Executor details"]')!.textContent).toContain('Default consumer')
  expect(contextPreview()).toBeNull()
})

it('keeps historical identity and missing project distinct from the live Store Context with the same Session ID', async () => {
  await render([{ sessionId: 'retained-unknown', focusedAt: NOW - HOUR_MS }, { sessionId: producer.senderId, focusedAt: NOW - 2 * HOUR_MS,
    identity: { name: 'Observed archived reviewer', kind: 'agent', providerId: 'claude', hostId: 'local', workspacePath: '/observed', project: { id: 'past-project', name: 'Observed project' } } }])
  // Remove only the current display projection; the Store still has the live name.
  const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts.filter(context => context.id === ID)
  await dom.render(<RecentFocusTimeline entries={[{ sessionId: producer.senderId, focusedAt: NOW - HOUR_MS,
    identity: { name: 'Observed archived reviewer', kind: 'agent', providerId: 'claude', hostId: 'local', workspacePath: '/observed', project: { id: 'past-project', name: 'Observed project' } } }]} currentSessionId={ID} contexts={contexts} onSelect={onSelect} />)
  const observed = dom.container.querySelector<HTMLElement>(`[data-focus-timeline-id="${producer.senderId}"] .agent-avatar`)!
  expect(observed.querySelector('[data-agent-provider="claude"]')).not.toBeNull()
  await act(async () => observed.focus())
  expect(contextPreview()!.textContent).toContain('Observed project')
  expect(contextPreview()!.textContent).toContain('Observed archived reviewer')
  await dom.render(<RecentFocusTimeline entries={[{ sessionId: producer.senderId, focusedAt: NOW - HOUR_MS }]} currentSessionId={ID} contexts={contexts} onSelect={onSelect} />)
  const avatar = dom.container.querySelector<HTMLElement>(`[data-focus-timeline-id="${producer.senderId}"] .agent-avatar`)!
  await act(async () => avatar.focus())
  expect(contextPreview()!.textContent).toContain('Project not recorded')
  expect(contextPreview()!.textContent).not.toContain('Author project')
  expect(contextPreview()!.textContent).not.toContain('Known sender')
  expect(contextPreview()!.textContent).toContain('Current state not recorded')
})

it('cancels a fly-by and lets pointer cross to a passive quick summary without stealing focus or fetching content', async () => {
  await render(); const target = marker(), input = dom.container.querySelector<HTMLInputElement>('input[aria-label="Late active input"]')!
  await act(async () => input.focus()); const before = counts()
  await enter(target); await wait(100); await leave(target); await wait(220)
  expect(tooltip()).toBeNull()
  await enter(target); await wait(181)
  const quick = tooltip()!; expect(quick).not.toBeNull()
  expect(quick.textContent).toContain(BODY); expect(quick.textContent).toContain('Recipient worker')
  expect(quick.querySelectorAll('.log-turn, button, a, input, [tabindex]')).toHaveLength(0)
  expect(quick.querySelector('header strong')!.textContent).toBe('You')
  expect(quick.querySelectorAll('time')).toHaveLength(1)
  expect(target.getAttribute('aria-describedby')).toBe(quick.id)
  // Chromium dispatches Pointer enter before the marker's Mouse leave.
  // Canceling only on Pointer enter lets that later Mouse leave close the panel.
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: quick }))
    quick.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: target }))
    target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: quick }))
    quick.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: target }))
  })
  await wait(200); expect(tooltip()).toBe(quick); expect(document.activeElement).toBe(input)
  expect(counts()).toEqual(before); expect(image).not.toHaveBeenCalled()
})

it('pins the common body once, preserves DOM and selection while another marker is hovered, and changes only on explicit click', async () => {
  await render(); const human = marker('human'), agent = marker('agent')
  await click(human); const pinned = preview()!, { body } = selectedBody()
  expect(pinned.getAttribute('role')).toBe('dialog')
  expect(pinned.querySelectorAll('.log-turn__who')).toHaveLength(1)
  expect(pinned.querySelectorAll('.log-turn__time')).toHaveLength(1)
  expect(pinned.querySelectorAll('header time')).toHaveLength(0)
  await enter(agent); await wait(181); await leave(agent); await wait(200)
  expect(preview()).toBe(pinned); expect(pinned.querySelector('.recent-focus__message-body')).toBe(body)
  expect(document.getSelection()!.toString()).toBe(BODY)
  expect(body.dataset.inputPreviewId).toBe(human.dataset.messageId)
  await click(agent); expect(preview()!.querySelector<HTMLElement>('.recent-focus__message-body')!.dataset.inputPreviewId).toBe(agent.dataset.messageId)
})

it('presents all three recorded speakers and uses explicit sender navigation only for an Agent', async () => {
  await render()
  const markers = [...dom.container.querySelectorAll<HTMLButtonElement>('.recent-focus__message')]
  expect(markers.map(node => node.dataset.messageAuthor)).toEqual(['unknown', 'human', 'agent', 'unknown'])
  for (const role of ['human', 'agent', 'unknown']) {
    const target = marker(role)
    await click(target); await wait(1); const node = preview()!
    expect(node.dataset.previewMessageId).toBe(target.dataset.messageId)
    // conversation-chat-clarity/T001 normalizes unknown only in the common body;
    // the public producer, Focus marker and preview record keep the recorded role.
    expect(node.dataset.messageAuthor).toBe(role)
    expect(node.querySelector('.log-turn')!.getAttribute('data-speaker-role')).toBe(role === 'unknown' ? 'human' : role)
    if (role === 'unknown') expect(node.querySelector('.log-turn__who')!.textContent).toBe('You')
    expect(node.querySelectorAll('.recent-focus__sender-link')).toHaveLength(role === 'agent' ? 1 : 0)
    if (role === 'agent') {
      expect(node.querySelector('.recent-focus__sender-run')!.textContent).toContain('Sender Run not recorded')
      await click(node.querySelector<HTMLElement>('.recent-focus__sender-link')!); expect(onSelect).toHaveBeenCalledExactlyOnceWith(producer.senderId)
    }
  }
})

it('shows an image-only raw input as a nonempty quick summary without reading or creating the image', async () => {
  const raw: AgentSessionHistoryPage = { ...producer.nativePage, items: [...producer.nativePage.items, { id: 'resource-only', kind: 'user-message', startedAt: NOW - 60_000,
    contentParts: [{ kind: 'resource', resourceType: 'image', reference: '/recorded/design.png', label: 'Design preview image' }] }] }
  page.mockResolvedValue(raw); await render()
  const target = dom.container.querySelector<HTMLElement>('[data-message-raw-id="resource-only"]')!
  expect(target).not.toBeNull(); await enter(target); await wait(181)
  const excerpt = tooltip()!.querySelector('.recent-focus__message-excerpt')
  expect(excerpt).not.toBeNull(); expect(excerpt!.textContent).toBe('Design preview image')
  expect(tooltip()!.querySelectorAll('img')).toHaveLength(0); expect(image).not.toHaveBeenCalled()
})

it('keyboard inspection is immediate, Escape respects a later active input, and closing cancels a pending open', async () => {
  await render(); const target = marker(), input = dom.container.querySelector<HTMLInputElement>('[aria-label="Late active input"]')!
  await act(async () => target.focus()); expect(tooltip()).not.toBeNull()
  await click(target); expect(preview()!.getAttribute('role')).toBe('dialog')
  await act(async () => input.focus())
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(preview()).toBeNull(); expect(document.activeElement).toBe(input)
  await enter(marker('agent')); await click(controls().find(node => node.getAttribute('aria-label') === 'Next focus window')!)
  await dom.click('[aria-label="Collapse focus history"]'); await wait(200)
  expect(preview()).toBeNull(); expect(useAppStore.getState().agentComposerDrafts[ID]).toBe('Keep this draft')
})

it('Context/Run replacement and unmount discard late quick opens rather than reviving old records', async () => {
  await render(); await enter(marker()); await render([], producer.senderId); await wait(200)
  expect(preview()).toBeNull()
  await render(); await enter(marker())
  await act(async () => useAppStore.setState({ sessions: producer.sessions.map(item => item.kind === 'agent' && item.id === ID ? { ...item, control: { ...item.control, run: { runId: 'new-observed-run' } } } : item) }))
  await render(); await wait(200); expect(preview()).toBeNull()
  await enter(marker()); await dom.render(null); await wait(200); expect(preview()).toBeNull()
})

it('hidden documents and Escape during a pending intent cancel both message and avatar timers', async () => {
  await render(); const target = marker()
  await enter(target)
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await wait(200); expect(preview()).toBeNull()
  const avatar = dom.container.querySelector<HTMLElement>(`[data-focus-timeline-id="${ID}"] .agent-avatar`)!
  await act(async () => avatar.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  await enter(target)
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  try {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await wait(200)
    expect(preview()).toBeNull(); expect(contextPreview()).toBeNull()
  } finally {
    if (original) Object.defineProperty(document, 'visibilityState', original)
    else delete (document as unknown as { visibilityState?: string }).visibilityState
  }
})

it('200 quick passes and 200 viewport updates leave catalog/page/timeline/projector counts unchanged and keep the pinned body', async () => {
  await render(); const target = marker(); await click(target); const { body } = selectedBody()
  // Enter historical snapshot once. Subsequent window intents only filter the same facts.
  await click(controls().find(node => node.getAttribute('aria-label') === 'Next focus window')!)
  await click(controls().find(node => node.getAttribute('aria-label') === 'Previous focus window')!); await wait(1)
  expect(page.mock.calls.length).toBe(2)
  const before = counts()
  for (let i = 0; i < 200; i++) {
    await enter(marker('agent')); await leave(marker('agent'))
  }
  for (let i = 0; i < 200; i++) {
    const next = controls().find(node => node.getAttribute('aria-label') === (i % 2 ? 'Previous focus window' : 'Next focus window'))!
    await click(next)
  }
  await wait(200)
  expect(counts()).toEqual(before)
  expect(preview()!.querySelector('.recent-focus__message-body')).toBe(body)
  expect(document.getSelection()!.toString()).toBe(BODY)
  expect(onSelect).not.toHaveBeenCalled(); expect(image).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[ID]).toBe('Keep this draft')
})
