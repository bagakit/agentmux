// @vitest-environment happy-dom
import { act, useRef } from 'react'
import type { Editor } from '@tiptap/core'
import { beforeEach, expect, it, vi } from 'vitest'
import { InlineComposer } from '@agentmux/client-ui/components/InlineComposer'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { expandComposerInput } from '@agentmux/client-ui/composer-semantic-reference'
import { fileUploadRevision, type FileUploadIdentity } from '@agentmux/core/files'
import { ComposerFeedback, useComposerFeedback } from '../src/renderer/src/components/ComposerFeedback'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { api } from '../src/renderer/src/lib/api'
import { useComposerAttachments } from '../src/renderer/src/lib/use-composer-attachments'
import { screenshotAttachmentReceiver } from '../src/renderer/src/lib/screenshot-attachment'
import { originalSourceInputOwnerKey } from '../src/renderer/src/lib/original-space-navigation'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import type { SpaceMountMemberTarget } from '../src/shared/space-mount'

const dom = composerDOM(), owner = 'original-source-input'
const localImage = fixturePath('pasted/original.png')
const bytes = new Uint8Array([1, 2, 3]), mimeType = 'image/png'
const upload: FileUploadIdentity = { hostId: 'original-agent-device', agentSessionId: 'same-sid', expectedRun: { runId: 'original-run' },
  operationId: 'original-image-upload', name: 'image', mimeType, byteLength: bytes.length, revision: fileUploadRevision(bytes) }
type Result = { upload: FileUploadIdentity; observation: 'confirmed' | 'unavailable'; issue?: { code?: string; message: string } }
type Retain = (bytes: Uint8Array, mimeType: string) => Promise<Result>
const documentRef = { windowId: 'original-window', documentGeneration: 'original-document' }

/** The shared hook consumes actual maintained editor events, bookmarks and Undo. Only resource IO is replaced. */
function SharedAttachments({ scope = owner, retainImage, local = false }: { scope?: string; retainImage?: Retain; local?: boolean }) {
  const insertion = useRef<ComposerInsertionHandle>(null), feedback = useComposerFeedback(scope)
  const draft = useAppStore(state => state.agentComposerDrafts[scope] ?? '')
  const attachments = useComposerAttachments({ scope, hostId: local ? 'local' : undefined, workspacePath: undefined,
    ...(local ? { sessionControl: composerSession().control } : {}), ...(retainImage ? { retainImage } : {}),
    disabled: false, insertion, feedback, document: documentRef })
  return <div onFocusCapture={attachments.claimScreenshotTarget}>
    <InlineComposer value={draft} onValueChange={value => useAppStore.getState().setAgentComposerDraft(scope, value)}
      disabled={false} placeholder="Original input" aria-label="Original input" onKeyDown={() => {}}
      insertionRef={insertion} onPasteImage={attachments.pasteImage} onDropFiles={attachments.dropFiles}
      readPastedImage={api.ui.readPastedImage} />
    <button onClick={() => void feedback.run(() => attachments.capture())}>Capture original image</button>
    <ComposerFeedback failure={feedback.failure} onDismiss={feedback.dismiss} />
  </div>
}
const editor = () => (dom.container.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
async function paste() {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  const file = new File([bytes], 'original.png', { type: mimeType })
  Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: mimeType, getAsFile: () => file }], getData: () => '' } })
  await act(async () => dom.container.querySelector('.tiptap')!.dispatchEvent(event))
}
beforeEach(() => {
  useAppStore.setState({ agentComposerDrafts: { [owner]: 'Before selection after', later: 'Later original draft' }, agentSteerQueues: {
    [owner]: [{ operationId: 'original-unknown-input', text: 'Unconfirmed original input', enqueuedAt: 1, runId: 'original-run', status: 'deferred', awaitingExplicitSend: true, origin: 'manual', promptCondition: null }] } })
  vi.spyOn(api.ui, 'savePastedImage').mockResolvedValue(localImage)
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue({ dataUrl: 'data:image/png;base64,AQID' })
})

it('pastes through the original image port while preserving the maintained selection, later edits and Undo', async () => {
  let finish!: (value: Result) => void
  const retain = vi.fn<Retain>(() => new Promise(resolve => { finish = resolve }))
  const local = vi.spyOn(api.ui, 'retainInputImage')
  await dom.render(<SharedAttachments retainImage={retain} />)
  await act(async () => editor().commands.setTextSelection({ from: 8, to: 17 }))
  await paste(); await vi.waitFor(() => expect(retain).toHaveBeenCalledExactlyOnceWith(bytes, mimeType))
  await act(async () => editor().chain().setTextSelection(editor().state.doc.content.size - 1).insertContent(' later').run())
  await act(async () => finish({ upload, observation: 'confirmed' }))
  await vi.waitFor(() => expect(expandComposerInput(dom.draft(owner)!).inputImages).toHaveLength(1))
  const selected = expandComposerInput(dom.draft(owner)!)
  expect(selected.text).toBe('Before [Selected image] after later')
  expect(selected.text).not.toContain(localImage)
  expect(selected.inputImages[0]?.upload).toEqual(upload)
  expect(local).not.toHaveBeenCalled()
  expect(api.ui.savePastedImage).toHaveBeenCalledExactlyOnceWith({ bytes, extension: 'png' })
  await act(async () => editor().commands.undo())
  expect(dom.draft(owner)).toBe('Before selection after later')
  await act(async () => editor().commands.redo())
  expect(expandComposerInput(dom.draft(owner)!).inputImages[0]?.upload).toEqual(upload)
  expect(retain).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().agentSteerQueues[owner]?.[0]?.operationId).toBe('original-unknown-input')
})

it.each(['FILE_UPLOAD_HOST_UNAVAILABLE', 'FILE_UPLOAD_FORBIDDEN'])('retains the original image identity and exact %s issue without a new-upload Retry', async code => {
  const retain = vi.fn<Retain>().mockResolvedValue({ upload, observation: 'unavailable', issue: { code, message: 'Original image receipt requires inspection' } })
  await dom.render(<SharedAttachments retainImage={retain} />); await paste()
  await vi.waitFor(() => expect(expandComposerInput(dom.draft(owner)!).inputImages[0]?.upload).toEqual(upload))
  expect(expandComposerInput(dom.draft(owner)!).text).not.toContain(localImage)
  expect(dom.container.textContent).toContain('Original image receipt requires inspection')
  expect(dom.container.textContent).toContain(localImage)
  const retry = [...dom.container.querySelectorAll('button')].find(button => /retry|重试|继续确认/i.test(button.getAttribute('aria-label') ?? button.textContent ?? ''))
  if (retry) await act(async () => retry.click())
  expect(retain).toHaveBeenCalledTimes(1)
  expect(retry).toBeUndefined()
})

it('keeps the local original image and draft when no original Run can admit this upload', async () => {
  const retain = vi.fn<Retain>().mockRejectedValue(new Error('The original Run is unconfirmed'))
  await dom.render(<SharedAttachments retainImage={retain} />); await paste()
  await vi.waitFor(() => expect(dom.container.textContent).toContain('The original Run is unconfirmed'))
  expect(api.ui.savePastedImage).toHaveBeenCalledOnce()
  expect(dom.container.textContent).toContain(localImage)
  expect(dom.draft(owner)).toBe('Before selection after')
})

it('captures locally and uploads the original bytes without manufacturing a local Agent', async () => {
  const capture = vi.spyOn(api.ui, 'captureScreenshot').mockResolvedValue(localImage)
  const retain = vi.fn<Retain>().mockResolvedValue({ upload, observation: 'confirmed' })
  const local = vi.spyOn(api.ui, 'retainInputImage')
  await dom.render(<SharedAttachments retainImage={retain} />); await dom.click('button')
  await vi.waitFor(() => expect(retain).toHaveBeenCalledExactlyOnceWith(bytes, mimeType))
  expect(capture).toHaveBeenCalledOnce(); expect(api.ui.readPastedImage).toHaveBeenCalledWith(localImage)
  expect(api.ui.savePastedImage).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled()
  expect(expandComposerInput(dom.draft(owner)!).inputImages[0]?.upload).toEqual(upload)
})

it.each(['cancelled', 'unreadable'] as const)('keeps a %s local capture from becoming an unconfirmed remote path', async outcome => {
  vi.spyOn(api.ui, 'captureScreenshot').mockResolvedValue(outcome === 'cancelled' ? null : localImage)
  vi.mocked(api.ui.readPastedImage).mockResolvedValue(null)
  const retain = vi.fn<Retain>()
  await dom.render(<SharedAttachments retainImage={retain} />); await dom.click('button')
  if (outcome === 'unreadable') await vi.waitFor(() => expect(dom.container.textContent).toContain('original captured image bytes are unavailable'))
  else await vi.waitFor(() => expect(api.ui.captureScreenshot).toHaveBeenCalledOnce())
  expect(dom.draft(owner)).toBe('Before selection after'); expect(retain).not.toHaveBeenCalled()
  if (outcome === 'unreadable') expect(dom.container.textContent).toContain(localImage)
})

it('keeps a dropped original image while reporting the unrelated untransferred file without batch replay', async () => {
  const retain = vi.fn<Retain>().mockResolvedValue({ upload, observation: 'confirmed' })
  await dom.render(<SharedAttachments retainImage={retain} />)
  vi.spyOn(editor().view, 'posAtCoords').mockReturnValue({ pos: 8, inside: 0 })
  const files = [new File([bytes], 'original.png', { type: mimeType }), new File(['private text'], 'original.txt', { type: 'text/plain' })]
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'], items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })), getData: () => '' } })
  await act(async () => dom.container.querySelector('.tiptap')!.dispatchEvent(event))
  await vi.waitFor(() => expect(expandComposerInput(dom.draft(owner)!).inputImages).toHaveLength(1))
  expect(dom.container.textContent).toContain('original.txt: This local file has not been transferred')
  expect(expandComposerInput(dom.draft(owner)!).text).not.toContain(localImage)
  expect(retain).toHaveBeenCalledTimes(1)
})

it('routes the original focused screenshot shortcut through the same port exactly once', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const retain = vi.fn<Retain>().mockResolvedValue({ upload, observation: 'confirmed' })
  await dom.render(<SharedAttachments retainImage={retain} />)
  await act(async () => { editor().commands.focus(); dom.container.querySelector<HTMLElement>('.tiptap')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
  expect(screenshotAttachmentReceiver.prepare('original-capture')).toEqual(documentRef)
  await act(async () => screenshotAttachmentReceiver.complete('original-capture', localImage))
  expect(expandComposerInput(dom.draft(owner)!).inputImages[0]?.upload).toEqual(upload)
  expect(retain).toHaveBeenCalledTimes(1)
})

it('does not move a late original upload acknowledgement into a later editor or upload it again', async () => {
  let finish!: (value: Result) => void
  const retain = vi.fn<Retain>(() => new Promise(resolve => { finish = resolve }))
  await dom.render(<SharedAttachments retainImage={retain} />); await paste()
  await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce())
  await dom.render(<SharedAttachments scope="later" retainImage={retain} />)
  await act(async () => finish({ upload, observation: 'confirmed' }))
  expect(dom.draft(owner)).toBe('Before selection after'); expect(dom.draft('later')).toBe('Later original draft')
  expect(retain).toHaveBeenCalledTimes(1)
})

it('keeps the existing local retention and path semantics when no original port is supplied', async () => {
  const retain = vi.spyOn(api.ui, 'retainInputImage').mockResolvedValue({ upload: { ...upload, hostId: 'local' }, observation: 'confirmed' })
  await dom.render(<SharedAttachments local />); await paste()
  await vi.waitFor(() => expect(retain).toHaveBeenCalledExactlyOnceWith({ session: composerSession().control, bytes, mimeType }))
  expect(expandComposerInput(dom.draft(owner)!).text).toContain(localImage)
})

it('does not claim an untransferred local path when neither local control nor an original upload port exists', async () => {
  await dom.render(<SharedAttachments />); await paste()
  await vi.waitFor(() => expect(dom.container.textContent).toContain('has not been transferred'))
  expect(api.ui.savePastedImage).not.toHaveBeenCalled(); expect(dom.draft(owner)).toBe('Before selection after')
})

it.each(['paste', 'capture'] as const)('the actual Source Composer uses its original image port for %s without borrowing an observer same-SID Agent', async action => {
  const sourceOwner = originalSourceInputOwnerKey('original-runtime', upload.agentSessionId)
  const target: SpaceMountMemberTarget = { hostId: 'source-carrier', target: {
    reference: { runtimeId: 'source-runtime', spaceId: 'original-space' }, regionId: 'original-region',
    runtimeId: 'original-runtime', agentSessionId: upload.agentSessionId, expectedRun: upload.expectedRun,
    expectedAdmission: { kind: 'creation', operationId: 'original-creation' } } }
  const session = { ...composerSession(upload.agentSessionId), hostId: upload.hostId,
    control: { kind: 'agent' as const, hostId: upload.hostId, agentSessionId: upload.agentSessionId, run: upload.expectedRun } }
  const observer = composerSession(upload.agentSessionId), retain = vi.fn<Retain>().mockResolvedValue({ upload, observation: 'confirmed' })
  const local = vi.spyOn(api.ui, 'retainInputImage')
  vi.spyOn(api.ui, 'captureScreenshot').mockResolvedValue(localImage)
  useAppStore.setState({ sessions: [observer], agentComposerDrafts: { [sourceOwner]: 'Original Source message', [observer.id]: 'Unrelated local draft' } })
  await dom.render(<AgentSessionComposer sessionId={sourceOwner} source={{ target, session, retainImage: retain }} />)
  if (action === 'paste') await paste()
  else { await dom.click('.composer-tool--mode'); await dom.click('[aria-label="Capture a screen region"]') }
  await vi.waitFor(() => expect(retain).toHaveBeenCalledExactlyOnceWith(bytes, mimeType))
  const input = expandComposerInput(dom.draft(sourceOwner)!)
  expect(input.inputImages[0]?.upload).toEqual(upload)
  expect(input.text).toContain('[Selected image]'); expect(input.text).not.toContain(localImage)
  expect(dom.draft(observer.id)).toBe('Unrelated local draft')
  expect(useAppStore.getState().sessions[0]).toBe(observer); expect(local).not.toHaveBeenCalled()
})


it('the actual Source Composer keeps selection and later typing when its original upload target rejects before admission', async () => {
  const sourceOwner = originalSourceInputOwnerKey('original-runtime', upload.agentSessionId)
  let reject!: (error: Error) => void
  const retain = vi.fn<Retain>(() => new Promise((_resolve, decline) => { reject = decline }))
  const target: SpaceMountMemberTarget = { hostId: 'source-carrier', target: {
    reference: { runtimeId: 'source-runtime', spaceId: 'original-space' }, regionId: 'original-region',
    runtimeId: 'original-runtime', agentSessionId: upload.agentSessionId, expectedRun: upload.expectedRun,
    expectedAdmission: { kind: 'creation', operationId: 'original-creation' } } }
  const observer = composerSession(upload.agentSessionId), local = vi.spyOn(api.ui, 'retainInputImage')
  useAppStore.setState({ sessions: [observer], agentComposerDrafts: { [sourceOwner]: 'Before selection after', [observer.id]: 'Unrelated local draft' } })
  await dom.render(<AgentSessionComposer sessionId={sourceOwner} source={{ target, retainImage: retain }} />)
  await act(async () => editor().commands.setTextSelection({ from: 8, to: 17 }))
  await paste(); await vi.waitFor(() => expect(retain).toHaveBeenCalledExactlyOnceWith(bytes, mimeType))
  await act(async () => editor().chain().setTextSelection(editor().state.doc.content.size - 1).insertContent(' later').run())
  await act(async () => reject(new Error('The original Run is unconfirmed; no image upload was admitted')))
  expect(dom.draft(sourceOwner)).toBe('Before selection after later')
  const opened = new Event('toggle'); Object.defineProperty(opened, 'newState', { value: 'open' })
  await act(async () => dom.container.querySelector('.composer-mailbox')!.dispatchEvent(opened))
  await dom.click('[id$="-system-tab"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('The original Run is unconfirmed'))
  expect(dom.container.textContent).toContain(localImage)
  expect(expandComposerInput(dom.draft(sourceOwner)!).inputImages).toHaveLength(0)
  expect(dom.draft(observer.id)).toBe('Unrelated local draft'); expect(local).not.toHaveBeenCalled()
  expect(api.ui.savePastedImage).toHaveBeenCalledExactlyOnceWith({ bytes, extension: 'png' })
  expect(retain).toHaveBeenCalledTimes(1)
})
