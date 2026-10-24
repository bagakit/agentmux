import { act, createRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { MobileAttachments, type MobileAttachmentControls } from '../src/conversation/MobileAttachments'
import { MobileNoticeProvider, MobileNoticeRestore } from '../src/notices/MobileNotice'
import type { MobileFileUpload } from '../src/conversation/attachments'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { MobileRecoveryPanel } from '../src/recovery/MobileRecoveryPanel'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function connectedFixture() {
  const f = fixture()
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'original-appearance', dispose: async () => {} })
  f.client.forwardRpc = vi.fn(async method => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } }
    throw new Error('Original observation unavailable: ' + method)
  }) as typeof f.client.forwardRpc
  return f
}

it.each(['export', 'inspect'] as const)('shows a later explicit %s failure even when its explanation matches a dismissed failure', async action => {
  const original = getDeviceWorkface().snapshot().record
  const exportFile = vi.fn().mockRejectedValue(new Error('system save unavailable'))
  const view = await mount(<MobileNoticeProvider><MobileRecoveryPanel exportFile={exportFile} /></MobileNoticeProvider>)
  const invoke = async (index: number) => {
    if (action === 'export') await click(button(view.element, '导出工作面文件'))
    else await act(async () => {
      const input = view.element.querySelector<HTMLInputElement>('input[type=file]')!
      Object.defineProperty(input, 'files', { configurable: true, value: [{ name: `broken-${index}.json`, size: 4, text: async () => '{bad' }] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  await invoke(1)
  const first = view.element.querySelector('.mobile-notice')!.textContent
  await click(button(view.element.querySelector('.mobile-notice')!, '收起提醒'))
  expect(view.element.querySelector('.mobile-notice')).toBeNull()
  await invoke(2)
  const later = view.element.querySelector('.mobile-notice')
  expect(later, 'A new explicit operation must reveal its own failure').not.toBeNull()
  expect(later!.textContent).toBe(first)
  expect(getDeviceWorkface().snapshot().record).toEqual(original)
  expect(view.element.querySelector('.mobile-workface-candidate')).toBeNull()
  expect(exportFile).toHaveBeenCalledTimes(action === 'export' ? 2 : 0)
})

it('restores an original connection notice from the fixed App menu without losing draft or invoking an operation', async () => {
  getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const f = connectedFixture(), platform = createBrowserPlatform()
  const connection = { state: 'disconnected' as const, message: '原连接中断；健康状态未知' }
  const view = await mount(<MobileApp client={f.client} connection={connection} platform={platform} />)
  await paste(view.element, '离线保留的正文')
  const originalEditor = editor(view.element), packet = structuredClone(getDeviceWorkface().snapshot().record.conversation)
  await click(button(view.element.querySelector('.mobile-conversation__connection')!, '收起提醒'))
  expect(view.element.querySelector('.mobile-conversation__connection')).toBeNull()
  await click(button(view.element, '手机设置与连接'))
  await click(button(document.body, '提醒与诊断'))
  expect(document.body.querySelector('[role=dialog]')!.textContent).toContain('有已收起的提醒')
  await click(button(document.body, '恢复已收起提醒'))
  expect(view.element.querySelector('.mobile-conversation__connection')?.textContent).toContain(connection.message)
  expect(editor(view.element)).toBe(originalEditor)
  expect(originalEditor.textContent).toBe('离线保留的正文')
  expect(getDeviceWorkface().snapshot().record.conversation).toEqual(packet)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.inspectInput).not.toHaveBeenCalled()
  expect(f.client.forwardRpc).not.toHaveBeenCalledWith('agent.open', expect.anything())
})

it('dismisses the actual unreadable device-storage warning while preserving original bytes and editable draft', async () => {
  localStorage.setItem('agentmux-mobile-workface-v1', '{unreadable-original')
  const f = fixture()
  const view = await mount(<MobileNoticeProvider><MobileNoticeRestore /><MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={{ state: 'connected', message: '原 Host' }} platform={createBrowserPlatform()} /></MobileNoticeProvider>)
  await paste(view.element, '暂存于当前页的草稿')
  const originalEditor = editor(view.element)
  const issue = [...view.element.querySelectorAll<HTMLElement>('.mobile-notice')].find(value => value.textContent?.includes('原记录尚未覆盖'))!
  expect(issue).toBeDefined()
  await click(button(issue, '收起提醒'))
  expect(view.element.textContent).not.toContain('原记录尚未覆盖')
  await click(button(view.element, '恢复已收起提醒'))
  expect(view.element.textContent).toContain('原记录尚未覆盖')
  expect(editor(view.element)).toBe(originalEditor)
  expect(originalEditor.textContent).toBe('暂存于当前页的草稿')
  expect(localStorage.getItem('agentmux-mobile-workface-v1')).toBe('{unreadable-original')
  expect(f.submit).not.toHaveBeenCalled()
})

it('closes an original unknown upload warning without deleting its reference, inspecting or retrying its exact operation', async () => {
  const f = fixture(), controls = createRef<MobileAttachmentControls>(), insert = vi.fn(), pick = vi.fn()
  const original: MobileFileUpload = { runtimeId: 'original-runtime', phase: 'unknown', issue: '原上传回执未知',
    identity: { hostId: 'host-original', agentSessionId: 'session-original', expectedRun: { runId: 'run-original' },
      operationId: 'original-upload', name: 'evidence.png', mimeType: 'image/png', byteLength: 3, revision: 'sha256:' + 'a'.repeat(64) } }
  await getDeviceWorkface().retainFileUpload(original)
  f.client.forwardRpc = vi.fn()
  const view = await mount(<MobileNoticeProvider><MobileNoticeRestore /><MobileAttachments client={f.client} session={f.sessions.get('session-original')!}
    connected controls={controls} insert={insert} pickFile={pick} promptOperationId={null} confirmedPrompt={null} /></MobileNoticeProvider>)
  await click(button(view.element.querySelector('.mobile-notice')!, '收起提醒'))
  expect([...view.element.querySelectorAll('.mobile-notice')].map(node => node.textContent).join('')).not.toContain('原上传回执未知')
  expect(view.element.querySelector('details.mobile-attachment-details')?.hasAttribute('open')).toBe(false)
  expect(button(view.element, '核对 evidence.png 原上传')).toBeDefined()
  expect(view.element.querySelector('[aria-label="移除 evidence.png 本地引用"]')).toBeNull()
  await click(button(view.element, '恢复已收起提醒'))
  expect(view.element.textContent).toContain('原上传回执未知')
  expect(getDeviceWorkface().snapshot().record.fileUploads).toEqual([original])
  expect(f.client.forwardRpc).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled(); expect(pick).not.toHaveBeenCalled()
})
