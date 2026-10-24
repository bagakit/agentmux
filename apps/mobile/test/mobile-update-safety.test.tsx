import { act, createRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fileUploadRevision } from '@agentmux/core/files'
import { MobileAttachments, type MobileAttachmentControls } from '../src/conversation/MobileAttachments'
import { MobileWebUpdateSafetyProvider, useMobileWebUpdateSafety, useMobileWebUpdateSafetyOwner } from '../src/mobile-web/update-safety'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { useGoalDraft } from '../src/goals/useGoalDraft'
import { useKnowledgeDraft } from '../src/topics/useKnowledgeDraft'
import { useMoteFileDraft } from '../src/navigation/useMoteFileDraft'
import { useMoteQuickDraft } from '../src/navigation/useMoteQuickDraft'
import { MobileNoteFile } from '../src/navigation/MobileNoteFile'
import { MobileAgentCreate } from '../src/navigation/MobileAgentCreate'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NoteSnapshotTestWorker } from '../../desktop/test/note-snapshot-test-worker'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

let apply: ReturnType<typeof useMobileWebUpdateSafety>['apply']
function Action() { apply = useMobileWebUpdateSafety().apply; return null }
function Owner({ check }: { check: () => string | null }) { useMobileWebUpdateSafetyOwner(check); return null }
let editGoal: (field: 'title' | 'description', value: string) => void
let editKnowledge: (field: 'title' | 'content' | 'form' | 'certainty' | 'authoringScope', value: string) => void
function DraftOwners() {
  editGoal = useGoalDraft('goal-original', null, null, null, false, () => {}).editText
  editKnowledge = useKnowledgeDraft({ topicId: 'topic-original', entryId: 'knowledge-original' }, null, false, () => {}).edit
  return null
}
let editMoteFile: (value: string) => void, editMoteQuick: (value: { executorId?: string }) => void
const resource = { hostId: 'local', workspaceId: 'workspace-original', workspacePath: '/opaque' }
function MoteFileOwner() {
  editMoteFile = useMoteFileDraft({ spaceId: 'mote-original', path: 'MOTE.md', observation: null, reference: { ...resource, zoneId: 'zone-original' } }, null, true, () => {}, () => {}).edit
  return null
}
function MoteQuickOwner() {
  editMoteQuick = useMoteQuickDraft({ spaceId: 'mote-original', zoneId: 'zone-original', expectedResource: resource }, null, true, () => {}).edit
  return null
}
const verifyConnection = async () => () => true
const response = () => ({ ok: true, url: location.origin + '/mobile/new-build/' + 'a'.repeat(64) + '/index.html' }) as Response

beforeEach(async () => {
  localStorage.clear()
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  vi.stubGlobal('fetch', vi.fn(async () => response()))
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('preserves a selected file from another Session and an unfinished picker', async () => {
  const f = fixture(), controls = createRef<MobileAttachmentControls>(), selected = deferred<any>()
  Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime' }) })
  const original = { ...f.sessions.get('session-original')!, hostId: 'local' }
  const props = { client: f.client, session: original, connected: true, promptOperationId: null, confirmedPrompt: null,
    controls, insert: async () => {}, pickFile: () => selected.promise }
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileAttachments {...props} /></MobileWebUpdateSafetyProvider>)
  let picking!: Promise<void>
  await act(async () => { picking = controls.current!.choose() })
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('读取') })
  const bytes = Buffer.from('image')
  await act(async () => { selected.resolve({ id: 'original-upload', name: 'image.png', mimeType: 'image/png', size: bytes.length,
    revision: fileUploadRevision(bytes), dataBase64: bytes.toString('base64') }); await picking })
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileAttachments {...props} session={{ ...original, agentSessionId: 'another-session' }} /></MobileWebUpdateSafetyProvider>)
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  expect(fetch).not.toHaveBeenCalled()
})

it('waits for the original attachment operation without replaying it', async () => {
  const f = fixture(), controls = createRef<MobileAttachmentControls>(), upload = deferred<any>(), bytes = Buffer.from('image')
  const forward = vi.fn(() => upload.promise)
  Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime' }), forwardRpc: forward })
  const original = { ...f.sessions.get('session-original')!, hostId: 'local' }
  f.sessions.set('session-original', original)
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileAttachments client={f.client} session={original} connected
    promptOperationId={null} confirmedPrompt={null} controls={controls} insert={async read => { await read() }}
    pickFile={async () => ({ id: 'original-upload', name: 'image.png', mimeType: 'image/png', size: bytes.length,
      revision: fileUploadRevision(bytes), dataBase64: bytes.toString('base64') })} /></MobileWebUpdateSafetyProvider>)
  await act(async () => { await controls.current!.choose() })
  await click(button(view.element, '上传并加入 image.png'))
  await vi.waitFor(() => expect(forward).toHaveBeenCalledOnce())
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('附件操作') })
  expect(forward).toHaveBeenCalledOnce()
  upload.reject(new Error('unknown original receipt'))
})

it('rejects a late edit during entry preflight, without navigating', async () => {
  const waiting = deferred<Response>()
  vi.mocked(fetch).mockReturnValueOnce(waiting.promise)
  let issue: string | null = null
  await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><Owner check={() => issue} /></MobileWebUpdateSafetyProvider>)
  const operation = apply()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  issue = '原稿仍在本页'
  waiting.resolve(response())
  expect(await operation).toEqual({ status: 'blocked', message: issue })
})

it('does not adopt a different owner set if the original surface unmounts during preflight', async () => {
  const waiting = deferred<Response>()
  vi.mocked(fetch).mockReturnValueOnce(waiting.promise)
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><Owner check={() => null} /></MobileWebUpdateSafetyProvider>)
  const operation = apply()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /></MobileWebUpdateSafetyProvider>)
  waiting.resolve(response())
  expect(await operation).toMatchObject({ status: 'blocked', message: expect.stringContaining('工作面') })
})

it('rejects a storage write arriving during entry preflight', async () => {
  const waiting = deferred<Response>()
  vi.mocked(fetch).mockReturnValueOnce(waiting.promise)
  await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /></MobileWebUpdateSafetyProvider>)
  const operation = apply()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  await getDeviceWorkface().updateConversation({ version: 1, drafts: [['["draft","another"]', 'new text']], attempts: [], responses: [] })
  waiting.resolve(response())
  expect(await operation).toMatchObject({ status: 'blocked', message: expect.stringContaining('工作面') })
  expect(getDeviceWorkface().snapshot().record.conversation.drafts).toEqual([['["draft","another"]', 'new text']])
})

it('does not adopt a replacement workface that was already queued when checking began', async () => {
  const owner = getDeviceWorkface(), original = owner.recordIdentity()
  const replacement = owner.replaceBackup(emptyDeviceWorkface())
  const check = owner.preparePageReload()
  await replacement
  expect(owner.recordIdentity()).not.toBe(original)
  expect((await check)()).toBe(false)
})

it('retains the current page after the actual device write fails', async () => {
  const owner = getDeviceWorkface(), fail = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
  await expect(owner.updateConversation({ version: 1, drafts: [['["draft","original"]', 'memory-only body']], attempts: [], responses: [] })).rejects.toThrow()
  fail.mockRestore()
  await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /></MobileWebUpdateSafetyProvider>)
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('工作面') })
  expect(owner.snapshot().record.conversation.drafts).toEqual([['["draft","original"]', 'memory-only body']])
})

it('keeps the real Composer text when an oversized draft cannot be encoded to the workface', async () => {
  const f = fixture(), platform = createBrowserPlatform(), body = 'x'.repeat(65537)
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client}
    agentSessionId="session-original" connection={{ state: 'connected', message: '原连接' }} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await paste(view.element, body)
  await vi.waitFor(() => expect(editor(view.element).textContent).toContain(body))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('草稿') })
  expect(fetch).not.toHaveBeenCalled()
})

it('protects a new Agent initial instruction after its form is hidden', async () => {
  const platform = createBrowserPlatform(), props = { client: null, connected: false, target: {}, platform, onClose: vi.fn(), openSession: vi.fn() }
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileAgentCreate {...props} visible /></MobileWebUpdateSafetyProvider>)
  const input = document.querySelector<HTMLTextAreaElement>('[aria-label="新 Agent 初始指令"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '原始指令'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileAgentCreate {...props} visible={false} /></MobileWebUpdateSafetyProvider>)
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('新建 Agent') })
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileAgentCreate {...props} visible /></MobileWebUpdateSafetyProvider>)
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="新 Agent 初始指令"]')?.value).toBe('原始指令')
})

it('offers an explicit escape when Agent creation was never sent because its local intent could not be retained', async () => {
  const rpc = vi.fn(async (method: string) => method === 'space.ls' ? { catalog: { spaces: [{ spaceId: 'space-original', name: 'Original', hostId: 'local' }],
    zones: [{ zoneId: 'zone-original', directoryPath: '/opaque' }], bindings: [{ spaceId: 'space-original', zoneId: 'zone-original' }], tabs: [] } }
    : { items: [{ id: 'executor-original', value: { name: 'Original' } }], issues: [] })
  const client = { forwardRpc: rpc, runtimeOwnerIdentity: () => ({ runtimeId: 'runtime-original' }) } as any
  const failed = vi.spyOn(getDeviceWorkface(), 'retainAgentCreate').mockRejectedValue(new Error('device unavailable'))
  await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileAgentCreate client={client} connected visible target={{}}
    platform={createBrowserPlatform()} onClose={() => {}} openSession={() => {}} /></MobileWebUpdateSafetyProvider>)
  await vi.waitFor(() => expect(document.querySelectorAll('[aria-label="新 Agent 空间"] option').length).toBe(2))
  const select = async (label: string, value: string) => { const input = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; await act(async () => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) }) }
  await select('新 Agent 空间', 'space-original'); await select('新 Agent Zone', 'zone-original'); await select('新 Agent 执行器', 'executor-original')
  await click(button(document.body, '创建 Agent'))
  await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce())
  expect(rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(0)
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('创建操作') })
  await click(button(document.body, '放弃未发起的创建'))
  expect(document.body.textContent).toContain('表单保留')
  expect(rpc.mock.calls.filter(([method]) => method === 'agent.open')).toHaveLength(0)
})

it('protects actual in-memory Goal and Knowledge drafts without a confirmed Host scope', async () => {
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><DraftOwners /></MobileWebUpdateSafetyProvider>)
  await act(async () => { editGoal('description', 'original goal text') })
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('目标草稿') })
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /></MobileWebUpdateSafetyProvider>)
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><DraftOwners /></MobileWebUpdateSafetyProvider>)
  await act(async () => { editKnowledge('content', 'original knowledge text') })
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('知识草稿') })
  expect(fetch).not.toHaveBeenCalled()
})

it('protects the original Mote file and configuration owners when edits only exist in memory', async () => {
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MoteFileOwner /></MobileWebUpdateSafetyProvider>)
  await act(async () => { editMoteFile('original mote body') })
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('Mote 文件') })
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MoteQuickOwner /></MobileWebUpdateSafetyProvider>)
  await act(async () => { editMoteQuick({ executorId: 'original-executor' }) })
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('Mote 配置') })
  expect(fetch).not.toHaveBeenCalled()
})

it('protects the actual Note editor when its separate local draft write fails', async () => {
  vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  vi.spyOn(location, 'assign').mockImplementation(() => {})
  const document = serializeNoteDocument(newNoteDocument('original', 'note-original', 'block-original'))
  const file = { ...resource, zoneId: 'zone-original', zonePath: '/opaque', path: 'original.note.md' }
  const read = { resource: file, result: { status: 'read' as const, document: { path: file.path, content: document, revision: fileUploadRevision(Buffer.from(document)) } } }
  const rpc = vi.fn(async () => ({ resourceChanges: [], conversionIssues: [] })) as any
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileNoteFile rpc={rpc}
    params={{ zoneId: file.zoneId, path: file.path, expectedResource: resource }} read={read} /></MobileWebUpdateSafetyProvider>)
  await click(button(view.element, '编辑原笔记'))
  const editor = view.element.querySelector<HTMLElement>('[contenteditable="true"]') as HTMLElement & { editor: { commands: { insertContent(value: string): void } } }
  expect(editor?.editor).toBeDefined()
  const failure = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
  await act(async () => { editor.editor.commands.insertContent('memory-only note') })
  failure.mockRestore()
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('笔记草稿') })
  expect(editor.textContent).toContain('memory-only note')
})

it('retains the page if the root entry is unavailable or points elsewhere', async () => {
  await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /></MobileWebUpdateSafetyProvider>)
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, url: 'https://other.example/mobile/new/' + 'a'.repeat(64) + '/index.html' } as Response)
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('入口') })
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('连接') })
})

it('opens the same-origin root after the original owners and entry confirm', async () => {
  const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
  await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /></MobileWebUpdateSafetyProvider>)
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/#amux-update')
})
