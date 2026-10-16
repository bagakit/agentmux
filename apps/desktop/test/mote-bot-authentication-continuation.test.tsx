// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConnectionEnrollmentView } from '@agentmux/core/connections'
import { moteBotUi } from './fixtures/mote-bot-ui'

let f: Awaited<ReturnType<typeof moteBotUi>>
beforeEach(async () => { f = await moteBotUi() })
afterEach(async () => { await f?.close() })
const parent = () => f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as { operationId: string }
async function visible(selector: string, timeout = 4000) {
  await vi.waitFor(async () => { await f.settle(); expect(document.querySelector(selector), selector).not.toBeNull() }, { timeout })
}
async function create() {
  await f.open()
  await f.click('Create a bot for this Mote')
  await visible('.mote-bot-confirmation svg')
}
function observeViews() {
  const views: ConnectionEnrollmentView[] = [], forward = f.connectionCalls.getMockImplementation()!
  f.connectionCalls.mockImplementation(async (method, input) => {
    const result = await forward(method, input)
    if (method === 'connection.enrollment.inspect') views.push(structuredClone(result as ConnectionEnrollmentView))
    return result
  })
  return views
}
async function pause(milliseconds = 1700) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, milliseconds)) })
}

it('automatically follows the original Mote sign-in through pending and scanned states, then requires both account and creation confirmation', async () => {
  const views = observeViews(), pending = [1, 1, 2], native = f.registration.getMockImplementation()!
  f.registration.mockImplementation(async (url, input) => {
    if (new URL(String(url)).pathname === '/accounts/qrlogin/polling') {
      const previous = views.at(-1)!
      expect(Date.now()).toBeGreaterThanOrEqual(previous.challenge!.nextPollAt)
      expect(new Headers(input?.headers).get('cookie')).toContain('mote-session=1')
      const status = pending.shift()
      if (status !== undefined)
        return Response.json({ code: 0, data: { next_step: 'qr_login_polling', step_info: { status } } })
    }
    return native(url, input)
  })
  await create()
  const id = parent().operationId, original = views[0]!, qr = document.querySelector('.mote-bot-confirmation svg')
  for (const [index, stage] of ['waiting', 'waiting', 'scanned'].entries()) {
    await vi.waitFor(async () => { await f.settle(); expect(views.length).toBeGreaterThan(index + 1) }, { timeout: 4000 })
    expect(views[index + 1]).toMatchObject({
      operation: { operationId: original.operation!.operationId, authentication: { stage, attemptId: original.operation!.authentication!.attemptId } },
      challenge: { qrPayload: original.challenge!.qrPayload }
    })
    expect(document.querySelector('.mote-bot-confirmation svg')).toBe(qr)
  }
  await visible('[data-mote-enrollment-action="confirm-account"]', 7000)
  expect(views.map(view => view.operation!.authentication!.stage)).toEqual(['waiting', 'waiting', 'waiting', 'scanned', 'handoff', 'handoff', 'handoff', 'account'])
  expect(views.every(view => view.operation!.authentication!.attemptId === original.operation!.authentication!.attemptId)).toBe(true)
  const advances = f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.advance')
  for (const [index, [, input]] of advances.entries()) {
    const before = views[index]!, offered = before.actions.find(action => action.kind === 'continue-authentication')!
    expect(input).toEqual({ operationId: id, enrollment: { operationId: before.operation!.operationId,
      ownRevision: offered.ownRevision, decision: { actionId: offered.actionId, kind: offered.kind } } })
  }
  const count = advances.length
  await pause(50)
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.advance')).toHaveLength(count)
  expect(f.creationCount).toBe(0)
  await f.click('Confirm this account')
  await visible('[data-mote-enrollment-action="create"]')
  await pause(50)
  expect(f.creationCount).toBe(0)
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.create')).toHaveLength(1)
}, 20_000)

it.each(['close', 'target'] as const)('stops queued authentication after changing the original %s and retains the same request', async change => {
  await create()
  const id = parent().operationId
  if (change === 'close') await f.click('Close bot choice')
  else await f.render(1)
  await pause()
  expect(f.authenticationCount).toBe(0)
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.advance')).toEqual([])
  const original = (await f.client.call('space.mote.connection.inspect', { operationId: id })).operation!
  expect(original.enrollment?.authentication?.stage).toBe('waiting')
  expect(f.beginCount).toBe(1)
})

it('stops on an unknown native result and reads the same recorded request without restarting authentication', async () => {
  const native = f.registration.getMockImplementation()!
  f.registration.mockImplementation(async (url, input) => new URL(String(url)).pathname === '/accounts/qrlogin/polling'
    ? Response.json({ code: 0, data: { next_step: 'unrecognized_machine_step', step_info: { status: 99 } } })
    : native(url, input))
  await create()
  const id = parent().operationId
  await visible('[data-mote-enrollment-action="renew-authentication"]')
  const count = f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.advance').length
  await pause()
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.advance')).toHaveLength(count)
  expect(f.creationCount).toBe(0); expect(f.beginCount).toBe(1)
  const platformRequests = f.registration.mock.calls.length
  await f.click('Original setup details'); await f.click('Check saved progress')
  await pause(50)
  expect(parent().operationId).toBe(id)
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.advance')).toHaveLength(count + 1)
  expect(f.registration.mock.calls).toHaveLength(platformRequests)
  expect(f.beginCount).toBe(1)
})
