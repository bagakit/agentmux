import './mobile-lan-crypto.setup'
import { Blob as NodeBlob } from 'node:buffer'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { nativeDevicePorts } from '../src/platform/native/device'
import { MobileWebUpdateSafetyProvider } from '../src/mobile-web/update-safety'
import { mobileUpdateFragment } from '../src/connection/reload-identity'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const network = vi.hoisted(() => ({ attempts: 0 }))
// Only the module transport is controlled. The actual MobileApp, reload action
// and original safety owner consume the failure and preserve the same workface.
vi.mock('../src/navigation/defer-mobile-surface', async original => {
  const actual = await original<typeof import('../src/navigation/defer-mobile-surface')>()
  return { deferMobileSurface(label: string, load: () => Promise<{ default: React.ComponentType<object> }>) {
    return actual.deferMobileSurface(label, label !== '终端' ? load : () => {
      network.attempts += 1
      return Promise.reject(new Error('Module response unavailable'))
    })
  } }
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear()
})

async function failedPanel(withImage = false) {
  window.history.replaceState(null, '', '/mobile/original-build/' + 'a'.repeat(64) + '/index.html'); localStorage.clear()
  const owner = getDeviceWorkface(); await owner.replaceBackup(emptyDeviceWorkface())
  await owner.updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const f = fixture(), verifyConnection = vi.fn(async () => () => true), prepareReload = vi.fn(() => () => {})
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  const fetchEntry = vi.fn(async () => ({ ok: true, url: location.origin + '/mobile/original-build/' + 'a'.repeat(64) + '/index.html' }) as Response)
  vi.stubGlobal('fetch', fetchEntry)
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'appearance-observation', dispose: async () => {} })
  f.client.forwardRpc = vi.fn().mockImplementation(async method => {
    if (method === 'agent.inspect') return { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } }
    throw new Error('No unrelated read configured: ' + method)
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection} prepareReload={prepareReload}>
    <MobileApp client={f.client} connection={{ state: 'connected', message: '已连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  const originalEditor = editor(view.element)
  await paste(view.element, '未确认消息的原草稿')
  f.submit.mockRejectedValueOnce(new Error('Original input receipt unavailable'))
  await click(button(view.element, 'Send'))
  const operationId = f.submit.mock.calls[0]![0].operationId
  await vi.waitFor(() => expect(owner.snapshot().record.conversation.attempts[0]![1].phase).toBe('unknown'))
  let image: Element | null = null
  if (withImage) {
    const blob = new NodeBlob(['image'], { type: 'image/png' })
    vi.spyOn(nativeDevicePorts.filePicker, 'pickFiles').mockResolvedValue({ files: [{ name: 'retained.png', mimeType: 'image/png', size: blob.size, blob: blob as unknown as Blob }] })
    await click(button(view.element, 'Reference files for the Agent to read'))
    await vi.waitFor(() => expect(view.element.querySelector('.mobile-attachment-preview')).not.toBeNull())
    image = view.element.querySelector('.mobile-attachment-preview')
  }
  await click(button(view.element, '查看终端'))
  expect(view.element.querySelector('.mobile-terminal-panel')?.textContent).toContain('终端暂时无法打开')
  return { ...f, ...view, owner, originalEditor, operationId, image, verifyConnection, prepareReload, navigate, fetchEntry }
}

it('reopens a failed panel through the original safety owner without replaying the retained unknown input', async () => {
  const f = await failedPanel()
  await click(button(f.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '保全并重新打开网页'))
  await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledOnce())
  expect(f.navigate).toHaveBeenCalledWith('/' + mobileUpdateFragment)
  expect(f.verifyConnection).toHaveBeenCalledTimes(2)
  expect(f.prepareReload).toHaveBeenCalledOnce()
  expect(f.fetchEntry).toHaveBeenCalledOnce()
  expect(editor(f.element)).toBe(f.originalEditor)
  expect(f.owner.snapshot().record.conversation.attempts[0]![1]).toMatchObject({ operationId: f.operationId, phase: 'unknown' })
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('shows the original image-preservation blocker and keeps return available without forcing page navigation', async () => {
  const f = await failedPanel(true)
  await click(button(f.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '保全并重新打开网页'))
  expect(f.element.querySelector('.mobile-terminal-panel')?.textContent).toContain('所选附件仅保存在当前页面')
  expect(f.verifyConnection).not.toHaveBeenCalled(); expect(f.fetchEntry).not.toHaveBeenCalled(); expect(f.prepareReload).not.toHaveBeenCalled()
  expect(f.navigate).not.toHaveBeenCalled()
  await click(button(f.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '返回'))
  expect(f.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
  expect(editor(f.element)).toBe(f.originalEditor)
  expect(f.originalEditor.textContent).toBe('未确认消息的原草稿')
  expect(f.element.querySelector('.mobile-attachment-preview')).toBe(f.image)
  expect(f.owner.snapshot().record.conversation.attempts[0]![1].operationId).toBe(f.operationId)
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('keeps the original page when the user returns during entry preflight', async () => {
  const f = await failedPanel(), pending = deferred<Response>()
  f.fetchEntry.mockReturnValueOnce(pending.promise)
  await click(button(f.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '保全并重新打开网页'))
  await vi.waitFor(() => expect(f.fetchEntry).toHaveBeenCalledOnce())
  await click(button(f.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '返回'))
  await vi.waitFor(() => expect(f.owner.snapshot().record.panel).toBe('conversation'))
  await act(async () => pending.resolve({ ok: true, url: location.origin + '/mobile/original-build/' + 'a'.repeat(64) + '/index.html' } as Response))
  expect(f.navigate).not.toHaveBeenCalled(); expect(f.prepareReload).not.toHaveBeenCalled()
  expect(editor(f.element)).toBe(f.originalEditor)
  expect(f.owner.snapshot().record.conversation.attempts[0]![1].operationId).toBe(f.operationId)
  expect(f.submit).toHaveBeenCalledOnce()
})

it('cancels the original reopening intent when Return is used during the first connection check', async () => {
  const f = await failedPanel(), pending = deferred<() => boolean>()
  f.verifyConnection.mockReturnValueOnce(pending.promise)
  await click(button(f.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '保全并重新打开网页'))
  expect(f.verifyConnection).toHaveBeenCalledOnce()
  await click(button(f.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '返回'))
  await vi.waitFor(() => expect(f.owner.snapshot().record.panel).toBe('conversation'))
  await act(async () => pending.resolve(() => true))
  await vi.waitFor(() => expect(f.element.querySelector('.mobile-terminal-panel')?.textContent).toContain('保全并重新打开网页'))
  expect(f.navigate).not.toHaveBeenCalled()
  expect(f.prepareReload).not.toHaveBeenCalled()
  expect(editor(f.element)).toBe(f.originalEditor)
  expect(f.submit).toHaveBeenCalledOnce()
})

it('withdraws only the hidden panel reopening intent and permits a new explicit attempt before its old check settles', async () => {
  const f = await failedPanel(), pending = deferred<() => boolean>()
  f.verifyConnection.mockReturnValueOnce(pending.promise)
  await click(button(f.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '保全并重新打开网页'))
  await click(button(f.element, '查看对话'))
  await vi.waitFor(() => expect(f.owner.snapshot().record.panel).toBe('conversation'))
  await vi.waitFor(() => expect(button(f.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '保全并重新打开网页').disabled).toBe(false))
  expect(f.fetchEntry).not.toHaveBeenCalled(); expect(f.navigate).not.toHaveBeenCalled()
  await click(button(f.element, '查看终端'))
  await click(button(f.element.querySelector<HTMLElement>('.mobile-terminal-panel')!, '保全并重新打开网页'))
  await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledOnce())
  await act(async () => pending.resolve(() => true))
  expect(f.fetchEntry).toHaveBeenCalledOnce(); expect(f.prepareReload).toHaveBeenCalledOnce(); expect(f.navigate).toHaveBeenCalledOnce()
  expect(editor(f.element)).toBe(f.originalEditor)
  expect(f.owner.snapshot().record.conversation.attempts[0]![1].operationId).toBe(f.operationId)
  expect(f.submit).toHaveBeenCalledOnce()
})
