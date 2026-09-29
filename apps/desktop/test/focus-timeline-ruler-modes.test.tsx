// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { focusDateCandidates, focusRulerTicks, createFocusTimeFormatters, DEFAULT_FOCUS_RULER, type FocusRulerPreferences } from '../src/renderer/src/lib/focus-timeline-ruler'
import { useAppStore, restorePersistedUiState } from '../src/renderer/src/store'
import { composerConfig } from './helpers/composer-dom-fixture'
import { FocusTimelineRulerSettings } from '../src/renderer/src/components/FocusTimelineRulerSettings'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { api } from '../src/renderer/src/lib/api'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import * as UserMessages from '@agentmux/core/session-user-messages'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const baseline = useAppStore.getState()
const roots: Root[] = [], containers: HTMLElement[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const node of containers.splice(0)) node.remove()
  for (const clean of cleanups.splice(0)) await clean()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.getElementById('agentmux-window-overlay-host')?.remove()
})
const prefs = (timeZone: string, extra: Partial<FocusRulerPreferences> = {}): FocusRulerPreferences => ({ ...DEFAULT_FOCUS_RULER, timeZone, ...extra })
const range = (start: string, end: string) => ({ start: Date.parse(start), end: Date.parse(end) })
const ticks = (start: string, end: string, settings: FocusRulerPreferences) => focusRulerTicks(range(start, end), settings)

it('publishes midnight-based four-tier calendar marks on both local dates and retains an honestly empty aligned short window', () => {
  const grid = ticks('2026-10-03T15:00Z', '2026-10-03T22:00Z', prefs('Asia/Shanghai'))
  const clock = createFocusTimeFormatters('Asia/Shanghai', 'en-GB')
  expect(grid.map(tick => [clock.clock(tick.instant), tick.tier])).toEqual([
    ['23:15:00', 'fine'], ['00:00:00', 'major'], ['00:45:00', 'fine'], ['01:30:00', 'shorter'],
    ['02:15:00', 'fine'], ['03:00:00', 'short'], ['03:45:00', 'fine'], ['04:30:00', 'shorter'], ['05:15:00', 'fine'], ['06:00:00', 'major']
  ])
  expect(ticks('2026-10-04T00:01Z', '2026-10-04T00:31Z', prefs('UTC'))).toEqual([])
  const free = ticks('2026-10-04T01:01Z', '2026-10-04T01:31Z', prefs('UTC', { mode: 'free' }))
  expect(free.map(tick => new Date(tick.instant).toISOString())).toEqual([
    '2026-10-04T01:01:00.000Z', '2026-10-04T01:08:30.000Z', '2026-10-04T01:16:00.000Z', '2026-10-04T01:23:30.000Z', '2026-10-04T01:31:00.000Z'
  ])
})

it('keeps non-day-divisor civil phase stable while panning across different viewport dates', () => {
  const settings = prefs('UTC', { mode: 'uniform', intervalMinutes: 420 })
  const left = ticks('2026-01-01T00:00Z', '2026-01-03T00:00Z', settings)
  const right = ticks('2026-01-02T00:00Z', '2026-01-04T00:00Z', settings)
  const overlap = (items: typeof left) => items.filter(item => item.instant >= Date.parse('2026-01-02T00:00Z') && item.instant <= Date.parse('2026-01-03T00:00Z'))
  expect(overlap(left).map(item => new Date(item.instant).toISOString())).toEqual([
    '2026-01-02T06:00:00.000Z', '2026-01-02T13:00:00.000Z', '2026-01-02T20:00:00.000Z'
  ])
  expect(overlap(right)).toEqual(overlap(left))
})

it('skips New York gaps, preserves both repeated offsets and handles Lord Howe half-hour transitions', () => {
  expect(focusDateCandidates('2026-03-08T02:30', 'America/New_York')).toEqual([])
  expect(focusDateCandidates('2026-11-01T01:30', 'America/New_York')).toEqual([
    { instant: Date.parse('2026-11-01T05:30Z'), offset: -240 }, { instant: Date.parse('2026-11-01T06:30Z'), offset: -300 }
  ])
  expect(focusDateCandidates('2026-10-04T02:15', 'Australia/Lord_Howe')).toEqual([])
  expect(focusDateCandidates('2026-04-05T01:45', 'Australia/Lord_Howe')).toEqual([
    { instant: Date.parse('2026-04-04T14:45Z'), offset: 660 }, { instant: Date.parse('2026-04-04T15:15Z'), offset: 630 }
  ])
  const settings = prefs('America/New_York', { mode: 'uniform' })
  expect(ticks('2026-11-01T04:00Z', '2026-11-01T10:00Z', settings).map(item => [new Date(item.instant).toISOString(), item.offset, item.repeated])).toEqual([
    ['2026-11-01T05:00:00.000Z', -240, true], ['2026-11-01T06:00:00.000Z', -300, true],
    ['2026-11-01T08:00:00.000Z', -300, false], ['2026-11-01T10:00:00.000Z', -300, false]
  ])
})

it('thins dense mathematical grid lines without moving their phase and keeps all source instants immutable', () => {
  const grid = ticks('2026-01-01T00:00Z', '2026-01-03T00:00Z', prefs('UTC', { mode: 'uniform', intervalMinutes: 1 }))
  expect(grid.length).toBeGreaterThan(0); expect(grid.length).toBeLessThanOrEqual(512)
  for (const tick of grid) expect(tick.instant % 60_000).toBe(0)
  const input = Date.parse('2026-11-01T05:30Z')
  expect(createFocusTimeFormatters('America/New_York', 'en-GB').dateInput(input)).toBe('2026-11-01T01:30')
  expect(createFocusTimeFormatters('Asia/Shanghai', 'en-GB').dateInput(input)).toBe('2026-11-01T13:30')
  expect(input).toBe(1793511000000)
  expect(createFocusTimeFormatters('Asia/Shanghai', 'en-GB')).toBe(createFocusTimeFormatters('Asia/Shanghai', 'en-GB'))
})

it('persists ruler preferences through the existing Store projection and skips same-value or invalid updates', () => {
  const settings = prefs('America/New_York', { mode: 'uniform', intervalMinutes: 7, phaseMinutes: 77 })
  const updates = vi.fn(), stop = useAppStore.subscribe(updates)
  useAppStore.getState().setFocusTimelineRuler(settings)
  expect(useAppStore.getState().focusTimelineRuler).toEqual(settings)
  const count = updates.mock.calls.length
  useAppStore.getState().setFocusTimelineRuler({ ...settings })
  useAppStore.getState().setFocusTimelineRuler({ ...settings, intervalMinutes: 0 })
  expect(updates.mock.calls.length).toBe(count); stop()
  const partialize = useAppStore.persist.getOptions().partialize!
  const saved = partialize(useAppStore.getState())
  expect(saved.focusTimelineRuler).toEqual(settings)
  expect(restorePersistedUiState(composerConfig, saved).focusTimelineRuler).toEqual(settings)
})

it('lets the actual shared dialog choose all three modes, minute limits, offset and selected time zone without an extra toolbar row', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = document.createElement('div'); document.body.append(element); containers.push(element)
  const root = createRoot(element); roots.push(root)
  const change = vi.fn(), cancel = vi.fn()
  await act(async () => root.render(createElement(FocusTimelineRulerSettings, { preferences: DEFAULT_FOCUS_RULER, onChange: change, dateChoice: null, onSelectDate: vi.fn(), onCancelDate: cancel })))
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Focus timeline settings"]')!.click())
  expect([...document.querySelectorAll<HTMLInputElement>('[name="focus-ruler-mode"]')].map(input => input.value)).toEqual(['daily', 'uniform', 'free'])
  await act(async () => document.querySelector<HTMLInputElement>('[name="focus-ruler-mode"][value="uniform"]')!.click())
  const input = document.querySelector<HTMLInputElement>('[aria-label="Time ruler interval in minutes"]')!
  expect(input.value).toBe('120')
  const phase = document.querySelector<HTMLInputElement>('[aria-label="Time ruler clock offset"]')!; expect(phase.value).toBe('23:00')
  await act(async () => { const zone = document.querySelector<HTMLSelectElement>('[aria-label="Focus timeline time zone"]')!; zone.value = 'America/New_York'; zone.dispatchEvent(new Event('change', { bubbles: true })) })
  const apply = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Apply')!; expect(apply).toBeDefined()
  await act(async () => apply.click())
  expect(change.mock.calls).toEqual([[prefs('America/New_York', { mode: 'uniform' })]])
  expect(document.querySelector('[aria-label="Focus timeline time zone"]')).toBeNull()
})

/** Real retired FileStore/Claude reader; only the desktop transport is isolated. */
async function mountedTimeline() {
  const now = Date.parse('2026-10-03T12:00:00Z'), recordedAt = now - 3_600_000
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(now)
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: (entries: Array<{ target: Element }>) => void) {}
    observe(target: Element) { this.callback([{ target }]) }
    unobserve() {}
    disconnect() {}
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains('recent-focus__time-scale') ? 640 : 800
    return new DOMRect(0, 0, width, this.classList.contains('recent-focus__header') ? 28 : 24)
  })
  const directory = await mkdtemp(join(tmpdir(), 'focus-ruler-')), path = join(directory, 'native.jsonl')
  await writeFile(path, Array.from({ length: 130 }, (_, i) => JSON.stringify({ sessionId: 'native-ruler', uuid: `raw-${i}`, type: 'user', message: { role: 'user', content: `Original task ${i}` }, timestamp: new Date(recordedAt).toISOString() })).join('\n') + '\n')
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'retired-ruler', providerId: 'claude', executorId: 'private', hostId: 'private', workspacePath: directory,
    run: { runId: 'not-a-live-run' }, retiredRuns: [], hookBindingId: 'private', hookToken: 'private', createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-ruler', transcriptPath: path } }
  await store.compareAndSwap(null, session)
  const reservation = { kind: 'stop' as const, reservationId: 'retire', ownerId: 'private', ownerPid: process.pid, agentSessionId: session.agentSessionId, expectedRun: session.run,
    operationId: 'retire', expiresAt: now + 60_000, stopOperation: { daemonInstance: 'no-runtime', operationKey: 'not-a-stop', runId: session.run.runId } }
  await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
  const client = new AgentMuxClient({ store }), pending = new Set<Promise<unknown>>()
  function read<T>(promise: Promise<T>) { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise }
  cleanups.push(async () => { await Promise.allSettled([...pending]); expect(pending.size).toBe(0); await client.dispose(); await rm(directory, { recursive: true, force: true }) })
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('No Runtime is permitted'))
  const catalog = vi.spyOn(api.sessions, 'historySources').mockImplementation(() => read(client.sessionHistorySources()))
  const page = vi.spyOn(api.sessions, 'historyPage').mockImplementation((reference, options) => read(client.sessionHistoryPage(reference.agentSessionId, options)))
  const timeline = vi.spyOn(api.sessions, 'timeline').mockImplementation(reference => read(client.sessionTimeline(reference.agentSessionId)))
  const projector = vi.spyOn(UserMessages, 'projectSessionUserMessages')
  useAppStore.setState({ config: null, sessions: [], tabs: {}, layouts: {}, timelines: {}, focusTimelineRuler: prefs('UTC'), agentFocus: EMPTY_AGENT_FOCUS,
    agentComposerDrafts: { original: 'Keep this draft' } })
  const element = document.createElement('div'); document.body.append(element); containers.push(element)
  const root = createRoot(element); roots.push(root)
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  const wait = async (check: () => void) => { for (let index = 0; index < 100; index++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); try { check(); return } catch (error) { if (index === 99) throw error } } }
  const click = async (label: string) => act(async () => { const node = element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!; expect(node).not.toBeNull(); node.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })); node.click() })
  const range = () => { const node = element.querySelector<HTMLElement>('.recent-focus')!; expect(node).not.toBeNull(); return [Number(node.dataset.windowStart), Number(node.dataset.windowEnd)] }
  const changeDate = async (value: string) => act(async () => { const node = element.querySelector<HTMLInputElement>('[aria-label="Focus history date and time"]')!; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })) })
  const counts = () => [catalog.mock.calls.length, page.mock.calls.length, timeline.mock.calls.length, projector.mock.calls.length]
  return { element, now, recordedAt, wait, click, range, changeDate, counts, page, connect }
}

it('uses all three actual Global timeline modes without shifting the selected range or raw instants', async () => {
  const h = await mountedTimeline(), original = h.range()
  const marks = () => [...h.element.querySelectorAll<HTMLElement>('[data-tick-at]')].map(node => Number(node.dataset.tickAt))
  expect(h.element.querySelector('.recent-focus')!.getAttribute('data-ruler-mode')).toBe('daily')
  expect(marks().length).toBeGreaterThan(0)
  expect(marks().map(instant => instant % (45 * 60_000))).toEqual(marks().map(() => 0))
  await h.click('Focus timeline settings')
  await act(async () => document.querySelector<HTMLInputElement>('[name="focus-ruler-mode"][value="uniform"]')!.click())
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Apply')!.click())
  expect(useAppStore.getState().focusTimelineRuler).toEqual(prefs('UTC', { mode: 'uniform' }))
  expect(marks()).toEqual([Date.parse('2026-10-03T09:00Z'), Date.parse('2026-10-03T11:00Z'), Date.parse('2026-10-03T13:00Z')])
  await act(async () => useAppStore.getState().setFocusTimelineRuler(prefs('UTC', { mode: 'free' })))
  expect(marks()).toEqual(Array.from({ length: 5 }, (_, index) => original[0]! + (original[1]! - original[0]!) * index / 4))
  expect(h.range()).toEqual(original); expect(h.connect.mock.calls).toEqual([])
})

it('rejects actual selected-zone gaps without moving the window and resolves both fold offsets explicitly', async () => {
  const h = await mountedTimeline(), original = h.range()
  await act(async () => useAppStore.getState().setFocusTimelineRuler(prefs('America/New_York')))
  await h.changeDate('2026-03-08T02:30')
  expect(h.element.querySelector('input[aria-invalid="true"]')).not.toBeNull()
  expect(h.element.querySelector('.recent-focus__date-error[role="status"]')!.textContent).toContain('does not exist')
  expect(h.range()).toEqual(original)
  await h.changeDate('2026-11-01T01:30')
  const choices = [...document.querySelectorAll<HTMLButtonElement>('.focus-ruler-settings__dates button')]
  expect(choices.map(node => node.textContent!.slice(0, 9))).toEqual(['UTC−04:00', 'UTC−05:00'])
  expect(h.range()).toEqual(original)
  await act(async () => choices[1]!.click())
  expect(h.range()).toEqual([Date.parse('2026-11-01T03:30Z'), Date.parse('2026-11-01T07:30Z')])
  expect([...h.element.querySelectorAll<HTMLElement>('[data-tick-at]')].map(node => Number(node.dataset.tickAt)).filter(instant => instant === Date.parse('2026-11-01T05:30Z') || instant === Date.parse('2026-11-01T06:30Z'))).toEqual([Date.parse('2026-11-01T05:30Z'), Date.parse('2026-11-01T06:30Z')])
  expect(document.querySelector('.focus-ruler-settings__dates')).toBeNull()
  await act(async () => useAppStore.getState().setFocusTimelineRuler(prefs('Australia/Lord_Howe')))
  const before = h.range(); await h.changeDate('2026-10-04T02:15')
  expect(h.range()).toEqual(before); expect(h.element.querySelector('input[aria-invalid="true"]')).not.toBeNull()
})

it('keeps one resolved System time zone across the ruler and date input after an operating-system zone change', async () => {
  const priorZone = process.env.TZ
  try {
    process.env.TZ = 'UTC'
    const h = await mountedTimeline()
    await act(async () => useAppStore.getState().setFocusTimelineRuler(prefs('system')))
    expect(h.element.querySelector('.recent-focus')!.getAttribute('data-time-zone')).toBe('UTC')
    const initialRange = h.range(), initialCounts = h.counts()
    process.env.TZ = 'Asia/Kathmandu'
    const currentSystemZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(currentSystemZone).not.toBe('UTC')
    await act(async () => {
      const size = h.element.querySelector<HTMLSelectElement>('[aria-label="Focus window size"]')!
      size.value = '6'; size.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(h.element.querySelector('.recent-focus')!.getAttribute('data-time-zone')).toBe(currentSystemZone)
    expect(h.element.querySelector<HTMLInputElement>('[aria-label="Focus history date and time"]')!.value).toBe('2026-10-03T17:45')
    const tickInstants = [...h.element.querySelectorAll<HTMLElement>('[data-tick-at]')].map(node => Number(node.dataset.tickAt))
    expect(tickInstants.length).toBeGreaterThan(0)
    for (const instant of tickInstants) expect(createFocusTimeFormatters('Asia/Kathmandu', 'en-GB').clock(instant).slice(-5)).toMatch(/^(00|15|30|45):00$/)
    await h.changeDate('2026-10-03T18:00')
    expect(h.range()).toEqual([Date.parse('2026-10-03T07:45Z'), Date.parse('2026-10-03T13:45Z')])
    expect(initialRange).toEqual([Date.parse('2026-10-03T09:00Z'), Date.parse('2026-10-03T13:00Z')])
    expect(h.counts()).toEqual(initialCounts)
    expect(h.connect.mock.calls).toEqual([])
  } finally {
    if (priorZone === undefined) delete process.env.TZ
    else process.env.TZ = priorZone
  }
})

it('keeps ninety real reader records, original body/Range and opaque reading scope through two hundred viewport/grid/zone changes', async () => {
  const h = await mountedTimeline()
  await h.click('View input records')
  await h.wait(() => expect(document.querySelector('[aria-label="Input records Context"] option[value="retired-ruler"]')).not.toBeNull())
  await act(async () => { const selector = document.querySelector<HTMLSelectElement>('[aria-label="Input records Context"]')!; selector.value = 'retired-ruler'; selector.dispatchEvent(new Event('change', { bubbles: true })) })
  await h.wait(() => expect(document.querySelectorAll('[data-input-message-id]').length).toBe(90))
  expect(h.page.mock.calls.length).toBe(3)
  const record = document.querySelector<HTMLButtonElement>('[data-input-message-id]')!
  await act(async () => record.click())
  const body = document.querySelector<HTMLElement>('.recent-focus__message-body')!, text = body.querySelector('.log-turn__text')!.firstChild!
  const selection = document.createRange(); selection.selectNodeContents(text); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(selection)
  const selected = document.getSelection()!.toString(); expect(selected.length).toBeGreaterThan(0)
  const viewport = h.element.querySelector<HTMLElement>('.recent-focus__viewport')!; viewport.scrollTop = 37; viewport.scrollLeft = 23
  const before = h.counts(), initialRange = h.range(), rawIds = [...document.querySelectorAll<HTMLElement>('[data-input-message-id]')].map(node => node.dataset.inputMessageId)
  expect(rawIds).toHaveLength(90)
  for (let index = 0; index < 200; index++) await act(async () => {
    useAppStore.getState().setFocusTimelineRuler(prefs(index % 2 ? 'Asia/Shanghai' : 'America/New_York', { mode: index % 3 === 0 ? 'free' : index % 3 === 1 ? 'uniform' : 'daily' }))
    const select = h.element.querySelector<HTMLSelectElement>('[aria-label="Focus window size"]')!; select.value = index % 2 ? '4' : '6'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(h.counts()).toEqual(before)
  expect(document.querySelector('.recent-focus__message-body')).toBe(body); expect(document.getSelection()!.toString()).toBe(selected)
  expect([...document.querySelectorAll<HTMLElement>('[data-input-message-id]')].map(node => node.dataset.inputMessageId)).toEqual(rawIds)
  expect(body.querySelector('.log-turn__time')!.textContent).toBe(createFocusTimeFormatters('Asia/Shanghai').clock(h.recordedAt))
  expect(viewport.scrollTop).toBe(37); expect(viewport.scrollLeft).toBe(23); expect(h.range()).toEqual(initialRange)
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ original: 'Keep this draft' }); expect(h.connect.mock.calls).toEqual([])
})
