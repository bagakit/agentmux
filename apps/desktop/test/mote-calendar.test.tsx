import { fixtureEpoch as _batchFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContinuousProgressLoop } from '@agentmux/core'
import { DateTime } from 'luxon'
import * as scheduleCalendar from '@agentmux/core/schedule-calendar'
import { MoteCalendar, moteScheduleQueries } from '../src/renderer/src/components/MoteCalendar'
import { MoteDetailsPanel } from '../src/renderer/src/components/MoteDetailsPanel'
import { CalendarScheduleControl } from '../src/renderer/src/components/CalendarScheduleControl'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { composerDOM } from './helpers/composer-dom-fixture'
import { createScheduleRpcFixture } from './helpers/schedule-rpc-fixture'
import { seedMoteWorkface, defaultAgent, neighborAgent, defaultTab, neighborTab, scratchWorkspace, moteTopics } from './fixtures/mote-workface'
import { scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import type { MoteWorkfaceScope } from '../src/renderer/src/lib/mote-workface'

const dom = composerDOM()
const now = _batchFixtureEpoch(20748, 0, 36000000)
const target = { hostId: defaultAgent.hostId, providerId: defaultAgent.providerId, workspacePath: defaultAgent.workspacePath, agentSessionId: defaultAgent.control.agentSessionId }
const topic = { ...moteTopics[0]!, physicalDirectoryPath: defaultAgent.workspacePath, confirmedDirectoryPaths: [defaultAgent.workspacePath] }
const scope: MoteWorkfaceScope = { workspace: scratchWorkspace, topic, rootPath: scratchTopicDirectoryName(topic.id) }
const reference = { displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: 'default-region' }
const saved = (id: string, patch: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop => ({ ...target, loopId: id, afterMs: 90000, intervalMs: 1000,
  nextCheckAt: now + 90000, prompt: 'Original countdown ' + id, status: 'active', revision: 1, creationOperationId: 'created-' + id, futureIntentId: 'future-' + id, ...patch })
let fixture: Awaited<ReturnType<typeof createScheduleRpcFixture>> | undefined
beforeEach(() => {
  seedMoteWorkface(); useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  useAppStore.setState({ config: { ...useAppStore.getState().config!, automation: { calendarTimezone: 'UTC' } } })
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(async () => { await fixture?.dispose(); fixture = undefined })
async function owner(records: ContinuousProgressLoop[]) {
  fixture = await createScheduleRpcFixture({ records, now: () => now, futureInputs: { authorizeFutureIntent: async () => {}, saveFutureIntent: async () => {} } })
  const rpc = fixture.rpc, manager = fixture.manager
  vi.spyOn(api.schedule, 'list').mockImplementation(params => rpc.call('schedule.list', params))
  vi.spyOn(api.schedule, 'inspect').mockImplementation(params => rpc.call('schedule.inspect', params))
  vi.spyOn(api.schedule, 'create').mockImplementation(params => rpc.call('schedule.create', params))
  vi.spyOn(api.schedule, 'pause').mockImplementation(params => rpc.call('schedule.pause', params))
  vi.spyOn(api.schedule, 'resume').mockImplementation(params => rpc.call('schedule.resume', params))
  vi.spyOn(api.schedule, 'cancel').mockImplementation(params => rpc.call('schedule.cancel', params))
  vi.spyOn(api.schedule, 'onChanged').mockImplementation(listener => manager.subscribe(listener))
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
async function openForm() { await act(async () => { const element = dom.container.querySelector<HTMLDetailsElement>('.schedule-create')!; element.open = true; element.dispatchEvent(new Event('toggle')) }) }

describe('Mote calendar original schedule consumer', () => {
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
    await vi.waitFor(() => expect(dom.container.querySelectorAll('[data-schedule-id]')).toHaveLength(2))
    await button('Month')
    const day = dom.container.querySelector<HTMLButtonElement>(("[data-mote-date=\"" + (new Date(_batchFixtureEpoch(20748, 0, 0)).toISOString().slice(0, 10)) + "\"]"))!
    await act(async () => day.click())
    expect(dom.container.querySelector('[aria-label="Selected day arrangements"] [data-schedule-id="countdown"]')).not.toBeNull()
    await act(async () => day.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(dom.container.querySelector(("[data-mote-date=\"" + (new Date(_batchFixtureEpoch(20749, 0, 0)).toISOString().slice(0, 10)) + "\"]"))?.getAttribute('aria-pressed')).toBe('true')
    expect(dom.container.querySelector('[data-occurrence-kind="projected"]')).not.toBeNull()
    expect(dom.container.textContent).toContain('Planned')
    await act(async () => dom.container.querySelector<HTMLButtonElement>(("[data-mote-date=\"" + (new Date(_batchFixtureEpoch(20747, 0, 0)).toISOString().slice(0, 10)) + "\"]"))!.click())
    expect(dom.container.querySelector('[data-occurrence-kind="last-accepted"]')).not.toBeNull()
    expect(dom.container.textContent).toContain('Input accepted')
  })
  it('opens the exact original Main Mote discussion through existing spatial navigation without changing the execution lane', async () => {
    await owner([saved('main-discussion')])
    const initial = useAppStore.getState(), execution = initial.agentFocus.execution, sessions = initial.sessions, drafts = initial.agentComposerDrafts
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
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
    await vi.waitFor(() => expect(dom.container.querySelector('[data-schedule-id="countdown"]')).not.toBeNull())
    await openForm(); await edit('Arranged message', 'Keep my arrangement draft')
    await dom.render(<MoteCalendar scope={{ ...scope, issue: 'Directory unavailable' }} reference={reference} active />)
    expect(api.schedule.list).toHaveBeenCalledTimes(1)
    expect(dom.container.querySelector('[data-schedule-id="countdown"]')).not.toBeNull()
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
    const tree = vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'deleted' })
    await dom.render(<MoteDetailsPanel scope={scope} reference={reference} onOpenPath={async () => {}} />)
    await button('Calendar'); await vi.waitFor(() => expect(dom.container.querySelector('[data-schedule-id="countdown"]')).not.toBeNull())
    const before = [tree.mock.calls.length, read.mock.calls.length]
    await openForm(); await edit('Arranged message', 'My calendar draft')
    await act(async () => useAppStore.setState({ workspaceFileRevisions: { [scratchWorkspace.id]: 1234 } }))
    expect([tree.mock.calls.length, read.mock.calls.length]).toEqual(before)
    await button('Profile'); await button('Calendar')
    expect(dom.container.querySelector<HTMLTextAreaElement>('.mote-calendar textarea')!.value).toBe('My calendar draft')
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })
  it('a newly visible list replaces same-version cached delivery facts from before it was hidden', async () => {
    await owner([saved('countdown', { lastTickAt: now, lastOutcome: 'unknown', status: 'paused' })])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Delivery unconfirmed'))
    await dom.render(<MoteCalendar scope={scope} reference={reference} active={false} />)
    // A later authoritative snapshot can finish delivery without a control-revision bump.
    vi.mocked(api.schedule.list).mockResolvedValue({ schedules: [saved('countdown', { status: 'stopped', lastTickAt: now, lastOutcome: 'sent' })], executionScope: 'connected-host' })
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Show ended (1)'))
    expect(dom.container.querySelector('[data-schedule-id="countdown"]')).toBeNull()
  })
  it('Ideas keeps an edited frozen arrangement and its unknown operation reachable across Calendar and remount', async () => {
    await owner([])
    vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
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
    await vi.waitFor(() => expect(dom.container.querySelectorAll('.mote-calendar__point')).toHaveLength(2))
    expect(dom.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Month')
    expect(dom.container.querySelectorAll('.mote-calendar__cell')).toHaveLength(35)
    await button('+3 more')
    expect(dom.container.querySelectorAll('[aria-label="Selected day arrangements"] [data-schedule-id]')).toHaveLength(5)
    const point = dom.container.querySelector<HTMLButtonElement>('[data-calendar-schedule-id="preview-1"]')!
    expect(point.textContent).toContain((new Date(_batchFixtureEpoch(0, 36120)).toISOString().slice(11, 16)))
    await act(async () => point.click())
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLDetailsElement>('[data-schedule-id="preview-1"] details')?.open).toBe(true))
    expect(dom.container.querySelector('[data-schedule-id="preview-1"]')?.textContent).toContain('Exact request context')
    expect(api.schedule.create).not.toHaveBeenCalled()
  })
  it('Week projects only seven civil days and a time shortcut creates through the original public owner', async () => {
    const today = DateTime.fromMillis(now, { zone: 'UTC' }), tomorrow = today.plus({ days: 1 })
    await owner([saved('early', { nextCheckAt: today.set({ hour: 8, minute: 15 }).toMillis() }), saved('later', { nextCheckAt: today.set({ hour: 17, minute: 45 }).toMillis() }), saved('outside', { nextCheckAt: today.plus({ weeks: 1 }).toMillis() })])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await button('Week')
    await vi.waitFor(() => expect(dom.container.querySelectorAll('.mote-calendar__point--week')).toHaveLength(2))
    expect(dom.container.querySelectorAll('[data-mote-date]')).toHaveLength(7)
    expect([...dom.container.querySelectorAll('.mote-calendar__point--week time')].map(item => item.textContent)).toEqual([(new Date(_batchFixtureEpoch(0, 29700)).toISOString().slice(11, 16)), (new Date(_batchFixtureEpoch(0, 63900)).toISOString().slice(11, 16))])
    expect(dom.container.querySelector('.mote-calendar__week-timeline [data-calendar-schedule-id="outside"]')).toBeNull()
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
    expect(intervals.mock.calls.filter(call => call[1] === 1000)).toHaveLength(0)
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await vi.waitFor(() => expect(dom.container.querySelector('[data-schedule-id="countdown"]')).not.toBeNull())
    const projected = projection.mock.calls.length, subscribed = vi.mocked(api.schedule.onChanged).mock.calls.length
    const presentationClocks = intervals.mock.calls.flatMap((call, index) => call[1] === 1000 ? [intervals.mock.results[index]!.value] : [])
    expect(projected).toBeGreaterThan(0); expect(presentationClocks).toHaveLength(1)
    await act(async () => useAppStore.setState({ sessions: [...useAppStore.getState().sessions, { ...neighborAgent, id: 'unrelated-presentation' }] }))
    expect(projection).toHaveBeenCalledTimes(projected)
    await dom.render(<MoteCalendar scope={scope} reference={reference} active={false} />)
    expect(projection).toHaveBeenCalledTimes(projected)
    expect(api.schedule.onChanged).toHaveBeenCalledTimes(subscribed)
    expect(clearing).toHaveBeenCalledWith(presentationClocks[0])
  })
  it('Week restores its user scroll across view changes and hidden re-entry', async () => {
    await owner([saved('countdown')])
    await dom.render(<MoteCalendar scope={scope} reference={reference} active />)
    await button('Week')
    await vi.waitFor(() => expect(dom.container.querySelector('.mote-calendar__point--week')).not.toBeNull())
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
    expect(dom.container.querySelector('.schedule-create')?.textContent).toContain('Original discussion · ' + neighborAgent.control.agentSessionId)
    await edit('Arrangement timing', 'afterMs')
    await edit('Arranged message', 'Keep my explicit original discussion'); await button('Save arrangement')
    await vi.waitFor(() => expect(api.schedule.create).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.schedule.create).mock.calls[0]![0].target).toEqual({ hostId: neighborAgent.hostId, providerId: neighborAgent.providerId,
      workspacePath: neighborAgent.workspacePath, agentSessionId: neighborAgent.control.agentSessionId })
    await vi.waitFor(async () => expect(await fixture!.store.load()).toHaveLength(1))
    expect((await fixture!.store.load())[0]?.agentSessionId).toBe(neighborAgent.control.agentSessionId)
  })
})
