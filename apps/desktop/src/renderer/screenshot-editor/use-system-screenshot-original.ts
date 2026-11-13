import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import type { ScreenshotOriginalApi, ScreenshotOriginalGrant } from '../../shared/screenshot-original'
import { createEditableAnnotationDocument, encodeEditableAnnotationDocument, parseEditableAnnotationDocument,
  type EditableAnnotationDocument } from '../src/components/image-annotation/document'
import { ANNOTATION_DOCUMENT_LIMITS } from '../src/components/browser-screenshot/document-files'
import type { AnnotationImage, ImageAnnotationInput } from '../src/components/image-annotation/types'

type Attempt = { file?: ScreenshotOriginalGrant; operationId: string; content: string; edit: number; generation: number }
type Options = { image: AnnotationImage; api: ScreenshotOriginalApi; onError(message: string): void;
  onStatus(message: string): void; onEdited?(): void }

/** Original-file IO stays with this host. The shared image editor only emits a snapshot. */
export function useSystemScreenshotOriginal(options: Options) {
  const [opened, setOpened] = useState<EditableAnnotationDocument | null>(null), [generation, setGeneration] = useState(0)
  const [file, setFile] = useState<ScreenshotOriginalGrant | null>(null), [busy, setBusy] = useState(false)
  const [, setUncertainVersion] = useState(0)
  const lifetime = useRef(0), edits = useRef(0), pending = useRef(false), alive = useRef(true)
  const documentGeneration = useRef(0)
  const originalFile = useRef(file), uncertain = useRef(new Map<string, Attempt>())
  useEffect(() => { alive.current = true; return () => { alive.current = false; lifetime.current += 1 } }, [])
  const image = opened?.image ?? options.image, source = opened?.source ?? null
  function keepFile(value: ScreenshotOriginalGrant) { originalFile.current = value; setFile(value) }
  function edited() { edits.current += 1; options.onEdited?.(); options.onStatus('Unsaved changes') }

  async function openOriginal() {
    if (pending.current) return
    const token = ++lifetime.current, startEdit = edits.current
    pending.current = true; setBusy(true)
    try {
      const result = await options.api.open()
      if (!alive.current || lifetime.current !== token || result.status === 'cancelled') return
      if (result.status !== 'read') { options.onError(result.message); return }
      const document = parseEditableAnnotationDocument(result.content, ANNOTATION_DOCUMENT_LIMITS)
      const decoded = new Image()
      await new Promise<void>((resolve, reject) => {
        decoded.onload = () => resolve(); decoded.onerror = () => reject(new Error('The original PNG could not be decoded. Current edits are kept.'))
        decoded.src = document.image.dataUrl
      })
      if (!alive.current || lifetime.current !== token) return
      if (decoded.naturalWidth !== document.image.width || decoded.naturalHeight !== document.image.height)
        throw new Error('The original image dimensions do not match its PNG. Current edits are kept.')
      if (edits.current !== startEdit) { options.onStatus('Newer edits kept · Open the original again when ready'); return }
      edits.current += 1; documentGeneration.current += 1; keepFile(result.file); setOpened(document); setGeneration(documentGeneration.current)
      options.onEdited?.(); options.onStatus('Opened original · ' + result.file.path)
    } catch (error) { if (alive.current && lifetime.current === token) options.onError(message(error)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }

  async function saveOriginal(input: ImageAnnotationInput) {
    if (pending.current) return
    const selectedFile = originalFile.current
    if ([...uncertain.current.values()].some(attempt => !attempt.file || attempt.file.grantId === selectedFile?.grantId)) {
      options.onError('Check the earlier save before saving this original again. Current edits are kept.'); return
    }
    let content: string
    try {
      content = encodeEditableAnnotationDocument(createEditableAnnotationDocument({ image: { dataUrl: image.dataUrl, width: input.displayWidth,
        height: input.displayHeight }, shapes: input.shapes, crop: input.crop, source }, ANNOTATION_DOCUMENT_LIMITS), ANNOTATION_DOCUMENT_LIMITS)
    } catch (error) { options.onError(message(error)); return }
    const token = ++lifetime.current, edit = edits.current, operationId = mintObjectId()
    const attempt: Attempt = { ...(selectedFile ? { file: selectedFile } : {}), operationId, content, edit, generation: documentGeneration.current }
    pending.current = true; setBusy(true)
    options.onEdited?.(); options.onStatus('Saving original…')
    try {
      const result = await options.api.save({ content, ...(selectedFile ? { file: { grantId: selectedFile.grantId, expectedRevision: selectedFile.revision } } : {}) }, operationId)
      if (result.status === 'unknown') {
        uncertain.current.set(operationId, { ...attempt, ...(result.file ? { file: result.file } : {}) })
        if (alive.current) setUncertainVersion(value => value + 1)
      }
      if (!alive.current || lifetime.current !== token || result.status === 'cancelled') return
      if (result.status === 'saved') {
        keepFile(result.file)
        options.onStatus(edits.current === edit ? 'Original saved' : 'Earlier edits saved · Newer edits unsaved')
      } else {
        if (result.status === 'unknown' && result.file && !selectedFile) keepFile(result.file)
        options.onError(result.message)
      }
    } catch (error) {
      // A submitted write without a response remains unknown. Do not choose another path or retry.
      uncertain.current.set(operationId, attempt)
      if (alive.current) setUncertainVersion(value => value + 1)
      if (alive.current && lifetime.current === token) options.onError('Original save is unconfirmed. ' + message(error) + ' Current edits are kept.')
    } finally { pending.current = false; if (alive.current) setBusy(false) }
  }

  async function checkOriginal() {
    if (pending.current) return
    const attempt = [...uncertain.current.values()].find(attempt => attempt.file?.grantId === originalFile.current?.grantId) ?? uncertain.current.values().next().value
    if (!attempt) return
    const token = ++lifetime.current
    pending.current = true; setBusy(true)
    try {
      if (!attempt.file) {
        const receipt = await options.api.reconcile?.(attempt.operationId)
        if (!alive.current || lifetime.current !== token) return
        if (!receipt || receipt.status === 'pending') {
          options.onError('The original save operation is still unconfirmed. Keep its current image and check again before saving.'); return
        }
        if (receipt.status === 'unknown') {
          if (receipt.file) { attempt.file = receipt.file; if (documentGeneration.current === attempt.generation) keepFile(receipt.file) }
          options.onError(receipt.message); return
        }
        uncertain.current.delete(attempt.operationId); setUncertainVersion(value => value + 1)
        if (receipt.status === 'saved') {
          if (documentGeneration.current === attempt.generation) keepFile(receipt.file)
          options.onStatus(edits.current === attempt.edit ? 'Original save receipt confirmed' : 'Earlier save confirmed · Newer edits unsaved')
        } else if (receipt.status !== 'cancelled') options.onError(receipt.message)
        else options.onStatus('Earlier save was cancelled · Current edits kept')
        return
      }
      const result = await options.api.inspect(attempt.file.grantId)
      if (!alive.current || lifetime.current !== token) return
      if (result.status === 'read' && result.content === attempt.content || result.status === 'absent' || result.status === 'read' && result.verification === 'unchanged') {
        uncertain.current.delete(attempt.operationId); setUncertainVersion(value => value + 1)
        if (originalFile.current?.grantId === attempt.file.grantId) keepFile(result.file)
        options.onStatus(result.status === 'read' && result.content === attempt.content
          ? edits.current === attempt.edit ? 'Original verified on disk' : 'Earlier original verified · Newer edits unsaved'
          : 'Earlier file checked · Current edits kept · Save again when ready')
      } else if (result.status === 'read') options.onError('The file differs from the earlier save. Open its current version or choose another file. Current edits are kept.')
      else if (result.status !== 'cancelled') options.onError(result.message)
    } catch (error) { if (alive.current && lifetime.current === token) options.onError(message(error)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }

  return { image, initialState: opened, generation, source, file, busy, uncertain: uncertain.current.size > 0,
    edited, openOriginal, saveOriginal, checkOriginal }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
