import { forwardRef, useImperativeHandle, useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { BrowserScreenshotCapture } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { ImageAnnotationEditor } from '../image-annotation/ImageAnnotationEditor'
import type { ImageAnnotationInput } from '../image-annotation/types'
import { createEditableAnnotationDocument, encodeEditableAnnotationDocument, type EditableAnnotationDocument, type AnnotationHistoricalSource } from '../image-annotation/document'
import { ANNOTATION_DOCUMENT_LIMITS, readEditableAnnotationFile, saveEditableAnnotationFile } from './document-files'
import { AnnotationFileDialog, type AnnotationFileActionResult } from './AnnotationFileDialog'

export type ScreenshotCompleteInput = ImageAnnotationInput & {
  capture: BrowserScreenshotCapture | null
  source: AnnotationHistoricalSource
}
type SaveAttempt = { path: string; document: EditableAnnotationDocument; expectedRevision: string | null; edit: number }

export type ScreenshotEditorHandle = { openOriginal(): void }

/** Browser capture, provenance, focus and user-file IO stay outside the image editor. */
export const ScreenshotEditor = forwardRef<ScreenshotEditorHandle, {
  capture?: BrowserScreenshotCapture
  workspaceId: string
  busy: boolean
  copied?: string | null
  active?: boolean
  onCancel(): void
  onComplete(input: ScreenshotCompleteInput): void
  onCopyContext?(input: ScreenshotCompleteInput): void
  onEdited?(): void
  onOriginalOpened?(): void
  onError?(error: unknown): void
}>(function ScreenshotEditor(props, handle) {
  const host = useRef<HTMLDivElement>(null), operation = useRef(0), edits = useRef(0), hasImage = useRef(!!props.capture)
  const [opened, setOpened] = useState<EditableAnnotationDocument | null>(null), [generation, setGeneration] = useState(0)
  const [file, setFile] = useState<{ path: string; revision: string } | null>(null)
  const [dialog, setDialog] = useState<'open' | 'save' | null>(props.capture ? null : 'open')
  const [status, setStatus] = useState<string | null>(null)
  const saveDraft = useRef<SaveAttempt | null>(null), uncertain = useRef(new Map<string, SaveAttempt>())
  useImperativeHandle(handle, () => ({ openOriginal() { operation.current += 1; setDialog('open') } }), [])
  const image = opened ? opened.image : props.capture?.image
  const source = opened ? opened.source : props.capture?.source ?? null
  useEffect(() => () => { operation.current += 1 }, [])
  useEffect(() => { if (props.active === false) operation.current += 1 }, [props.active])
  useEffect(() => {
    if (props.active === false) return
    const transferFocus = () => {
      const pane = host.current?.closest('.browser-surface'), focused = document.activeElement
      if (focused === document.body || (pane && focused instanceof HTMLButtonElement && focused.closest('.browser-surface') === pane && !host.current?.contains(focused)))
        host.current?.querySelector<HTMLCanvasElement>('canvas')?.focus({ preventScroll: true })
    }
    transferFocus(); const frame = requestAnimationFrame(transferFocus)
    return () => cancelAnimationFrame(frame)
  }, [props.active, generation, dialog])
  function edited() { edits.current += 1; setStatus('Unsaved changes'); props.onEdited?.() }
  function cancel() { operation.current += 1; props.onCancel() }
  function closeDialog() { operation.current += 1; setDialog(null); if (!hasImage.current) props.onCancel() }
  function output(input: ImageAnnotationInput): ScreenshotCompleteInput {
    return { ...input, capture: opened ? null : props.capture ?? null, source }
  }
  function saveOriginal(input: ImageAnnotationInput) {
    if (!image) return
    // Clear previous copy feedback without creating an edit or changing its revision.
    props.onEdited?.()
    try {
      const document = createEditableAnnotationDocument({ image: { dataUrl: image.dataUrl, width: image.width, height: image.height },
        shapes: input.shapes, crop: input.crop, source }, ANNOTATION_DOCUMENT_LIMITS)
      saveDraft.current = { path: file?.path ?? 'screenshot.agentmux-annotation.json', expectedRevision: file?.revision ?? null, document, edit: edits.current }
      operation.current += 1; setDialog('save')
    } catch (error) { setStatus(presentError(error)); props.onError?.(error) }
  }
  async function openOriginal(path: string): Promise<AnnotationFileActionResult> {
    const token = ++operation.current, startEdit = edits.current
    const result = await readEditableAnnotationFile(api.files, { workspaceId: props.workspaceId, path })
    if (operation.current !== token) return { status: 'error', message: 'Opening was cancelled. Your current image is kept.' }
    if (result.status !== 'read') return { status: 'error', message: result.message }
    try {
      const decoded = new Image()
      await new Promise<void>((resolve, reject) => {
        decoded.onload = () => resolve(); decoded.onerror = () => reject(new Error('The original image could not be decoded. Your current edits are kept.'))
        decoded.src = result.document.image.dataUrl
      })
      if (operation.current !== token || edits.current !== startEdit) return { status: 'error', message: 'Newer edits are kept. Open the original again when ready.' }
      if (decoded.naturalWidth !== result.document.image.width || decoded.naturalHeight !== result.document.image.height)
        return { status: 'error', message: 'The saved image dimensions do not match its pixels. Your current edits are kept.' }
      edits.current += 1; hasImage.current = true
      setOpened(result.document); setFile({ path, revision: result.revision }); setGeneration(value => value + 1)
      setStatus('Opened original'); props.onOriginalOpened?.(); props.onEdited?.()
      return { status: 'done' }
    } catch (error) { return { status: 'error', message: presentError(error) } }
  }
  async function saveToFile(path: string): Promise<AnnotationFileActionResult> {
    const prepared = saveDraft.current
    if (!prepared) return { status: 'error', message: 'Choose Save original again to capture your current edits.' }
    if (uncertain.current.has(path)) return { status: 'unknown', message: 'The earlier save is unconfirmed. Check this file before writing again, or choose a new file.' }
    const attempt = { ...prepared, path, expectedRevision: file?.path === path ? file.revision : null }
    const token = ++operation.current
    setStatus('Saving original…')
    const result = await saveEditableAnnotationFile(api.files, { workspaceId: props.workspaceId, ...attempt })
    // A submitted write may finish after Cancel; it is never retried or claimed rolled back.
    if (result.status === 'unknown' || (result.status === 'written' && operation.current !== token)) uncertain.current.set(path, attempt)
    if (operation.current !== token) {
      if (host.current?.isConnected && edits.current === attempt.edit)
        setStatus(result.status === 'written' ? 'Earlier save confirmed · Check file before saving again' :
          result.status === 'unknown' ? 'Earlier save unconfirmed · Check file before saving again' : 'Earlier save did not complete · Edits kept')
      return { status: 'error', message: 'The save reply arrived after closing. Read the original file to check its result.' }
    }
    if (result.status === 'written') {
      setFile({ path, revision: result.revision })
      setStatus(edits.current === attempt.edit ? 'Original saved' : 'Earlier edits saved · Newer edits unsaved')
      return { status: 'done' }
    }
    if (result.status === 'conflict') {
      setStatus('File changed · Edits kept')
      return { status: 'conflict', message: 'This file already exists or changed. Your edits are kept. Open that version before replacing it, or choose a new filename.' }
    }
    setStatus(result.status === 'unknown' ? 'Save unconfirmed · Edits kept' : 'Save failed · Edits kept')
    return { status: result.status, message: result.message }
  }
  async function checkFile(path: string): Promise<AnnotationFileActionResult> {
    const token = ++operation.current, attempt = uncertain.current.get(path)
    let result: Awaited<ReturnType<typeof api.files.read>>
    try { result = await api.files.read(props.workspaceId, path) }
    catch (error) { return { status: 'unknown', message: presentError(error) } }
    if (operation.current !== token) return { status: 'error', message: 'Checking was cancelled.' }
    if (!attempt) return { status: 'conflict', message: 'Open the existing version before replacing it, or choose a new filename.' }
    if (result.status === 'read' && result.document.content === encodeEditableAnnotationDocument(attempt.document, ANNOTATION_DOCUMENT_LIMITS)) {
      uncertain.current.delete(path); setFile({ path, revision: result.document.revision })
      setStatus(edits.current === attempt.edit ? 'Original verified on disk' : 'Earlier original verified · Newer edits unsaved')
      return { status: 'done' }
    }
    if ((result.status === 'deleted' && attempt.expectedRevision === null) ||
      (result.status === 'read' && result.document.revision === attempt.expectedRevision)) {
      uncertain.current.delete(path)
      setStatus((result.status === 'deleted' ? 'File absent' : 'Opened version still on disk') + ' · Edits kept · Save again when ready')
      return { status: 'done' }
    }
    if (result.status !== 'read') return { status: 'unknown', message: result.status === 'error' ? result.message : 'The file could not confirm the earlier save. Your edits are kept.' }
    return { status: 'conflict', message: 'The file differs from this save. Open that version before replacing it, or save your edits under a new filename.' }
  }
  return <div ref={host} style={{ display: 'contents' }}>
    {image ? <ImageAnnotationEditor key={generation} image={image} {...(opened ? { initialState: opened } : {})}
      busy={props.busy} copied={props.copied ?? null} active={props.active ?? true} documentStatus={status}
      onCancel={cancel} onComplete={input => props.onComplete(output(input))}
      {...(props.onCopyContext ? { onCopyContext: (input: ImageAnnotationInput) => props.onCopyContext!(output(input)) } : {})}
      onSaveOriginal={saveOriginal} onOpenOriginal={() => { operation.current += 1; setDialog('open') }} onEdited={edited}
      {...(props.onError ? { onError: props.onError } : {})} /> : null}
    {dialog && props.active !== false ? <AnnotationFileDialog key={dialog + ':' + generation} mode={dialog}
      initialPath={dialog === 'save' ? saveDraft.current?.path ?? '' : file?.path ?? ''}
      onSubmit={dialog === 'open' ? openOriginal : saveToFile} {...(dialog === 'save' ? { onCheck: checkFile } : {})} onClose={closeDialog} /> : null}
  </div>
})
