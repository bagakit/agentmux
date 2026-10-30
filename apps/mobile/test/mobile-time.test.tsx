import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxRpcGoal } from '@agentmux/core'
import { fixtureEpoch } from '../../../packages/core/test/helpers/fixture-values'
import { formatMobileTime, withMobileTime } from '../src/presentation/time'
import { MobileGoalsSurface } from '../src/goals/MobileGoalsSurface'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixture, mount, mounted } from './conversation-fixture'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() } })

it.each([undefined, null, NaN, Infinity, -Infinity, 0, -1, Number.MAX_VALUE])('keeps the confirmed fact when its time cannot be represented: %s', at => {
  expect(formatMobileTime(at)).toBeNull()
  expect(withMobileTime('目标已确认', at)).toBe('目标已确认')
})

it('formats valid historical and current times without a calendar cutoff or seconds', () => {
  const at = fixtureEpoch(2), date = new Date(at), now = Date.now(), current = new Date(now)
  expect(formatMobileTime(at, now)).toBe(`${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`)
  const clock = [current.getHours(), current.getMinutes()].map(value => String(value).padStart(2, '0')).join(':')
  expect(formatMobileTime(now, now)).toBe(`今天 ${clock}`)
  const otherDay = new Date(now); otherDay.setDate(current.getDate() === 1 ? 2 : 1)
  expect(formatMobileTime(otherDay.getTime(), now)).toBe(`${otherDay.getMonth() + 1}月${otherDay.getDate()}日 ${clock}`)
})

it.each([fixtureEpoch(2), Number.MAX_VALUE])('keeps original Goal confirmation through the mounted consumer: %s', async at => {
  const f = fixture(), goal = { id: 'goal-original', title: '原目标', description: '原意', status: 'todo', priority: 'normal', projectId: null,
    sessionIds: ['session-original'], createdAt: at, updatedAt: at, source: 'session', alignment: { summary: '原范围', criteria: [], openQuestions: [], revision: 2, confirmedAt: at } } as AgentMuxRpcGoal
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', availability: 'connected' })
  f.client.forwardRpc = vi.fn(async (method: string) => {
    if (method === 'goal.ls') return { goals: [goal] }
    if (method === 'goal.inspect') return { goal, goalContinuations: [] }
    if (method === 'goal.decisions') return { goalId: goal.id, decisions: [] }
    throw Error('Unexpected ' + method)
  }) as typeof f.client.forwardRpc
  const view = await mount(<MobileGoalsSurface client={f.client} connected visible initialContext={{ goalId: goal.id, mode: 'detail', discussion: null }} />)
  const date = new Date(at), expected = Number.isFinite(date.getTime()) ? `目标已确认 · ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日` : '目标已确认'
  expect([...view.element.querySelectorAll('p')].map(p => p.textContent)).toContain(expected)
  expect(view.element.textContent).not.toContain('NaN')
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.every(([method]) => ['goal.ls', 'goal.inspect', 'goal.decisions'].includes(method))).toBe(true)
  expect(goal.alignment?.confirmedAt).toBe(at)
})
