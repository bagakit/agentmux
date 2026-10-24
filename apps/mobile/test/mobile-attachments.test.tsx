import { act, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileUploadOwner } from '../../host/src/file-upload-owner'
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
  await act(async () => { await vi.waitFor(() => { const upload = getDeviceWorkface().snapshot().record.fileUploads?.[0]; expect(upload?.phase, upload?.issue).toBe(phase) }) })
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
  const core = { agentSessions: () => [...f.sessions.values()], readAgentSession: async (id: string) => f.sessions.get(id) ?? null,
    readAgentSessions: async () => [...f.sessions.values()], sessionHistorySources: async () => [] } as unknown as AgentMuxRpcCorePort
  const service = new AgentMuxRpcService({ fileUploads: owner, coreClients: () => [{ hostId: 'local', client: core }] })
  const calls: Array<{ method: string; params: any }> = []
  const forward = vi.fn(async (method: any, params: any) => {
    calls.push({ method, params: structuredClone(params) })
    return await service.call(method, JSON.parse(JSON.stringify(params)), { principal: { kind: 'device', id: 'private-phone' }, assertCurrent: () => {} })
  })
  Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'runtime-original', availability: 'connected' }), forwardRpc: forward })
  return { ...f, owner, calls, forward }
}
function identity(file: LocalAttachment) { return { hostId: 'local', agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, operationId: file.id,
  name: file.name, mimeType: file.mimeType, byteLength: file.size, revision: file.revision } }

describe('actual Mobile picker, attachment chip, shared Composer and original send', () => {
  it('sends selected images without text through actual Hosted upload, public socket, Core admission and original Run producer', async () => {
    const f = await attachmentHostedFixture(root); disposers.push(f.dispose)
    pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await click(button(ui.element, 'Reference files for the Agent to read'))
    expect(button(ui.element, 'Send').disabled).toBe(false)
    expect(f.writes).toEqual([]); expect(f.submit).not.toHaveBeenCalled()
    await click(button(ui.element, 'Send'))
    await act(async () => { await vi.waitFor(() => expect(f.core.agentSession('session-original').promptCompletionAdmission).toMatchObject({
      acknowledged: true, intent: { run: { runId: 'run-original' }, message: { authorHuman: true } }
    })) })
    expect(f.submit).toHaveBeenCalledOnce()
    const reference = f.submit.mock.calls[0]![0].prompt.match(/@([^\s]+attachment\.png)/u)?.[1]
    expect(reference).toBeTruthy()
    expect(await readFile(reference!, 'utf8')).toBe('file')
    expect(f.writes).toEqual([expect.stringContaining('@' + reference)])
    expect(editor(ui.element).textContent).toBe('')
  })

  it('uploads all selected attachments before one original text input without a separate upload click', async () => {
    const f = boundFixture()
    pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, '阅读所选图片'); await click(button(ui.element, 'Reference files for the Agent to read'))
    await click(button(ui.element, 'Send'))
    await act(async () => { await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()) })
    expect(f.calls.map(call => call.method)).toEqual(['file.upload'])
    const receipt = await f.owner.inspect(f.calls[0]!.params)
    expect(receipt.status).toBe('uploaded')
    if (receipt.status !== 'uploaded') throw new Error('Original uploaded receipt required')
    expect(f.submit.mock.calls[0]![0]).toMatchObject({ agentSessionId: 'session-original', expectedRun: { runId: 'run-original' } })
    expect(f.submit.mock.calls[0]![0].prompt).toContain('阅读所选图片')
    expect(f.submit.mock.calls[0]![0].prompt).toContain('@' + receipt.path)
    expect(editor(ui.element).textContent).toBe('')
  })

  it('keeps an unknown selected upload out of input, then a new Send only inspects the same operation before submitting', async () => {
    const f = boundFixture(), originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => {
      const result = await originalForward(method, params)
      if (method === 'file.upload') throw new Error('private upload reply lost')
      return result
    })
    pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, '原正文'); await click(button(ui.element, 'Reference files for the Agent to read'))
    await click(button(ui.element, 'Send')); await settled('unknown')
    expect(f.submit).not.toHaveBeenCalled()
    expect(getDeviceWorkface().snapshot().record.conversation.attempts).toEqual([])
    expect(editor(ui.element).textContent).toBe('原正文')
    expect(ui.element.textContent?.split('附件尚未确认保存在原 Mac；本次消息没有发送。').length).toBe(2)
    const original = f.calls[0]!.params
    await click(button(ui.element, 'Send'))
    await act(async () => { await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()) })
    expect(f.calls.map(call => call.method)).toEqual(['file.upload', 'file.upload.inspect'])
    expect(f.calls[1]!.params).toEqual(identity({ ...local(), id: original.operationId, name: original.name, mimeType: original.mimeType,
      size: original.byteLength, revision: original.revision }))
    expect(f.calls[1]!.params).not.toHaveProperty('dataBase64')
    expect(f.submit.mock.calls[0]![0].prompt).toContain('原正文')
    expect(f.submit.mock.calls[0]![0].prompt).toContain('@')
  })

  it('keeps partial upload results and the original body when one attachment fails, and explicitly retries only the same failed operation', async () => {
    const f = boundFixture(), originalForward = f.forward.getMockImplementation()!, selected: any[] = []
    let fail = true
    f.forward.mockImplementation(async (method, params) => {
      selected.push({ method, params: structuredClone(params) })
      if (method === 'file.upload' && params.name === 'second.png' && fail) {
        const { dataBase64: _bytes, ...original } = params
        return { ...original, status: 'error', code: 'PRIVATE_DISK_FAILURE', message: 'private disk unavailable' } as any
      }
      return await originalForward(method, params)
    })
    const pick = pickFiles([{ name: 'first.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, '原正文'); await click(button(ui.element, 'Reference files for the Agent to read'))
    pick.mockResolvedValue({ files: [{ name: 'second.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['next'], { type: 'image/png' }) as Blob }] })
    await click(button(ui.element, 'Reference files for the Agent to read'))
    await click(button(ui.element, 'Send'))
    await act(async () => { await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.map(item => item.phase)).toEqual(['uploaded', 'error'])) })
    expect(f.submit).not.toHaveBeenCalled(); expect(editor(ui.element).textContent).toBe('原正文')
    expect(getDeviceWorkface().snapshot().record.conversation.attempts).toEqual([])
    fail = false; await click(button(ui.element, 'Send'))
    await act(async () => { await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()) })
    expect(selected.map(item => [item.method, item.params.name])).toEqual([['file.upload', 'first.png'], ['file.upload', 'second.png'], ['file.upload', 'second.png']])
    expect(selected[2]!.params).toEqual(selected[1]!.params)
    expect(f.submit.mock.calls[0]![0].prompt.match(/@/gu)).toHaveLength(2)
  })

  it('freezes the selected message while a slow upload leaves later typing and new attachments untouched, and double Send cannot duplicate it', async () => {
    const f = boundFixture(), gate = deferred<void>(), originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await originalForward(method, params); if (method === 'file.upload') await gate.promise; return result })
    const pick = pickFiles([{ name: 'first.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, '原正文'); await click(button(ui.element, 'Reference files for the Agent to read'))
    await click(button(ui.element, 'Send'))
    await act(async () => { await vi.waitFor(() => expect(f.calls).toHaveLength(1)) })
    expect(button(ui.element, 'Send').disabled).toBe(true)
    await click(button(ui.element, 'Send'))
    await paste(ui.element, '后来编辑')
    pick.mockResolvedValue({ files: [{ name: 'later.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['next'], { type: 'image/png' }) as Blob }] })
    await click(button(ui.element, 'Reference files for the Agent to read'))
    await act(async () => { gate.resolve(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()) })
    expect(f.calls).toHaveLength(1)
    expect(f.submit.mock.calls[0]![0].prompt).toContain('原正文')
    expect(f.submit.mock.calls[0]![0].prompt).not.toContain('后来编辑')
    expect(f.submit.mock.calls[0]![0].prompt).not.toContain('later.png')
    expect(editor(ui.element).textContent).toContain('后来编辑')
    expect(ui.element.querySelector('.mobile-attachment[data-phase="selected"]')?.textContent).toContain('later.png')
  })

  it('keeps a target change after pre-RPC input retention as never requested and can explicitly send the same complete original operation afterwards', async () => {
    const f = boundFixture(), owner = getDeviceWorkface(), edit = owner.editConversation.bind(owner)
    const originalSession = f.sessions.get('session-original')!
    let changeTarget = true
    vi.spyOn(owner, 'editConversation').mockImplementation((edits, record) => {
      const pending = edit(edits, record)
      if (changeTarget && edits.some(item => item.bucket === 'attempts' && typeof item.next === 'object' && item.next && 'inputRequested' in item.next && item.next.inputRequested === true)) {
        changeTarget = false
        return pending.then(value => { f.sessions.set('session-original', { ...originalSession, run: { runId: 'later-run' } }); return value })
      }
      return pending
    })
    pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, '原正文'); await click(button(ui.element, 'Reference files for the Agent to read')); await click(button(ui.element, 'Send'))
    await act(async () => { await vi.waitFor(() => {
      const current = owner.snapshot().record.conversation.attempts[0]?.[1]
      expect(current).toMatchObject({ phase: 'rejected', inputRequested: false })
    }) })
    expect(f.submit).not.toHaveBeenCalled()
    const original = owner.snapshot().record.conversation.attempts[0]![1]
    expect(original.draft).toContain('原正文'); expect(original.draft).toContain('agentmux-file:')
    f.sessions.set('session-original', originalSession)
    await click(button(ui.element, 'Send'))
    await act(async () => { await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()) })
    expect(f.submit.mock.calls[0]![0].operationId).toBe(original.operationId)
    expect(f.calls.filter(item => item.method === 'file.upload')).toHaveLength(1)
    expect(f.submit.mock.calls[0]![0].prompt).toContain('@')
  })

  it.each(['session', 'client', 'runtime', 'host', 'run', 'record'] as const)('does not input a prepared selected message after its original %s changes', async change => {
    const f = boundFixture(), gate = deferred<void>(), originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await originalForward(method, params); if (method === 'file.upload') await gate.promise; return result })
    pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const render = (id = 'session-original', client = f.client) => <MobileConversationSurface client={client} agentSessionId={id} connection={connected} platform={platform} />
    const ui = await mount(render())
    await paste(ui.element, '原正文'); await click(button(ui.element, 'Reference files for the Agent to read')); await click(button(ui.element, 'Send'))
    await act(async () => { await vi.waitFor(() => expect(f.calls).toHaveLength(1)) })
    const original = f.sessions.get('session-original')!
    if (change === 'runtime') Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'later-runtime' }) })
    if (change === 'host') f.sessions.set('session-original', { ...original, hostId: 'later-host' })
    if (change === 'run') f.sessions.set('session-original', { ...original, run: { runId: 'later-run' } })
    if (change === 'record') await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
    await ui.render(render(change === 'session' ? 'other' : 'session-original', change === 'client' ? { ...f.client } : f.client))
    await act(async () => { gate.resolve(); await f.forward.mock.results[0]!.value })
    if (change === 'record') await act(async () => { await vi.waitFor(() => expect(ui.element.textContent).toContain('附件回执仅在本次运行中保留')) })
    else await settled('uploaded')
    expect(f.submit).not.toHaveBeenCalled()
    expect(getDeviceWorkface().snapshot().record.conversation.attempts).toEqual([])
  })

  it.each(['session', 'host', 'runtime', 'run', 'record'] as const)('keeps a late chooser result on its captured %s target and never writes the later selection', async change => {
    const f = boundFixture(), file = local(), originalSession = f.sessions.get('session-original')!, gate = deferred<LocalAttachment | null>()
    const controls = createRef<MobileAttachmentControls>(), { insert, added } = insertionSpy()
    const render = (id = 'session-original') => <MobileAttachments client={f.client} session={f.sessions.get(id)!} connected promptOperationId={null} promptConfirmed={false} controls={controls} insert={insert} pickFile={() => gate.promise} />
    const ui = await mount(render())
    let pending!: Promise<void>
    await act(async () => { pending = controls.current!.choose() })
    if (change === 'host') f.sessions.set('session-original', { ...originalSession, hostId: 'foreign-host' })
    if (change === 'run') f.sessions.set('session-original', { ...originalSession, run: { runId: 'later-run' } })
    if (change === 'runtime') Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'later-runtime' }) })
    if (change === 'record') await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
    await ui.render(render(change === 'session' ? 'other' : 'session-original'))
    await act(async () => { gate.resolve(file); await pending })
    expect(f.calls).toEqual([]); expect(added).toEqual([])
    expect(ui.element.textContent).toContain('原选择')
    f.sessions.set('session-original', originalSession)
    Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'runtime-original' }) })
    await ui.render(render())
    await click(button(ui.element, '上传并加入 notes.md'))
    if (change === 'record') {
      expect(f.calls).toEqual([]); expect(ui.element.textContent).toContain('设备工作面已被替换')
      expect(getDeviceWorkface().snapshot().record.fileUploads ?? []).toEqual([])
      await click(button(ui.element, '移除 notes.md 本地引用'))
      expect(ui.element.querySelector('.mobile-attachment')).toBeNull()
    } else {
      await settled('inserted')
      expect(f.calls[0]!.params).toMatchObject(identity(file)); expect(added).toHaveLength(1)
    }
  })

  it.each(['session', 'run', 'record'] as const)('pins a pending Blob read before the %s changes and keeps the original bytes', async change => {
    const f = boundFixture(), originalSession = f.sessions.get('session-original')!, gate = deferred<void>()
    const controls = createRef<MobileAttachmentControls>(), { insert, added } = insertionSpy()
    const file = { name: 'slow.png', type: 'image/png', size: 4, stream: () => new ReadableStream<Uint8Array>({
      async start(controller) { await gate.promise; controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close() }
    }) }
    const render = (id = 'session-original') => <MobileAttachments client={f.client} session={f.sessions.get(id)!} connected promptOperationId={null} promptConfirmed={false} controls={controls} insert={insert} />
    const ui = await mount(render()); let pending!: Promise<void>
    await act(async () => { pending = controls.current!.stageFile(file) })
    if (change === 'run') f.sessions.set('session-original', { ...originalSession, run: { runId: 'later-run' } })
    if (change === 'record') await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
    await ui.render(render(change === 'session' ? 'other' : 'session-original'))
    await act(async () => { gate.resolve(); await pending })
    expect(f.calls).toEqual([]); expect(added).toEqual([])
    f.sessions.set('session-original', originalSession); await ui.render(render())
    expect(ui.element.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQIDBA==')
    await click(button(ui.element, '上传并加入 slow.png'))
    if (change === 'record') { expect(f.calls).toEqual([]); expect(ui.element.textContent).toContain('设备工作面已被替换') }
    else { await settled('inserted'); expect(f.calls[0]!.params).toMatchObject({ agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, dataBase64: 'AQIDBA==' }) }
  })

  it.each(['paste', 'drop'] as const)('adopts every %s file through the actual shared Composer in order and names a rejected item without losing later files', async kind => {
    const f = boundFixture(), gate = deferred<void>()
    const first = { name: 'first.png', type: 'image/png', size: 4, stream: () => new ReadableStream<Uint8Array>({
      async start(controller) { await gate.promise; controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close() }
    }) }
    const files = [first, Object.assign(new NodeBlob(['second']), { name: 'second.txt' }),
      Object.assign(new NodeBlob(['unsupported'], { type: 'image/svg+xml' }), { name: 'rejected.svg' }),
      Object.assign(new NodeBlob(['last']), { name: 'last.txt' })]
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, '原草稿')
    await act(async () => {
      const event = new MouseEvent(kind, { bubbles: true, cancelable: true, clientX: 0, clientY: 0 })
      Object.defineProperty(event, kind === 'paste' ? 'clipboardData' : 'dataTransfer', { value: kind === 'paste'
        ? { items: files.map(file => ({ kind: 'file', type: file.type ?? '', getAsFile: () => file })), getData: () => '' }
        : { files, types: ['Files'], getData: () => '' } })
      editor(ui.element).dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    })
    expect(f.calls).toEqual([])
    await act(async () => { gate.resolve() })
    await vi.waitFor(async () => { await act(async () => {}); expect(ui.element.querySelectorAll('.mobile-attachment'), ui.element.textContent).toHaveLength(3) })
    expect([...ui.element.querySelectorAll('.mobile-attachment-copy strong')].map(node => node.textContent)).toEqual(['first.png', 'second.txt', 'last.txt'])
    expect(ui.element.textContent).toContain('rejected.svg：')
    expect(editor(ui.element).textContent).toBe('原草稿'); expect(f.calls).toEqual([]); expect(f.submit).not.toHaveBeenCalled()
    await click(button(ui.element, '上传并加入 first.png')); await settled('inserted')
    expect(f.calls[0]!.params).toMatchObject({ name: 'first.png', agentSessionId: 'session-original' })
    expect(editor(ui.element).textContent).toContain('原草稿'); expect(f.submit).not.toHaveBeenCalled()
  })

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
    await act(async () => {
      await vi.waitFor(() => expect(f.core.agentSession('session-original').promptCompletionAdmission).toMatchObject({
        acknowledged: true, intent: { run: { runId: 'run-original' }, message: { authorHuman: true } }
      }))
    })
    expect(f.writes).toEqual([expect.stringContaining('@' + receipt.path)])
    expect(f.writes[0]).toContain('阅读附件')
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
  it('stages a pasted image with thumbnail preview, uploads to Host on confirmation, and ignores picker cancellation without error banners', async () => {
    const f = boundFixture()
    nativeDevicePorts.filePicker = { pickFiles: vi.fn().mockRejectedValue(new Error('pickFiles canceled.')) } as unknown as NativeDevicePorts['filePicker']
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, '查看这张截图')
    await click(button(ui.element, 'Reference files for the Agent to read'))
    expect(ui.element.querySelector('.mobile-attachment-notice')).toBeNull()
    expect(editor(ui.element).textContent).toBe('查看这张截图')
    const pngBytes = Buffer.from('fake-png-bytes')
    const imageFile = Object.assign(new NodeBlob([pngBytes], { type: 'image/png' }), { name: 'screenshot.png' })
    await act(async () => {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', {
        value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile }], getData: () => '' }
      })
      editor(ui.element).dispatchEvent(event)
    })
    await act(async () => { await vi.waitFor(() => expect(ui.element.querySelector('.mobile-attachment[data-phase="selected"]')).not.toBeNull()) })
    expect(ui.element.querySelector('img.mobile-attachment-preview')).not.toBeNull()
    expect(f.calls).toHaveLength(0)
    await click(button(ui.element, '上传并加入 screenshot.png'))
    await settled('inserted')
    expect(f.calls.filter(call => call.method === 'file.upload')).toHaveLength(1)
    expect(editor(ui.element).textContent).toContain('screenshot.png')
    expect(f.submit).not.toHaveBeenCalled()
  })
})
