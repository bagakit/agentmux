// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ContinuousProgressLoop } from '@agentmux/core'
import { CalendarScheduleControl } from '../src/renderer/src/components/CalendarScheduleControl'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { composerDOM } from './helpers/composer-dom-fixture'
import { fixturePath } from '../../../packages/core/test/helpers/fixture-values'

const dom = composerDOM()
const target = { hostId: 'local', agentSessionId: 'original-agent', providerId: 'generic', workspacePath: fixturePath('schedule-project') }
const saved = (overrides: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop => ({ ...target,
  loopId: 'original-arrangement', prompt: 'Original saved arrangement', intervalMs: 60_000, afterMs: 60_000,
  nextCheckAt: 60_000, status: 'active', revision: 1, creationOperationId: 'original-create', futureIntentId: 'original-intent', ...overrides })
const result = (schedules: ContinuousProgressLoop[]) => ({ schedules, executionScope: 'connected-host' as const })
let hidden: boolean
beforeEach(() => {
  vi.useFakeTimers(); hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  vi.spyOn(api.schedule, 'list').mockResolvedValue(result([]))
})
afterEach(() => { vi.useRealTimers() })
const advance = async (milliseconds: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) }) }
async function visibility(value: boolean) {
  hidden = value
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
}
async function click(text: string) {
  await act(async () => { [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click() })
}

it('hidden retained Calendar consumers start no polling even with status callbacks and keep their original form on reveal', async () => {
  const targets = Array.from({ length: 32 }, (_, index) => ({ ...target, agentSessionId: `retained-agent-${index}` }))
  const status = vi.fn()
  const render = (visible: boolean) => dom.render(<>{targets.map((exact, index) => <CalendarScheduleControl key={exact.agentSessionId}
    target={exact} presented={visible && index === 0} onStatusChange={status} initialMessage={index === 0 ? 'Keep this arrangement draft' : undefined} />)}</>)
  await render(false); await advance(30_000)
  expect(api.schedule.list).toHaveBeenCalledTimes(0)
  const original = dom.container.querySelector('textarea')!
  await render(true)
  expect(api.schedule.list).toHaveBeenCalledExactlyOnceWith({ target: targets[0] })
  expect(original.value).toBe('Keep this arrangement draft')
  await render(false); await advance(15_000); await visibility(true); await visibility(false)
  expect(api.schedule.list).toHaveBeenCalledTimes(1)
  await render(true)
  expect(api.schedule.list).toHaveBeenCalledTimes(2)
  expect(dom.container.querySelector('textarea')).toBe(original)
  expect(original.value).toBe('Keep this arrangement draft')
})

it('one slow exact-scope read is shared across ticks and hide/show, then foreground immediately takes a fresh cut', async () => {
  let finish!: (value: ReturnType<typeof result>) => void
  vi.mocked(api.schedule.list).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await dom.render(<CalendarScheduleControl target={target} />)
  await advance(16_000)
  expect(api.schedule.list).toHaveBeenCalledTimes(1)
  await dom.render(<CalendarScheduleControl target={target} presented={false} />)
  await dom.render(<CalendarScheduleControl target={target} />)
  expect(api.schedule.list).toHaveBeenCalledTimes(1)
  vi.mocked(api.schedule.list).mockResolvedValue(result([saved({ prompt: 'Fresh original cut', revision: 2 })]))
  await act(async () => finish(result([saved({ prompt: 'Old hidden cut' })])))
  expect(api.schedule.list).toHaveBeenCalledTimes(2)
  expect(dom.container.textContent).toContain('Fresh original cut')
  expect(dom.container.textContent).not.toContain('Old hidden cut')
  await visibility(true); await advance(10_000)
  expect(api.schedule.list).toHaveBeenCalledTimes(2)
  vi.mocked(api.schedule.list).mockResolvedValue(result([saved({ prompt: 'Foreground original cut', revision: 3 })]))
  await visibility(false)
  expect(api.schedule.list).toHaveBeenCalledTimes(3)
  expect(dom.container.textContent).toContain('Foreground original cut')
})

it('returning to a still-pending scope waits for its old read and never publishes its previous presentation cut', async () => {
  const other = { ...target, agentSessionId: 'other-agent' }
  let finish!: (value: ReturnType<typeof result>) => void
  vi.mocked(api.schedule.list).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce(result([saved({ ...other, prompt: 'Other exact scope' })]))
    .mockResolvedValue(result([saved({ prompt: 'Current original scope', revision: 2 })]))
  await dom.render(<CalendarScheduleControl target={target} />)
  await dom.render(<CalendarScheduleControl target={other} />)
  expect(dom.container.textContent).toContain('Other exact scope')
  await dom.render(<CalendarScheduleControl target={target} />)
  expect(api.schedule.list).toHaveBeenCalledTimes(2)
  await act(async () => finish(result([saved({ prompt: 'Obsolete original scope' })])))
  expect(api.schedule.list).toHaveBeenCalledTimes(3)
  expect(dom.container.textContent).toContain('Current original scope')
  expect(dom.container.textContent).not.toContain('Obsolete original scope')
  expect(dom.container.textContent).not.toContain('Other exact scope')
})

it('foreground invalidates an old in-flight cut while preserving the last confirmed rows until the fresh read returns', async () => {
  vi.mocked(api.schedule.list).mockResolvedValueOnce(result([saved()]))
  await dom.render(<CalendarScheduleControl target={target} />)
  let old!: (value: ReturnType<typeof result>) => void, fresh!: (value: ReturnType<typeof result>) => void
  vi.mocked(api.schedule.list).mockImplementationOnce(() => new Promise(resolve => { old = resolve }))
    .mockImplementationOnce(() => new Promise(resolve => { fresh = resolve }))
  await visibility(false); await visibility(true); await visibility(false)
  expect(api.schedule.list).toHaveBeenCalledTimes(2)
  await act(async () => old(result([saved({ prompt: 'Obsolete foreground cut', revision: 2 })])))
  expect(api.schedule.list).toHaveBeenCalledTimes(3)
  expect(dom.container.textContent).toContain('Original saved arrangement')
  expect(dom.container.textContent).not.toContain('Obsolete foreground cut')
  await act(async () => fresh(result([saved({ prompt: 'Confirmed foreground cut', revision: 3 })])))
  expect(dom.container.textContent).toContain('Confirmed foreground cut')
})

it('an old read failure cannot replace the newer confirmed action received by the actual arrangement row', async () => {
  vi.mocked(api.schedule.list).mockResolvedValueOnce(result([saved()]))
  await dom.render(<CalendarScheduleControl target={target} />)
  let reject!: (error: Error) => void
  vi.mocked(api.schedule.list).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  await visibility(false)
  vi.spyOn(api.schedule, 'pause').mockImplementation(async params => ({ schedule: saved({ status: 'paused', revision: 2,
    lastMutation: { action: 'pause', operationId: params.operationId, expectedRevision: params.expectedRevision } }), executionScope: 'connected-host', diskDurability: 'confirmed' }))
  await click('Pause arrangement')
  await act(async () => reject(new Error('Obsolete original read failure')))
  expect(dom.container.querySelector('[data-schedule-state]')!.getAttribute('data-schedule-state')).toBe('paused')
  expect(dom.container.textContent).not.toContain('Obsolete original read failure')
  expect(api.schedule.pause).toHaveBeenCalledTimes(1)
  expect(api.schedule.list).toHaveBeenCalledTimes(2)
})
