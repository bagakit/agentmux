import { act } from 'react'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileNotice, MobileNoticeProvider, MobileNoticeRestore, MobileNoticeScope } from '../src/notices/MobileNotice'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { MobileMoteQuickEditor } from '../src/navigation/MobileMoteQuickEditor'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

it('dismisses only original presentation and restores portal recovery actions without invoking them', async () => {
  const retry = vi.fn(), owner = {}, portal = document.createElement('div')
  document.body.append(portal)
  const view = await mount(<MobileNoticeProvider><MobileNoticeScope owner={owner} identity={['original-SID', 'original-op']}>
    {createPortal(<MobileNotice identity={['read-failure']}><p>原读取失败</p><button onClick={retry}>重试原读取</button></MobileNotice>, portal)}
    <input aria-label="原草稿" defaultValue="完整原正文" />
    <MobileNoticeRestore />
  </MobileNoticeScope></MobileNoticeProvider>)
  const input = view.element.querySelector('input')!
  await click(button(portal, '收起提醒'))
  expect(portal.textContent).not.toContain('原读取失败')
  expect(view.element.textContent).toContain('有已收起的提醒')
  await click(button(view.element, '恢复已收起提醒'))
  expect(portal.textContent).toContain('原读取失败')
  expect(view.element.querySelector('input')).toBe(input)
  expect(input.value).toBe('完整原正文')
  expect(retry).not.toHaveBeenCalled()
  await click(button(portal, '重试原读取'))
  expect(retry).toHaveBeenCalledOnce()
})

it('separates exact owner, object and operation while keeping hidden owners and unrelated rerenders unchanged', async () => {
  const a = {}, b = {}, render = (owner: object, sid: string, operation: string, revision = 0) => <MobileNoticeProvider>
    <MobileNoticeScope owner={owner} identity={[sid]}><MobileNotice identity={[operation]}>同一说明</MobileNotice></MobileNoticeScope>
    <div hidden><MobileNoticeScope owner={owner} identity={['hidden-SID']}><MobileNotice>隐藏工作面说明</MobileNotice></MobileNoticeScope></div>
    <span>{revision}</span><MobileNoticeRestore />
  </MobileNoticeProvider>
  const view = await mount(render(a, 'SID-A', 'op-1'))
  await click(button(view.element.querySelector('.mobile-notice')!, '收起提醒'))
  await view.render(render(a, 'SID-A', 'op-1', 1))
  expect(view.element.textContent).not.toContain('同一说明')
  expect(view.element.querySelector('[hidden]')!.textContent).toContain('隐藏工作面说明')
  await view.render(render(a, 'SID-B', 'op-1')); expect(view.element.textContent).toContain('同一说明')
  await view.render(render(a, 'SID-A', 'op-2')); expect(view.element.textContent).toContain('同一说明')
  await view.render(render(b, 'SID-A', 'op-1')); expect(view.element.textContent).toContain('同一说明')
  await view.render(render(a, 'SID-A', 'op-1')); expect(view.element.textContent).not.toContain('同一说明')
  await click(button(view.element, '恢复已收起提醒'))
  expect(view.element.textContent).toContain('同一说明')
})

it('restores original T1 mounted preferences, then preserves later dismissal across remount and neighboring consumers', async () => {
  const f = fixture(), platform = createBrowserPlatform()
  f.submit.mockRejectedValue(new Error('原投递回执丢失'))
  const render = (show = true, other = false) => <MobileNoticeProvider><MobileNoticeRestore />
    {show && <MobileConversationSurface client={f.client} agentSessionId="session-original" connection={{ state: 'connected', message: '原 Host' }} platform={platform} />}
    {other && <MobileConversationSurface client={f.client} agentSessionId="other" connection={{ state: 'connected', message: '原 Host' }} platform={platform} />}
  </MobileNoticeProvider>
  const view = await mount(render())
  await paste(view.element, '原投递正文')
  await click(button(view.element, 'Send'))
  await act(async () => { await vi.waitFor(() => expect(view.element.querySelector('.mobile-send-status[data-phase=unknown]')).not.toBeNull()) })
  const packet = structuredClone(getDeviceWorkface().snapshot().record.conversation)
  const inspected = f.inspectInput.mock.calls.length
  await click(button(view.element, '关闭操作说明'))
  expect(view.element.querySelector('.mobile-send-status--collapsed')).not.toBeNull()
  await click(button(view.element, '恢复已收起提醒'))
  expect(view.element.querySelector('.mobile-send-status--collapsed')).toBeNull()
  expect(f.inspectInput.mock.calls.length).toBe(inspected)
  await click(button(view.element, '关闭操作说明'))
  await view.render(render(false, true))
  expect(view.element.textContent).toContain('有已收起的提醒')
  await view.render(render(true))
  expect(view.element.querySelector('.mobile-send-status--collapsed')).not.toBeNull()
  expect(editor(view.element).textContent).toBe('原投递正文')
  expect(getDeviceWorkface().snapshot().record.conversation).toEqual(packet)
  expect(f.submit).toHaveBeenCalledOnce()
  expect(f.inspectInput).toHaveBeenCalledExactlyOnceWith({ key: { kind: 'prompt', agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, submissionId: f.submit.mock.calls[0]![0].operationId } })
})

it('keeps the original QuickEditor feedback dismissed when an unchanged inline target is recreated', async () => {
  const f = fixture()
  f.client.forwardRpc = vi.fn().mockRejectedValue(new Error('原配置读取不可用'))
  const target = { spaceId: 'original-mote', zoneId: 'original-zone', expectedResource: { hostId: 'host-original', workspaceId: 'original-workspace', workspacePath: fixturePath('original/workspace') } }
  const render = (revision: number) => <MobileNoticeProvider><span>{revision}</span><MobileMoteQuickEditor client={f.client}
    target={{ ...target }} visible copyText={createBrowserPlatform().copyText} onClose={() => {}} onSaved={() => {}} /></MobileNoticeProvider>
  const view = await mount(render(0))
  await act(async () => { await vi.waitFor(() => expect(view.element.querySelector('.mobile-notice')).not.toBeNull()) })
  await click(button(view.element.querySelector('.mobile-notice')!, '收起提醒'))
  await view.render(render(1))
  expect(view.element.querySelector('.mobile-notice')).toBeNull()
  expect(view.element.querySelector('form')).not.toBeNull()
})
