import { act, createRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fileUploadRevision } from '@agentmux/core/files'
import { MobileAttachments, type MobileAttachmentControls } from '../src/conversation/MobileAttachments'
import { MobileWebUpdateSafetyProvider, useMobileWebDispatchedOperations, useMobileWebUpdateSafety, useMobileWebUpdateSafetyOwner } from '../src/mobile-web/update-safety'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { useGoalDraft } from '../src/goals/useGoalDraft'
import { useKnowledgeDraft } from '../src/topics/useKnowledgeDraft'
import { useMoteFileDraft } from '../src/navigation/useMoteFileDraft'
import { useMoteQuickDraft } from '../src/navigation/useMoteQuickDraft'
import { MobileNoteFile } from '../src/navigation/MobileNoteFile'
import { MobileAgentCreate } from '../src/navigation/MobileAgentCreate'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import * as localDraftModule from '../src/conversation/local-drafts'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NoteSnapshotTestWorker } from '../../desktop/test/note-snapshot-test-worker'
import { acceptedPrompt, button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

let apply: ReturnType<typeof useMobileWebUpdateSafety>['apply']
function Action() { apply = useMobileWebUpdateSafety().apply; return null }
function Owner({ check }: { check: () => string | null }) { useMobileWebUpdateSafetyOwner(check); return null }
let dispatches: ReturnType<typeof useMobileWebDispatchedOperations>
function DispatchProbe() { dispatches = useMobileWebDispatchedOperations(); return null }
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

it('keeps an accepted retry protected after its conversation unmounts, without replaying it for update', async () => {
  const key = JSON.stringify(['draft', 'session-original']), gate = deferred<any>(), f = fixture()
  await getDeviceWorkface().updateConversation({ version: 1, drafts: [[key, '原正文']], responses: [], attempts: [[key, {
    operationId: 'original-prompt', runId: 'run-original', draft: '原正文', phase: 'unknown', inputRequested: true,
    originalRuntimeId: 'original-runtime', originalHostId: 'host-original', explicit: true,
    manualInput: { agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, runtimeId: 'original-runtime' }
  }]] })
  const surface = <MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />{surface}</MobileWebUpdateSafetyProvider>)
  await vi.waitFor(() => expect(f.inspectInput).toHaveBeenCalled())
  f.inspectInput.mockClear().mockImplementation(() => gate.promise)
  await click(button(view.element, '重试原请求'))
  expect(f.inspectInput).toHaveBeenCalledOnce()
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /></MobileWebUpdateSafetyProvider>)
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('重试操作') })
  expect(f.submit).not.toHaveBeenCalled()
  await act(async () => { gate.resolve(null); await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce()) })
  expect(f.submit.mock.calls[0]![0].operationId).toBe('original-prompt')
})

it('explicitly cancels a retry while the original observation is pending, without submitting later', async () => {
  const key = JSON.stringify(['draft', 'session-original']), gate = deferred<any>(), f = fixture()
  await getDeviceWorkface().updateConversation({ version: 1, drafts: [[key, '原正文']], responses: [], attempts: [[key, {
    operationId: 'original-prompt', runId: 'run-original', draft: '原正文', phase: 'unknown', inputRequested: true,
    originalRuntimeId: 'original-runtime', originalHostId: 'host-original', explicit: true,
    manualInput: { agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, runtimeId: 'original-runtime' }
  }]] })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await vi.waitFor(() => expect(f.inspectInput).toHaveBeenCalled())
  f.inspectInput.mockClear().mockImplementation(() => gate.promise)
  await click(button(view.element, '重试原请求'))
  await click(button(view.element, '取消未发起的重试'))
  expect(await apply()).toEqual({ status: 'navigating' })
  const save = vi.spyOn(getDeviceWorkface(), 'editConversation')
  await act(async () => gate.resolve(null))
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoinInput).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  expect(createLocalDrafts().attempts.get(key)).toMatchObject({ operationId: 'original-prompt', draft: '原正文', phase: 'unknown' })
})

it('cancels the original retry reached from Send without retaining a second update blocker', async () => {
  const key = JSON.stringify(['draft', 'session-original']), gate = deferred<any>(), f = fixture()
  await getDeviceWorkface().updateConversation({ version: 1, drafts: [[key, '原正文']], responses: [], attempts: [[key, {
    operationId: 'original-prompt', runId: 'run-original', draft: '原正文', phase: 'unknown', inputRequested: true,
    originalRuntimeId: 'original-runtime', originalHostId: 'host-original', explicit: true,
    manualInput: { agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, runtimeId: 'original-runtime' }
  }]] })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await vi.waitFor(() => expect(f.inspectInput).toHaveBeenCalled())
  f.inspectInput.mockClear().mockImplementation(() => gate.promise)
  await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(f.inspectInput).toHaveBeenCalledOnce())
  await click(button(view.element, '取消未发起的重试'))
  expect(await apply()).toEqual({ status: 'navigating' })
  await act(async () => gate.resolve(null))
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoinInput).not.toHaveBeenCalled()
})

it('updates after the original manual retry is dispatched without replaying it', async () => {
  const key = JSON.stringify(['draft', 'session-original']), gate = deferred<any>(), f = fixture()
  await getDeviceWorkface().updateConversation({ version: 1, drafts: [[key, '原正文']], responses: [], attempts: [[key, {
    operationId: 'original-prompt', runId: 'run-original', draft: '原正文', phase: 'unknown', inputRequested: true,
    originalRuntimeId: 'original-runtime', originalHostId: 'host-original', explicit: true,
    manualInput: { agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, runtimeId: 'original-runtime' }
  }]] })
  f.submit.mockImplementation(() => gate.promise)
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await click(button(view.element, '重试原请求'))
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
  expect(f.submit.mock.calls[0]![0].operationId).toBe('original-prompt')
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(createLocalDrafts().attempts.get(key)).toMatchObject({ operationId: 'original-prompt', phase: 'unknown' })
  expect(f.submit).toHaveBeenCalledOnce()
  await act(async () => gate.resolve(await acceptedPrompt(f.submit.mock.calls[0]![0])))
})

it('cancels a manual retry during its request save without changing the prior request fact', async () => {
  const key = JSON.stringify(['draft', 'session-original']), gate = deferred<void>(), f = fixture(), owner = getDeviceWorkface(), edit = owner.editConversation.bind(owner), entered = vi.fn(), restored = vi.fn()
  await owner.updateConversation({ version: 1, drafts: [[key, '原正文']], responses: [], attempts: [[key, {
    operationId: 'original-prompt', runId: 'run-original', draft: '原正文', phase: 'unknown', inputRequested: false,
    originalRuntimeId: 'original-runtime', originalHostId: 'host-original', explicit: true,
    manualInput: { agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, runtimeId: 'original-runtime' }
  }]] })
  let requestedWritten = false
  vi.spyOn(owner, 'editConversation').mockImplementation((edits, recordId) => {
    if (edits.some(item => item.bucket === 'attempts' && (item.next as { inputRequested?: boolean } | undefined)?.inputRequested === true)) {
      entered(); return gate.promise.then(() => edit(edits, recordId)).then(result => { requestedWritten = true; return result })
    }
    if (requestedWritten) restored()
    return edit(edits, recordId)
  })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await click(button(view.element, '重试原请求')); await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  await click(button(view.element, '取消未发起的重试'))
  expect(await apply()).toMatchObject({ status: 'blocked' })
  await act(async () => { gate.resolve(); await vi.waitFor(() => expect(restored).toHaveBeenCalledOnce()) })
  await vi.waitFor(() => expect(createLocalDrafts().attempts.get(key)?.inputRequested).toBe(false))
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoinInput).not.toHaveBeenCalled()
  expect(createLocalDrafts().attempts.get(key)).toMatchObject({ operationId: 'original-prompt', draft: '原正文', phase: 'unknown' })
})

it('retains a matching Core observation when cancelling a retry during its request save', async () => {
  const key = JSON.stringify(['draft', 'session-original']), gate = deferred<void>(), f = fixture(), owner = getDeviceWorkface(), edit = owner.editConversation.bind(owner), entered = vi.fn(), rollback = vi.fn()
  await owner.updateConversation({ version: 1, drafts: [[key, '原正文']], responses: [], attempts: [[key, {
    operationId: 'original-prompt', runId: 'run-original', draft: '原正文', phase: 'unknown', inputRequested: false,
    originalRuntimeId: 'original-runtime', originalHostId: 'host-original', explicit: true,
    manualInput: { agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, runtimeId: 'original-runtime' }
  }]] })
  const receipt = (await acceptedPrompt({ agentSessionId: 'session-original', operationId: 'original-prompt', expectedRun: { runId: 'run-original' },
    admissionIntent: { kind: 'manual-actor' }, prompt: '原正文', execution: 'immediate', authorHuman: true }))!
  const waiting = { ...receipt, admission: null, status: 'waiting' as const, observation: 'rejoin-needed' as const, control: {
    ref: receipt.ref, state: 'enabled' as const, at: receipt.control.at, waiting: {
      phase: 'input-environment' as const, reason: 'original-input-unconfirmed' as const, wake: 'explicit-rejoin' as const,
      failure: { name: 'Error', message: 'pending' } } } }
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await vi.waitFor(() => expect(f.inspectInput).toHaveBeenCalled())
  f.inspectInput.mockResolvedValue(null)
  let requestedWritten = false
  vi.spyOn(owner, 'editConversation').mockImplementation((edits, recordId) => {
    if (edits.some(item => item.bucket === 'attempts' && (item.next as { inputRequested?: boolean } | undefined)?.inputRequested === true)) {
      entered(); return gate.promise.then(() => edit(edits, recordId)).then(result => { requestedWritten = true; return result })
    }
    if (entered.mock.calls.length && !requestedWritten) return gate.promise.then(() => edit(edits, recordId))
    if (requestedWritten) rollback()
    return edit(edits, recordId)
  })
  await click(button(view.element, '重试原请求')); await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  await act(async () => f.emit({ type: 'agent-input', receipt: waiting }))
  await click(button(view.element, '取消未发起的重试'))
  await act(async () => { gate.resolve(); await vi.waitFor(() => expect(owner.snapshot().record.conversation.attempts[0]![1].inputRequested).toBe(true)) })
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoinInput).not.toHaveBeenCalled()
  expect(rollback).not.toHaveBeenCalled()
  expect(createLocalDrafts().attempts.get(key)).toMatchObject({ operationId: 'original-prompt', inputRequested: true, phase: 'unknown' })
})

it('does not replace a newly observed waiting input with the older rejected phase when retry is cancelled', async () => {
  const key = JSON.stringify(['draft', 'session-original']), gate = deferred<void>(), f = fixture(), owner = getDeviceWorkface(), edit = owner.editConversation.bind(owner), entered = vi.fn(), settled = vi.fn()
  await owner.updateConversation({ version: 1, drafts: [[key, '原正文']], responses: [], attempts: [[key, {
    operationId: 'original-prompt', runId: 'run-original', draft: '原正文', phase: 'rejected', inputRequested: false,
    originalRuntimeId: 'original-runtime', originalHostId: 'host-original', explicit: true
  }]] })
  const receipt = (await acceptedPrompt({ agentSessionId: 'session-original', operationId: 'original-prompt', expectedRun: { runId: 'run-original' },
    admissionIntent: { kind: 'manual-actor' }, prompt: '原正文', execution: 'immediate', authorHuman: true }))!
  f.inspectInput.mockResolvedValue({ ...receipt, admission: null, status: 'waiting', observation: 'rejoin-needed', control: {
    ref: receipt.ref, state: 'enabled', at: receipt.control.at, waiting: {
      phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin', failure: { name: 'Error', message: 'pending' } } } })
  let requestedWritten = false
  vi.spyOn(owner, 'editConversation').mockImplementation((edits, recordId) => {
    if (edits.some(item => item.bucket === 'attempts' && (item.next as { inputRequested?: boolean } | undefined)?.inputRequested === true)) {
      entered(); return gate.promise.then(() => edit(edits, recordId)).then(result => { requestedWritten = true; return result })
    }
    if (entered.mock.calls.length && !requestedWritten) return gate.promise.then(() => edit(edits, recordId))
    if (requestedWritten) settled()
    return edit(edits, recordId)
  })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await click(button(view.element, '重试原请求')); await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  await click(button(view.element, '取消未发起的重试'))
  await act(async () => { gate.resolve(); await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce()) })
  await vi.waitFor(() => expect(createLocalDrafts().attempts.get(key)?.phase).toBe('unknown'))
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoinInput).not.toHaveBeenCalled()
  expect(createLocalDrafts().attempts.get(key)).toMatchObject({ operationId: 'original-prompt', phase: 'unknown', inputRequested: true,
    manualInput: { agentSessionId: 'session-original', expectedRun: { runId: 'run-original' } } })
})

it('cancels a nonmanual retry during its phase save without dispatching or changing the old phase', async () => {
  const key = JSON.stringify(['draft', 'session-original']), gate = deferred<void>(), f = fixture(), owner = getDeviceWorkface(), edit = owner.editConversation.bind(owner), entered = vi.fn(), restored = vi.fn()
  await owner.updateConversation({ version: 1, drafts: [[key, '原正文']], responses: [], attempts: [[key, {
    operationId: 'original-prompt', runId: 'run-original', draft: '原正文', phase: 'unknown', inputRequested: true,
    originalRuntimeId: 'original-runtime', originalHostId: 'host-original', explicit: false,
    request: { condition: { expectedRun: { runId: 'run-original' }, afterSubmissionId: 'previous' }, execution: 'default', explicit: false, runtimeId: 'original-runtime' }
  }]] })
  let sendingWritten = false
  vi.spyOn(owner, 'editConversation').mockImplementation((edits, recordId) => {
    if (edits.some(item => item.bucket === 'attempts' && (item.next as { phase?: string } | undefined)?.phase === 'sending')) {
      entered(); return gate.promise.then(() => edit(edits, recordId)).then(result => { sendingWritten = true; return result })
    }
    if (sendingWritten) restored()
    return edit(edits, recordId)
  })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await click(button(view.element, '重试原请求')); await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  await click(button(view.element, '取消未发起的重试'))
  expect(await apply()).toMatchObject({ status: 'blocked' })
  await act(async () => { gate.resolve(); await vi.waitFor(() => expect(restored).toHaveBeenCalledOnce()) })
  await vi.waitFor(() => expect(owner.snapshot().record.conversation.attempts[0]![1].phase).toBe('unknown'))
  expect(f.submit).not.toHaveBeenCalled()
  expect(createLocalDrafts().attempts.get(key)).toMatchObject({ operationId: 'original-prompt', phase: 'unknown', inputRequested: true })
})

it('restores the original unrequested input when condition retention is cancelled', async () => {
  const key = JSON.stringify(['draft', 'session-original']), gate = deferred<void>(), f = fixture(), owner = getDeviceWorkface(), edit = owner.editConversation.bind(owner), entered = vi.fn(), restored = vi.fn()
  await owner.updateConversation({ version: 1, drafts: [[key, '原正文']], responses: [], attempts: [[key, {
    operationId: 'original-prompt', runId: 'run-original', draft: '原正文', phase: 'rejected', inputRequested: false,
    originalRuntimeId: 'original-runtime', originalHostId: 'host-original', explicit: false
  }]] })
  let conditionWritten = false
  vi.spyOn(owner, 'editConversation').mockImplementation((edits, recordId) => {
    if (edits.some(item => item.bucket === 'attempts' && (item.next as { request?: unknown } | undefined)?.request)) {
      entered(); return gate.promise.then(() => edit(edits, recordId)).then(result => { conditionWritten = true; return result })
    }
    if (conditionWritten) restored()
    return edit(edits, recordId)
  })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await click(button(view.element, '重试原请求')); await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  await click(button(view.element, '取消未发起的重试'))
  await act(async () => { gate.resolve(); await vi.waitFor(() => expect(restored).toHaveBeenCalledOnce()) })
  await vi.waitFor(() => expect(owner.snapshot().record.conversation.attempts[0]![1]).not.toHaveProperty('request'))
  expect(f.submit).not.toHaveBeenCalled()
  expect(createLocalDrafts().attempts.get(key)).toMatchObject({ operationId: 'original-prompt', phase: 'rejected', inputRequested: false })
})

it('cancels a stop while its intent save is pending, retaining the original waiting input', async () => {
  const gate = deferred<void>(), f = fixture(), owner = getDeviceWorkface(), edit = owner.editConversation.bind(owner), entered = vi.fn(), restored = vi.fn()
  f.submit.mockImplementation(async input => {
    const receipt = (await acceptedPrompt(input))!
    return { ...receipt, admission: null, status: 'waiting', observation: 'rejoin-needed', control: {
      ref: receipt.ref, state: 'enabled', at: receipt.control.at,
      waiting: { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin', failure: { name: 'Error', message: 'pending' } }
    } }
  })
  let stopWritten = false
  vi.spyOn(owner, 'editConversation').mockImplementation((edits, recordId) => {
    if (edits.some(item => item.bucket === 'attempts' && (item.next as any)?.manualInput?.stopIntent)) {
      entered(); return gate.promise.then(() => edit(edits, recordId)).then(result => { stopWritten = true; return result })
    }
    if (stopWritten) restored()
    return edit(edits, recordId)
  })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文'); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(button(view.element, '停止等待')).toBeDefined())
  await click(button(view.element, '停止等待')); await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  await click(button(view.element, '取消未发起的停止'))
  await click(button(view.element, '重试停止等待'))
  expect(entered).toHaveBeenCalledOnce()
  expect(f.stopInput).not.toHaveBeenCalled()
  expect(await apply()).toMatchObject({ status: 'blocked' })
  await act(async () => { gate.resolve(); await vi.waitFor(() => expect(restored).toHaveBeenCalledOnce()) })
  await vi.waitFor(() => expect(createLocalDrafts().attempts.get(JSON.stringify(['draft', 'session-original']))?.manualInput?.stopIntent).toBeUndefined())
  expect(f.stopInput).not.toHaveBeenCalled()
  expect(await apply()).toEqual({ status: 'navigating' })
})

it('retains an already dispatched stop across update without issuing a second stop', async () => {
  const gate = deferred<any>(), f = fixture()
  f.submit.mockImplementation(async input => {
    const receipt = (await acceptedPrompt(input))!
    return { ...receipt, admission: null, status: 'waiting', observation: 'rejoin-needed', control: {
      ref: receipt.ref, state: 'enabled', at: receipt.control.at,
      waiting: { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin', failure: { name: 'Error', message: 'pending' } }
    } }
  })
  f.stopInput.mockImplementation(() => gate.promise)
  const surface = <MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />{surface}</MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文'); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(button(view.element, '停止等待')).toBeDefined())
  await click(button(view.element, '停止等待'))
  await vi.waitFor(() => expect(f.stopInput).toHaveBeenCalledOnce())
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /></MobileWebUpdateSafetyProvider>)
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(createLocalDrafts().attempts.get(JSON.stringify(['draft', 'session-original']))?.manualInput?.stopIntent).toEqual(f.stopInput.mock.calls[0]![0])
  expect(f.stopInput).toHaveBeenCalledOnce()
  await act(async () => gate.resolve({ ...f.stopInput.mock.calls[0]![0], outcome: 'stopped-before-dispatch', at: new Date().toISOString() }))
})

it('updates after the exact original send was dispatched and cold-reads it as unknown without replay', async () => {
  const gate = deferred<any>(), f = fixture()
  f.submit.mockImplementation(() => gate.promise)
  const surface = <MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />{surface}</MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文'); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
  const original = f.submit.mock.calls[0]![0]
  expect(getDeviceWorkface().snapshot().record.conversation.attempts[0]![1]).toMatchObject({
    operationId: original.operationId, draft: '原正文', phase: 'sending', inputRequested: true })
  expect(await apply()).toEqual({ status: 'navigating' })
  const cold = createLocalDrafts().attempts.get(JSON.stringify(['draft', 'session-original']))!
  expect(cold).toMatchObject({ operationId: original.operationId, draft: '原正文', phase: 'unknown', inputRequested: true })
  expect(f.submit).toHaveBeenCalledOnce()
  const terminal = (await acceptedPrompt(f.submit.mock.calls[0]![0]))!
  const receipt = { ...terminal, admission: null, status: 'waiting' as const, observation: 'rejoin-needed' as const,
    control: { ref: terminal.ref, state: 'enabled' as const, at: terminal.control.at, waiting: {
      phase: 'input-environment' as const, reason: 'original-input-unconfirmed' as const, wake: 'explicit-rejoin' as const,
      failure: { name: 'Error', message: 'pending' } } } }
  await act(async () => f.emit({ type: 'agent-input', receipt }))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.conversation.attempts[0]![1].phase).toBe('unknown'))
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /></MobileWebUpdateSafetyProvider>)
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(f.submit).toHaveBeenCalledOnce()
  await act(async () => gate.resolve(receipt))
})

it('can explicitly cancel before a pending send-intent save finishes, without dispatching', async () => {
  const f = fixture(), owner = getDeviceWorkface(), gate = deferred<void>()
  const edit = owner.editConversation.bind(owner)
  const blockedSave = vi.fn()
  vi.spyOn(owner, 'editConversation').mockImplementation((edits, recordId) => {
    if (edits.some(item => item.bucket === 'attempts' && (item.next as { inputRequested?: boolean } | undefined)?.inputRequested === true)) {
      blockedSave(); return gate.promise.then(() => edit(edits, recordId))
    }
    return edit(edits, recordId)
  })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文'); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(blockedSave).toHaveBeenCalledOnce())
  expect(await apply()).toMatchObject({ status: 'blocked' })
  expect(f.submit).not.toHaveBeenCalled()
  await click(button(view.element, '取消发送准备'))
  expect(editor(view.element).textContent).toBe('原正文')
  expect(view.element.textContent).toContain('设备保存尚未确认')
  expect(f.submit).not.toHaveBeenCalled()
  await act(async () => { gate.resolve(); await vi.waitFor(() => expect(owner.snapshot().record.conversation.attempts[0]?.[1].phase).toBe('rejected')) })
  expect(f.submit).not.toHaveBeenCalled()
  expect(editor(view.element).textContent).toBe('原正文')
})

it('does not apply a dispatched marker to an identical operation in another Session', async () => {
  const f = fixture(), gate = deferred<any>(), create = createLocalDrafts
  let local!: ReturnType<typeof createLocalDrafts>
  vi.spyOn(localDraftModule, 'createLocalDrafts').mockImplementation((...args) => local = create(...args))
  f.submit.mockImplementation(() => gate.promise)
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文'); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
  const first = local.attempts.get(JSON.stringify(['draft', 'session-original']))!
  local.attempts.set(JSON.stringify(['draft', 'other']), structuredClone(first))
  await act(async () => { await local.save() })
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('仍在发送') })
  expect(f.submit).toHaveBeenCalledOnce()
  await act(async () => gate.resolve(await acceptedPrompt(f.submit.mock.calls[0]![0])))
})

it('checks only dispatched operations for the original workface key', async () => {
  await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><DispatchProbe /></MobileWebUpdateSafetyProvider>)
  const irrelevant = vi.fn(() => false), relevant = vi.fn(() => true)
  for (let index = 0; index < 500; index++) dispatches.track(`other-${index}`, irrelevant)
  const release = dispatches.track('original-key', relevant)
  expect(dispatches.includes('original-key', {})).toBe(true)
  expect(relevant).toHaveBeenCalledOnce(); expect(irrelevant).not.toHaveBeenCalled()
  release()
  expect(dispatches.includes('original-key', {})).toBe(false)
  expect(irrelevant).not.toHaveBeenCalled()
})

it('does not update a dispatched send whose original intent failed to persist', async () => {
  const f = fixture(), owner = getDeviceWorkface(), edit = owner.editConversation.bind(owner), receipt = deferred<any>()
  f.submit.mockImplementation(() => receipt.promise)
  vi.spyOn(owner, 'editConversation').mockImplementation((edits, recordId) => {
    if (edits.some(item => item.bucket === 'attempts' && (item.next as { inputRequested?: boolean } | undefined)?.inputRequested === true)) {
      return Promise.reject(new Error('device write failed'))
    }
    return edit(edits, recordId)
  })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />
    <MobileConversationSurface client={f.client} agentSessionId="session-original"
      connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} />
  </MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文'); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('尚未确认保存在设备') })
  expect(f.submit).toHaveBeenCalledOnce()
  await act(async () => receipt.resolve(await acceptedPrompt(f.submit.mock.calls[0]![0])))
})

it('keeps a dispatched original send updateable across real mobile workface switches and remount', async () => {
  const f = fixture(), gate = deferred<any>(), platform = createBrowserPlatform()
  f.submit.mockImplementation(() => gate.promise)
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'appearance', dispose: async () => {} })
  f.client.forwardRpc = vi.fn().mockImplementation(async method => {
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [],
      agentPresentation: [{ agentSessionId: 'session-original', name: '原 Agent', project: '原项目', group: 'working', state: 'working', detail: '执行中', providerId: 'codex' }] } }
    if (method === 'app.snapshot') return { agents: [] }
    if (method === 'agent.inspect') return { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } }
    throw new Error('Observation unavailable: ' + method)
  })
  await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const app = <MobileApp client={f.client} connection={{ state: 'connected', message: '原连接' }} platform={platform} />
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />{app}</MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文'); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
  await click(button(view.element.querySelector('nav.mobile-navigation')!, 'Space'))
  await click(button(view.element.querySelector('nav.mobile-navigation')!, 'Focus'))
  await click(view.element.querySelector('.mobile-session-list button')!)
  expect(await apply()).toEqual({ status: 'navigating' })
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /></MobileWebUpdateSafetyProvider>)
  await view.render(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action />{app}</MobileWebUpdateSafetyProvider>)
  expect(editor(view.element).textContent).toBe('原正文')
  expect(createLocalDrafts().attempts.get(JSON.stringify(['draft', 'session-original']))?.phase).toBe('unknown')
  expect(await apply()).toEqual({ status: 'navigating' })
  expect(f.submit).toHaveBeenCalledOnce()
  await act(async () => gate.resolve(await acceptedPrompt(f.submit.mock.calls[0]![0])))
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
