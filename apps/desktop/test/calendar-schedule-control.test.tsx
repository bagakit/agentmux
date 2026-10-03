import { fixtureCivil as _hygiene_fixtureCivil, fixtureClock as _hygiene_fixtureClock, fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContinuousProgressLoop } from '@agentmux/core'
import { CalendarScheduleControl } from '../src/renderer/src/components/CalendarScheduleControl'
import { ContinuousProgressControl } from '../src/renderer/src/components/ContinuousProgressControl'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const target = { hostId: 'local', agentSessionId: 'native-agent', providerId: 'codex', workspacePath: _hygiene_fixturePath("repo") }
const calendar = { kind: 'daily' as const, timezone: 'America/New_York', time: _hygiene_fixtureClock(9, 0), policies: { gap: 'skip' as const, fold: 'earlier' as const, monthEnd: 'clamp' as const, overdue: 'latest' as const } }
const saved = (overrides: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop => ({ ...target, loopId: 'saved-calendar', intervalMs: 60000, calendar, prompt: 'Ask one original question.\nKeep this entire saved message.', status: 'active', nextCheckAt: Date.parse(_hygiene_fixtureIso(26316000000, "minute")), revision: 1, creationOperationId: 'created-calendar', futureIntentId: 'intent-1', ...overrides })
const receipt = (schedule: ContinuousProgressLoop) => ({ schedule, diskDurability: 'confirmed' as const, executionScope: 'connected-host' as const })
beforeEach(() => {
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
  vi.spyOn(api.schedule, 'onChanged').mockImplementation(() => vi.fn())
})
async function mount(schedule?: ContinuousProgressLoop) {
  if (schedule) vi.mocked(api.schedule.list).mockResolvedValue({ schedules: [schedule], executionScope: 'connected-host' })
  await dom.render(<CalendarScheduleControl target={target} />)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-schedule-state]')!.getAttribute('data-schedule-state')).not.toBe('unconfirmed'))
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

describe('original calendar control', () => {
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
    vi.spyOn(api.continuousProgress, 'onChanged').mockImplementation(() => vi.fn())
    await dom.render(<ContinuousProgressControl session={session} />)
    expect(api.schedule.list).toHaveBeenCalledExactlyOnceWith({ target })
    expect(interval).toHaveBeenCalledExactlyOnceWith(target)
  })
  it('shows full saved message, civil due and actual status and uses the original three mutations', async () => {
    await mount(saved())
    expect(dom.container.querySelector('.calendar-schedules__message')!.textContent).toBe(saved().prompt)
    expect(dom.container.textContent).toContain('America/New_York')
    expect(dom.container.querySelector('time')!.dateTime).toBe(new Date(saved().nextCheckAt).toISOString())
    expect(dom.container.textContent).not.toContain('Check now')
    const pause = vi.spyOn(api.schedule, 'pause').mockImplementation(async params => receipt(saved({ revision: 2, status: 'paused', lastMutation: { ...params, action: 'pause' } })))
    const resume = vi.spyOn(api.schedule, 'resume').mockImplementation(async params => receipt(saved({ revision: 3, lastMutation: { ...params, action: 'resume' } })))
    const cancel = vi.spyOn(api.schedule, 'cancel').mockImplementation(async params => receipt(saved({ revision: 4, status: 'stopped', lastMutation: { ...params, action: 'cancel' } })))
    await clickText('Pause arrangement'); await clickText('Resume arrangement'); await clickText('Cancel arrangement')
    expect([pause, resume, cancel].map(call => call.mock.calls[0]![0])).toEqual([1, 2, 3].map(expectedRevision => ({ scheduleId: 'saved-calendar', expectedRevision, operationId: expect.stringMatching(/^schedule-/) })))
    expect(dom.container.textContent).toContain('Ended')
    expect(dom.container.querySelectorAll('.calendar-schedules__actions button')).toHaveLength(0)
  })
  it.each(['once', 'daily', 'weekly', 'monthly', 'yearly'] as const)('saves %s with explicit civil policies through the real typed create API', async kind => {
    await mount(); await openForm()
    const create = vi.spyOn(api.schedule, 'create').mockImplementation(async params => receipt(saved({ ...params.target, calendar: params.calendar, prompt: params.prompt, creationOperationId: params.operationId })))
    await edit('[aria-label="Arrangement repeat"]', kind)
    await edit('[aria-label="Arrangement time zone"]', 'Europe/Berlin')
    await edit('[aria-label="Arrangement time"]', _hygiene_fixtureClock(8, 30))
    await edit('textarea', 'Keep my exact original instruction.\nSecond line.')
    if (kind === 'once') await edit('[aria-label="Arrangement date"]', _hygiene_fixtureCivil(2, 14, 1))
    if (kind === 'weekly') await edit('[aria-label="Arrangement weekday"]', '5')
    if (kind === 'monthly' || kind === 'yearly') await edit('[aria-label="Arrangement day"]', '31')
    if (kind === 'yearly') await edit('[aria-label="Arrangement month"]', '2')
    await clickText('Save arrangement')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toEqual({ target, prompt: 'Keep my exact original instruction.\nSecond line.', operationId: expect.stringMatching(/^schedule-/), calendar: { kind, timezone: 'Europe/Berlin', time: _hygiene_fixtureClock(8, 30), policies: calendar.policies, ...(kind === 'once' ? { date: _hygiene_fixtureCivil(2, 14, 1) } : {}), ...(kind === 'weekly' ? { weekday: 5 } : {}), ...(kind === 'monthly' || kind === 'yearly' ? { day: 31 } : {}), ...(kind === 'yearly' ? { month: 2 } : {}) } })
    expect(dom.container.querySelector('form')).toBeNull()
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
    expect(dom.container.textContent).not.toContain('Retry original operation')
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
  it('keeps fresher event facts when a list returns late and rejects a different target', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.schedule.list>>) => void
    vi.mocked(api.schedule.list).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    let changed!: (loop: ContinuousProgressLoop) => void
    vi.mocked(api.schedule.onChanged).mockImplementation(listener => { changed = listener; return vi.fn() })
    await dom.render(<CalendarScheduleControl target={target} />)
    await act(async () => { changed(saved({ revision: 2, status: 'paused' })); changed(saved({ hostId: 'foreign' })); finish({ schedules: [saved()], executionScope: 'connected-host' }) })
    expect(dom.container.querySelector('[data-schedule-state]')!.getAttribute('data-schedule-state')).toBe('paused')
    expect(dom.container.querySelectorAll('[data-schedule-id]')).toHaveLength(1)
    const resume = vi.spyOn(api.schedule, 'resume').mockResolvedValue(receipt(saved({ hostId: 'foreign', revision: 3 })))
    await clickText('Resume arrangement')
    expect(resume).toHaveBeenCalledTimes(1)
    expect(dom.container.textContent).toContain('another arrangement target')
    expect(dom.container.querySelector('.calendar-schedules__message')!.textContent).toBe(saved().prompt)
  })
})
