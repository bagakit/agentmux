import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileGoalLinks } from '../src/goals/MobileGoalLinks'
import { MobileGoalActions } from '../src/goals/MobileGoalActions'
import { MobileGoalOperationRecovery, MobileGoalOperationSafety } from '../src/goals/goal-operation-recovery'
import { MobileWebUpdateSafetyProvider, useMobileWebUpdateSafety } from '../src/mobile-web/update-safety'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, fixture, mount, mounted } from './conversation-fixture'

let apply: ReturnType<typeof useMobileWebUpdateSafety>['apply']
function Update() { apply = useMobileWebUpdateSafety().apply; return null }
const connection = async () => () => true
const goal = { id: 'goal-original', updatedAt: 1, assigneeSessionIds: [], supervisorSessionId: null } as any
async function input(view: HTMLElement) {
  const element = view.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, 'session-original'); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('sends the original Goal request without waiting for bookkeeping and removes only its confirmed record', async () => {
  const owner = getDeviceWorkface(), f = fixture(), release = deferred<void>()
  await act(async () => { await owner.replaceBackup(emptyDeviceWorkface()) })
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const write = owner.retainGoalRequest.bind(owner)
  vi.spyOn(owner, 'retainGoalRequest').mockImplementation(async (item, id) => { await release.promise; return write(item, id) })
  const rpc = vi.fn(async () => ({ goal })), updated = vi.fn(); f.client.forwardRpc = rpc as any
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={connection}><Update /><MobileGoalOperationSafety /><MobileGoalLinks client={f.client} goal={goal} updated={updated} /></MobileWebUpdateSafetyProvider>)
  await input(view.element); await click(button(view.element, '关联会话'))
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(updated).toHaveBeenCalledOnce()
  expect(view.element.textContent).toContain('会话已关联到原目标')
  expect(button(view.element, '关联会话').disabled).toBe(false)
  expect(await apply()).toMatchObject({ status: 'blocked' })
  await act(async () => { release.resolve(); await release.promise })
  await vi.waitFor(() => expect(owner.snapshot().record.goalOperationRecords ?? []).toEqual([]))
  expect(rpc).toHaveBeenCalledTimes(1)
})

it('does not misclassify a confirmed Goal receipt when the local presentation callback throws', async () => {
  const owner = getDeviceWorkface(), f = fixture()
  await owner.replaceBackup(emptyDeviceWorkface())
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn(async () => ({ goal })); f.client.forwardRpc = rpc as any
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={connection}><Update /><MobileGoalOperationSafety /><MobileGoalLinks client={f.client} goal={goal} updated={() => { throw Error('local presentation failed') }} /></MobileWebUpdateSafetyProvider>)
  await input(view.element); await click(button(view.element, '关联会话'))
  expect(view.element.textContent).toContain('原关联已收到回执')
  expect(view.element.textContent).not.toContain('关联回执未确认')
  await vi.waitFor(() => expect(owner.snapshot().record.goalOperationRecords ?? []).toEqual([]))
  expect(rpc).toHaveBeenCalledOnce()
})

it('retains the exact request when another page replaces the workface, then explicitly saves it into the current one', async () => {
  const owner = getDeviceWorkface(), f = fixture(), waiting = deferred<any>()
  await owner.replaceBackup(emptyDeviceWorkface())
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn((..._args: any[]) => waiting.promise); f.client.forwardRpc = rpc as any
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, url: `${location.origin}/mobile/new/${'a'.repeat(64)}/index.html` })))
  const render = (show: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={connection}><Update /><MobileGoalOperationSafety /><MobileGoalOperationRecovery copyText={vi.fn()} />{show && <MobileGoalLinks client={f.client} goal={goal} updated={() => {}} />}</MobileWebUpdateSafetyProvider>
  const view = await mount(render(true)); await input(view.element); await click(button(view.element, '关联会话'))
  await vi.waitFor(() => expect(owner.snapshot().record.goalOperationRecords?.length).toBe(1))
  await act(async () => { waiting.reject(Error('original receipt unavailable')); await Promise.resolve() })
  const original = owner.snapshot().record.goalOperationRecords![0]!
  const priorRecordId = owner.recordIdentity()
  await act(async () => { await owner.replaceBackup(emptyDeviceWorkface()) })
  expect(owner.recordIdentity()).not.toBe(priorRecordId)
  await view.render(render(false))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('目标原请求尚未') })
  await click(button(view.element, '保存到当前设备工作面'))
  expect(owner.snapshot().record.goalOperationRecords).toEqual([original])
  expect(await apply()).toEqual({ status: 'navigating' }); expect(navigate).toHaveBeenCalledOnce()
  expect(rpc).toHaveBeenCalledTimes(1)
})

it('immediately reports the unknown receipt and restores the action when bookkeeping is still hung', async () => {
  const owner = getDeviceWorkface(), f = fixture(), release = deferred<void>()
  await owner.replaceBackup(emptyDeviceWorkface())
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const write = owner.retainGoalRequest.bind(owner)
  vi.spyOn(owner, 'retainGoalRequest').mockImplementation(async (item, id) => { await release.promise; return write(item, id) })
  const rpc = vi.fn(async () => { throw Error('original receipt unavailable') }); f.client.forwardRpc = rpc as any
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={connection}><Update /><MobileGoalOperationSafety /><MobileGoalLinks client={f.client} goal={goal} updated={() => {}} /></MobileWebUpdateSafetyProvider>)
  await input(view.element); await click(button(view.element, '关联会话'))
  expect(view.element.textContent).toContain('关联回执未确认')
  expect(button(view.element, '关联会话').disabled).toBe(false)
  expect(await apply()).toMatchObject({ status: 'blocked' })
  await act(async () => { release.resolve(); await release.promise })
  await vi.waitFor(() => expect(owner.snapshot().record.goalOperationRecords?.length).toBe(1))
  expect(rpc).toHaveBeenCalledOnce()
})

it.each(['success', 'unknown', 'presentation-error'] as const)('shows assignment %s independently of a hung device write', async outcome => {
  const owner = getDeviceWorkface(), f = fixture(), release = deferred<void>()
  await owner.replaceBackup(emptyDeviceWorkface())
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const write = owner.retainGoalRequest.bind(owner)
  vi.spyOn(owner, 'retainGoalRequest').mockImplementation(async (item, id) => { await release.promise; return write(item, id) })
  const rpc = vi.fn(async (method: string) => { if (method === 'app.snapshot') return { sessions: [], unavailable: [] }; if (outcome === 'unknown') throw Error('receipt unavailable'); return { goal } })
  f.client.forwardRpc = rpc as any
  const updated = vi.fn(() => { if (outcome === 'presentation-error') throw Error('local presentation failed') })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={connection}><Update /><MobileGoalOperationSafety /><MobileGoalActions client={f.client} goal={goal} visible updated={updated} deleted={() => {}} /></MobileWebUpdateSafetyProvider>)
  await click(button(view.element, '保存负责人分配'))
  expect(view.element.textContent).toContain(outcome === 'success' ? '负责人分配已保存' : outcome === 'unknown' ? '分配回执未确认' : '原操作已收到回执')
  expect(button(view.element, '保存负责人分配').disabled).toBe(false)
  if (outcome === 'presentation-error') expect(view.element.textContent).not.toContain('分配回执未确认')
  expect(rpc.mock.calls.filter(([method]) => method === 'goal.assign')).toHaveLength(1)
  await act(async () => { release.resolve(); await release.promise })
  await vi.waitFor(() => expect(owner.snapshot().record.goalOperationRecords?.length ?? 0).toBe(outcome === 'unknown' ? 1 : 0))
})
