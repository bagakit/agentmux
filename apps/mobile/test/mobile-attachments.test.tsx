import { act, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileUploadOwner } from '../../desktop/src/main/file-upload-owner'
import { AgentMuxRpcService, type AgentMuxRpcCorePort } from '../../../packages/core/src/public-rpc-service'
import { fileUploadRevision, FILE_UPLOAD_MAX_BYTES, type FileUploadParams } from '../../../packages/core/src/public-rpc-files'
import { MobileAttachments, type MobileAttachmentControls } from '../src/conversation/MobileAttachments'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { fileUploadScopeMatches, type MobileFileUpload } from '../src/conversation/attachments'
import { getDeviceWorkface, emptyDeviceWorkface } from '../src/recovery/device-workface'
import { nativeDevicePorts, pickLocalAttachment, type NativeDevicePorts, type LocalAttachment } from '../src/platform/native/device'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, deferred, editor, fixture, mount, mounted, paste, session } from './conversation-fixture'
import { attachmentHostedFixture } from './file-upload-hosted-fixture'

let root: string
const disposers: Array<() => Promise<void>> = []
const originalFilePicker = nativeDevicePorts.filePicker
function pickFiles(files: unknown[]) {
  const pick = vi.fn().mockResolvedValue({ files })
  nativeDevicePorts.filePicker = { pickFiles: pick } as unknown as NativeDevicePorts['filePicker']
  return pick
}
async function settled(phase: MobileFileUpload['phase']) {
  await act(async () => { await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe(phase)) })
}
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); root = await mkdtemp(join(tmpdir(), 'amx-mobile-file-')) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; for (const dispose of disposers.splice(0)) await dispose(); await rm(root, { recursive: true, force: true }); nativeDevicePorts.filePicker = originalFilePicker; vi.restoreAllMocks(); vi.unstubAllEnvs() })
function insertionSpy() {
  const added: string[] = []
  const insert = vi.fn(async (resolve: () => Promise<string | null>) => { const path = await resolve(); if (path !== null) added.push(path) })
  return { insert, added }
}
const connected = { state: 'connected' as const, message: '已连接原 Mac' }
const platform = createBrowserPlatform({ clipboard: { writeText: async () => {} } })
function local(id = 'upload-original', text = 'pinned local bytes'): LocalAttachment {
  const bytes = Buffer.from(text)
  return { id, name: 'notes.md', mimeType: 'text/markdown', size: bytes.length, revision: fileUploadRevision(bytes), dataBase64: bytes.toString('base64') }
}
function boundFixture() {
  const f = fixture(), owner = new FileUploadOwner(join(root, 'uploads'))
  for (const [id, value] of f.sessions) f.sessions.set(id, { ...value, hostId: 'local' })
  const core = { agentSessions: () => [...f.sessions.values()], readAgentSessions: async () => [...f.sessions.values()], sessionHistorySources: async () => [] } as unknown as AgentMuxRpcCorePort
  const service = new AgentMuxRpcService({ fileUploads: owner, coreClients: () => [{ hostId: 'local', client: core }] })
  const calls: Array<{ method: string; params: any }> = []
  const forward = vi.fn(async (method: any, params: any) => {
    calls.push({ method, params: structuredClone(params) })
    return await service.call(method, JSON.parse(JSON.stringify(params)), { principal: { kind: 'device', id: 'private-phone' } })
  })
  Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'runtime-original', availability: 'connected' }), forwardRpc: forward })
  return { ...f, owner, calls, forward }
}
function identity(file: LocalAttachment) { return { hostId: 'local', agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, operationId: file.id,
  name: file.name, mimeType: file.mimeType, byteLength: file.size, revision: file.revision } }

describe('actual Mobile picker, attachment chip, shared Composer and original send', () => {
  it('delivers a confirmed phone attachment through the actual public socket, Hosted SDK, Core admission and original Run byte producer', async () => {
    const f = await attachmentHostedFixture(root); disposers.push(f.dispose)
    pickFiles([{ name: '资料.md', mimeType: 'text/markdown', size: 4, blob: new NodeBlob(['file']) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, '阅读附件'); await click(button(ui.element, 'Reference files for the Agent to read'))
    await click(button(ui.element, '上传并加入 资料.md')); await settled('inserted')
    const original = getDeviceWorkface().snapshot().record.fileUploads![0]!, receipt = await f.owner.inspect(original.identity)
    if (receipt.status !== 'uploaded') throw new Error('Actual Host readback required')
    expect(await readFile(receipt.path, 'utf8')).toBe('file')
    expect(f.writes).toEqual([]); expect(f.submit).not.toHaveBeenCalled()
    await click(button(ui.element, 'Send'))
    await act(async () => { await f.submit.mock.results[0]!.value })
    expect(f.writes).toEqual([expect.stringContaining('@' + receipt.path)])
    expect(f.writes[0]).toContain('阅读附件')
    expect(f.core.agentSession('session-original').promptCompletionAdmission).toMatchObject({ acknowledged: true,
      intent: { run: { runId: 'run-original' }, message: { authorHuman: true } } })
  })
  it('selects local bytes, explicitly persists to original Host and adds the confirmed path to the original draft before ordinary send', async () => {
    const f = boundFixture(), content = 'original phone file bytes'
    const pick = pickFiles([{ name: '资料.md', mimeType: 'text/markdown', size: Buffer.byteLength(content), blob: new NodeBlob([content]) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, '请阅读这份资料。')
    await click(button(ui.element, 'Reference files for the Agent to read'))
    expect(pick).toHaveBeenCalledExactlyOnceWith({ limit: 1, readData: false })
    expect(f.calls).toHaveLength(0); expect(f.submit).not.toHaveBeenCalled()
    await click(button(ui.element, '上传并加入 资料.md')); await settled('inserted')
    expect(f.calls.filter(call => call.method === 'file.upload')).toHaveLength(1)
    const upload = f.calls.find(call => call.method === 'file.upload')!.params as FileUploadParams
    const receipt = await f.owner.inspect(upload)
    if (receipt.status !== 'uploaded') throw new Error('Actual Main file readback required')
    expect(await readFile(receipt.path, 'utf8')).toBe(content)
    expect(editor(ui.element).textContent).toContain('请阅读这份资料。')
    expect(editor(ui.element).textContent).toContain('资料.md'); expect(editor(ui.element).textContent).not.toContain(receipt.path)
    expect(f.submit).not.toHaveBeenCalled()
    await click(button(ui.element, 'Send'))
    expect(f.submit).toHaveBeenCalledOnce()
    expect(f.submit.mock.calls[0]![0]).toMatchObject({ agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, authorHuman: true })
    expect(f.submit.mock.calls[0]![0].prompt).toContain('@' + receipt.path)
  })
  it('maps a slow confirmed attachment into the maintained editor without losing later typed text', async () => {
    const f = boundFixture(), receipt = deferred<void>(), originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const response = await originalForward(method, params); if (method === 'file.upload') await receipt.promise; return response })
    pickFiles([{ name: 'notes.md', mimeType: 'text/plain', size: 4, blob: new NodeBlob(['file']) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, 'original '); await click(button(ui.element, 'Reference files for the Agent to read'))
    await click(button(ui.element, '上传并加入 notes.md'))
    await paste(ui.element, 'later words')
    await act(async () => receipt.resolve()); await settled('inserted')
    expect(editor(ui.element).textContent).toContain('original')
    expect(editor(ui.element).textContent).toContain('later words')
    expect(editor(ui.element).textContent).toContain('notes.md')
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('does not append a late receipt into another Session and retains it for explicit insertion on return', async () => {
    const f = boundFixture(), gate = deferred<void>(), file = local(), controls = createRef<MobileAttachmentControls>(), { insert, added } = insertionSpy()
    const originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const response = await originalForward(method, params); if (method === 'file.upload') await gate.promise; return response })
    const render = (id: string) => <MobileAttachments client={f.client} session={f.sessions.get(id)!} connected promptOperationId={null} promptConfirmed={false} controls={controls} insert={insert} pickFile={async () => file} />
    const ui = await mount(render('session-original')); await act(async () => controls.current!.choose())
    await click(button(ui.element, '上传并加入 notes.md')); await ui.render(render('other'))
    await act(async () => gate.resolve()); await settled('uploaded'); expect(added).toEqual([])
    expect(getDeviceWorkface().snapshot().record.fileUploads![0]!.phase).toBe('uploaded')
    await ui.render(render('session-original')); await click(button(ui.element, '将 notes.md 加入消息'))
    expect(added).toHaveLength(1)
  })
  it('reconciles a lost upload receipt after remount using only the original operation, never retransmitting bytes', async () => {
    const f = boundFixture(), file = local(), controls = createRef<MobileAttachmentControls>(), { insert, added } = insertionSpy()
    const originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await originalForward(method, params); if (method === 'file.upload') throw new Error('private lost reply'); return result })
    const props = { client: f.client, session: f.sessions.get('session-original')!, connected: true, promptOperationId: null, promptConfirmed: false, controls, insert, pickFile: async () => file }
    const ui = await mount(<MobileAttachments {...props} />); await act(async () => controls.current!.choose()); await click(button(ui.element, '上传并加入 notes.md'))
    await settled('unknown'); expect(getDeviceWorkface().snapshot().record.fileUploads![0]!.phase).toBe('unknown'); expect(added).toEqual([])
    await ui.render(<div />); await ui.render(<MobileAttachments {...props} />)
    await click(button(ui.element, '核对 notes.md 原上传')); await settled('inserted')
    expect(f.calls.map(call => call.method)).toEqual(['file.upload', 'file.upload.inspect'])
    expect(f.calls[1]!.params).toEqual(identity(file)); expect(f.calls[1]!.params).not.toHaveProperty('dataBase64')
    expect(added).toHaveLength(1)
  })
  it('retains local bytes while offline and leaves text input available; explicit reconnect action uploads once', async () => {
    const f = boundFixture(), file = local(), controls = createRef<MobileAttachmentControls>(), { insert, added } = insertionSpy()
    const render = (online: boolean) => <MobileAttachments client={f.client} session={f.sessions.get('session-original')!} connected={online} promptOperationId={null} promptConfirmed={false} controls={controls} insert={insert} pickFile={async () => file} />
    const ui = await mount(render(false)); await act(async () => controls.current!.choose()); await click(button(ui.element, '上传并加入 notes.md'))
    expect(f.calls).toHaveLength(0); expect(ui.element.textContent).toContain('未连接')
    await ui.render(render(true)); await click(button(ui.element, '上传并加入 notes.md')); await settled('inserted')
    expect(f.calls.map(call => call.method)).toEqual(['file.upload']); expect(added).toHaveLength(1)
  })
  it('does not write the Host if the original device intent cannot be retained durably', async () => {
    const f = boundFixture(), file = local(), controls = createRef<MobileAttachmentControls>(), { insert, added } = insertionSpy()
    const ui = await mount(<MobileAttachments client={f.client} session={f.sessions.get('session-original')!} connected promptOperationId={null} promptConfirmed={false} controls={controls} insert={insert} pickFile={async () => file} />)
    await act(async () => controls.current!.choose())
    vi.spyOn(getDeviceWorkface(), 'retainFileUpload').mockImplementation(() => { throw new Error('private device storage full') })
    await click(button(ui.element, '上传并加入 notes.md'))
    expect(f.calls).toHaveLength(0); expect(added).toEqual([])
    expect(ui.element.textContent).toContain('本次没有上传')
    expect(button(ui.element, '移除 notes.md 本地引用')).toBeDefined()
  })
  it('bounds pending local selections without taking away the existing attachment or message path', async () => {
    const f = boundFixture(), controls = createRef<MobileAttachmentControls>(), { insert } = insertionSpy()
    const bytes = Buffer.alloc(FILE_UPLOAD_MAX_BYTES), dataBase64 = bytes.toString('base64'), revision = fileUploadRevision(bytes)
    let count = 0
    const ui = await mount(<MobileAttachments client={f.client} session={f.sessions.get('session-original')!} connected promptOperationId={null} promptConfirmed={false} controls={controls} insert={insert}
      pickFile={async () => ({ id: `local-budget-${++count}`, name: `original-${count}.bin`, mimeType: 'application/octet-stream', size: bytes.length, revision, dataBase64 })} />)
    for (let i = 0; i < 5; i++) await act(async () => controls.current!.choose())
    expect(ui.element.querySelectorAll('.mobile-attachment')).toHaveLength(4)
    expect(ui.element.textContent).toContain('先上传或移除')
    expect(f.calls).toHaveLength(0)
    await click(button(ui.element, '移除 original-1.bin 本地引用'))
    await act(async () => controls.current!.choose())
    expect(ui.element.querySelectorAll('.mobile-attachment')).toHaveLength(4)
    expect(ui.element.textContent).toContain('original-6.bin')
  })
  it('refuses a changed Runtime or Run without writing, and a later message suppresses automatic insertion', async () => {
    const f = boundFixture(), file = local(), controls = createRef<MobileAttachmentControls>(), { insert, added } = insertionSpy()
    const render = (op: string | null) => <MobileAttachments client={f.client} session={f.sessions.get('session-original')!} connected promptOperationId={op} promptConfirmed={false} controls={controls} insert={insert} pickFile={async () => file} />
    const ui = await mount(render(null)); await act(async () => controls.current!.choose())
    Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'foreign-runtime' }) })
    await click(button(ui.element, '上传并加入 notes.md')); expect(f.calls).toHaveLength(0)
    Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'runtime-original' }) })
    f.sessions.set('session-original', { ...f.sessions.get('session-original')!, run: { runId: 'foreign-run' } })
    await ui.render(render(null)); await click(button(ui.element, '上传并加入 notes.md')); expect(f.calls).toHaveLength(0)
    f.sessions.set('session-original', { ...session(), hostId: 'local' }); await ui.render(render(null))
    const gate = deferred<void>(), originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await originalForward(method, params); await gate.promise; return result })
    await click(button(ui.element, '上传并加入 notes.md')); await ui.render(render('later-message')); await act(async () => gate.resolve()); await settled('uploaded')
    expect(added).toEqual([]); expect(ui.element.textContent).toContain('已在原 Mac')
  })
  it('uses the same exact target/content guard and never lets device persistence replace the original upload identity', () => {
    const file = local(), original: MobileFileUpload = { runtimeId: 'runtime', identity: identity(file), phase: 'unknown' }
    getDeviceWorkface().retainFileUpload(original)
    expect(() => getDeviceWorkface().retainFileUpload({ ...original, identity: { ...original.identity, agentSessionId: 'foreign' } })).toThrow('原附件')
    expect(() => getDeviceWorkface().removeFileUpload(file.id)).toThrow('尚未确认')
    expect(fileUploadScopeMatches(original, { runtimeId: 'runtime', hostId: 'local', sessionId: 'session-original', runId: 'foreign' })).toBe(false)
    expect(getDeviceWorkface().snapshot().record.fileUploads![0]).toEqual(original)
  })
  it('bounds native OS stream reading, rejects size growth and oversize before any native byte read', async () => {
    const readNative = vi.fn(async () => new Response('real OS bytes'))
    const filePicker = { pickFiles: vi.fn().mockResolvedValue({ files: [{ name: 'native.bin', mimeType: '', size: 13, path: 'content://chosen/file' }] }) } as unknown as NativeDevicePorts['filePicker']
    const selected = await pickLocalAttachment({ filePicker }, readNative)
    expect(selected?.dataBase64).toBe(Buffer.from('real OS bytes').toString('base64'))
    expect(selected).not.toHaveProperty('path'); expect(readNative).toHaveBeenCalledExactlyOnceWith('content://chosen/file')
    vi.mocked(filePicker.pickFiles).mockResolvedValue({ files: [{ name: 'huge.bin', mimeType: 'application/octet-stream', size: FILE_UPLOAD_MAX_BYTES + 1, path: 'content://huge' }] })
    await expect(pickLocalAttachment({ filePicker }, readNative)).rejects.toThrow('4 MiB'); expect(readNative).toHaveBeenCalledTimes(1)
    vi.mocked(filePicker.pickFiles).mockResolvedValue({ files: [{ name: 'grows.bin', mimeType: 'application/octet-stream', size: 1, path: 'content://grows' }] })
    await expect(pickLocalAttachment({ filePicker }, readNative)).rejects.toThrow('变大')
  })
})
