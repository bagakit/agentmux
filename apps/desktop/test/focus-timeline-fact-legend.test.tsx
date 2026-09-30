// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { fixture, NOW, HOUR } from './fixtures/focus-history-public'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../src/renderer/src/store'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'
import type { AgentFocusHistoryEntry } from '../src/renderer/src/lib/agent-focus'

// Typed current semantic observations exercise UI facts; these are not physical
// healthy-Run qualification. Messages still come through the genuine public reader.
const context = (h: Awaited<ReturnType<typeof fixture>>, i: number, state: FocusContext['state'] = 'running', start: number | null = null): FocusContext => ({
  id: `archived-${i}`, name: `Context ${i}`, detail: 'Observed task', recap: null, detailIsRecap: false, state, stateLabel: state, processState: 'running', bucket: state === 'working' ? 'working' : 'idle', kind: 'agent', providerId: 'claude', hostId: 'private-host', topicId: null,
  workspaceId: 'project', workspaceName: 'Project', workspacePath: h.directory, liveAgent: true, actionable: false, lastActivityAt: null, runId: `not-controlled-archived-${i}`, workingEnteredAt: start, workspace: undefined
})
const visit = (id: string, at: number): AgentFocusHistoryEntry => ({ sessionId: id, focusedAt: at })

it('shows four distinct meanings and a current work band without any focus history; alive idle does not become work', async () => {
  const h = await fixture(undefined, 3)
  const contexts = [context(h, 0, 'working', NOW - HOUR), context(h, 1), context(h, 2, 'working')]
  await act(async () => h.root.render(createElement(RecentFocusTimeline, { contexts, entries: [visit('archived-1', NOW - HOUR)], currentSessionId: null, onSelect: h.onSelect })))
  expect(h.element.querySelector('.recent-focus__legend-key')?.textContent).toBe('NowWorkingFocusAlive')
  expect(h.element.querySelectorAll('[data-working-entered-at]')).toHaveLength(1)
  expect(h.element.querySelector('[data-working-entered-at]')?.getAttribute('data-working-entered-at')).toBe(String(NOW - HOUR))
  expect(h.element.querySelectorAll('[data-run-state="running"]')).toHaveLength(3)
  expect(h.element.querySelectorAll('[data-focused-at]')).toHaveLength(1)
  expect(h.element.querySelector('.recent-focus__playhead--ruler')).not.toBeNull()
  const before = h.counts(); await h.click('Timeline meaning and coverage')
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Being online does not mean it is working')
  expect(dialog.textContent).toContain('Past working intervals were not continuously recorded')
  expect(dialog.querySelectorAll('[data-focus-fact]')).toHaveLength(4)
  expect(h.counts()).toEqual(before); h.noRuntime()
})

it('retains coverage distinctions and provides the same keyboard/Escape entry without an extra toolbar row', async () => {
  const h = await fixture(undefined, 2); await h.render()
  await h.wait(() => expect(h.calls.catalogue.mock.calls).toHaveLength(1))
  const header = h.element.querySelector('.recent-focus__header')!, before = h.counts()
  const button = h.element.querySelector<HTMLButtonElement>('[aria-label="Timeline meaning and coverage"]')!
  expect(header.contains(button)).toBe(true)
  await act(async () => { button.focus(); button.click() })
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  await h.wait(() => expect(dialog.textContent).toContain('0 sources read · 2 available'))
  expect(dialog.textContent).toContain('Other sources have not been read')
  expect(dialog.textContent).toContain('Inputs without a recorded time')
  expect(dialog.textContent).toContain('missing native identities')
  expect(dialog.textContent).toContain('does not cover the entire history')
  expect(h.counts()).toEqual(before)
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await h.wait(() => expect(document.activeElement).toBe(button))
  await h.click('Timeline meaning and coverage')
  const action = [...document.querySelectorAll<HTMLButtonElement>('button')].find(n => n.textContent === 'Open Input records')!
  expect(action).not.toBeUndefined(); await act(async () => action.click())
  expect(document.querySelector('[aria-label="Input records Context"]')).not.toBeNull()
  expect(h.calls.page.mock.calls).toEqual([]); h.noRuntime()
})

it('shows only real successful history reads, exposes unknown-time inputs, and separates unavailable from no records', async () => {
  const h = await fixture(undefined, 2); await h.render(); await h.selectSource(); await h.wait(() => expect(h.inputs()).toHaveLength(4))
  await h.click('Timeline meaning and coverage')
  const text = document.querySelector('.recent-focus__legend-dialog')!.textContent!
  expect(text).toContain('1 source read · 2 available'); expect(text).toContain('Other sources have not been read')
  expect(text).toContain('Inputs without a recorded time remain in Input records')
  expect(h.inputs().map(n => n.dataset.inputMessageId)).toContain('native:claude:native-archived-0:two')
  expect(h.markers().map(n => n.dataset.messageId)).not.toContain('native:claude:native-archived-0:two')
  h.noRuntime()
})

it('locates the selected lower track among thirteen at 168px only on explicit request, without changing window or ranks', async () => {
  const h = await fixture([], 13)
  const contexts = Array.from({ length: 13 }, (_, i) => context(h, i, i === 12 ? 'working' : 'done', i === 12 ? NOW - HOUR : null))
  useAppStore.setState({ focusTimelineHeight: 168, agentComposerDrafts: { original: 'Keep the original draft' } })
  await act(async () => h.root.render(createElement(RecentFocusTimeline, { contexts, entries: contexts.map((c, i) => visit(c.id, NOW - (i + 1) * 1000)), currentSessionId: 'archived-12', onSelect: h.onSelect })))
  await h.wait(() => { expect(h.element.querySelectorAll('[data-focus-timeline-id]')).toHaveLength(13); expect(h.element.querySelector('.recent-focus')!.getAttribute('data-native-record-count')).toBe('1') })
  const viewport = h.element.querySelector<HTMLElement>('.recent-focus__viewport')!, track = h.element.querySelector<HTMLElement>('[data-focus-current="true"]')!, ruler = h.element.querySelector('.recent-focus__ruler')!
  expect(track.dataset.focusTimelineId).toBe('archived-12')
  const box = (top: number, height: number) => ({ left: 0, right: 640, width: 640, top, bottom: top + height, height, x: 0, y: top, toJSON() {} })
  // Geometry is browser transport input here; real hit/scroll is qualified by
  // the light compiled scene, not fabricated as a physical view in this test.
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(box(28, 140))
  vi.spyOn(ruler, 'getBoundingClientRect').mockReturnValue(box(28, 18))
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(box(350, 24))
  const order = [...h.element.querySelectorAll<HTMLElement>('[data-focus-timeline-id]')].map(n => n.dataset.focusTimelineId)
  const section = h.element.querySelector<HTMLElement>('.recent-focus')!, original = [section.dataset.windowStart, section.dataset.windowEnd], count = h.counts()
  expect(section.style.height).toBe('168px'); expect(viewport.scrollTop).toBe(0)
  await h.click('Locate current Context track')
  await h.wait(() => expect(viewport.scrollTop).toBe(206))
  expect([section.dataset.windowStart, section.dataset.windowEnd]).toEqual(original)
  expect([...h.element.querySelectorAll<HTMLElement>('[data-focus-timeline-id]')].map(n => n.dataset.focusTimelineId)).toEqual(order)
  const scrolled = viewport.scrollTop
  await h.click('Next focus window'); expect(viewport.scrollTop).toBe(scrolled)
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Keep the original draft')
  expect(h.counts()).toEqual(count); h.noRuntime()
})

it('does not turn a completed current state into invented past working history', async () => {
  const h = await fixture(undefined, 1)
  await act(async () => h.root.render(createElement(RecentFocusTimeline, { contexts: [context(h, 0, 'working', NOW - HOUR)], entries: [], currentSessionId: null, onSelect: h.onSelect })))
  expect(h.element.querySelectorAll('[data-working-entered-at]')).toHaveLength(1)
  await act(async () => h.root.render(createElement(RecentFocusTimeline, { contexts: [context(h, 0, 'done')], entries: [], currentSessionId: null, onSelect: h.onSelect })))
  expect(h.element.querySelectorAll('[data-working-entered-at]')).toHaveLength(0)
  expect(h.element.querySelectorAll('[data-run-state="running"]')).toHaveLength(1)
  await h.click('Timeline meaning and coverage')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Past working intervals were not continuously recorded')
  h.noRuntime()
})
