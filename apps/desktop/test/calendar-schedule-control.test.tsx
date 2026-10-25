import { fixtureEpoch as _batchFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixtureCivil as _hygiene_fixtureCivil, fixtureClock as _hygiene_fixtureClock, fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContinuousProgressLoop } from '@agentmux/core'
import { CalendarScheduleControl } from '../src/renderer/src/components/CalendarScheduleControl'
import { ContinuousProgressControl } from '../src/renderer/src/components/ContinuousProgressControl'
import { api } from '../src/renderer/src/lib/api'
import { DEFAULT_AGENT_SCHEDULE_CHECK_IN } from '@agentmux/core/schedule'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import * as automationPreferences from '../src/shared/automation-preferences'

const dom = composerDOM()
const target = { hostId: 'local', agentSessionId: 'native-agent', providerId: 'codex', workspacePath: _hygiene_fixturePath("repo") }
const calendar = { kind: 'daily' as const, timezone: 'America/New_York', time: _hygiene_fixtureClock(9, 0), policies: { gap: 'skip' as const, fold: 'earlier' as const, monthEnd: 'clamp' as const, overdue: 'latest' as const } }
const saved = (overrides: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop => ({ ...target, loopId: 'saved-calendar', intervalMs: 60000, calendar, prompt: 'Ask one original question.\nKeep this entire saved message.', status: 'active', nextCheckAt: Date.parse(_hygiene_fixtureIso(26316000000, "minute")), revision: 1, creationOperationId: 'created-calendar', futureIntentId: 'intent-1', ...overrides })
const receipt = (schedule: ContinuousProgressLoop) => ({ schedule, diskDurability: 'confirmed' as const, executionScope: 'connected-host' as const })
beforeEach(() => {
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
})
async function mount(schedule?: ContinuousProgressLoop) {
  if (schedule) vi.mocked(api.schedule.list).mockResolvedValue({ schedules: [schedule], executionScope: 'connected-host' })
  await dom.render(<CalendarScheduleControl target={target} />)
  await vi.waitFor(() => schedule ? expect(dom.container.querySelector('[data-schedule-id]')).not.toBeNull() : expect(dom.container.querySelector('[data-schedule-state]')!.getAttribute('data-schedule-state')).not.toBe('unconfirmed'))
}
async function edit(selector: string, text: string) {
  const input = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
async function openForm() {
  await act(async () => { const details = dom.container.querySelector<HTMLDetailsElement>('.calendar-schedules > details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
}
async function clickText(text: string) {
  await act(async () => { [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click() })
}
async function refreshVisible() {
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
}

describe('original calendar control', () => {
  it('exposes the complete single-line prompt in compact arrangement details', async () => {
    const prompt = 'Keep this original full message readable. '.repeat(18) + 'The final instruction remains available.'
    vi.mocked(api.schedule.list).mockResolvedValue({ schedules: [saved({ prompt })], executionScope: 'connected-host' })
    await dom.render(<CalendarScheduleControl target={target} unified />)
    await vi.waitFor(() => expect(dom.container.querySelector('[data-schedule-id="saved-calendar"]')).not.toBeNull())
    const row = dom.container.querySelector<HTMLElement>('[data-schedule-id="saved-calendar"]')!
    const details = row.querySelector<HTMLDetailsElement>('.schedule-arrangement__details')!
    await act(async () => { details.querySelector<HTMLElement>('summary')!.click() })
    expect(details.open).toBe(true)
    expect(details.querySelector('.calendar-schedules__context')!.textContent).toBe(prompt)
    expect(row.querySelector('.schedule-arrangement__message')!.textContent).toBe(prompt)
    expect(row.closest('[hidden]')).toBeNull()
  })

  it('keeps one schedule draft while the isolated editor exposes repeat, calendar and countdown timing', async () => {
    const create = vi.spyOn(api.schedule, 'create')
    await dom.render(<CalendarScheduleControl target={target} unified />)
    const overview = dom.container.querySelector<HTMLElement>('[data-automation-view="overview"]')!
    const editor = dom.container.querySelector<HTMLElement>('[data-automation-view="editor"]')!
    const entry = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New automation')!
    expect(overview.hidden).toBe(false); expect(editor.hidden).toBe(true)
    await act(async () => entry.click())
    const message = editor.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!
    expect(message.closest('[hidden]')).toBeNull()
    expect(overview.hidden).toBe(true); expect(editor.hidden).toBe(false)
    await edit('[aria-label="Arranged message"]', 'Keep this same timing draft')
    const choices = [...editor.querySelectorAll<HTMLInputElement>('[aria-label="Arrangement timing"] input[type="radio"]')]
    expect(choices.map(choice => choice.value)).toEqual(['everyMs', 'calendar', 'afterMs'])
    expect(choices.filter(choice => choice.checked).map(choice => choice.value)).toEqual(['everyMs'])
    await dom.click('[aria-label="Arrangement timing"] input[value="calendar"]')
    expect(editor.querySelector('[aria-label="Arrangement local time"]')!.closest('[hidden]')).toBeNull()
    expect(editor.querySelector('[aria-label="Repeat interval in minutes"]')).toBeNull()
    await dom.click('[aria-label="Arrangement timing"] input[value="afterMs"]')
    expect(editor.querySelector('[aria-label="Countdown duration"]')!.closest('[hidden]')).toBeNull()
    await dom.click('[aria-label="Arrangement timing"] input[value="everyMs"]')
    expect(editor.querySelector('[aria-label="Repeat interval in minutes"]')!.closest('[hidden]')).toBeNull()
    expect(editor.querySelector('[aria-label="Arranged message"]')).toBe(message)
    expect(message.value).toBe('Keep this same timing draft')
    await dom.click('[aria-label="Back to automations"]')
    expect(overview.hidden).toBe(false); expect(editor.hidden).toBe(true)
    await vi.waitFor(() => expect(document.activeElement).toBe(entry))
    await act(async () => entry.click())
    expect(editor.querySelector('[aria-label="Arranged message"]')).toBe(message)
    expect(message.value).toBe('Keep this same timing draft')
    expect(create).not.toHaveBeenCalled(); expect(api.schedule.list).toHaveBeenCalledTimes(1)
    expect(dom.draft()).toBe('Keep my draft')
  })

  it.each([1, 32])('keeps %i hidden forms without starting schedule readers or repeated timezone work', async count => {
    const timezone = vi.spyOn(automationPreferences, 'automationCalendarTimezone')
    const targets = Array.from({ length: count }, (_, index) => ({ ...target, agentSessionId: `retained-arrangement-${index}` }))
    const status = vi.fn()
    const render = () => dom.render(<>{targets.map(exact => <CalendarScheduleControl key={exact.agentSessionId}
      target={exact} presented={false} onStatusChange={status} />)}</>)
    await render()
    expect(dom.container.querySelectorAll('[data-schedule-state="unconfirmed"]')).toHaveLength(count)
    expect(api.schedule.list).not.toHaveBeenCalled()
    expect(dom.container.querySelectorAll('textarea')).toHaveLength(count)
    const input = dom.container.querySelector('textarea')
    timezone.mockClear()
    for (let index = 0; index < 10; index++) await render()
    expect(timezone).not.toHaveBeenCalled()
    expect(status).toHaveBeenLastCalledWith('unconfirmed')
    expect(dom.container.querySelector('textarea')).toBe(input)
    expect(timezone).not.toHaveBeenCalled()
    expect(dom.draft()).toBe('Keep my draft')
  })
  it('resolves current display timezone once for actual saved rows and keeps the original form on reveal', async () => {
    vi.mocked(api.schedule.list).mockResolvedValue({ schedules: [saved(), saved({ loopId: 'second-arrangement' })], executionScope: 'connected-host' })
    const timezone = vi.spyOn(automationPreferences, 'automationCalendarTimezone'), status = vi.fn()
    await dom.render(<CalendarScheduleControl target={target} presented={false} onStatusChange={status} />)
    expect(api.schedule.list).not.toHaveBeenCalled()
    const input = dom.container.querySelector('textarea')
    await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, automation: { calendarTimezone: 'Asia/Tokyo' } } }))
    timezone.mockClear()
    await dom.render(<CalendarScheduleControl target={target} onStatusChange={status} />)
    expect(dom.container.querySelectorAll('[data-schedule-id]')).toHaveLength(2)
    expect(timezone.mock.calls.length).toBeGreaterThan(0)
    expect(timezone.mock.calls.every(([value]) => value.calendarTimezone === 'Asia/Tokyo')).toBe(true)
    // The original presentation clock refreshes on reveal; measure one subsequent render.
    timezone.mockClear()
    await dom.render(<CalendarScheduleControl target={target} onStatusChange={status} />)
    expect(timezone).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ calendarTimezone: 'Asia/Tokyo' }))
    const expectedDate = new Intl.DateTimeFormat(undefined, { timeZone: 'Asia/Tokyo', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(saved().nextCheckAt)
    expect([...dom.container.querySelectorAll('.schedule-arrangement__when time')].map(time => time.textContent)).toEqual([expectedDate, expectedDate])
    expect(dom.container.querySelector('textarea')).toBe(input)
    timezone.mockClear()
    await dom.render(<CalendarScheduleControl target={target} presented={false} onStatusChange={status} />)
    expect(timezone).not.toHaveBeenCalled()
    expect(dom.container.querySelectorAll('[data-schedule-id]')).toHaveLength(0)
  })
  it.each([false, true])('replaces loading with a retryable read failure and preserves input and original arrangements (retained: %s)', async retained => {
    let reject!: (error: Error) => void
    if (retained) await mount(saved())
    vi.mocked(api.schedule.list).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const create = vi.spyOn(api.schedule, 'create')
    await dom.render(<CalendarScheduleControl target={target} />)
    if (retained) await refreshVisible()
    else expect(dom.container.textContent).toContain('Reading arrangements…')
    await openForm(); await edit('textarea', 'Keep this unsaved arrangement')
    const input = dom.container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => reject(new Error('Calendar source unavailable')))
    expect(dom.container.querySelector('[role="status"]')!.textContent).toContain('Calendar source unavailable')
    expect([...dom.container.querySelectorAll('button')].some(button => button.textContent === 'Retry arrangements')).toBe(true)
    expect(dom.container.textContent).not.toContain('Reading arrangements…')
    expect(dom.container.textContent).not.toContain('No saved arrangements for this Agent.')
    expect(dom.container.querySelectorAll('[data-schedule-id]')).toHaveLength(retained ? 1 : 0)
    if (retained) expect(dom.container.querySelector('[data-schedule-id] .calendar-schedules__context')!.textContent).toBe(saved().prompt)
    expect(input.disabled).toBe(false); expect(input.value).toBe('Keep this unsaved arrangement')
    expect(dom.draft()).toBe('Keep my draft')
    vi.mocked(api.schedule.list).mockResolvedValue({ schedules: [saved({ revision: 2, status: 'paused' })], executionScope: 'connected-host' })
    await clickText('Retry arrangements')
    expect(api.schedule.list).toHaveBeenCalledTimes(retained ? 3 : 2)
    expect(dom.container.querySelector('[data-schedule-state]')!.getAttribute('data-schedule-state')).toBe('paused')
    expect(dom.container.querySelector('.calendar-schedules__heading')!.textContent).toContain('1 saved')
    expect(dom.container.textContent).not.toContain('Calendar source unavailable')
    expect(dom.container.textContent).not.toContain('Reading arrangements…')
    expect(dom.container.querySelector('textarea')).toBe(input)
    expect(input.disabled).toBe(false); expect(input.value).toBe('Keep this unsaved arrangement')
    expect(dom.container.querySelector('[data-schedule-id] .calendar-schedules__context')!.textContent).toBe(saved().prompt)
    expect(create).not.toHaveBeenCalled(); expect(dom.draft()).toBe('Keep my draft')
  })
  it('folding preserves a draft while a confirmed creation gives the next form current defaults', async () => {
    useAppStore.setState({ config: { ...useAppStore.getState().config!, automation: { calendarTimezone: 'Europe/Berlin', checkInDailyBudget: 2 } } })
    await mount(); await openForm(); await edit('textarea', 'Keep this draft'); await edit('[aria-label="Arrangement time zone"]', 'America/New_York')
    await act(async () => { const details = dom.container.querySelector<HTMLDetailsElement>('.calendar-schedules > details')!; details.open = false; details.dispatchEvent(new Event('toggle')) })
    await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, automation: { calendarTimezone: 'Asia/Tokyo', checkInDailyBudget: 3 } } }))
    await openForm()
    expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this draft')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement time zone"]')!.value).toBe('America/New_York')
    vi.spyOn(api.schedule, 'create').mockImplementation(async params => receipt(saved({ calendar: params.calendar, prompt: params.prompt, creationOperationId: params.operationId })))
    await clickText('Save arrangement'); expect(dom.container.querySelector<HTMLDetailsElement>('.schedule-create')!.open).toBe(false)
    await openForm()
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement time zone"]')!.value).toBe('Asia/Tokyo')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Enable quiet follow-up"]')!.checked).toBe(false)
    await dom.click('[aria-label="Enable quiet follow-up"]'); expect(dom.container.textContent).toContain('3 attempts per local day')
    expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('')
  })
  it('freezes saved timezone and quiet defaults for a new original creation while preserving explicit message and pending operation', async () => {
    useAppStore.setState({ config: { ...useAppStore.getState().config!, automation: { calendarTimezone: 'Europe/Berlin', progressPrompt: 'Must not replace a sourced message',
      checkInQuietStart: new Date(_batchFixtureEpoch(0, 23 * 60 * 60 + 15 * 60)).toISOString().slice(11, 16), checkInQuietEnd: new Date(_batchFixtureEpoch(0, 7 * 60 * 60 + 45 * 60)).toISOString().slice(11, 16), checkInSilenceMs: 7200000, checkInMinIntervalMs: 10800000, checkInDailyBudget: 2 } } })
    await dom.render(<CalendarScheduleControl target={target} initialMessage="Original sourced topic" initialMessageContext="Original frozen context" />)
    await vi.waitFor(() => expect(dom.container.querySelector('form')).not.toBeNull())
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement time zone"]')!.value).toBe('Europe/Berlin')
    expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Original sourced topic')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Enable quiet follow-up"]')!.checked).toBe(false)
    const create = vi.spyOn(api.schedule, 'create').mockRejectedValue(new Error('Original result is unknown'))
    await dom.click('[aria-label="Enable quiet follow-up"]')
    await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, automation: { calendarTimezone: 'Asia/Tokyo', checkInDailyBudget: 3 } } }))
    await dom.render(<CalendarScheduleControl target={{ ...target }} initialMessage="Later seed" initialMessageContext="Later context" />)
    await clickText('Save arrangement')
    const original = create.mock.calls[0]![0]
    expect(original).toMatchObject({ target, calendar: { timezone: 'Europe/Berlin' }, prompt: 'Original sourced topic\n\nOriginal frozen context',
      checkIn: { silenceMs: 7200000, minIntervalMs: 10800000, dailyBudget: 2, quiet: { start: new Date(_batchFixtureEpoch(0, 23 * 60 * 60 + 15 * 60)).toISOString().slice(11, 16), end: new Date(_batchFixtureEpoch(0, 7 * 60 * 60 + 45 * 60)).toISOString().slice(11, 16) } } })
    await clickText('Retry original operation')
    expect(create.mock.calls[1]![0]).toEqual(original)
    expect(dom.draft()).toBe('Keep my draft')
  })
  it('new exact targets initialize current defaults while same-target edited forms keep their own values', async () => {
    useAppStore.setState({ config: { ...useAppStore.getState().config!, automation: { calendarTimezone: 'Europe/Berlin' } } })
    await mount(); await openForm(); await edit('[aria-label="Arrangement time zone"]', 'America/New_York'); await edit('textarea', 'An edited original draft')
    await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, automation: { calendarTimezone: 'Asia/Tokyo' } } }))
    await dom.render(<CalendarScheduleControl target={{ ...target }} />)
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement time zone"]')!.value).toBe('America/New_York')
    expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('An edited original draft')
    await dom.render(<CalendarScheduleControl target={{ ...target, agentSessionId: 'another-exact-agent' }} />); await openForm()
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement time zone"]')!.value).toBe('Asia/Tokyo')
    expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('')
  })
  it('starts a one-time date on the local civil day across a UTC day boundary', async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai'); vi.useFakeTimers(); vi.setSystemTime(new Date(_hygiene_fixtureIso(24165000000, "minute")))
    try {
      await mount(); await openForm(); await edit('[aria-label="Arrangement repeat"]', 'once')
      expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Arrangement date"]')!.value).toBe(_hygiene_fixtureCivil(10, 8))
    } finally { vi.useRealTimers(); vi.unstubAllEnvs() }
  })
  it('consumes the exact control identity for both calendar and interval rather than its display id', async () => {
    const session = { ...composerSession('display-region'), control: { ...composerSession().control, agentSessionId: target.agentSessionId } }
    const interval = vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
    await dom.render(<ContinuousProgressControl session={session} />)
    expect(api.schedule.list).toHaveBeenCalledExactlyOnceWith({ target })
    expect(interval).toHaveBeenCalledExactlyOnceWith(target)
  })
  it('shows full saved message, civil due and actual status and uses the original three mutations', async () => {
    await mount(saved())
    expect(dom.container.querySelector('.calendar-schedules__context')!.textContent).toBe(saved().prompt)
    expect(dom.container.textContent).toContain('America/New_York')
    expect(dom.container.querySelector('time')!.dateTime).toBe(new Date(saved().nextCheckAt).toISOString())
    expect(dom.container.textContent).not.toContain('Check now')
    const pause = vi.spyOn(api.schedule, 'pause').mockImplementation(async params => receipt(saved({ revision: 2, status: 'paused', lastMutation: { operationId: params.operationId, expectedRevision: params.expectedRevision, action: 'pause' } })))
    const resume = vi.spyOn(api.schedule, 'resume').mockImplementation(async params => receipt(saved({ revision: 3, lastMutation: { operationId: params.operationId, expectedRevision: params.expectedRevision, action: 'resume' } })))
    const cancel = vi.spyOn(api.schedule, 'cancel').mockImplementation(async params => receipt(saved({ revision: 4, status: 'stopped', lastMutation: { operationId: params.operationId, expectedRevision: params.expectedRevision, action: 'cancel' } })))
    await clickText('Pause arrangement'); await clickText('Resume arrangement'); await clickText('Cancel arrangement')
    expect([pause, resume, cancel].map(call => call.mock.calls[0]![0])).toEqual([1, 2, 3].map(expectedRevision => ({ scheduleId: 'saved-calendar', expectedRevision, operationId: expect.any(String) })))
    expect(dom.container.textContent).toContain('Ended')
    expect([...dom.container.querySelectorAll('button')].some(button => button.textContent === 'Resume arrangement')).toBe(false)
  })
  it.each(['once', 'daily', 'weekly', 'monthly', 'yearly'] as const)('saves %s with explicit civil policies through the real typed create API', async kind => {
    await mount(); await openForm()
    const create = vi.spyOn(api.schedule, 'create').mockImplementation(async params => receipt(saved({ ...params.target, calendar: params.calendar, prompt: params.prompt, creationOperationId: params.operationId })))
    await edit('[aria-label="Arrangement repeat"]', kind)
    await edit('[aria-label="Arrangement time zone"]', 'Europe/Berlin')
    await edit('[aria-label="Arrangement local time"]', _hygiene_fixtureClock(8, 30))
    await edit('textarea', 'Keep my exact original instruction.\nSecond line.')
    if (kind === 'once') await edit('[aria-label="Arrangement date"]', _hygiene_fixtureCivil(2, 14, 1))
    if (kind === 'weekly') await edit('[aria-label="Arrangement weekday"]', '5')
    if (kind === 'monthly' || kind === 'yearly') await edit('[aria-label="Arrangement day"]', '31')
    if (kind === 'yearly') await edit('[aria-label="Arrangement month"]', '2')
    await clickText('Save arrangement')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toEqual({ target, prompt: 'Keep my exact original instruction.\nSecond line.', operationId: expect.any(String), calendar: { kind, timezone: 'Europe/Berlin', time: _hygiene_fixtureClock(8, 30), policies: calendar.policies, ...(kind === 'once' ? { date: _hygiene_fixtureCivil(2, 14, 1) } : {}), ...(kind === 'weekly' ? { weekday: 5 } : {}), ...(kind === 'monthly' || kind === 'yearly' ? { day: 31 } : {}), ...(kind === 'yearly' ? { month: 2 } : {}) } })
    expect(dom.container.querySelector<HTMLDetailsElement>('.schedule-create')!.open).toBe(false)
  })
  it('retains an uncertain creation and retries the same original operation without a second intent', async () => {
    await mount(); await openForm(); await edit('textarea', 'Original unsent instruction')
    const create = vi.spyOn(api.schedule, 'create').mockRejectedValueOnce(new Error('Receipt unavailable')).mockImplementation(async params => receipt(saved({ calendar: params.calendar, prompt: params.prompt, creationOperationId: params.operationId })))
    await clickText('Save arrangement')
    const original = create.mock.calls[0]![0]
    expect(dom.container.querySelector('textarea')!.value).toBe('Original unsent instruction')
    expect(dom.container.querySelector('textarea')!.disabled).toBe(true)
    expect(dom.container.textContent).toContain('Manual messages remain available.')
    await clickText('Retry original operation')
    expect(create.mock.calls.map(call => call[0])).toEqual([original, original])
    expect(dom.draft()).toBe('Keep my draft')
  })
  it('keeps the same creation when the connected Host has not found its operation', async () => {
    await mount(); await openForm(); await edit('textarea', 'Original unsent request')
    const create = vi.spyOn(api.schedule, 'create').mockRejectedValueOnce(new Error('Receipt unavailable')).mockImplementation(async params => receipt(saved({ calendar: params.calendar, prompt: params.prompt, creationOperationId: params.operationId })))
    vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: null, executionScope: 'connected-host' })
    await clickText('Save arrangement'); await clickText('Check original operation')
    expect(dom.container.querySelector('textarea')!.value).toBe('Original unsent request')
    expect(dom.container.textContent).toContain('retry uses the same request')
    expect([...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Retry original operation')).toBeDefined()
    await clickText('Retry original operation')
    expect(create.mock.calls.map(call => call[0])).toEqual([create.mock.calls[0]![0], create.mock.calls[0]![0]])
    expect(dom.draft()).toBe('Keep my draft')
  })
  it('does not confirm a creation with the same operation but a different saved message', async () => {
    await mount(); await openForm(); await edit('textarea', 'My original idea direction')
    const create = vi.spyOn(api.schedule, 'create').mockRejectedValue(new Error('Receipt unavailable'))
    vi.spyOn(api.schedule, 'inspect').mockImplementation(async params => {
      const operationId = create.mock.calls[0]![0].operationId
      expect(params.operationId).toBe(operationId)
      return receipt(saved({ prompt: 'Another saved instruction', creationOperationId: operationId }))
    })
    await clickText('Save arrangement'); await clickText('Check original operation')
    expect(dom.container.querySelector('textarea')).not.toBeNull()
    expect(dom.container.querySelector('textarea')!.value).toBe('My original idea direction')
    expect(dom.container.textContent).toContain('original operation is still unconfirmed')
    await clickText('Retry original operation')
    expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0])
  })
  it('quiet follow-up controls require explicit opt-in and preserve the editable original topic', async () => {
    await mount(); await openForm()
    const create = vi.spyOn(api.schedule, 'create').mockImplementation(async params => receipt(saved({ ...params.target, calendar: params.calendar, prompt: params.prompt, ...(params.checkIn ? { checkIn: params.checkIn } : {}), creationOperationId: params.operationId })))
    const checkbox = dom.container.querySelector<HTMLInputElement>('[aria-label="Enable quiet follow-up"]')!
    expect(checkbox.checked).toBe(false)
    expect(api.schedule.create).not.toHaveBeenCalled()
    await dom.click('[aria-label="Enable quiet follow-up"]'); await edit('textarea', 'Ask about my confirmed design decision')
    expect(dom.container.textContent).toContain('at least 18h silence')
    await clickText('Save arrangement')
    expect(create.mock.calls[0]![0]).toMatchObject({ prompt: 'Ask about my confirmed design decision', checkIn: DEFAULT_AGENT_SCHEDULE_CHECK_IN })
    expect(dom.draft()).toBe('Keep my draft')
  })
  it('quiet follow-up controls distinguish accepted, unconfirmed and skipped attempts using the saved policy', async () => {
    const checkInState = { budgetDate: _hygiene_fixtureCivil(10, 7), budgetUsed: 1, unanswered: { humanId: 'real-human', humanCreatedAt: _batchFixtureEpoch(0, 0, 1), claimAt: _batchFixtureEpoch(0, 0, 2) } }
    await mount(saved({ checkIn: DEFAULT_AGENT_SCHEDULE_CHECK_IN, checkInState, lastOutcome: 'unknown', status: 'paused' }))
    expect(dom.container.textContent).toContain('Previous follow-up is unconfirmed')
    expect(dom.container.textContent).not.toContain('Waiting for your next confirmed reply')
    await dom.render(<CalendarScheduleControl target={{ ...target }} />)
    expect(api.schedule.list).toHaveBeenCalledTimes(1)
    vi.mocked(api.schedule.list).mockResolvedValue({ schedules: [saved({ checkIn: DEFAULT_AGENT_SCHEDULE_CHECK_IN, checkInState, lastOutcome: 'sent', revision: 2 })], executionScope: 'connected-host' })
    await refreshVisible()
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Waiting for your next confirmed reply'))
    vi.mocked(api.schedule.list).mockResolvedValue({ schedules: [saved({ checkIn: DEFAULT_AGENT_SCHEDULE_CHECK_IN, checkInState: { budgetDate: _hygiene_fixtureCivil(10, 7), budgetUsed: 1 }, lastOutcome: 'skipped', lastDecision: 'No new question was delivered', revision: 3 })], executionScope: 'connected-host' })
    await refreshVisible()
    await vi.waitFor(() => expect(dom.container.textContent).toContain('No new question was delivered'))
    expect(dom.container.textContent).not.toContain('Waiting for your next confirmed reply')
  })
  it('quiet follow-up controls preserve a known paused arrangement and the new topic until its original cancellation', async () => {
    await mount(saved({ checkIn: DEFAULT_AGENT_SCHEDULE_CHECK_IN, status: 'paused' })); await openForm()
    const create = vi.spyOn(api.schedule, 'create').mockImplementation(async params => receipt(saved({ loopId: 'next-follow-up', ...params.target, calendar: params.calendar, prompt: params.prompt, ...(params.checkIn ? { checkIn: params.checkIn } : {}), creationOperationId: params.operationId })))
    const cancel = vi.spyOn(api.schedule, 'cancel').mockImplementation(async params => receipt(saved({ status: 'stopped', checkIn: DEFAULT_AGENT_SCHEDULE_CHECK_IN, revision: 2, lastMutation: { operationId: params.operationId, expectedRevision: params.expectedRevision, action: 'cancel' } })))
    await dom.click('[aria-label="Enable quiet follow-up"]'); await edit('textarea', 'Keep this next topic until I decide')
    await clickText('Save arrangement')
    expect(create).not.toHaveBeenCalled()
    expect(dom.container.textContent).toContain('A quiet follow-up is already saved for this Agent')
    expect(dom.container.querySelector('[data-schedule-state]')!.getAttribute('data-schedule-state')).toBe('paused')
    expect(dom.container.querySelector('textarea')!.value).toBe('Keep this next topic until I decide')
    expect(dom.container.querySelector('textarea')!.disabled).toBe(false)
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Enable quiet follow-up"]')!.disabled).toBe(false)
    expect([...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Resume arrangement')!.disabled).toBe(false)
    await clickText('Cancel arrangement'); await clickText('Save arrangement')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledExactlyOnceWith({ target, calendar: expect.any(Object), prompt: 'Keep this next topic until I decide', checkIn: DEFAULT_AGENT_SCHEDULE_CHECK_IN, operationId: expect.any(String) })
    expect(dom.draft()).toBe('Keep my draft')
  })
  it('does not let a late creation clear the new target or its later instruction', async () => {
    await mount(); await openForm(); await edit('textarea', 'Old target instruction')
    let finish!: (result: ReturnType<typeof receipt>) => void
    const create = vi.spyOn(api.schedule, 'create').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await clickText('Save arrangement')
    const next = { ...target, hostId: 'another-host', agentSessionId: 'new-native-agent' }
    await dom.render(<CalendarScheduleControl target={next} />); await openForm(); await edit('textarea', 'Later instruction for the new target')
    await act(async () => { finish(receipt(saved())) })
    expect(create).toHaveBeenCalledTimes(1)
    expect(dom.container.querySelector('textarea')).not.toBeNull()
    expect(dom.container.querySelector('textarea')!.value).toBe('Later instruction for the new target')
    expect(dom.container.querySelectorAll('[data-schedule-id]')).toHaveLength(0)
    expect(api.schedule.list).toHaveBeenLastCalledWith({ target: next })
  })
  it('inspects the original operation after a missing receipt and displays its durable result', async () => {
    await mount(saved())
    const pause = vi.spyOn(api.schedule, 'pause').mockRejectedValue(new Error('Receipt unknown'))
    const inspect = vi.spyOn(api.schedule, 'inspect').mockImplementation(async params => receipt(saved({ status: 'paused', revision: 2, lastMutation: { operationId: params.operationId!, expectedRevision: 1, action: 'pause' } })))
    await clickText('Pause arrangement'); await clickText('Check original operation')
    expect(inspect).toHaveBeenCalledExactlyOnceWith({ operationId: pause.mock.calls[0]![0].operationId })
    expect(dom.container.textContent).toContain('Paused')
    expect(dom.container.textContent).toContain('Retry original operation')
    expect(dom.container.textContent).toContain('save receipt is still unconfirmed')
  })
  it('keeps the original retry when inspection has only an attempted mutation rather than its confirmed state', async () => {
    await mount(saved({ status: 'paused' }))
    const resume = vi.spyOn(api.schedule, 'resume').mockRejectedValue(new Error('Core intent save unknown'))
    vi.spyOn(api.schedule, 'inspect').mockImplementation(async params => receipt(saved({ status: 'paused', revision: 2, lastMutation: { operationId: params.operationId!, expectedRevision: 1, action: 'resume' } })))
    await clickText('Resume arrangement'); await clickText('Check original operation')
    expect([...dom.container.querySelectorAll('button')].some(button => button.textContent === 'Retry original operation')).toBe(true)
    await clickText('Retry original operation')
    expect(resume.mock.calls[1]![0]).toEqual(resume.mock.calls[0]![0])
    expect(dom.container.textContent).toContain('Manual messages remain available.')
  })
  it('keeps a confirmed creation when the original empty list returns late', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.schedule.list>>) => void
    vi.mocked(api.schedule.list).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await dom.render(<CalendarScheduleControl target={target} initialMessage="A confirmed new idea" />)
    const create = vi.spyOn(api.schedule, 'create').mockImplementation(async params => receipt(saved({ calendar: params.calendar, prompt: params.prompt, creationOperationId: params.operationId })))
    await clickText('Save arrangement')
    expect(create).toHaveBeenCalledTimes(1)
    expect(dom.container.querySelectorAll('[data-schedule-id]')).toHaveLength(1)
    await act(async () => finish({ schedules: [], executionScope: 'connected-host' }))
    expect(dom.container.querySelectorAll('[data-schedule-id]')).toHaveLength(1)
    expect(dom.container.querySelector('.schedule-arrangement__message')!.textContent).toBe('A confirmed new idea')
    expect(dom.draft()).toBe('Keep my draft')
  })
  it('keeps a confirmed action when a list returns late and rejects a different target', async () => {
    await mount(saved())
    let finish!: (value: Awaited<ReturnType<typeof api.schedule.list>>) => void
    vi.mocked(api.schedule.list).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await refreshVisible()
    vi.spyOn(api.schedule, 'pause').mockImplementation(async params => receipt(saved({ revision: 2, status: 'paused', lastMutation: { operationId: params.operationId, expectedRevision: params.expectedRevision, action: 'pause' } })))
    await clickText('Pause arrangement')
    await act(async () => finish({ schedules: [saved()], executionScope: 'connected-host' }))
    expect(dom.container.querySelector('[data-schedule-state]')!.getAttribute('data-schedule-state')).toBe('paused')
    expect(dom.container.querySelectorAll('[data-schedule-id]')).toHaveLength(1)
    const resume = vi.spyOn(api.schedule, 'resume').mockResolvedValue(receipt(saved({ hostId: 'foreign', revision: 3 })))
    await clickText('Resume arrangement')
    expect(resume).toHaveBeenCalledTimes(1)
    expect(dom.container.textContent).toContain('Schedule mutation receipt does not match')
    expect(dom.container.querySelector('.calendar-schedules__context')!.textContent).toBe(saved().prompt)
  })
})
