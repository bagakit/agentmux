import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxRpcGoal } from '@agentmux/core'
import { MobileWebUpdateSafetyProvider, useMobileWebUpdateSafety } from '../src/mobile-web/update-safety'
import { MobileTopicOrganization } from '../src/topics/MobileTopicOrganization'
import { MobileGoalActions } from '../src/goals/MobileGoalActions'
import { MobileGoalLinks } from '../src/goals/MobileGoalLinks'
import { MobileGoalOperationRecovery, MobileGoalOperationSafety } from '../src/goals/goal-operation-recovery'
import { getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, fixture, mount, mounted } from './conversation-fixture'

let apply: ReturnType<typeof useMobileWebUpdateSafety>['apply']
function Update() { apply = useMobileWebUpdateSafety().apply; return null }
const verifyConnection = async () => () => true
const goal = { id: 'goal-original', title: '原目标', description: '原意', status: 'todo', priority: 'normal', projectId: null, projectName: null,
  sessionIds: [], assigneeSessionIds: [], supervisorSessionId: null, createdAt: 1, updatedAt: 2, source: 'session', activityLog: [] } as AgentMuxRpcGoal
const category = { categoryId: 'category-original', title: '原分类', hostId: 'host-original', spaceId: 'space-original', directoryPath: '/opaque', revision: 'revision-original' }
const response = () => ({ ok: true, url: location.origin + '/mobile/new-build/' + 'a'.repeat(64) + '/index.html' }) as Response
async function fill(element: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response()))
})
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('protects the hidden Topic organization draft and original unconfirmed creation ID', async () => {
  const waiting = deferred<any>(), rpc = vi.fn((..._args: any[]) => waiting.promise)
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileTopicOrganization rpc={rpc as any} categories={[category]} category={category} topic={null} onChanged={() => {}} /></MobileWebUpdateSafetyProvider>)
  await click(button(view.element, '新建 Topic'))
  const input = view.element.querySelector<HTMLInputElement>('[aria-label="分类或 Topic 名称"]')!
  await fill(input, '原 Topic 名称')
  await click(button(view.element, '保留草稿并返回'))
  expect(input.closest('[hidden]')).not.toBeNull()
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('Topic 管理草稿') })
  await click(button(view.element, '继续管理草稿')); await click(button(view.element, '确认保存'))
  expect(rpc).toHaveBeenCalledTimes(1)
  const identity = rpc.mock.calls[0]![1] as { topicId: string }
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('Topic 管理操作') })
  await act(async () => { waiting.reject(Error('原回执未确认')); await Promise.resolve() })
  await click(button(view.element, '保留草稿并返回'))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('Topic 管理操作') })
  await click(button(view.element, '继续管理草稿'))
  expect(input.value).toBe('原 Topic 名称')
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(identity.topicId).toBeTruthy(); expect(fetch).not.toHaveBeenCalled()
})

it('protects hidden Goal action input, in-flight requests and the original unknown operation', async () => {
  const f = fixture(), waiting = deferred<any>()
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn((method: string) => method === 'goal.assign' ? waiting.promise : Promise.resolve({ sessions: [], unavailable: [] }))
  f.client.forwardRpc = rpc as any
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  const render = (visible: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalOperationSafety /><div hidden={!visible}><MobileGoalActions client={f.client} goal={goal} visible={visible} updated={() => {}} deleted={() => {}} /></div></MobileWebUpdateSafetyProvider>
  const view = await mount(render(true)), input = view.element.querySelector<HTMLInputElement>('[aria-label="分配 Session IDs"]')!
  await fill(input, 'original-session')
  await view.render(render(false))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('目标操作输入') })
  await view.render(render(true)); await click(button(view.element, '保存负责人分配'))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.goalOperationRecords?.some(item => JSON.stringify(item.request) === JSON.stringify(rpc.mock.calls.find(([method]) => method === 'goal.assign')![1]))).toBe(true))
  expect(await apply()).toEqual({ status: 'navigating' })
  await act(async () => { waiting.reject(Error('原回执未确认')); await Promise.resolve() })
  await fill(input, '')
  await view.render(render(false))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('目标操作输入') })
  await fill(input, 'original-session')
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(navigate).toHaveBeenCalledTimes(2)
  expect(getDeviceWorkface().snapshot().record.goalOperationRecords?.[0]?.request).toEqual(rpc.mock.calls.find(([method]) => method === 'goal.assign')![1])
  expect(view.element.textContent).toContain('original-session')
  expect(rpc.mock.calls.filter(([method]) => method === 'goal.assign')).toHaveLength(1)
})

it('protects hidden Goal link input and the exact original unconfirmed request', async () => {
  const f = fixture(), waiting = deferred<any>(), rpc = vi.fn((..._args: any[]) => waiting.promise)
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  f.client.forwardRpc = rpc as any
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  const render = (visible: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalOperationSafety /><div hidden={!visible}><MobileGoalLinks client={f.client} goal={goal} updated={() => {}} /></div></MobileWebUpdateSafetyProvider>
  const view = await mount(render(true)), input = view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!
  await fill(input, 'original-session'); await view.render(render(false))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('目标关联输入') })
  await view.render(render(true)); await click(button(view.element, '关联会话'))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.goalOperationRecords?.some(item => JSON.stringify(item.request) === JSON.stringify(rpc.mock.calls[0]![1]))).toBe(true))
  expect(await apply()).toEqual({ status: 'navigating' })
  await act(async () => { waiting.reject(Error('原回执未确认')); await Promise.resolve() })
  await fill(input, ''); await view.render(render(false))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('目标关联输入') })
  await fill(input, 'original-session')
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(navigate).toHaveBeenCalledTimes(2)
  expect(getDeviceWorkface().snapshot().record.goalOperationRecords?.some(item => JSON.stringify(item.request) === JSON.stringify(rpc.mock.calls[0]![1]))).toBe(true)
  expect(view.element.textContent).toContain('original-session')
  expect(JSON.parse(view.element.querySelector('pre')!.textContent!)).toEqual(rpc.mock.calls[0]![1])
  expect(rpc).toHaveBeenCalledTimes(1)
})

it('allows an update after Goal assignment is actually confirmed and no input remains unsaved', async () => {
  const f = fixture(), navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  f.client.forwardRpc = vi.fn(async () => ({ goal })) as any
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalActions client={f.client} goal={goal} visible updated={() => {}} deleted={() => {}} /></MobileWebUpdateSafetyProvider>)
  await fill(view.element.querySelector<HTMLInputElement>('[aria-label="分配 Session IDs"]')!, 'original-session')
  await click(button(view.element, '保存负责人分配'))
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/#amux-update')
})

it('allows an update after a Goal link is confirmed and the original input is unchanged', async () => {
  const f = fixture(), navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  f.client.forwardRpc = vi.fn(async () => ({ goal })) as any
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalLinks client={f.client} goal={goal} updated={() => {}} /></MobileWebUpdateSafetyProvider>)
  await fill(view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!, 'original-session')
  await click(button(view.element, '关联会话'))
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/#amux-update')
})

it('keeps an unsaved unknown request after its Goal view unmounts and retries bookkeeping without repeating the RPC', async () => {
  const f = fixture(), waiting = deferred<any>(), owner = getDeviceWorkface()
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' } as never)
  const rpc = vi.fn((..._args: any[]) => waiting.promise); f.client.forwardRpc = rpc as any
  vi.spyOn(owner, 'retainGoalRequest').mockRejectedValueOnce(Error('device storage unavailable'))
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  const render = (show: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalOperationSafety /><MobileGoalOperationRecovery copyText={vi.fn()} />{show && <MobileGoalLinks client={f.client} goal={goal} updated={() => {}} />}</MobileWebUpdateSafetyProvider>
  const view = await mount(render(true))
  await fill(view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!, 'session-after-failure')
  await click(button(view.element, '关联会话'))
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(rpc.mock.calls[0]![3]).toEqual({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' })
  await act(async () => { waiting.reject(Error('lost receipt')); await Promise.resolve() })
  await view.render(render(false))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('尚未保存在当前设备工作面') })
  await click(button(view.element, '保存原设备工作面'))
  expect(getDeviceWorkface().snapshot().record.goalOperationRecords?.some(item => JSON.stringify(item.request) === JSON.stringify(rpc.mock.calls[0]![1]))).toBe(true)
  expect(await apply()).toEqual({ status: 'navigating' }); expect(navigate).toHaveBeenCalledOnce()
  expect(rpc).toHaveBeenCalledTimes(1)
})

it('never replaces an existing operation with a different exact request or accepts a mismatched late receipt', async () => {
  const owner = getDeviceWorkface(), recordId = owner.recordIdentity()
  const item = { runtimeId: 'runtime-original', ownerInstanceId: 'owner-original', deviceHostId: 'host-original', origin: location.origin,
    method: 'goal.link-session' as const, request: { goalId: 'goal-original', operationId: 'collision-original', sessionId: 'session-original' } }
  await owner.retainGoalRequest(item, recordId)
  const different = { ...item, request: { ...item.request, sessionId: 'session-other' } }
  await expect(Promise.resolve().then(() => owner.retainGoalRequest(different, recordId))).rejects.toThrow('其他请求')
  await expect(Promise.resolve().then(() => owner.confirmGoalRequest(different, recordId))).rejects.toThrow('其他请求')
  expect(owner.snapshot().record.goalOperationRecords).toContainEqual(item)
  await owner.confirmGoalRequest(item, recordId)
  expect(owner.snapshot().record.goalOperationRecords).not.toContainEqual(item)
})

it('records unconfirmed runtime identity honestly while preserving the normal original request', async () => {
  const f = fixture(), waiting = deferred<any>(), rpc = vi.fn((..._args: any[]) => waiting.promise)
  f.client.runtimeOwnerIdentity = () => null; f.client.forwardRpc = rpc as any
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Update /><MobileGoalOperationSafety /><MobileGoalLinks client={f.client} goal={goal} updated={() => {}} /></MobileWebUpdateSafetyProvider>)
  await fill(view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')!, 'unverified-session')
  await click(button(view.element, '关联会话'))
  expect(rpc.mock.calls[0]![3]).toBeUndefined()
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.goalOperationRecords?.some(item => JSON.stringify(item.request) === JSON.stringify(rpc.mock.calls[0]![1]))).toBe(true))
  const record = getDeviceWorkface().snapshot().record.goalOperationRecords!.find(item => JSON.stringify(item.request) === JSON.stringify(rpc.mock.calls[0]![1]))!
  expect(record.runtimeId).toBeNull(); expect(record.ownerInstanceId).toBeNull()
  expect(await apply()).toEqual({ status: 'navigating' }); expect(navigate).toHaveBeenCalledOnce()
})
