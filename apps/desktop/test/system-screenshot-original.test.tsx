// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSystemScreenshotOriginal } from '../src/renderer/screenshot-editor/use-system-screenshot-original'
import { createEditableAnnotationDocument, encodeEditableAnnotationDocument, parseEditableAnnotationDocument } from '../src/renderer/src/components/image-annotation/document'
import { ANNOTATION_DOCUMENT_LIMITS } from '../src/renderer/src/components/browser-screenshot/document-files'
import type { ScreenshotOriginalApi, ScreenshotOriginalReadResult, ScreenshotOriginalSaveResult } from '../src/shared/screenshot-original'
import type { ImageAnnotationInput } from '../src/renderer/src/components/image-annotation/types'

const image = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
const file = { grantId: 'original-grant', path: 'chosen-original.json', revision: 'original-revision' }
function original(text = '  saved\r\n' + '注'.repeat(1001) + '\n  ') {
  return createEditableAnnotationDocument({ image, shapes: [{ id: 'text', kind: 'text', color: '#123456', fontSize: .1,
    at: { x: .1, y: .1 }, text }], crop: null, source: null }, ANNOTATION_DOCUMENT_LIMITS)
}
const encode = (document: ReturnType<typeof original>) => encodeEditableAnnotationDocument(document, ANNOTATION_DOCUMENT_LIMITS)
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let root: ReturnType<typeof createRoot>, node: HTMLDivElement, current: ReturnType<typeof useSystemScreenshotOriginal>
let held: Array<() => void>, holdDecode: boolean
class Decoder {
  naturalWidth = 1; naturalHeight = 1; onload: (() => void) | null = null; onerror: (() => void) | null = null
  set src(_value: string) { if (holdDecode) held.push(() => this.onload?.()); else queueMicrotask(() => this.onload?.()) }
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('Image', Decoder); held = []; holdDecode = false
  node = document.createElement('div'); document.body.append(node); root = createRoot(node) })
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals() })
async function mount() {
  const api = { open: vi.fn<ScreenshotOriginalApi['open']>(), save: vi.fn<ScreenshotOriginalApi['save']>(), inspect: vi.fn<ScreenshotOriginalApi['inspect']>(), reconcile: vi.fn<NonNullable<ScreenshotOriginalApi['reconcile']>>() }
  const onError = vi.fn(), onStatus = vi.fn(), onEdited = vi.fn()
  function Probe() { current = useSystemScreenshotOriginal({ image, api, onError, onStatus, onEdited }); return null }
  await act(async () => root.render(<Probe />))
  return { api, onError, onStatus, onEdited }
}
function snapshot(): ImageAnnotationInput { return { image: document.createElement('img'), displayWidth: 1, displayHeight: 1,
  shapes: original().shapes, crop: null } }

describe('system screenshot editable-original host', () => {
  it('fully decodes the original before replacing the editor and preserves exact multiline text through a real save snapshot', async () => {
    const { api, onStatus } = await mount(), document = original(), content = encode(document)
    api.open.mockResolvedValue({ status: 'read', file, content })
    await act(async () => current.openOriginal())
    expect(current.generation).toBe(1); expect(current.initialState).toEqual(document)
    api.save.mockResolvedValue({ status: 'saved', file: { ...file, revision: 'saved-revision' } })
    await act(async () => current.saveOriginal(snapshot()))
    const [input, operationId] = api.save.mock.lastCall!
    expect(operationId).toEqual(expect.any(String)); expect(input.file).toEqual({ grantId: file.grantId, expectedRevision: file.revision })
    expect(parseEditableAnnotationDocument(input.content, ANNOTATION_DOCUMENT_LIMITS), 'actual save snapshot must preserve the complete original').toEqual(document)
    expect(onStatus).toHaveBeenLastCalledWith('Original saved')
  })

  it('keeps newer edits when original image decode or an earlier save finishes later', async () => {
    const { api, onStatus } = await mount(), read = deferred<ScreenshotOriginalReadResult>()
    api.open.mockReturnValue(read.promise); holdDecode = true
    let opening!: Promise<void>
    await act(async () => { opening = current.openOriginal(); read.resolve({ status: 'read', file, content: encode(original()) }); await Promise.resolve() })
    expect(held).toHaveLength(1)
    await act(async () => current.edited())
    await act(async () => { held.shift()!(); await opening })
    expect(current.initialState, 'late decode must not replace newer editor state').toBeNull()
    expect(current.generation).toBe(0)
    expect(onStatus).toHaveBeenLastCalledWith('Newer edits kept · Open the original again when ready')
    const save = deferred<ScreenshotOriginalSaveResult>(); api.save.mockReturnValue(save.promise)
    let saving!: Promise<void>
    await act(async () => { saving = current.saveOriginal(snapshot()) })
    await act(async () => current.edited())
    await act(async () => { save.resolve({ status: 'saved', file: { ...file, revision: 'saved' } }); await saving })
    expect(onStatus).toHaveBeenLastCalledWith('Earlier edits saved · Newer edits unsaved')
    expect(current.initialState).toBeNull()
  })

  it('checks a grant-bearing unknown save without retrying or replacing current edits', async () => {
    const { api, onError, onStatus } = await mount()
    api.save.mockResolvedValue({ status: 'unknown', file: { ...file, revision: null }, message: 'Original receipt lost' })
    await act(async () => current.saveOriginal(snapshot()))
    expect(current.uncertain).toBe(true)
    await act(async () => { current.edited(); await current.saveOriginal(snapshot()) })
    expect(api.save, 'an unknown original save must not be replayed').toHaveBeenCalledOnce()
    const content = api.save.mock.lastCall![0].content
    api.inspect.mockResolvedValue({ status: 'read', file: { ...file, revision: 'verified' }, content, verification: 'saved' })
    await act(async () => current.checkOriginal())
    expect(api.inspect).toHaveBeenCalledExactlyOnceWith(file.grantId)
    expect(current.uncertain).toBe(false); expect(current.initialState).toBeNull()
    expect(onStatus).toHaveBeenLastCalledWith('Earlier original verified · Newer edits unsaved')
    expect(onError).toHaveBeenCalledWith('Check the earlier save before saving this original again. Current edits are kept.')
  })

  it('retains the first save operation after a lost IPC response and reconciles only that receipt', async () => {
    const { api, onStatus } = await mount()
    api.save.mockRejectedValue(new Error('IPC disconnected'))
    await act(async () => current.saveOriginal(snapshot()))
    const operationId = api.save.mock.lastCall![1]!
    expect(current.uncertain, 'a lost first save must retain an inspectable original operation').toBe(true)
    await act(async () => current.saveOriginal(snapshot()))
    expect(api.save).toHaveBeenCalledOnce()
    api.reconcile.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'saved', file: { ...file, revision: 'confirmed' } })
    await act(async () => current.checkOriginal()); expect(current.uncertain).toBe(true)
    await act(async () => current.checkOriginal()); expect(current.uncertain).toBe(true)
    await act(async () => { current.edited(); await current.checkOriginal() })
    expect(api.reconcile.mock.calls).toEqual([[operationId], [operationId], [operationId]])
    expect(api.save).toHaveBeenCalledOnce(); expect(current.uncertain).toBe(false)
    expect(onStatus).toHaveBeenLastCalledWith('Earlier save confirmed · Newer edits unsaved')
  })

  it('does not bind an earlier lost save receipt to a different original opened later', async () => {
    const { api } = await mount()
    api.save.mockRejectedValueOnce(new Error('First save response lost'))
    await act(async () => current.saveOriginal(snapshot()))
    const laterFile = { grantId: 'later-grant', path: 'later-original.json', revision: 'later-revision' }, laterDocument = original('Later opened text stays')
    api.open.mockResolvedValue({ status: 'read', file: laterFile, content: encode(laterDocument) })
    await act(async () => current.openOriginal())
    expect(current.file).toEqual(laterFile); expect(current.initialState).toEqual(laterDocument)
    api.reconcile.mockResolvedValue({ status: 'saved', file: { ...file, revision: 'earlier-save-confirmed' } })
    await act(async () => current.checkOriginal())
    expect(current.file, 'an earlier operation must not retarget the newly opened original').toEqual(laterFile)
    expect(current.initialState).toEqual(laterDocument); expect(current.uncertain).toBe(false)
  })
})
