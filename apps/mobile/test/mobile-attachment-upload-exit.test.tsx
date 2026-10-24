import { act, createRef } from 'react'
import { Blob as NodeBlob } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FileUploadOwner } from '../../host/src/file-upload-owner'
import { AgentMuxRpcService, type AgentMuxRpcCorePort } from '../../../packages/core/src/public-rpc-service'
import { fileUploadRevision } from '@agentmux/core/files'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { MobileAttachments, type MobileAttachmentControls } from '../src/conversation/MobileAttachments'
import { MobileApp } from '../src/MobileApp'
import { MobileWebUpdateSafetyProvider, useMobileWebAttachmentOwner, useMobileWebUpdateSafety } from '../src/mobile-web/update-safety'
import type { AttachmentPageOwner } from '../src/conversation/attachment-page-owner'
import { nativeDevicePorts } from '../src/platform/native/device'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

let root: string, apply: ReturnType<typeof useMobileWebUpdateSafety>['apply']
let attachmentOwner: AttachmentPageOwner
const picker = nativeDevicePorts.filePicker
function Action() { apply = useMobileWebUpdateSafety().apply; return null }
function AttachmentProbe() { attachmentOwner = useMobileWebAttachmentOwner(); return null }
const verifyConnection = async () => () => true
const platform = createBrowserPlatform(), connected = { state: 'connected' as const, message: '原连接' }
function bound() {
  const f = fixture(), owner = new FileUploadOwner(join(root, 'uploads'))
  for (const [id, value] of f.sessions) f.sessions.set(id, { ...value, hostId: 'local' })
  const core = { agentSessions: () => [...f.sessions.values()], readAgentSession: async (id: string) => f.sessions.get(id) ?? null,
    readAgentSessions: async () => [...f.sessions.values()], sessionHistorySources: async () => [] } as unknown as AgentMuxRpcCorePort
  const service = new AgentMuxRpcService({ fileUploads: owner, coreClients: () => [{ hostId: 'local', client: core }] })
  const forward = vi.fn(async (method: any, params: any) => service.call(method, JSON.parse(JSON.stringify(params)), { principal: { kind: 'device', id: 'phone' }, assertCurrent: () => {} }))
  Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'runtime-original' }), forwardRpc: forward })
  nativeDevicePorts.filePicker = { pickFiles: vi.fn().mockResolvedValue({ files: [{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) }] }) } as any
  return { ...f, owner, forward }
}
beforeEach(async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); root = await mkdtemp(join(tmpdir(), 'amx-upload-exit-'))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, url: location.origin + '/mobile/new-build/' + 'a'.repeat(64) + '/index.html' })))
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  nativeDevicePorts.filePicker = picker; vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true })
})
function render(f: ReturnType<typeof bound>) { return <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider> }

it('ends a dispatched original upload, confirms only the local copy discard and never inserts a late Host receipt', async () => {
  const f = bound(), receipt = deferred<any>(), originalForward = f.forward.getMockImplementation()!
  f.forward.mockImplementation(async (method, params) => { const result = await originalForward(method, params); return method === 'file.upload' ? receipt.promise : result })
  const view = await mount(render(f))
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read'))
  await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(f.forward).toHaveBeenCalledOnce())
  const original = structuredClone(getDeviceWorkface().snapshot().record.fileUploads![0]!)
  await vi.waitFor(async () => expect((await f.owner.inspect(original.identity)).status).toBe('uploaded'))
  await click(button(view.element, '结束等待'))
  expect(view.element.textContent).toContain('原操作回执未知')
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  await click(button(view.element, '管理 screen.png 本机副本'))
  expect(button(view.element, '管理 screen.png 本机副本').getAttribute('aria-expanded')).toBe('true')
  await click(button(view.element, '放弃本机副本')); await click(button(view.element, '保留'))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  await click(button(view.element, '放弃本机副本')); await click(button(view.element, '确认放弃'))
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(getDeviceWorkface().snapshot().record.fileUploads![0]!.identity).toEqual(original.identity)
  const actualReceipt = await f.owner.inspect(original.identity)
  await act(async () => receipt.resolve(actualReceipt))
  expect(editor(view.element).textContent).toBe('原正文'); expect(f.submit).not.toHaveBeenCalled()
  expect(f.forward.mock.calls.filter(call => call[0] === 'file.upload')).toHaveLength(1)
})

it('retains the original file across real MobileApp unmount and remount under the same update owner', async () => {
  const f = bound(), rpc = f.forward.getMockImplementation()!
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'appearance', dispose: async () => {} })
  f.forward.mockImplementation(async (method, params) => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } } as any
    if (method === 'app.snapshot') return { agents: [] } as any
    if (method === 'agent.inspect') return { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } } as any
    return rpc(method, params)
  })
  await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const app = <MobileApp client={f.client} connection={connected} platform={platform} />
  const renderApp = (show: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />{show && app}</MobileWebUpdateSafetyProvider>
  const view = await mount(renderApp(true))
  await click(button(view.element, 'Reference files for the Agent to read'))
  expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('screen.png')
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  await view.render(renderApp(false))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  await view.render(renderApp(true))
  expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('screen.png')
  await click(button(view.element, '移除 screen.png 本地引用'))
  expect(await apply()).toEqual({ status: 'navigating' })
})

it('ends a pure inspection without claiming upload was dispatched or repeating the original upload', async () => {
  const f = bound(), gate = deferred<any>(), originalForward = f.forward.getMockImplementation()!
  f.forward.mockImplementation(async (method, params) => {
    if (method === 'file.upload') throw new Error('no original upload receipt')
    if (method === 'file.upload.inspect') return gate.promise
    return originalForward(method, params)
  })
  const view = await mount(render(f))
  await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('unknown'))
  const original = structuredClone(getDeviceWorkface().snapshot().record.fileUploads![0]!)
  await click(button(view.element, '核对 screen.png 原上传'))
  await vi.waitFor(() => expect(f.forward.mock.calls.map(call => call[0])).toEqual(['file.upload', 'file.upload.inspect']))
  await click(button(view.element, '结束等待'))
  expect(view.element.textContent).toContain('原上传是否发生仍未知')
  expect(getDeviceWorkface().snapshot().record.fileUploads![0]!.identity).toEqual(original.identity)
  const observed = await f.owner.inspect(original.identity)
  await act(async () => gate.resolve(observed))
  expect(f.forward.mock.calls.map(call => call[0])).toEqual(['file.upload', 'file.upload.inspect'])
  expect(f.submit).not.toHaveBeenCalled()
})

it('does not infer an upload from a dispatched inspect of an unobserved original operation', async () => {
  const f = bound(), gate = deferred<any>(), bytes = Buffer.from('file')
  const original = { runtimeId: 'runtime-original', identity: { hostId: 'local', agentSessionId: 'session-original', expectedRun: { runId: 'run-original' },
    operationId: 'original-inspection-only', name: 'screen.png', mimeType: 'image/png', byteLength: 4, revision: fileUploadRevision(bytes) }, phase: 'unknown' as const }
  await getDeviceWorkface().retainFileUpload(original)
  f.forward.mockImplementation(async () => gate.promise)
  const view = await mount(render(f))
  await click(button(view.element, '核对 screen.png 原上传'))
  await vi.waitFor(() => expect(f.forward.mock.calls.map(call => call[0])).toEqual(['file.upload.inspect']))
  await click(button(view.element, '结束等待'))
  expect(view.element.textContent).toContain('原上传是否发生仍未知')
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(getDeviceWorkface().snapshot().record.fileUploads![0]!.identity).toEqual(original.identity)
  await act(async () => gate.resolve(await f.owner.inspect(original.identity)))
  expect(f.forward.mock.calls.map(call => call[0])).toEqual(['file.upload.inspect']); expect(f.submit).not.toHaveBeenCalled()
})

it('cancels the pre-dispatch continuation even if the original device save finishes late', async () => {
  const f = bound(), owner = getDeviceWorkface(), gate = deferred<void>(), entered = deferred<void>(), retain = owner.retainFileUpload.bind(owner)
  vi.spyOn(owner, 'retainFileUpload').mockImplementation(async (...args) => { entered.resolve(); await gate.promise; return retain(...args) })
  const view = await mount(render(f))
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read'))
  await click(button(view.element, '上传并加入 screen.png')); await act(async () => entered.promise)
  await click(button(view.element, '结束等待'))
  expect(view.element.textContent).toContain('设备仍在保全原操作')
  expect(f.forward).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
  await act(async () => gate.resolve())
  await vi.waitFor(() => expect(view.element.textContent).toContain('原请求尚未派发'))
  expect(f.forward).not.toHaveBeenCalled(); expect(editor(view.element).textContent).toBe('原正文')
  expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('sending')
})

it('does not apply a late receipt to a replacement device workface with the same operation ID', async () => {
  const f = bound(), gate = deferred<any>(), originalForward = f.forward.getMockImplementation()!
  f.forward.mockImplementation(async (method, params) => { const value = await originalForward(method, params); return method === 'file.upload' ? gate.promise : value })
  const view = await mount(render(f))
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(f.forward).toHaveBeenCalledOnce())
  const original = structuredClone(getDeviceWorkface().snapshot().record.fileUploads![0]!)
  await vi.waitFor(async () => expect((await f.owner.inspect(original.identity)).status).toBe('uploaded'))
  const oldReceipt = await f.owner.inspect(original.identity)
  await click(button(view.element, '结束等待'))
  await act(async () => { await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
  const replacement = { ...original, identity: { ...original.identity, name: 'replacement.png' }, phase: 'unknown' as const }
  await getDeviceWorkface().retainFileUpload(replacement)
  await act(async () => gate.resolve(oldReceipt))
  await vi.waitFor(() => expect(view.element.textContent).toContain('原附件回执尚未保全'))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(getDeviceWorkface().snapshot().record.fileUploads).toEqual([replacement])
  expect(view.element.querySelector('.mobile-attachment')?.getAttribute('data-phase')).toBe('unknown')
  expect(editor(view.element).textContent).toBe('原正文'); expect(f.submit).not.toHaveBeenCalled()
})

it('never treats a failed or merely requested browser export as a saved local copy', async () => {
  const f = bound()
  f.forward.mockRejectedValueOnce(new Error('original upload receipt unavailable'))
  const view = await mount(render(f))
  await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('unknown'))
  await click(button(view.element, '管理 screen.png 本机副本'))
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('browser refused') })
  const clickLink = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await click(button(view.element, '保存本机副本'))
  expect(view.element.textContent).toContain('本机副本未确认保存')
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  create.mockReturnValue('blob:controlled')
  await click(button(view.element, '保存本机副本'))
  expect(clickLink).toHaveBeenCalledOnce(); expect(view.element.textContent).toContain('浏览器尚未确认文件已保存')
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  await click(button(view.element, '保留'))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  await click(button(view.element, '保存本机副本')); await click(button(view.element, '已保存，移除副本'))
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('unknown')
  expect(f.forward.mock.calls.filter(call => call[0] === 'file.upload')).toHaveLength(1)
})

it('does not let a newer failed inspection erase a late confirmed original upload', async () => {
  const f = bound(), uploadGate = deferred<any>(), inspectGate = deferred<any>(), originalForward = f.forward.getMockImplementation()!
  f.forward.mockImplementation(async (method, params) => {
    if (method === 'file.upload') { await originalForward(method, params); return uploadGate.promise }
    if (method === 'file.upload.inspect') return inspectGate.promise
    return originalForward(method, params)
  })
  const view = await mount(render(f))
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(f.forward).toHaveBeenCalledOnce())
  const original = getDeviceWorkface().snapshot().record.fileUploads![0]!
  await vi.waitFor(async () => expect((await f.owner.inspect(original.identity)).status).toBe('uploaded'))
  const actual = await f.owner.inspect(original.identity)
  await click(button(view.element, '结束等待')); await click(button(view.element, '核对 screen.png 原上传'))
  await vi.waitFor(() => expect(f.forward.mock.calls.map(call => call[0])).toEqual(['file.upload', 'file.upload.inspect']))
  await act(async () => uploadGate.resolve(actual))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('uploaded'))
  await act(async () => inspectGate.reject(new Error('late inspect unavailable')))
  await vi.waitFor(() => expect(view.element.textContent).toContain('原附件回执尚未保全'))
  expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('uploaded')
  expect(editor(view.element).textContent).toBe('原正文'); expect(f.submit).not.toHaveBeenCalled()
  expect(f.forward.mock.calls.map(call => call[0])).toEqual(['file.upload', 'file.upload.inspect'])
})

it('reconnects an in-flight upload owner after real MobileApp unmount and fences its late receipt', async () => {
  const f = bound(), gate = deferred<any>(), forward = f.forward.getMockImplementation()!
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'appearance', dispose: async () => {} })
  f.forward.mockImplementation(async (method, params) => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } } as any
    if (method === 'app.snapshot') return { agents: [] } as any
    if (method === 'agent.inspect') return { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } } as any
    const value = await forward(method, params); return method === 'file.upload' ? gate.promise : value
  })
  await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const surface = <MobileApp client={f.client} connection={connected} platform={platform} />
  const renderSurface = (show: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />{show && surface}</MobileWebUpdateSafetyProvider>
  const view = await mount(renderSurface(true))
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(f.forward.mock.calls.filter(call => call[0] === 'file.upload')).toHaveLength(1))
  const original = getDeviceWorkface().snapshot().record.fileUploads![0]!
  await vi.waitFor(async () => expect((await f.owner.inspect(original.identity)).status).toBe('uploaded'))
  const receipt = await f.owner.inspect(original.identity)
  await view.render(renderSurface(false))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('附件操作') })
  await view.render(renderSurface(true))
  await click(button(view.element, '结束等待'))
  await act(async () => gate.resolve(receipt))
  expect(editor(view.element).textContent).toBe('原正文'); expect(f.submit).not.toHaveBeenCalled()
  expect(f.forward.mock.calls.filter(call => call[0] === 'file.upload')).toHaveLength(1)
})

it('reconnects an original picker batch after conversation unmount and cancels only that batch', async () => {
  const f = bound(), gate = deferred<any>()
  nativeDevicePorts.filePicker = { pickFiles: vi.fn().mockReturnValue(gate.promise) } as any
  const surface = <MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />
  const renderSurface = (show: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />{show && surface}</MobileWebUpdateSafetyProvider>
  const view = await mount(renderSurface(true))
  await click(button(view.element, 'Reference files for the Agent to read'))
  await view.render(renderSurface(false))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('选择') })
  await view.render(renderSurface(true))
  await click(button(view.element, '取消本次选择'))
  expect(await apply()).toEqual({ status: 'navigating' })
  await act(async () => gate.resolve({ files: [{ name: 'late.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file']) }] }))
  expect(view.element.querySelector('.mobile-attachment')).toBeNull()
  expect(f.forward).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('keeps a synchronous RPC failure unknown and never automatically uploads the original again', async () => {
  const f = bound()
  f.forward.mockImplementation(() => { throw new Error('synchronous transport failure') })
  const view = await mount(render(f))
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('unknown'))
  expect(view.element.textContent).not.toContain('原请求尚未派发')
  expect(f.forward.mock.calls.map(call => call[0])).toEqual(['file.upload'])
  expect(f.submit).not.toHaveBeenCalled()
  await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(f.forward.mock.calls.length).toBe(2))
  expect(f.forward.mock.calls.map(call => call[0])).toEqual(['file.upload', 'file.upload.inspect'])
  expect(f.submit).not.toHaveBeenCalled()
})

it('does not overwrite retained bytes or a pending confirmation on an operation ID collision', async () => {
  const f = bound(), controls = createRef<MobileAttachmentControls>(), body = Buffer.from('file')
  let name = 'original.png'
  const pick = async () => ({ id: 'same-operation', name, mimeType: 'image/png', size: 4, revision: fileUploadRevision(body), dataBase64: body.toString('base64') })
  f.forward.mockRejectedValue(new Error('original receipt unavailable'))
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileAttachments client={f.client} session={f.sessions.get('session-original')!} connected
    promptOperationId={null} confirmedPrompt={null} controls={controls} insert={async read => { await read() }} pickFile={pick} /></MobileWebUpdateSafetyProvider>)
  await act(async () => controls.current!.choose()); await click(button(view.element, '上传并加入 original.png'))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('unknown'))
  const original = structuredClone(getDeviceWorkface().snapshot().record.fileUploads![0]!)
  await click(button(view.element, '管理 original.png 本机副本'))
  await click(button(view.element, '放弃本机副本'))
  name = 'different.png'; await act(async () => controls.current!.choose())
  expect(view.element.textContent).toContain('附件操作标识与原记录冲突')
  expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('original.png')
  expect(getDeviceWorkface().snapshot().record.fileUploads).toEqual([original])
  await click(button(view.element, '保留'))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
})

it('returns to the original Session to resolve its upload without touching another Session', async () => {
  const f = bound(), gate = deferred<any>(), forward = f.forward.getMockImplementation()!
  f.forward.mockImplementation(async (method, params) => { const result = await forward(method, params); return method === 'file.upload' ? gate.promise : result })
  const renderSession = (id: string) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client} agentSessionId={id} connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>
  const view = await mount(renderSession('session-original'))
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(f.forward).toHaveBeenCalledOnce())
  const original = getDeviceWorkface().snapshot().record.fileUploads![0]!
  await vi.waitFor(async () => expect((await f.owner.inspect(original.identity)).status).toBe('uploaded'))
  const receipt = await f.owner.inspect(original.identity)
  await view.render(renderSession('other'))
  await paste(view.element, '另一个会话的正文')
  expect(view.element.querySelector('.mobile-attachment')).toBeNull()
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('Session session-original') })
  await view.render(renderSession('session-original'))
  await click(button(view.element, '结束等待'))
  await click(button(view.element, '管理 screen.png 本机副本'))
  await click(button(view.element, '放弃本机副本')); await click(button(view.element, '确认放弃'))
  await act(async () => gate.resolve(receipt))
  expect(editor(view.element).textContent).toBe('原正文')
  await view.render(renderSession('other'))
  expect(editor(view.element).textContent).toBe('另一个会话的正文')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.forward.mock.calls.filter(call => call[0] === 'file.upload')).toHaveLength(1)
})

it('retains a late original upload after real App remount until the new editor explicitly inserts it', async () => {
  const f = bound(), gate = deferred<any>(), forward = f.forward.getMockImplementation()!
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'appearance', dispose: async () => {} })
  f.forward.mockImplementation(async (method, params) => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } } as any
    if (method === 'app.snapshot') return { agents: [] } as any
    if (method === 'agent.inspect') return { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } } as any
    const value = await forward(method, params); return method === 'file.upload' ? gate.promise : value
  })
  await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const app = <MobileApp client={f.client} connection={connected} platform={platform} />
  const scene = (show: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />{show && app}</MobileWebUpdateSafetyProvider>
  const view = await mount(scene(true))
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(f.forward.mock.calls.filter(call => call[0] === 'file.upload')).toHaveLength(1))
  const original = getDeviceWorkface().snapshot().record.fileUploads![0]!
  await vi.waitFor(async () => expect((await f.owner.inspect(original.identity)).status).toBe('uploaded'))
  const receipt = await f.owner.inspect(original.identity)
  await view.render(scene(false)); await view.render(scene(true))
  await act(async () => gate.resolve(receipt))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('uploaded'))
  expect(editor(view.element).textContent).toBe('原正文')
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  await click(button(view.element, '将 screen.png 加入消息'))
  await vi.waitFor(() => expect(editor(view.element).textContent).toContain('screen.png'))
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.forward.mock.calls.filter(call => call[0] === 'file.upload')).toHaveLength(1)
})

it('does not apply a discard confirmation to a replaced original byte object', async () => {
  const f = bound()
  f.forward.mockRejectedValue(new Error('original receipt unavailable'))
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><AttachmentProbe /><MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('unknown'))
  await click(button(view.element, '管理 screen.png 本机副本')); await click(button(view.element, '放弃本机副本'))
  const id = getDeviceWorkface().snapshot().record.fileUploads![0]!.identity.operationId, original = attachmentOwner.bytes.current.get(id)!
  await act(async () => { attachmentOwner.bytes.current.set(id, { ...original }); attachmentOwner.changed() })
  await click(button(view.element, '确认放弃'))
  expect(view.element.textContent).toContain('原附件或其操作已变化')
  expect(attachmentOwner.bytes.current.get(id)).not.toBe(original)
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  expect(f.submit).not.toHaveBeenCalled()
})

it('keeps an unconfirmed browser export across late upload, explicit insertion and App remount', async () => {
  const f = bound(), gate = deferred<any>(), forward = f.forward.getMockImplementation()!
  f.forward.mockImplementation(async (method, params) => { const result = await forward(method, params); return method === 'file.upload' ? gate.promise : result })
  const surface = <MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />
  const scene = (show: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />{show && surface}</MobileWebUpdateSafetyProvider>
  const view = await mount(scene(true))
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(f.forward).toHaveBeenCalledOnce())
  const original = getDeviceWorkface().snapshot().record.fileUploads![0]!
  await vi.waitFor(async () => expect((await f.owner.inspect(original.identity)).status).toBe('uploaded'))
  const receipt = await f.owner.inspect(original.identity)
  await click(button(view.element, '结束等待')); await click(button(view.element, '管理 screen.png 本机副本'))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:controlled'); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await click(button(view.element, '保存本机副本')); await click(button(view.element, '保留'))
  await act(async () => gate.resolve(receipt))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('uploaded'))
  await click(button(view.element, '将 screen.png 加入消息'))
  await vi.waitFor(() => expect(editor(view.element).textContent).toContain('screen.png'))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  await view.render(scene(false)); await view.render(scene(true))
  expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('screen.png')
  await click(button(view.element, '管理 screen.png 本机副本')); await click(button(view.element, '确认已另存'))
  await click(button(view.element, '已保存，移除副本'))
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(f.submit).not.toHaveBeenCalled(); expect(f.forward.mock.calls.filter(call => call[0] === 'file.upload')).toHaveLength(1)
})

it('keeps an unconfirmed export through ordinary Send, insertion commit and its confirmation', async () => {
  const f = bound(), forward = f.forward.getMockImplementation()!
  f.forward.mockImplementation(async (method, params) => { const result = await forward(method, params); if (method === 'file.upload') throw new Error('receipt unavailable'); return result })
  const view = await mount(render(f))
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('unknown'))
  await click(button(view.element, '管理 screen.png 本机副本'))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:controlled'); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await click(button(view.element, '保存本机副本')); await click(button(view.element, '保留'))
  await click(button(view.element, 'Send')); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('inserted'))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('screen.png')
  await click(button(view.element, '确认已另存')); await click(button(view.element, '已保存，移除副本'))
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.forward.mock.calls.map(call => call[0])).toEqual(['file.upload', 'file.upload.inspect'])
})

it('retains an unconfirmed export when a manual inspection inserts its confirmed Host path', async () => {
  const f = bound(), forward = f.forward.getMockImplementation()!
  f.forward.mockImplementation(async (method, params) => { const result = await forward(method, params); if (method === 'file.upload') throw new Error('receipt unavailable'); return result })
  const view = await mount(render(f))
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read')); await click(button(view.element, '上传并加入 screen.png'))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('unknown'))
  await click(button(view.element, '管理 screen.png 本机副本'))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:controlled'); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await click(button(view.element, '保存本机副本')); await click(button(view.element, '保留'))
  await click(button(view.element, '核对 screen.png 原上传'))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('inserted'))
  expect(editor(view.element).textContent).toContain('screen.png')
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  expect(f.submit).not.toHaveBeenCalled()
  await click(button(view.element, '确认已另存')); await click(button(view.element, '已保存，移除副本'))
  expect(await apply()).toEqual({ status: 'navigating' })
})
