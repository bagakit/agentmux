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
import { appendNamedFileReference } from '@agentmux/client-ui/composer-file-reference'

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
  it.each(['host', 'runtime', 'run', 'same'] as const)('cleans only an attachment consumed by its frozen confirmed input source after a late %s change', async change => {
    const f = boundFixture(), input = deferred<any>(), accepted = f.submit.getMockImplementation()!
    const file = local(), path = join(root, 'same-address.md')
    const upload: MobileFileUpload = { runtimeId: change === 'runtime' ? 'new-runtime' : 'runtime-original', identity: {
      ...identity(file), ...(change === 'host' ? { hostId: 'new-host' } : {}),
      ...(change === 'run' ? { expectedRun: { runId: 'new-run' } } : {}) }, phase: 'inserted', path }
    const body = appendNamedFileReference('Original frozen input', path, file.name)
    await getDeviceWorkface().retainFileUpload(upload)
    await getDeviceWorkface().updateConversation({ version: 1, drafts: [[JSON.stringify(['draft', 'session-original']), body]], attempts: [], responses: [] })
    f.submit.mockReturnValueOnce(input.promise)
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await click(button(ui.element, 'Send')); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
    const original = f.submit.mock.calls[0]![0]
    expect(original.expectedRun.runId).toBe('run-original')
    if (change === 'runtime') Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'new-runtime' }) })
    if (change === 'host' || change === 'run') await act(async () => f.emit({ type: 'agent-session', session: {
      ...f.sessions.get('session-original')!, ...(change === 'host' ? { hostId: 'new-host' } : { run: { runId: 'new-run' } }) } }))
    await act(async () => input.resolve(await accepted(original)))
    await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.conversation.attempts[0]?.[1].phase).toBe('confirmed'))
    if (change === 'same') await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads).toEqual([]))
    else expect(getDeviceWorkface().snapshot().record.fileUploads).toEqual([upload])
    expect(f.calls).toEqual([]); expect(f.submit).toHaveBeenCalledOnce()
  })

  it('keeps an inserted intent when confirmation has no original source, and the same confirmation does not re-enter cleanup on parent renders', async () => {
    const f = boundFixture(), file = local(), path = join(root, 'same-address.md'), controls = createRef<MobileAttachmentControls>()
    const upload: MobileFileUpload = { runtimeId: 'runtime-original', identity: identity(file), phase: 'inserted', path }
    await getDeviceWorkface().retainFileUpload(upload)
    const originalRemove = getDeviceWorkface().removeFileUpload.bind(getDeviceWorkface())
    const remove = vi.spyOn(getDeviceWorkface(), 'removeFileUpload'), gate = deferred<void>()
    remove.mockImplementation(async (...args) => { await gate.promise; return originalRemove(...args) })
    const props = { client: f.client, session: f.sessions.get('session-original')!, connected: true, promptOperationId: 'confirmed-input', controls, insert: insertionSpy().insert }
    const ui = await mount(<MobileAttachments {...props} confirmedPrompt={null} />)
    expect(getDeviceWorkface().snapshot().record.fileUploads).toEqual([upload]); expect(remove).not.toHaveBeenCalled()
    const confirmed = { operationId: 'confirmed-input', body: appendNamedFileReference('', path, file.name), source: { runtimeId: 'runtime-original', hostId: 'local', sessionId: 'session-original', runId: 'run-original' } }
    await ui.render(<MobileAttachments {...props} confirmedPrompt={confirmed} />)
    expect(remove).toHaveBeenCalledOnce()
    await ui.render(<MobileAttachments {...props} confirmedPrompt={{ ...confirmed, source: { ...confirmed.source } }} />)
    expect(remove).toHaveBeenCalledOnce()
    await act(async () => { gate.resolve(); await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads).toEqual([])) })
  })

  it('does not inspect a never-requested selection from its expanded details and preserves upload and removal', async () => {
    const f = boundFixture(), pick = pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, 'Selected original'); await click(button(ui.element, 'Reference files for the Agent to read'))
    const details = ui.element.querySelector<HTMLDetailsElement>('.mobile-attachment-details')!
    details.open = true
    expect(details.querySelector('button')).toBeNull(); expect(f.calls).toEqual([])
    await click(button(ui.element, '移除 screen.png 本地引用')); expect(ui.element.querySelector('.mobile-attachment')).toBeNull()
    await click(button(ui.element, 'Reference files for the Agent to read')); expect(pick).toHaveBeenCalledTimes(2)
    ui.element.querySelector<HTMLDetailsElement>('.mobile-attachment-details')!.open = true
    await click(button(ui.element, 'Send')); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
    expect(f.calls.map(call => call.method)).toEqual(['file.upload'])
    expect(f.submit.mock.calls[0]![0].prompt).toContain('Selected original')
  })

  it('joins the same saved manual upload before its reply returns, sends once and keeps later edits and selections', async () => {
    const f = boundFixture(), gate = deferred<void>(), originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await originalForward(method, params); if (method === 'file.upload') await gate.promise; return result })
    const pick = pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, 'Original frozen body'); await click(button(ui.element, 'Reference files for the Agent to read'))
    await click(button(ui.element, '上传并加入 screen.png')); await settled('sending')
    const original = getDeviceWorkface().snapshot().record.fileUploads![0]!
    await vi.waitFor(async () => expect((await f.owner.inspect(original.identity)).status).toBe('uploaded'))
    const saved = await f.owner.inspect(original.identity)
    expect(saved.status).toBe('uploaded'); if (saved.status !== 'uploaded') throw Error('Original saved bytes required')
    await click(button(ui.element, 'Send')); expect(f.submit).not.toHaveBeenCalled()
    await click(button(ui.element, 'Send'))
    await paste(ui.element, ' Later edit')
    pick.mockResolvedValue({ files: [{ name: 'later.txt', mimeType: 'text/plain', size: 4, blob: new NodeBlob(['next']) as Blob }] })
    await click(button(ui.element, 'Reference files for the Agent to read'))
    await act(async () => { gate.resolve(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()) })
    expect(f.calls.filter(call => call.method.startsWith('file.upload')).map(call => call.method)).toEqual(['file.upload'])
    expect(f.submit.mock.calls[0]![0].prompt.split('@' + saved.path)).toHaveLength(2)
    expect(f.submit.mock.calls[0]![0].prompt).toContain('Original frozen body'); expect(f.submit.mock.calls[0]![0].prompt).not.toContain('Later edit')
    expect(editor(ui.element).textContent).toContain('Later edit')
    expect(ui.element.querySelector('.mobile-attachment[data-phase="selected"]')?.textContent).toContain('later.txt')
  })

  it('joins manual insertion while inserted retention is pending without appending its frozen semantic file twice', async () => {
    const f = boundFixture(), owner = getDeviceWorkface(), retain = owner.retainFileUpload.bind(owner), gate = deferred<void>(), inserted = deferred<void>()
    pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, 'Original body'); await click(button(ui.element, 'Reference files for the Agent to read'))
    vi.spyOn(owner, 'retainFileUpload').mockImplementation(async (...args) => { if (args[0].phase === 'inserted') { inserted.resolve(); await gate.promise }; return retain(...args) })
    await click(button(ui.element, '上传并加入 screen.png')); await act(async () => inserted.promise)
    const upload = owner.snapshot().record.fileUploads![0]!, saved = await f.owner.inspect(upload.identity)
    expect(upload.phase).toBe('uploaded'); expect(saved.status).toBe('uploaded'); if (saved.status !== 'uploaded') throw Error('Saved original required')
    expect(editor(ui.element).textContent).toContain('screen.png')
    await click(button(ui.element, 'Send')); expect(f.submit).not.toHaveBeenCalled()
    await act(async () => { gate.resolve(); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()) })
    expect(f.submit.mock.calls[0]![0].prompt.split('@' + saved.path)).toHaveLength(2)
    expect(f.calls.filter(call => call.method === 'file.upload')).toHaveLength(1)
    expect(editor(ui.element).textContent).toBe('')
  })

  it('sends only the explicit body while retaining an unknown upload and its exact inspection entry', async () => {
    const f = boundFixture(), originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await originalForward(method, params); if (method === 'file.upload') throw new Error('Original receipt lost'); return result })
    pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, 'Body only intent'); await click(button(ui.element, 'Reference files for the Agent to read')); await click(button(ui.element, 'Send')); await settled('unknown')
    const original = getDeviceWorkface().snapshot().record.fileUploads![0]!
    await click(button(ui.element, '本次仅发送正文'))
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
    expect(f.submit.mock.calls[0]![0].prompt).toBe('Body only intent')
    expect(getDeviceWorkface().snapshot().record.fileUploads).toEqual([original])
    expect(f.calls.filter(call => call.method.startsWith('file.upload')).map(call => call.method)).toEqual(['file.upload'])
    await click(button(ui.element, '核对 screen.png 原上传')); await settled('inserted')
    expect(f.calls.filter(call => call.method.startsWith('file.upload')).map(call => call.method)).toEqual(['file.upload', 'file.upload.inspect'])
    expect(f.calls.find(call => call.method === 'file.upload.inspect')!.params).toEqual(original.identity)
  })

  it('explicit body-only supersedes only an undispatched attachment preparation and its late result cannot submit again', async () => {
    const f = boundFixture(), gate = deferred<void>(), originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await originalForward(method, params); if (method === 'file.upload') await gate.promise; return result })
    pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, 'Original body'); await click(button(ui.element, 'Reference files for the Agent to read')); await click(button(ui.element, 'Send')); await settled('sending')
    await click(button(ui.element, '本次仅发送正文')); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
    expect(f.submit.mock.calls[0]![0].prompt).toBe('Original body')
    await paste(ui.element, 'Later body')
    await act(async () => { gate.resolve(); await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('uploaded')) })
    expect(f.submit).toHaveBeenCalledOnce(); expect(editor(ui.element).textContent).toBe('Later body')
    expect(ui.element.textContent).not.toContain('附件未就绪'); expect(ui.element.textContent).not.toContain('本次已明确选择')
    expect(button(ui.element, '将 screen.png 加入消息')).toBeDefined()
  })

  it('body-only stops the old preparation before another selected file uploads while retaining its in-flight first operation', async () => {
    const f = boundFixture(), gate = deferred<void>(), originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await originalForward(method, params); if (method === 'file.upload') await gate.promise; return result })
    const pick = pickFiles([{ name: 'first.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, 'Only body'); await click(button(ui.element, 'Reference files for the Agent to read'))
    pick.mockResolvedValue({ files: [{ name: 'second.txt', mimeType: 'text/plain', size: 4, blob: new NodeBlob(['next']) as Blob }] })
    await click(button(ui.element, 'Reference files for the Agent to read')); await click(button(ui.element, 'Send')); await settled('sending')
    const first = getDeviceWorkface().snapshot().record.fileUploads![0]!.identity
    await click(button(ui.element, '本次仅发送正文')); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
    await act(async () => { gate.resolve(); await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('uploaded')) })
    expect(f.calls.filter(call => call.method === 'file.upload')).toHaveLength(1)
    expect(getDeviceWorkface().snapshot().record.fileUploads![0]!.identity).toEqual(first)
    expect(ui.element.querySelector('.mobile-attachment[data-phase="selected"]')?.textContent).toContain('second.txt')
    expect(f.submit.mock.calls[0]![0].prompt).toBe('Only body'); expect(f.submit).toHaveBeenCalledOnce()
  })

  it('body-only confirmation does not erase a manual attachment inserted after its body was frozen', async () => {
    const f = boundFixture(), gate = deferred<void>(), originalForward = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await originalForward(method, params); if (method === 'file.upload') await gate.promise; return result })
    const prompt = deferred<any>(), accepted = f.submit.getMockImplementation()!
    f.submit.mockReturnValueOnce(prompt.promise)
    pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, 'Original body'); await click(button(ui.element, 'Reference files for the Agent to read'))
    await click(button(ui.element, '上传并加入 screen.png')); await settled('sending')
    await click(button(ui.element, '本次仅发送正文')); expect(f.submit).toHaveBeenCalledOnce()
    await act(async () => { gate.resolve(); await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.fileUploads?.[0]?.phase).toBe('uploaded')) })
    await click(button(ui.element, '将 screen.png 加入消息')); await settled('inserted')
    const retained = getDeviceWorkface().snapshot().record.fileUploads![0]!
    await act(async () => prompt.resolve(await accepted(f.submit.mock.calls[0]![0])))
    expect(f.submit.mock.calls[0]![0].prompt).toBe('Original body')
    expect(getDeviceWorkface().snapshot().record.fileUploads).toEqual([retained])
    expect(editor(ui.element).textContent).toContain('screen.png')
  })

  it('does not use explicit body-only to replay the same unknown input, and refuses an empty body', async () => {
    const f = boundFixture()
    pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await click(button(ui.element, 'Reference files for the Agent to read'))
    expect(button(ui.element, '本次仅发送正文').disabled).toBe(true)
    await paste(ui.element, 'Unknown original body')
    f.submit.mockRejectedValueOnce(new Error('Original input receipt lost'))
    await click(button(ui.element, '本次仅发送正文')); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
    await click(button(ui.element, '本次仅发送正文'))
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.calls.filter(call => call.method.startsWith('file.upload'))).toEqual([])
    expect(ui.element.textContent).toContain('同一正文已有未确认输入')
  })

  it('cannot use body-only to take over a message that already entered the original input owner', async () => {
    const f = boundFixture(), input = deferred<any>(), accepted = f.submit.getMockImplementation()!
    f.submit.mockReturnValueOnce(input.promise)
    const pick = pickFiles([{ name: 'screen.png', mimeType: 'image/png', size: 4, blob: new NodeBlob(['file'], { type: 'image/png' }) as Blob }])
    const ui = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} />)
    await paste(ui.element, 'Original attached input'); await click(button(ui.element, 'Reference files for the Agent to read')); await click(button(ui.element, 'Send'))
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
    pick.mockResolvedValue({ files: [{ name: 'later.txt', mimeType: 'text/plain', size: 4, blob: new NodeBlob(['next']) as Blob }] })
    await click(button(ui.element, 'Reference files for the Agent to read'))
    expect(button(ui.element, '本次仅发送正文').disabled).toBe(true)
    await click(button(ui.element, '本次仅发送正文')); expect(f.submit).toHaveBeenCalledOnce()
    const original = f.submit.mock.calls[0]![0]
    expect(original.prompt).toContain('@')
    await act(async () => input.resolve(await accepted(original)))
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.submit.mock.calls[0]![0]).toEqual(original)
  })

  it.each(['client', 'record', 'complete-intent'] as const)('does not coalesce an uploaded-looking in-flight result after its %s changes', async change => {
    const f = boundFixture(), controls = createRef<MobileAttachmentControls>(), gate = deferred<void>(), inserting = deferred<void>()
    let captured!: MobileFileUpload
    const insert = vi.fn(async (resolve: () => Promise<string | null>, original: MobileFileUpload) => { captured = original; await resolve(); inserting.resolve(); await gate.promise })
    const props = { client: f.client, session: f.sessions.get('session-original')!, connected: true, promptOperationId: null, confirmedPrompt: null, controls, insert, pickFile: async () => local() }
    const ui = await mount(<MobileAttachments {...props} />)
    await act(async () => controls.current!.choose()); await click(button(ui.element, '上传并加入 notes.md')); await act(async () => inserting.promise)
    const retained = getDeviceWorkface().snapshot().record.fileUploads![0]!
    expect(retained.phase).toBe('uploaded')
    const name = captured.identity.name
    if (change === 'client') await ui.render(<MobileAttachments {...props} client={{ ...f.client }} />)
    if (change === 'record') await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
    if (change === 'complete-intent') captured.identity.name = 'different-original-name.md'
    const preparation = controls.current!.captureForSend()!
    const prepared = preparation.prepare('Original body').then(value => ({ value, error: null }), error => ({ value: null, error: error as Error }))
    captured.identity.name = name
    await act(async () => gate.resolve())
    expect((await prepared).error?.message).toContain(change === 'record' ? '工作面已改变' : '另一客户端、工作面或目标')
    if (change !== 'record') expect(getDeviceWorkface().snapshot().record.fileUploads).toEqual([{ ...retained, phase: 'inserted' }])
    expect(f.calls.filter(call => call.method.startsWith('file.upload'))).toHaveLength(1)
    expect((await f.owner.inspect(retained.identity)).status).toBe('uploaded')
    expect(f.submit).not.toHaveBeenCalled()
  })

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
    expect(ui.element.textContent?.split('附件未就绪；本次消息没有发送。').length).toBe(2)
    expect(ui.element.textContent).toContain('private upload reply lost')
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
    expect(ui.element.textContent).toContain('private disk unavailable [PRIVATE_DISK_FAILURE]')
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
    const render = (id = 'session-original') => <MobileAttachments client={f.client} session={f.sessions.get(id)!} connected promptOperationId={null} confirmedPrompt={null} controls={controls} insert={insert} pickFile={() => gate.promise} />
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
    const render = (id = 'session-original') => <MobileAttachments client={f.client} session={f.sessions.get(id)!} connected promptOperationId={null} confirmedPrompt={null} controls={controls} insert={insert} />
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
    const render = (id: string) => <MobileAttachments client={f.client} session={f.sessions.get(id)!} connected promptOperationId={null} confirmedPrompt={null} controls={controls} insert={insert} pickFile={async () => file} />
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
    const props = { client: f.client, session: f.sessions.get('session-original')!, connected: true, promptOperationId: null, confirmedPrompt: null, controls, insert, pickFile: async () => file }
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
    const render = (online: boolean) => <MobileAttachments client={f.client} session={f.sessions.get('session-original')!} connected={online} promptOperationId={null} confirmedPrompt={null} controls={controls} insert={insert} pickFile={async () => file} />
    const ui = await mount(render(false)); await act(async () => controls.current!.choose()); await click(button(ui.element, '上传并加入 notes.md'))
    expect(f.calls).toHaveLength(0); expect(ui.element.textContent).toContain('未连接')
    await ui.render(render(true)); await click(button(ui.element, '上传并加入 notes.md')); await settled('inserted')
    expect(f.calls.map(call => call.method)).toEqual(['file.upload']); expect(added).toHaveLength(1)
  })
  it('does not write the Host if the original device intent cannot be retained durably', async () => {
    const f = boundFixture(), file = local(), controls = createRef<MobileAttachmentControls>(), { insert, added } = insertionSpy()
    const ui = await mount(<MobileAttachments client={f.client} session={f.sessions.get('session-original')!} connected promptOperationId={null} confirmedPrompt={null} controls={controls} insert={insert} pickFile={async () => file} />)
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
    const ui = await mount(<MobileAttachments client={f.client} session={f.sessions.get('session-original')!} connected promptOperationId={null} confirmedPrompt={null} controls={controls} insert={insert}
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
    const render = (op: string | null) => <MobileAttachments client={f.client} session={f.sessions.get('session-original')!} connected promptOperationId={op} confirmedPrompt={null} controls={controls} insert={insert} pickFile={async () => file} />
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
