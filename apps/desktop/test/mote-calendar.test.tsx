import { fixtureEpoch as _batchFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { ContinuousProgressLoop } from '@agentmux/core'
import type { FileListParams, FileListResult } from '@agentmux/core/files'
import type { ScheduleHistoryEntry } from '@agentmux/core/schedule-rpc'
import type { FutureProgressInputOwner } from '@agentmux/host/continuous-progress-loop-manager'
import { DateTime } from 'luxon'
import * as scheduleCalendar from '@agentmux/core/schedule-calendar'
import { MoteCalendar, moteScheduleQueries } from '../src/renderer/src/components/MoteCalendar'
import { MoteDetailsPanel } from '../src/renderer/src/components/MoteDetailsPanel'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { moteEntryDraftKey } from '../src/renderer/src/lib/mote-entry-hold'
import { CalendarScheduleControl } from '../src/renderer/src/components/CalendarScheduleControl'
import { api } from '../src/renderer/src/lib/api'
import { calendarDayWindow, calendarHourWindows } from '../src/renderer/src/lib/mote-calendar-range'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { composerDOM } from './helpers/composer-dom-fixture'
import { createScheduleRpcFixture } from './helpers/schedule-rpc-fixture'
import { seedMoteWorkface, defaultAgent, neighborAgent, defaultTab, neighborTab, scratchWorkspace, moteDirectoryListing, moteTopics } from './fixtures/mote-workface'
import { scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import type { MoteWorkfaceScope } from '../src/renderer/src/lib/mote-workface'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { readWorkspaceDirectory } from '../src/renderer/src/lib/source-files-discovery'

const dom = composerDOM()
const now = _batchFixtureEpoch(20748, 0, 36000000)
const target = { hostId: defaultAgent.hostId, providerId: defaultAgent.providerId, workspacePath: defaultAgent.workspacePath, agentSessionId: defaultAgent.control.agentSessionId }
const topic = { ...moteTopics[0]!, physicalDirectoryPath: defaultAgent.workspacePath, confirmedDirectoryPaths: [defaultAgent.workspacePath] }
const scope: MoteWorkfaceScope = { workspace: scratchWorkspace, topic, rootPath: scratchTopicDirectoryName(topic.id) }
const reference = { displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: 'default-region' }
const ideaEntry = (rootPath: string, name: string) => ({ name, path: rootPath + '/' + name, isDirectory: false, isSymlink: false, mtimeMs: now })
const saved = (id: string, patch: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop => ({ ...target, loopId: id, afterMs: 90000, intervalMs: 1000,
  nextCheckAt: now + 90000, prompt: 'Original countdown ' + id, status: 'active', revision: 1, creationOperationId: 'created-' + id, futureIntentId: 'future-' + id, ...patch })
let fixture: Awaited<ReturnType<typeof createScheduleRpcFixture>> | undefined
beforeEach(() => {
  seedMoteWorkface(); useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  useAppStore.setState({ config: { ...useAppStore.getState().config!, automation: { calendarTimezone: 'UTC' } } })
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(async () => { await fixture?.dispose(); fixture = undefined })
async function owner(records: ContinuousProgressLoop[], readHistory?: FutureProgressInputOwner['readHistory']) {
  fixture = await createScheduleRpcFixture({ records, now: () => now, futureInputs: { authorizeFutureIntent: async () => {}, saveFutureIntent: async () => {}, ...(readHistory ? { readHistory } : {}) } })
  const rpc = fixture.rpc, manager = fixture.manager
  vi.spyOn(api.schedule, 'list').mockImplementation(params => rpc.call('schedule.list', params))
  vi.spyOn(api.schedule, 'history').mockImplementation(params => rpc.call('schedule.history', params))
  vi.spyOn(api.schedule, 'inspect').mockImplementation(params => rpc.call('schedule.inspect', params))
  vi.spyOn(api.schedule, 'create').mockImplementation(params => rpc.call('schedule.create', params))
  vi.spyOn(api.schedule, 'pause').mockImplementation(params => rpc.call('schedule.pause', params))
  vi.spyOn(api.schedule, 'resume').mockImplementation(params => rpc.call('schedule.resume', params))
  vi.spyOn(api.schedule, 'cancel').mockImplementation(params => rpc.call('schedule.cancel', params))
  return vi.spyOn(manager, 'call')
}
async function button(text: string) {
  const found = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)
  expect(found, text).toBeDefined(); await act(async () => found!.click())
}
async function edit(label: string, value: string) {
  const input = dom.container.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[aria-label="' + label + '"]')!
  expect(input, label).not.toBeNull()
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
async function openForm() {
  if (dom.container.querySelector('button[aria-label="New arrangement"]')) { await button('New arrangement'); return }
  await act(async () => { const disclosure = dom.container.querySelector<HTMLDetailsElement>('.schedule-create')!; disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
}

describe('Mote calendar original schedule consumer', () => {
  it('compresses only the heartbeat issued for this Mote and keeps its original delivery description', async () => {
    // Persisted source IDs were issued with the original Host SHA-256 encoding.
    const source = (moteId: string) => ({ sourceId: 'mote-main:' + createHash('sha256')
      .update(JSON.stringify({ hostId: scope.workspace.hostId, moteId })).digest('hex'), revision: 'prior-role' })
    await owner([
      saved('care', { prompt: 'Edited reminder', managedSource: source(topic.id) }),
      saved('other', { prompt: 'Other automation', managedSource: source('another-mote') }),
      saved('manual', { prompt: 'Mote heartbeat' })
    ])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    const point = (id: string) => dom.container.querySelector<HTMLElement>(`[data-calendar-schedule-id="${id}"]`)
    await vi.waitFor(() => expect(point('care')?.querySelector('[data-semantic-icon="object.heartbeat"]')).toBeTruthy())
    expect(point('care')!.getAttribute('aria-label')).toContain('Mote heartbeat')
    expect(point('care')!.textContent).not.toContain('Mote heartbeat')
    expect(point('other')?.textContent).toContain('Other automation')
    expect(point('manual')?.textContent).toContain('Mote heartbeat')
    expect(point('other')?.hasAttribute('data-heartbeat')).toBe(false)
    expect(point('manual')?.hasAttribute('data-heartbeat')).toBe(false)
    await button('Day')
    await vi.waitFor(() => expect(dom.container.querySelector('.mote-calendar__rate[data-heartbeat] svg')).toBeTruthy())
    await button('Upcoming')
    await vi.waitFor(() => expect(dom.container.querySelector('[data-schedule-id="care"] .schedule-arrangement__mark svg')?.getAttribute('data-semantic-icon')).toBe('object.heartbeat'))
    expect(dom.container.querySelector('[data-schedule-id="other"] .schedule-arrangement__message')?.textContent).toBe('Other automation')
  })

  it('filters selected-period receipt actions and reads along with their original schedules', async () => {
    const readHistory = vi.fn<NonNullable<FutureProgressInputOwner['readHistory']>>(async (record, query) => {
      if (query.bucketStarts) return { coverage: 'recorded-inputs', entries: [], buckets: [], nextCursor: null }
      return { coverage: record.loopId === 'fault' ? 'unconfirmed' : 'recorded-inputs', entries: [],
        nextCursor: record.loopId === 'pages' ? 'original-cursor' : null }
    })
    await owner([saved('fault'), saved('pages'), saved('visible')], readHistory)
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(readHistory).toHaveBeenCalledTimes(3))
    await dom.click('[data-mote-date="' + DateTime.fromMillis(now, { zone: 'UTC' }).toISODate() + '"]')
    const detail = () => dom.container.querySelector('.mote-calendar__events')!
    await vi.waitFor(() => {
      expect(detail().textContent).toContain('Retry')
      expect(detail().textContent).toContain('Earlier events')
    })
    readHistory.mockClear()
    await dom.click('[aria-label="Search and filter arrangements"]')
    await edit('Search arrangements', 'visible')
    expect(detail().textContent).toContain('visible')
    expect(detail().textContent).not.toContain('Retry')
    expect(detail().textContent).not.toContain('Earlier events')
    expect(readHistory).not.toHaveBeenCalled()
  })

  it('keeps an earlier completed event with its frozen recap after the latest input moves', async () => {
    const selectedDate = DateTime.fromMillis(now, { zone: 'UTC' }).minus({ days: 1 })
    const range = calendarDayWindow(selectedDate)
    const { afterMs: _, ...original } = saved('archived-heartbeat', { status: 'stopped', lastOutcome: 'sent', lastOccurrenceAt: now, prompt: 'New future instruction' })
    const other = { ...original, status: 'active' as const, loopId: 'another-arrangement', creationOperationId: 'another-create',
      futureIntentId: 'another-intent', lastOccurrenceAt: range.from + 7200000 }
    let firstNext = true
    const readHistory = vi.fn<NonNullable<FutureProgressInputOwner['readHistory']>>(async (loop, query) => {
      if (query.bucketStarts) return { coverage: 'recorded-inputs', entries: [], nextCursor: null, buckets: [] }
      if (query.from !== range.from) return { coverage: 'recorded-inputs', entries: [], nextCursor: null }
      const earlier = loop.loopId === original.loopId
      if (!query.cursor) return { coverage: 'recorded-inputs', entries: [{ operationId: 'original-input-' + loop.loopId, runId: 'recorded-run',
        recap: { text: earlier ? 'Original patrol\nReview current work against the open commitments' : 'Another original input', truncated: false },
        occurrenceAt: range.from + (earlier ? 3600000 : 7200000), delivery: 'native-admitted',
        nativeResult: { state: 'completed', observedAt: range.from + 7200001 } }], nextCursor: earlier ? 'earlier-cursor' : null }
      if (firstNext) { firstNext = false; return { coverage: 'unconfirmed', entries: [], nextCursor: null } }
      return { coverage: 'recorded-inputs', entries: [{ operationId: 'older-original-input', runId: 'previous-run', recap: null,
        occurrenceAt: range.from + 60000, delivery: 'unconfirmed', nativeResult: { state: 'unknown' } }], nextCursor: null }
    })
    const calls = await owner([{ ...original, everyMs: 60000 }, { ...other, everyMs: 120000 }], readHistory)
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(readHistory).toHaveBeenCalledTimes(2))
    const before = dom.container.querySelector<HTMLButtonElement>(`[data-mote-date="${selectedDate.toISODate()}"]`)!
    await act(async () => before.click())
    const entries = () => dom.container.querySelector('[aria-label="Calendar events"]')
    await vi.waitFor(() => {
      expect(entries()?.textContent ?? '').toContain('01:00Original patrolAgent turn completed')
      expect(entries()?.textContent).toContain('02:00Another original inputAgent turn completed')
    })
    await act(async () => entries()!.querySelector<HTMLButtonElement>('button[data-event-schedule="archived-heartbeat"]')!.click())
    expect(entries()?.textContent).toContain('Review current work against the open commitments')
    expect(entries()?.textContent).not.toContain('New future instruction')
    expect(entries()?.textContent).toContain('Open original discussion')
    await dom.render(<MoteCalendar scope={{ ...scope, issue: 'Original directory temporarily unconfirmed' }} reference={reference} active />)
    expect(entries()?.textContent).toContain('Review current work against the open commitments')
    expect(readHistory).toHaveBeenCalledTimes(4)
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    const query = { scheduleId: original.loopId, ...range, limit: 12 }
    expect(calls).toHaveBeenCalledWith('schedule.history', query, expect.objectContaining({ transport: 'unix' }))
    expect(readHistory).toHaveBeenCalledWith(expect.objectContaining({ loopId: other.loopId }), { ...query, scheduleId: other.loopId }, expect.anything())
    await vi.waitFor(() => expect(dom.container.querySelector('.mote-calendar__events')?.getAttribute('aria-busy')).toBe('false'))
    await button('Earlier events')
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Some events could not be checked.'))
    expect(entries()?.textContent).toContain('Review current work against the open commitments')
    await button('Retry')
    await vi.waitFor(() => expect(entries()?.textContent).toContain('Delivery unconfirmed'))
    expect(readHistory).toHaveBeenLastCalledWith(expect.objectContaining({ loopId: original.loopId }), { ...query, cursor: 'earlier-cursor' }, expect.anything())
    await button('Today')
    const today = calendarDayWindow(DateTime.fromMillis(now, { zone: 'UTC' }))
    await vi.waitFor(() => expect(readHistory).toHaveBeenCalledWith(expect.objectContaining({ loopId: other.loopId }), { ...today, scheduleId: other.loopId, limit: 12 }, expect.anything()))
    expect(entries()?.textContent).not.toContain('Original patrol')
    expect(calls.mock.calls.every(([method]) => method === 'schedule.list' || method === 'schedule.history')).toBe(true)
    expect((await fixture!.store.load()).find(loop => loop.loopId === original.loopId)).toMatchObject({ status: 'stopped', revision: original.revision })
  })

  it('opens the exact earlier assignment from the calendar instead of its latest publication', async () => {
    const day = DateTime.fromMillis(now, { zone: 'UTC' })
    const firstAt = day.startOf('day').plus({ hours: 1 }).toMillis()
    const mote = { spaceId: 'mote', zoneId: 'home', expectedResource: { hostId: 'local', workspaceId: 'scratch', workspacePath: '/scratch' } }
    const work = { kind: 'group' as const, mote, groupId: 'work-group', recipients: [{ moteId: 'peer', generation: 'original' }] }
    const publication = (occurrenceAt: number, messageId: string) => ({ conversationId: work.groupId, messageId, occurrenceAt,
      operationId: `scheduled/assignment/${occurrenceAt}` })
    const first = publication(firstAt, 'morning-assignment'), second = publication(firstAt + 3600000, 'later-assignment')
    const { futureIntentId: _nativeInput, ...assignment } = saved('assignment', {
      moteWork: work, prompt: '核对发布稿', lastOccurrenceAt: second.occurrenceAt, lastMotePublication: second
    })
    await owner([assignment])
    vi.spyOn(api.schedule, 'history').mockImplementation(async query => ({
      scheduleId: query.scheduleId, from: query.from, to: query.to, entries: [], executionScope: 'connected-host',
      coverage: 'recorded-publications', nextCursor: null,
      ...(query.bucketStarts ? { buckets: [], publicationBuckets: query.bucketStarts.flatMap((from, index, starts) => {
        const to = starts[index + 1] ?? query.to
        const times = [first.occurrenceAt, second.occurrenceAt].filter(at => at >= from && at < to)
        return times.length ? [{ from, to, firstAt: times[0]!, lastAt: times.at(-1)!, count: times.length }] : []
      }) } : { publications: [second, first].filter(item => item.occurrenceAt >= query.from && item.occurrenceAt < query.to) })
    }))
    const read = vi.spyOn(api.moteGroup, 'call').mockRejectedValue(new Error('Original fixture ends at the owner read'))
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(dom.container.querySelector(`[data-mote-date="${day.toISODate()}"]`)).not.toBeNull())
    await vi.waitFor(() => expect(dom.container.querySelector('[data-calendar-schedule-id="assignment"][title*="published"]')?.textContent)
      .toContain('核对发布稿2 published'))
    await act(async () => dom.container.querySelector<HTMLButtonElement>(`[data-mote-date="${day.toISODate()}"]`)!.click())
    const rows = () => [...dom.container.querySelectorAll<HTMLButtonElement>('button[data-event-schedule="assignment"]')]
    await vi.waitFor(() => expect(rows().filter(item => item.textContent?.includes('Assignment published'))).toHaveLength(2))
    await act(async () => rows().find(item => item.textContent?.includes('01:00'))!.click())
    await button('查看作业与回报')
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith('space.mote.group.inspect', { groupId: work.groupId, messageId: first.messageId }))
    expect(read).not.toHaveBeenCalledWith('space.mote.group.inspect', { groupId: work.groupId, messageId: second.messageId })
  })

  it('counts earlier recorded inputs across summary pages in the grid and opens the same hour', async () => {
    const day = DateTime.fromMillis(now, { zone: 'UTC' })
    const start = day.startOf('hour').minus({ hours: 1 })
    const times = [4, 21, 51].map(minutes => start.plus({ minutes }).toMillis())
    const history: ScheduleHistoryEntry[] = times.map((occurrenceAt, index) => ({
      operationId: 'recorded-' + index, occurrenceAt, runId: 'original-run', delivery: index === 0 ? 'native-admitted' : 'terminal-confirmed',
      nativeResult: index === 0 ? { state: 'failed', observedAt: occurrenceAt } : { state: 'unsupported' },
      recap: { text: 'Frozen input ' + index, truncated: false },
    }))
    let unavailable = true
    const reader = vi.fn<NonNullable<FutureProgressInputOwner['readHistory']>>(async (record, query) => {
      const entries = history.filter((entry, index) => (record.loopId === 'patrol') === (index === 0) && entry.occurrenceAt >= query.from && entry.occurrenceAt < query.to)
      const bounds = query.bucketStarts
      if (!bounds) return { entries: entries.reverse(), coverage: 'recorded-inputs', nextCursor: null }
      if (record.loopId === 'patrol' && unavailable) return { buckets: [], entries: [], coverage: 'unconfirmed', nextCursor: null }
      const receipt = entries[query.cursor ? 1 : 0]!
      const index = bounds.findIndex((at, i) => receipt.occurrenceAt >= at && receipt.occurrenceAt < (bounds[i + 1] ?? query.to))
      const buckets = [{ from: bounds[index]!, to: bounds[index + 1] ?? query.to, groups: [{ count: 1, originalLabel: receipt.recap!.text, delivery: receipt.delivery,
        nativeState: receipt.nativeResult.state, firstAt: receipt.occurrenceAt, lastAt: receipt.occurrenceAt }] }]
      return { entries: [], buckets, coverage: 'recorded-inputs', nextCursor: entries.length > 1 && !query.cursor ? 'next-original' : null }
    })
    await owner([saved('patrol'), saved('heartbeat', { lastOccurrenceAt: now })], reader)
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await button('Week')
    const key = day.toISODate() + ':' + start.hour
    const cell = dom.container.querySelector<HTMLButtonElement>(`[data-calendar-hour="${key}"]`)!
    await vi.waitFor(() => expect(cell.textContent).toContain('Sent to terminal ×2'))
    expect(dom.container.textContent).toContain('Recorded events partially available')
    unavailable = false; await button('Retry calendar')
    await vi.waitFor(() => expect(cell.firstElementChild?.textContent).toContain('Agent turn failed'))
    expect(cell.getAttribute('aria-label')).toContain('3 recorded')
    expect(cell.textContent).toContain('Frozen input 0')
    expect(cell.textContent).toContain('Scheduled input')
    expect(cell.textContent).not.toContain('Original countdown')
    expect(dom.container.querySelector('[aria-label="Selected day arrangements"]')).toBeNull()
    const summaryCalls = reader.mock.calls.filter(([, query]) => query.bucketStarts).length
    await act(async () => cell.click())
    await vi.waitFor(() => expect(dom.container.querySelectorAll('[aria-label="Calendar events"] li')).toHaveLength(3))
    expect(reader.mock.calls.filter(([, query]) => query.bucketStarts)).toHaveLength(summaryCalls)
    expect(reader.mock.calls.filter(([, query]) => !query.bucketStarts).every(([, query]) => query.from === start.toMillis() && query.to === start.plus({ hours: 1 }).toMillis())).toBe(true)
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-event-schedule="patrol"]')!.click())
    expect(dom.container.querySelector('.mote-calendar__recap')?.textContent).toContain('Frozen input 0')
    await dom.click('[aria-label="Close period details"]')
    expect(document.activeElement).toBe(cell)
    expect(api.schedule.create).not.toHaveBeenCalled()
  })
  it('only reads exact event receipts while the period is visible', async () => {
    const readHistory = vi.fn<NonNullable<FutureProgressInputOwner['readHistory']>>(async (_loop, query) => ({ coverage: 'recorded-inputs', entries: [], nextCursor: null, ...(query.bucketStarts ? { buckets: [] } : {}) }))
    const original = saved('only-original-countdown')
    await owner([original], readHistory)
    await dom.render(<MoteCalendar scope={scope} reference={reference} active={false} />)
    expect(readHistory).not.toHaveBeenCalled()
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(readHistory).toHaveBeenCalledTimes(1))
    expect(readHistory.mock.calls[0]![1].bucketStarts!.length).toBeGreaterThan(7)
    expect(dom.container.querySelector('[aria-label="Selected day arrangements"]')).toBeNull()
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-mote-date][aria-pressed="true"]')!.click())
    await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Calendar events"]')?.textContent).toContain('Planned'))
    const query = { scheduleId: original.loopId, ...calendarDayWindow(DateTime.fromMillis(now, { zone: 'UTC' })), limit: 12 }
    expect(readHistory).toHaveBeenCalledWith(expect.objectContaining({ loopId: original.loopId }), query, expect.anything())
  })

  it('groups the actual elapsed hours without duplicating or dropping DST minutes', () => {
    const zone = 'America/New_York'
    for (const [day, missing, folded, total] of [[21983, 2, undefined, 23], [22221, undefined, 1, 25]] as const) {
      const date = DateTime.fromMillis(_batchFixtureEpoch(day, 43200), { zone })
      const windows = calendarHourWindows(date)
      const ordered = [...windows.values()]
      const bounds = calendarDayWindow(date)
      expect(ordered[0]?.from).toBe(bounds.from)
      expect(ordered.at(-1)?.to).toBe(bounds.to)
      expect(ordered.slice(1).map(window => window.from)).toEqual(ordered.slice(0, -1).map(window => window.to))
      expect(ordered.reduce((sum, window) => sum + window.to - window.from, 0)).toBe(total * 3_600_000)
      if (missing !== undefined) expect(windows.has(missing)).toBe(false)
      if (folded !== undefined) expect(windows.get(folded)!.to - windows.get(folded)!.from).toBe(7_200_000)
    }
  })
  it('uses exact owner addresses, including confirmed aliases, and never infers a container or prefix', () => {
    expect(moteScheduleQueries(scope)).toEqual([{ scope: { hostId: target.hostId, workspacePath: target.workspacePath } }])
    expect(moteScheduleQueries({ ...scope, topic: { ...topic, confirmedDirectoryPaths: [new URL("old/home", new URL('/', import.meta.url)).pathname, new URL("new/home", new URL('/', import.meta.url)).pathname] } })).toEqual([
      { scope: { hostId: target.hostId, workspacePath: new URL("new/home", new URL('/', import.meta.url)).pathname } }, { scope: { hostId: target.hostId, workspacePath: new URL("old/home", new URL('/', import.meta.url)).pathname } }])
    const { physicalDirectoryPath: _, confirmedDirectoryPaths: __, ...unconfirmed } = topic
    expect(moteScheduleQueries({ ...scope, topic: unconfirmed })).toEqual([])
    expect(moteScheduleQueries({ ...scope, issue: 'Discovery unavailable' })).toEqual([])
  })
  it('actual Mote Renderer list and original control traverse typed API, public RPC, Main and private Store', async () => {
    const calls = await owner([saved('countdown'), saved('other-discussion', { agentSessionId: neighborAgent.control.agentSessionId }), saved('neighbor', { workspacePath: target.workspacePath + '-other' }), saved('remote', { hostId: 'another-host' })])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await button('Upcoming')
    await vi.waitFor(() => expect(dom.container.querySelectorAll('[data-schedule-id]')).toHaveLength(2))
    expect(api.schedule.list).toHaveBeenCalledExactlyOnceWith({ scope: { hostId: target.hostId, workspacePath: target.workspacePath } })
    expect(calls).toHaveBeenCalledWith('schedule.list', { scope: { hostId: target.hostId, workspacePath: target.workspacePath } }, expect.objectContaining({ transport: 'unix' }))
    expect(dom.container.textContent).toContain('Countdown')
    await button('Pause arrangement')
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Paused'))
    await vi.waitFor(() => expect([...dom.container.querySelectorAll<HTMLButtonElement>('[data-schedule-id="countdown"] button')].find(button => button.textContent === 'Resume arrangement')?.disabled).toBe(false))
    const original = vi.mocked(api.schedule.pause).mock.calls[0]![0]
    expect(original).toMatchObject({ scheduleId: 'countdown', expectedRevision: 1 })
    expect((await fixture!.store.load()).find(item => item.loopId === 'countdown')).toMatchObject({ status: 'paused', revision: 2, nextCheckAt: now + 90000, lastMutation: { operationId: original.operationId } })
    await button('Resume arrangement'); await vi.waitFor(async () => expect((await fixture!.store.load()).find(item => item.loopId === 'countdown')?.revision).toBe(3))
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('[data-schedule-id="countdown"] button[disabled]')).toBeNull())
    await button('Cancel arrangement'); await vi.waitFor(async () => expect((await fixture!.store.load()).find(item => item.loopId === 'countdown')?.status).toBe('stopped'))
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })
  it('Month selects a real original countdown day with keyboard and distinguishes plan from acceptance', async () => {
    const { afterMs: _, ...calendar } = saved('daily')
    await owner([saved('countdown'), { ...calendar, nextCheckAt: now + 300000, calendar: { kind: 'daily', timezone: 'UTC', time: (new Date(_batchFixtureEpoch(0, 36300)).toISOString().slice(11, 16)), policies: { gap: 'skip', fold: 'earlier', monthEnd: 'clamp', overdue: 'latest' } }, lastOccurrenceAt: now - 86400000 }])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(dom.container.querySelector('[data-calendar-schedule-id="countdown"]')).not.toBeNull())
    await button('Month')
    const day = dom.container.querySelector<HTMLButtonElement>(("[data-mote-date=\"" + (new Date(_batchFixtureEpoch(20748, 0, 0)).toISOString().slice(0, 10)) + "\"]"))!
    await act(async () => day.click())
    expect(dom.container.querySelector('[aria-label="Selected day arrangements"] [data-event-schedule="countdown"]')).not.toBeNull()
    await act(async () => day.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(dom.container.querySelector(("[data-mote-date=\"" + (new Date(_batchFixtureEpoch(20749, 0, 0)).toISOString().slice(0, 10)) + "\"]"))?.getAttribute('aria-pressed')).toBe('true')
    expect(dom.container.querySelector('[aria-label="Selected day arrangements"] .mote-calendar__plan-total')?.textContent).toBe('1 planned')
    await act(async () => dom.container.querySelector<HTMLButtonElement>(("[data-mote-date=\"" + (new Date(_batchFixtureEpoch(20747, 0, 0)).toISOString().slice(0, 10)) + "\"]"))!.click())
    expect(dom.container.querySelector('[aria-label="Selected date"]')?.textContent).toContain('Input accepted')
    expect(dom.container.querySelectorAll('[aria-label="Calendar events"] [data-event-schedule="daily"]')).toHaveLength(1)
  })
  it('date and hour keep confirmed ended input while Upcoming independently filters ended arrangements', async () => {
    const acceptedAt = now - 15 * 60_000
    const accepted = DateTime.fromMillis(acceptedAt, { zone: 'UTC' })
    const completed = saved('completed', { status: 'stopped', lastOccurrenceAt: acceptedAt, lastOutcome: 'sent', nextCheckAt: acceptedAt })
    const cancelled = saved('cancelled', { status: 'stopped', lastOutcome: 'unknown', nextCheckAt: now + 3_600_000 })
    await owner([completed, cancelled])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    const marker = () => dom.container.querySelector('[data-calendar-schedule-id="completed"]')
    await vi.waitFor(() => expect(marker()?.getAttribute('aria-label')).toContain('Input accepted'))
    expect(dom.container.querySelector('[data-calendar-schedule-id="cancelled"]')).toBeNull()
    expect(dom.container.textContent).not.toContain('Show ended')
    expect(dom.container.querySelector('.mote-calendar__legend')?.textContent).toContain('Events by day')
    await button('Day')
    const hour = dom.container.querySelector<HTMLButtonElement>(`[data-calendar-hour="${accepted.toISODate()}:${accepted.hour}"]`)!
    expect(hour.getAttribute('aria-label')).toContain('0 planned, 1 recorded')
    await act(async () => hour.click())
    expect(dom.container.querySelector('[aria-label="Selected hour"] [aria-label="Calendar events"]')?.textContent).toContain('Input accepted')
    await button('Upcoming')
    expect(dom.container.querySelector('[data-schedule-id="completed"]')).toBeNull()
    await act(async () => dom.container.querySelector<HTMLInputElement>('.mote-calendar__ended input')!.click())
    expect(dom.container.querySelector('[data-schedule-id="completed"]')).not.toBeNull()
    expect(dom.container.querySelector('[data-schedule-id="cancelled"]')).not.toBeNull()
    await button('Month')
    expect(marker()).not.toBeNull()
    expect(dom.container.querySelector('[data-calendar-schedule-id="cancelled"]')).toBeNull()
    expect(api.schedule.resume).not.toHaveBeenCalled()
  })
  it('opens the exact original Main Mote discussion through existing spatial navigation without changing the execution lane', async () => {
    await owner([saved('main-discussion')])
    const initial = useAppStore.getState(), execution = initial.agentFocus.execution, sessions = initial.sessions, drafts = initial.agentComposerDrafts
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await button('Upcoming')
    await vi.waitFor(() => expect(dom.container.querySelector('[data-schedule-id="main-discussion"]')).not.toBeNull())
    await button('Open original discussion')
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ workspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId })
    expect(useAppStore.getState().mainSurface).toBe('workbench')
    expect(useAppStore.getState().agentFocus.execution).toEqual(execution)
    expect(useAppStore.getState().sessions).toBe(sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
    expect(dom.container.textContent).not.toContain('could not be focused')
    // A stale presentation Host cannot stand in for the exact native control Host.
    const originalChoice = useAppStore.getState().workbenchSpaceSelection
    await act(async () => useAppStore.setState({ sessions: sessions.map(session => session.id === defaultAgent.id && session.kind === 'agent'
      ? { ...session, control: { ...session.control, hostId: 'another-control-host' } } : session) }))
    await button('Open original discussion')
    expect(dom.container.textContent).toContain('The original discussion is not confirmed')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(originalChoice)
    await openForm(); await edit('Arranged message', 'Keep this draft while the original control Host is unknown'); await button('Save arrangement')
    expect(api.schedule.create).not.toHaveBeenCalled()
    expect(dom.container.textContent).toContain('Choose an exact Mote discussion')
  })
  it('hidden Calendar performs no reads; unknown directory retains confirmed rows and drafts', async () => {
    await owner([saved('countdown')])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active={false} />)
    expect(api.schedule.list).not.toHaveBeenCalled()
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(dom.container.querySelector('[data-calendar-schedule-id="countdown"]')).not.toBeNull())
    await openForm(); await edit('Arranged message', 'Keep my arrangement draft')
    await dom.render(<MoteCalendar scope={{ ...scope, issue: 'Directory unavailable' }} reference={reference} active />)
    expect(api.schedule.list).toHaveBeenCalledTimes(1)
    expect(dom.container.querySelector('[data-calendar-schedule-id="countdown"]')).not.toBeNull()
    expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep my arrangement draft')
    expect(dom.container.textContent).toContain('Directory unavailable')
  })
  it('a draft written before first home discovery survives confirmed metadata and a remount', async () => {
    await owner([])
    const { physicalDirectoryPath: _, confirmedDirectoryPaths: __, ...unconfirmed } = topic
    await dom.render(<MoteCalendar scope={{ ...scope, topic: unconfirmed, issue: 'Home discovery pending' }} reference={null} active />)
    await openForm(); await edit('Arranged message', 'Keep this cold-start reminder draft')
    await dom.render(<MoteCalendar scope={{ ...scope, topic: { ...topic, identityDirectoryPath: target.workspacePath } }} reference={reference} active />)
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!.value).toBe('Keep this cold-start reminder draft')
    await dom.render(<div />)
    await dom.render(<MoteCalendar scope={{ ...scope, topic: { ...topic, identityDirectoryPath: target.workspacePath } }} reference={reference} active />)
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!.value).toBe('Keep this cold-start reminder draft')
    expect(api.schedule.create).not.toHaveBeenCalled()
  })
  it('original Session Arrangements creates afterMs over real RPC and recovers a lost ack with the same operation', async () => {
    await owner([])
    const create = vi.mocked(api.schedule.create).mockImplementationOnce(async params => { await fixture!.rpc.call('schedule.create', params); throw new Error('Private transport lost only the acknowledgment') })
    await dom.render(<CalendarScheduleControl target={target} />)
    await openForm(); await edit('Arrangement timing', 'afterMs'); await edit('Countdown duration', '7'); await edit('Countdown unit', 'minutes'); await edit('Arranged message', 'Return to my original idea')
    await button('Save arrangement'); await vi.waitFor(() => expect(dom.container.textContent).toContain('acknowledgment'))
    const original = create.mock.calls[0]![0]
    expect(original).toMatchObject({ target, afterMs: 420000, prompt: 'Return to my original idea' })
    await button('Check original operation')
    await vi.waitFor(() => expect(dom.container.textContent).toContain('save receipt is still unconfirmed'))
    await button('Retry original operation')
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(''))
    expect(create.mock.calls.map(call => call[0])).toEqual([original, original])
    const stored = await fixture!.store.load(); expect(stored).toHaveLength(1); expect(stored[0]).toMatchObject({ creationOperationId: original.operationId, afterMs: 420000, nextCheckAt: now + 420000 })
  })
  it('the actual details Calendar mode suspends knowledge reads and preserves the form across mode changes', async () => {
    await owner([saved('countdown')])
    const tree = vi.spyOn(api.files, 'listPublic').mockImplementation(async params => moteDirectoryListing(params, scope.rootPath, []))
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'deleted' })
    await dom.render(<MoteDetailsPanel scope={scope} reference={reference} onOpenPath={async () => {}} />)
    await button('Calendar'); await vi.waitFor(() => expect(dom.container.querySelector('[data-calendar-schedule-id="countdown"]')).not.toBeNull())
    const before = [tree.mock.calls.length, read.mock.calls.length]
    await openForm(); await edit('Arranged message', 'My calendar draft')
    await act(async () => useAppStore.setState({ workspaceFileRevisions: { [scratchWorkspace.id]: 1234 } }))
    expect([tree.mock.calls.length, read.mock.calls.length]).toEqual(before)
    await button('Profile'); await button('Calendar')
    expect(dom.container.querySelector<HTMLTextAreaElement>('.mote-calendar textarea')!.value).toBe('My calendar draft')
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })
  it('lists the exact Club Ideas directory alongside an unresolved Scratch Files selection and retries the same directory', async () => {
    const spaceId = directoryIdentity(scratchWorkspace.hostId, topic.directoryPath), zoneId = homeZoneId(spaceId)
    const originalSelection = { workspace: scratchWorkspace, target: { hostId: scratchWorkspace.hostId,
      reference: { runtimeId: 'other-runtime', spaceId: 'other-space' } },
      selection: { kind: 'directory' as const, path: scratchWorkspace.path + '/other-source' } }
    const held = { selections: { [scratchWorkspace.id]: originalSelection }, pending: {}, creations: {}, folderRequests: {} }
    useAppStore.setState({ sourceFilesInputs: held })
    await expect(readWorkspaceDirectory(scratchWorkspace.id, scope.rootPath, useAppStore.getState)).rejects.toThrow('Source directory is unconfirmed')
    const read = vi.spyOn(api.files, 'listPublic')
      .mockImplementationOnce(async params => moteDirectoryListing(params, scope.rootPath, [ideaEntry(scope.rootPath, 'confirmed-thought.md')], false))
      .mockResolvedValueOnce({ resource: null, result: { status: 'unknown', code: 'FILE_LIST_UNCONFIRMED', message: 'Original folder temporarily unavailable' } })
      .mockImplementationOnce(async params => moteDirectoryListing(params, scope.rootPath, []))
    const drafts = useAppStore.getState().agentComposerDrafts
    await dom.render(<MoteDetailsPanel scope={scope} reference={reference} onOpenPath={async () => {}} />)
    await button('Ideas')
    const ideas = dom.container.querySelector<HTMLElement>('.mote-details__ideas')!
    expect(ideas.querySelector('.mote-details__notes')?.textContent).toContain('confirmed-thought')
    expect(ideas.querySelector('.mote-ideas__heading small')).toBeNull()
    expect(ideas.textContent).toContain('partial list')
    await dom.click('.mote-details__ideas .mote-ideas__service button')
    expect(ideas.querySelector('.mote-details__notes')?.textContent).toContain('confirmed-thought')
    expect(ideas.querySelector('.mote-ideas__heading small')).toBeNull()
    expect(ideas.textContent).toContain('Original folder temporarily unavailable')
    await dom.click('.mote-details__ideas .mote-ideas__service button')
    expect(ideas.querySelector('.mote-ideas__heading small')?.textContent).toBe('0')
    expect(ideas.querySelector('.mote-details__notes')?.textContent).toBe('')
    expect(ideas.textContent).toContain('No notes yet')
    expect(read.mock.calls).toEqual(Array.from({ length: 3 }, () => [{
      spaceId, zoneId, path: '.', mode: 'directory',
      expectedResource: { hostId: scratchWorkspace.hostId, workspaceId: scratchWorkspace.id, workspacePath: scratchWorkspace.path }
    }]))
    expect(useAppStore.getState().sourceFilesInputs).toBe(held)
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  })
  it('does not show a delayed Ideas listing in a different Club on the same Scratch workspace', async () => {
    const otherTopic = moteTopics[1]!, otherRoot = scratchTopicDirectoryName(otherTopic.id)
    const otherScope = { workspace: scope.workspace, topic: otherTopic, rootPath: otherRoot }
    let finish!: () => void
    const read = vi.spyOn(api.files, 'listPublic')
      .mockImplementationOnce(params => new Promise<FileListResult>(resolve => {
        finish = () => resolve(moteDirectoryListing(params, scope.rootPath, [ideaEntry(scope.rootPath, 'old-club-note.md')]))
      }))
      .mockImplementationOnce(async params => moteDirectoryListing(params, otherRoot, [ideaEntry(otherRoot, 'current-club-note.md')]))
    const mountDetails = (nextScope: MoteWorkfaceScope) => dom.render(<MoteDetailsPanel scope={nextScope} onOpenPath={async () => {}} />)
    await mountDetails(scope); await button('Ideas')
    await mountDetails(otherScope)
    const notes = () => dom.container.querySelector('.mote-details__ideas .mote-details__notes')?.textContent
    expect(notes()).toContain('current-club-note')
    await act(async () => finish())
    expect(notes()).toContain('current-club-note')
    expect(notes()).not.toContain('old-club-note')
    expect(read.mock.calls.map(([params]: [FileListParams]) => params.zoneId)).toEqual([topic, otherTopic]
      .map(item => homeZoneId(directoryIdentity(scratchWorkspace.hostId, item.directoryPath))))
  })
  it('a newly visible list replaces same-version cached delivery facts from before it was hidden', async () => {
    await owner([saved('countdown', { lastTickAt: now, lastOutcome: 'unknown', status: 'paused' })])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Delivery unconfirmed'))
    await dom.render(<MoteCalendar scope={scope} reference={reference} active={false} />)
    // A later authoritative snapshot can finish delivery without a control-revision bump.
    vi.mocked(api.schedule.list).mockResolvedValue({ schedules: [saved('countdown', { status: 'stopped', lastTickAt: now, lastOutcome: 'sent' })], executionScope: 'connected-host' })
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await button('Upcoming')
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Show ended (1)'))
    expect(dom.container.querySelector('[data-schedule-id="countdown"]')).toBeNull()
  })
  it('Ideas keeps an edited frozen arrangement and its unknown operation reachable across Calendar and remount', async () => {
    await owner([])
    vi.spyOn(api.files, 'listPublic').mockImplementation(async params => moteDirectoryListing(params, scope.rootPath, []))
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'deleted' })
    const sources = vi.spyOn(api.files, 'readPublic').mockImplementation(async params => ({ resource: { ...params.expectedResource, zoneId: params.zoneId,
      zonePath: target.workspacePath, path: scope.rootPath + '/' + params.path }, result: { status: 'read', document: { path: scope.rootPath + '/' + params.path,
        content: '# Original saved profile', revision: 'sha256:' + 'a'.repeat(64) } } }))
    const create = vi.mocked(api.schedule.create).mockImplementationOnce(async params => { await fixture!.rpc.call('schedule.create', params); throw new Error('Original receipt lost') })
    const panel = <MoteDetailsPanel scope={scope} reference={reference} onOpenPath={async () => {}} />
    await dom.render(panel); await button('Ideas'); await edit('Idea direction', 'Find a useful original idea')
    await dom.click('[aria-label="Arrange sourced ideas"]')
    await vi.waitFor(() => expect(dom.container.querySelector('.mote-idea-controls__arrangement textarea')).not.toBeNull())
    await edit('Arranged message', 'An edited sourced direction'); await button('Save arrangement')
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Original receipt lost'))
    const original = create.mock.calls[0]![0], readCount = sources.mock.calls.length
    await button('Calendar'); await button('Ideas')
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!.value).toBe('An edited sourced direction')
    expect(dom.container.textContent).toContain('Retry original operation')
    expect(sources).toHaveBeenCalledTimes(readCount)
    sources.mockRejectedValue(new Error('The original source is now unavailable'))
    await dom.render(<div />); await dom.render(panel); await button('Ideas')
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!.value).toBe('An edited sourced direction')
    await button('Retry original operation')
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!.value).toBe(''))
    expect(create.mock.calls.map(call => call[0])).toEqual([original, original])
    expect(await fixture!.store.load()).toHaveLength(1)
  })
  it('keyboard date movement keeps focus in the original Calendar when two workfaces are mounted', async () => {
    await owner([])
    const calendars = (firstActive: boolean) => <><MoteCalendar scope={scope} reference={reference} active={firstActive} /><MoteCalendar scope={scope} reference={reference} active /></>
    await dom.render(calendars(true))
    for (const element of dom.container.querySelectorAll<HTMLElement>('[aria-label="Mote calendar"]'))
      await act(async () => [...element.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === 'Month')!.click())
    await dom.render(calendars(false))
    const second = dom.container.querySelectorAll('[aria-label="Mote calendar"]')[1]!
    const date = second.querySelector<HTMLButtonElement>(("[data-mote-date=\"" + (new Date(_batchFixtureEpoch(20748, 0, 0)).toISOString().slice(0, 10)) + "\"]"))!
    await act(async () => { date.focus(); date.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    await vi.waitFor(() => expect(document.activeElement).toBe(second.querySelector(("[data-mote-date=\"" + (new Date(_batchFixtureEpoch(20749, 0, 0)).toISOString().slice(0, 10)) + "\"]"))))
  })
  it('starts in Month and opens shared original details from bounded calendar previews', async () => {
    await owner(Array.from({ length: 5 }, (_, index) => saved('preview-' + index, { nextCheckAt: now + (index + 1) * 60000, prompt: 'Original full message ' + index + '\nExact request context' })))
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(dom.container.querySelectorAll('.mote-calendar__point')).toHaveLength(3))
    expect(dom.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Month')
    expect(dom.container.querySelectorAll('.mote-calendar__cell')).toHaveLength(35)
    await button('+2 more')
    expect(dom.container.querySelectorAll('[aria-label="Calendar events"] [data-event-schedule]')).toHaveLength(5)
    const point = dom.container.querySelector<HTMLButtonElement>('[data-calendar-schedule-id="preview-1"]')!
    expect(point.textContent).toContain((new Date(_batchFixtureEpoch(0, 36120)).toISOString().slice(11, 16)))
    await act(async () => point.click())
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-event-schedule="preview-1"]')!.click())
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLDetailsElement>('[data-schedule-id="preview-1"] details')?.open).toBe(true))
    expect(dom.container.querySelector('[data-schedule-id="preview-1"]')?.textContent).toContain('Exact request context')
    expect(api.schedule.create).not.toHaveBeenCalled()
  })
  it('Week projects only seven civil days and a time shortcut creates through the original public owner', async () => {
    const today = DateTime.fromMillis(now, { zone: 'UTC' }), tomorrow = today.plus({ days: 1 })
    await owner([saved('early', { nextCheckAt: today.set({ hour: 8, minute: 15 }).toMillis() }), saved('later', { nextCheckAt: today.set({ hour: 17, minute: 45 }).toMillis() }), saved('outside', { nextCheckAt: today.plus({ weeks: 1 }).toMillis() })])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await button('Week')
    await vi.waitFor(() => expect(dom.container.querySelectorAll('.mote-calendar__bucket .mote-calendar__rate')).toHaveLength(2))
    expect(dom.container.querySelectorAll('[data-mote-date]')).toHaveLength(7)
    const hourly = (hour: number) => dom.container.querySelector(`[data-calendar-hour="${today.toISODate()}:${hour}"]`)
    expect(hourly(8)?.textContent).toContain('Original countdown early')
    expect(hourly(17)?.textContent).toContain('Original countdown later')
    expect(dom.container.querySelector('.mote-calendar__week-timeline')?.textContent).not.toContain('Original countdown outside')
    const slot = [...dom.container.querySelectorAll<HTMLButtonElement>('.mote-calendar__slot')].find(item => item.getAttribute('aria-label') === 'Prepare arrangement ' + tomorrow.toFormat('cccc, LLLL d') + (" at " + new Date(_batchFixtureEpoch(0, 50400)).toISOString().slice(11, 16)))!
    await act(async () => slot.click())
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement date"]')!.value).toBe(tomorrow.toISODate())
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement local time"]')!.value).toBe((new Date(_batchFixtureEpoch(0, 50400)).toISOString().slice(11, 16)))
    expect(api.schedule.create).not.toHaveBeenCalled()
    await edit('Arranged message', 'A point in my original discussion'); await button('Save arrangement')
    await vi.waitFor(() => expect(api.schedule.create).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.schedule.create).mock.calls[0]![0]).toMatchObject({ target, prompt: 'A point in my original discussion', calendar: { kind: 'once', date: tomorrow.toISODate(), time: (new Date(_batchFixtureEpoch(0, 50400)).toISOString().slice(11, 16)), timezone: 'UTC' } })
    await vi.waitFor(async () => expect(await fixture!.store.load()).toHaveLength(4))
    await vi.waitFor(() => expect(dom.container.querySelector('.schedule-create__confirmation')?.textContent).toContain('Arrangement saved.'))
    const created = (await fixture!.store.load()).find(item => item.prompt === 'A point in my original discussion')!
    await button('View arrangement')
    expect(dom.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Upcoming')
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLDetailsElement>('[data-schedule-id="' + created.loopId + '"] details')?.open).toBe(true))
  })
  it('aggregates minute cadences by date and hour and opens a bounded page for the original schedules', async () => {
    const day = DateTime.fromMillis(now, { zone: 'UTC' }).plus({ days: 1 }).startOf('day')
    const date = day.toISODate()!
    const { afterMs: _afterMs, ...original } = saved('minute', { nextCheckAt: now + 60_000, lastOccurrenceAt: now - 60_000 })
    const everyMinute = { ...original, everyMs: 60_000 }
    const everyTwo = { ...original, loopId: 'two-minutes', creationOperationId: 'created-twice', futureIntentId: 'future-twice', everyMs: 120_000 }
    await owner([everyMinute, everyTwo])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(dom.container.querySelector('[data-calendar-schedule-id="minute"]')).not.toBeNull())
    await act(async () => dom.container.querySelector<HTMLButtonElement>(`[data-mote-date="${date}"]`)!.click())
    expect(dom.container.querySelector('.mote-calendar__plan-total strong')?.textContent?.replace(/\D/g, '')).toBe('2160')
    expect(dom.container.querySelectorAll('.mote-calendar__cell[data-selected="true"] [data-calendar-schedule-id]')).toHaveLength(2)
    expect(dom.container.querySelector('[aria-label="Calendar events"]')?.textContent).toContain('planned')
    await button('3 Days')
    expect(dom.container.querySelectorAll('[data-calendar-hour]')).toHaveLength(72)
    expect(dom.container.querySelectorAll('[data-occurrence-kind]')).toHaveLength(0)
    await act(async () => dom.container.querySelector<HTMLButtonElement>(`[data-calendar-hour="${date}:20"]`)!.click())
    expect(dom.container.querySelector('.mote-calendar__plan-total strong')?.textContent).toBe('90')
    const details = dom.container.querySelector<HTMLDetailsElement>('.mote-calendar__time-details')!
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
    await vi.waitFor(() => expect(details.querySelectorAll('li[data-occurrence-kind="projected"]')).toHaveLength(12))
    expect(details.textContent).toContain('1–12 / 90')
    await button('Next')
    expect(details.textContent).toContain('13–24 / 90')
    expect(details.querySelectorAll('li[data-occurrence-kind="projected"]')).toHaveLength(12)
    expect(dom.container.querySelectorAll('[aria-label="Selected hour"] [data-event-schedule]')).toHaveLength(2)
    expect(api.schedule.create).not.toHaveBeenCalled()
    await button('Day')
    expect(dom.container.querySelectorAll('[data-calendar-hour]')).toHaveLength(24)
    expect(dom.container.querySelector('[data-mote-date]')?.getAttribute('data-mote-date')).toBe(date)
  })
  it('opens at the selected hour, returns focus, and only moves a kept draft on request', async () => {
    await owner([])
    const day = DateTime.fromMillis(now, { zone: 'UTC' }).plus({ days: 1 })
    const date = day.toISODate()!
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await button('Week')
    const slot = dom.container.querySelector<HTMLButtonElement>(`[data-calendar-hour="${date}:14"]`)!
    await act(async () => slot.click())
    const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="New arrangement"]')!
    await act(async () => trigger.click())
    const dialog = () => dom.container.querySelector<HTMLElement>('[role="dialog"][aria-label="New arrangement"]')
    expect(dialog()!.querySelector<HTMLInputElement>('input[type="time"]')!.value).toBe('14:00')
    expect(dialog()!.querySelector<HTMLInputElement>('input[type="date"]')!.value).toBe(date)
    await edit('Arranged message', 'Keep my request')
    const message = dialog()!.querySelector('textarea')!
    await act(async () => { message.focus(); message.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })) })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(trigger)
    const next = dom.container.querySelector<HTMLButtonElement>(`[data-calendar-hour="${date}:16"]`)!
    await act(async () => next.click())
    await act(async () => trigger.click())
    expect(dialog()!.textContent).toContain('Existing draft')
    expect(dialog()!.querySelector<HTMLInputElement>('input[type="time"]')!.value).toBe('14:00')
    const move = [...dialog()!.querySelectorAll('button')].find(button => button.textContent?.startsWith('Move draft to'))!
    await act(async () => move.click())
    expect(dialog()!.querySelector<HTMLInputElement>('input[type="time"]')!.value).toBe('16:00')
    expect(dialog()!.querySelector('textarea')!.value).toBe('Keep my request')
    expect(api.schedule.create).not.toHaveBeenCalled()
  })
  it('date shortcuts keep edited timing, message and a pending original creation intact', async () => {
    await owner([])
    const today = DateTime.fromMillis(now, { zone: 'UTC' }), firstDate = today.plus({ days: 1 }).toISODate()!, nextDate = today.plus({ days: 2 }).toISODate()!
    const create = vi.mocked(api.schedule.create).mockImplementationOnce(async params => { await fixture!.rpc.call('schedule.create', params); throw new Error('Original creation acknowledgment unavailable') })
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-mote-date="' + firstDate + '"]')!.click())
    await button('New arrangement')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement date"]')!.value).toBe(firstDate)
    await edit('Arrangement local time', (new Date(_batchFixtureEpoch(0, 48000)).toISOString().slice(11, 16)))
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-mote-date="' + nextDate + '"]')!.click())
    await button('New arrangement')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement date"]')!.value).toBe(firstDate)
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement local time"]')!.value).toBe((new Date(_batchFixtureEpoch(0, 48000)).toISOString().slice(11, 16)))
    await edit('Arranged message', 'Keep this exact arrangement draft'); await button('Save arrangement')
    await vi.waitFor(() => expect(dom.container.textContent).toContain('acknowledgment unavailable'))
    expect(dom.container.querySelector('.schedule-create__confirmation')).toBeNull()
    const original = create.mock.calls[0]![0], pending = Object.values(useLauncherState.getState().drafts).find(draft => draft.schedule?.pending)?.schedule?.pending
    await button('Today'); await button('New arrangement')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement date"]')!.value).toBe(firstDate)
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!.value).toBe('Keep this exact arrangement draft')
    expect(Object.values(useLauncherState.getState().drafts).find(draft => draft.schedule?.pending)?.schedule?.pending).toEqual(pending)
    expect(create).toHaveBeenCalledTimes(1)
    await button('Check original operation')
    await vi.waitFor(() => expect(dom.container.textContent).toContain('save receipt is still unconfirmed'))
    expect(dom.container.querySelector('.schedule-create__confirmation')).toBeNull()
    await button('Retry original operation')
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls.map(call => call[0])).toEqual([original, original])
  })
  it('hidden and unrelated work neither projects occurrences nor starts presentation clocks', async () => {
    await owner([saved('countdown')])
    const projection = vi.spyOn(scheduleCalendar, 'projectScheduleOccurrences'), intervals = vi.spyOn(globalThis, 'setInterval'), clearing = vi.spyOn(globalThis, 'clearInterval')
    await dom.render(<MoteCalendar scope={scope} reference={reference} active={false} />)
    expect(projection).not.toHaveBeenCalled()
    expect(intervals.mock.calls.filter(call => call[1] === 60000)).toHaveLength(0)
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(dom.container.querySelector('[data-calendar-schedule-id="countdown"]')).not.toBeNull())
    const projected = projection.mock.calls.length, reads = vi.mocked(api.schedule.list).mock.calls.length
    const presentationClocks = intervals.mock.calls.flatMap((call, index) => call[1] === 60000 ? [intervals.mock.results[index]!.value] : [])
    expect(projected).toBeGreaterThan(0); expect(presentationClocks).toHaveLength(1)
    await act(async () => useAppStore.setState({ sessions: [...useAppStore.getState().sessions, { ...neighborAgent, id: 'unrelated-presentation' }] }))
    expect(projection).toHaveBeenCalledTimes(projected)
    await dom.render(<MoteCalendar scope={scope} reference={reference} active={false} />)
    expect(projection).toHaveBeenCalledTimes(projected)
    expect(api.schedule.list).toHaveBeenCalledTimes(reads)
    expect(clearing).toHaveBeenCalledWith(presentationClocks[0])
  })
  it('Week restores its user scroll across view changes and hidden re-entry', async () => {
    await owner([saved('countdown')])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await button('Week')
    await vi.waitFor(() => expect(dom.container.querySelector('.mote-calendar__bucket .mote-calendar__rate')).not.toBeNull())
    const scroller = dom.container.querySelector<HTMLDivElement>('.mote-calendar__week-scroll')!
    await act(async () => { scroller.scrollTop = 190; scroller.dispatchEvent(new Event('scroll')) })
    await button('Month'); await button('Week')
    expect(dom.container.querySelector<HTMLDivElement>('.mote-calendar__week-scroll')!.scrollTop).toBe(190)
    await dom.render(<MoteCalendar scope={scope} reference={reference} active={false} />)
    dom.container.querySelector<HTMLDivElement>('.mote-calendar__week-scroll')!.scrollTop = 0
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    expect(dom.container.querySelector<HTMLDivElement>('.mote-calendar__week-scroll')!.scrollTop).toBe(190)
  })
  it.each([false, true])('a date shortcut preserves an explicitly chosen discussion before any message or timing edit (remount=%s)', async remount => {
    await owner([])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await openForm()
    const otherReference = { ...reference, tabId: neighborTab.id, regionId: 'neighbor-region' }
    await dom.render(<MoteCalendar scope={scope} reference={otherReference} active />)
    await button('Use selected discussion')
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!.value).toBe('')
    if (remount) { await dom.render(<div />); await dom.render(<MoteCalendar scope={scope} reference={otherReference} active />) }
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    const date = DateTime.fromMillis(now, { zone: 'UTC' }).plus({ days: 1 }).toISODate()!
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-mote-date="' + date + '"]')!.click())
    await button('New arrangement')
    expect(dom.container.querySelector('.schedule-create')?.textContent).toContain('To · ' + neighborAgent.control.agentSessionId)
    await edit('Arrangement timing', 'afterMs')
    await edit('Arranged message', 'Keep my explicit original discussion'); await button('Save arrangement')
    await vi.waitFor(() => expect(api.schedule.create).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.schedule.create).mock.calls[0]![0].target).toEqual({ hostId: neighborAgent.hostId, providerId: neighborAgent.providerId,
      workspacePath: neighborAgent.workspacePath, agentSessionId: neighborAgent.control.agentSessionId })
    await vi.waitFor(async () => expect(await fixture!.store.load()).toHaveLength(1))
    expect((await fixture!.store.load())[0]?.agentSessionId).toBe(neighborAgent.control.agentSessionId)
  })
})


it('the floating page bar opens its original calendar in place and restores the existing conversation', async () => {
  await owner([saved('floating-calendar')])
  const topics = [topic, ...moteTopics.slice(1)]
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => topics.find(item => item.id === id) ?? null)
  useAppStore.setState(state => ({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
    [scratchWorkspace.id]: { ...state.scratchTopicSnapshots[scratchWorkspace.id]!, topics } } }))
  const select = vi.fn(() => true)
  const inspect = vi.spyOn(api.moteDialogue, 'inspectRecovery')
  const recovery = vi.spyOn(api.moteDialogue, 'ensureRecovery')
  const draftKey = moteEntryDraftKey(scope)
  useLauncherState.getState().setDraft(draftKey, 'prompt', 'Original unsent message')
  const render = (visible: boolean) => dom.render(<MoteWorkface floating workspaceId={scratchWorkspace.id} topicId={topic.id}
    visible={visible} reference={reference} onReferenceSelect={select}><input aria-label="Retained conversation field" /></MoteWorkface>)
  await render(true)
  const field = dom.container.querySelector<HTMLInputElement>('input[aria-label="Retained conversation field"]')!
  field.value = 'Original member reading'
  const before = useAppStore.getState().workbenchSpaceSelection
  const nav = (value: string) => dom.click(`[role="tablist"][aria-label="Mote 内容"] [data-surface-mode="${value}"]`)
  expect(dom.container.querySelector('[aria-label="Mote calendar"]')).toBeNull()
  expect(api.schedule.list).not.toHaveBeenCalled()
  await nav('calendar')
  await button('Upcoming')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-schedule-id="floating-calendar"]')).not.toBeNull())
  expect(api.schedule.list).toHaveBeenCalledWith({ scope: { hostId: target.hostId, workspacePath: target.workspacePath } })
  expect(field.closest('.mote-composer-stage')?.hasAttribute('hidden')).toBe(true)
  expect(dom.container.querySelector('.mote-composer-surface')?.hasAttribute('hidden')).toBe(true)
  expect(dom.container.querySelector('.mote-main-slot')).toBeNull()
  await nav('discussion')
  expect(field.closest('.mote-composer-stage')?.hasAttribute('hidden')).toBe(false)
  expect(dom.container.querySelector('input[aria-label="Retained conversation field"]')).toBe(field)
  expect(field.value).toBe('Original member reading')
  expect(useLauncherState.getState().drafts[draftKey]?.prompt).toBe('Original unsent message')
  expect(select).not.toHaveBeenCalled()
  expect(inspect).not.toHaveBeenCalled()
  expect(recovery).not.toHaveBeenCalled()
  await nav('calendar')
  await button('Open original discussion')
  expect(select).toHaveBeenCalledExactlyOnceWith(reference, 'member')
  expect(dom.container.querySelector('[data-surface-mode="members"]')?.getAttribute('aria-selected')).toBe('true')
  await nav('calendar'); await nav('members')
  expect(select).toHaveBeenCalledTimes(1)
  expect(field.closest('.mote-workface__original')?.hasAttribute('hidden')).toBe(false)
  expect(field.closest('.mote-composer-stage')?.hasAttribute('hidden')).toBe(false)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before)
  expect(api.schedule.create).not.toHaveBeenCalled()
  await render(false)
})

it('combines calendar filters across views and restores original arrangements without changing them', async () => {
  const sourceId = 'mote-main:' + createHash('sha256').update(JSON.stringify({ hostId: scope.workspace.hostId, moteId: topic.id })).digest('hex')
  await owner([
    saved('care', { managedSource: { sourceId, revision: 'original' }, prompt: '巡检' }),
    saved('manual', { prompt: 'Mote heartbeat 巡检' }),
    saved('paused', { status: 'paused', prompt: 'Pause for approval 巡检' }),
    saved('ended', { status: 'stopped', prompt: 'Ended patrol' })
  ])
  await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
  const cell = (id: string) => dom.container.querySelector('[data-calendar-schedule-id="' + id + '"]')
  const ids = () => [...dom.container.querySelectorAll<HTMLElement>('[data-schedule-id]')].map(row => row.dataset.scheduleId).sort()
  await vi.waitFor(() => expect(cell('care')).toBeTruthy())
  await dom.click('[aria-label="Hide heartbeats"]')
  expect(cell('care')).toBeNull()
  expect(cell('manual')).toBeTruthy()
  await dom.click('[aria-label="Search and filter arrangements"]')
  await edit('Search arrangements', '巡检')
  await button('Upcoming')
  await vi.waitFor(() => expect(ids()).toEqual(['manual', 'paused']))
  await edit('Arrangement status', 'paused')
  expect(ids()).toEqual(['paused'])
  await edit('Search arrangements', 'nothing matches')
  expect(ids()).toEqual([])
  expect(dom.container.querySelector('.mote-calendar__filter-empty')?.textContent).toContain('No matching arrangements')
  await button('Clear filters')
  expect(ids()).toEqual(['care', 'manual', 'paused'])
  await edit('Arrangement status', 'stopped')
  expect(ids()).toEqual(['ended'])
  expect(api.schedule.create).not.toHaveBeenCalled()
  expect(api.schedule.pause).not.toHaveBeenCalled()
  expect(api.schedule.resume).not.toHaveBeenCalled()
  expect(api.schedule.cancel).not.toHaveBeenCalled()
})
