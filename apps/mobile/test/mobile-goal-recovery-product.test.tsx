import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { MobileGoalLinks } from '../src/goals/MobileGoalLinks'
import { MobileWebUpdateSafetyProvider, useMobileWebUpdateSafety } from '../src/mobile-web/update-safety'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, fixture, mount, mounted } from './conversation-fixture'

let update: ReturnType<typeof useMobileWebUpdateSafety>['apply']
function CaptureUpdate() { update = useMobileWebUpdateSafety().apply; return null }

afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  vi.restoreAllMocks()
})

it('keeps an unpersisted request through Goal unmount and retries it through the real App menu', async () => {
  const owner = getDeviceWorkface(), f = fixture(), waiting = deferred<any>()
  await owner.replaceBackup({ ...emptyDeviceWorkface(), selectedSessionId: 'original-session' })
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn((..._args: any[]) => waiting.promise); f.client.forwardRpc = rpc as any
  vi.spyOn(owner, 'retainGoalRequest').mockRejectedValueOnce(Error('device storage unavailable'))
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, url: `${location.origin}/mobile/new/${'a'.repeat(64)}/index.html` })))
  const goal = { id: 'goal-original' } as any
  const render = (show: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={async () => () => true}><CaptureUpdate /><MobileApp client={null} connection={{ state: 'disconnected', message: '离线' }} platform={createBrowserPlatform()} />{show && <MobileGoalLinks client={f.client} goal={goal} updated={() => {}} />}</MobileWebUpdateSafetyProvider>
  const view = await mount(render(true))
  const input = view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'session-original'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(button(view.element, '关联会话'))
  expect(rpc).toHaveBeenCalledTimes(1)
  await act(async () => { waiting.reject(Error('receipt unavailable')); await Promise.resolve() })
  await view.render(render(false))
  expect(await update()).toMatchObject({ status: 'blocked', message: expect.stringContaining('目标原请求尚未') })
  await click(button(view.element, '手机设置与连接')); await click(button(document.body, '提醒与诊断'))
  expect(document.body.textContent).toContain('goal-original')
  await click(button(document.body, '保存到当前设备工作面'))
  expect(await update()).toEqual({ status: 'navigating' })
  expect(navigate).toHaveBeenCalledOnce(); expect(rpc).toHaveBeenCalledTimes(1)
  vi.unstubAllGlobals()
})

it('shows an original unknown Goal request in the actual offline App even if the Goal no longer exists', async () => {
  const owner = getDeviceWorkface(), item = { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', deviceHostId: 'original-host', origin: location.origin,
    method: 'goal.delete' as const, request: { goalId: 'deleted-original-goal', operationId: 'original-operation', confirmation: 'delete' } }
  await owner.replaceBackup({ ...emptyDeviceWorkface(), selectedSessionId: 'original-session', goalOperationRecords: [item] })
  const platform = createBrowserPlatform(), copy = vi.fn(async () => {})
  platform.copyText = copy
  const view = await mount(<MobileApp client={null} connection={{ state: 'disconnected', message: '原 Host 暂时离线' }} platform={platform} />)
  await click(button(view.element, '手机设置与连接'))
  await click(button(document.body, '提醒与诊断'))
  expect(document.body.textContent).toContain('deleted-original-goal')
  expect(document.body.textContent).toContain('回执未确认')
  await click(button(document.body, '复制原请求'))
  expect(JSON.parse(copy.mock.calls[0]![0])).toEqual(item)
  expect(owner.snapshot().record.goalOperationRecords).toEqual([item])
})

it('refuses an additional record at capacity without evicting any original request', async () => {
  const owner = getDeviceWorkface(), record = (index: number) => ({ runtimeId: null, ownerInstanceId: null, deviceHostId: null, origin: location.origin,
    method: 'goal.start' as const, request: { goalId: 'original-goal', operationId: `original-operation-${index}` } })
  const originals = Array.from({ length: 256 }, (_, index) => record(index))
  await owner.replaceBackup({ ...emptyDeviceWorkface(), goalOperationRecords: originals })
  await expect(Promise.resolve().then(() => owner.retainGoalRequest(record(256), owner.recordIdentity()))).rejects.toThrow('已满')
  expect(owner.snapshot().record.goalOperationRecords).toEqual(originals)
})
