import { basename, dirname, isAbsolute } from 'node:path'
import { realpath } from 'node:fs/promises'
import { mintObjectId } from '@agentmux/core/object-id'
import { runWorkspaceFileWorker } from '@agentmux/host/ordinary-files'
import { parseEditableAnnotationDocument } from '../renderer/src/components/image-annotation/document'
import { ANNOTATION_DOCUMENT_LIMITS } from '../renderer/src/components/browser-screenshot/document-files'
import type { ScreenshotOriginalApi, ScreenshotOriginalGrant, ScreenshotOriginalReadResult, ScreenshotOriginalSaveInput,
  ScreenshotOriginalInspectResult, ScreenshotOriginalSaveResult } from '../shared/screenshot-original'

type Grant = { file: ScreenshotOriginalGrant; pending: boolean; uncertain?: { content: string; expectedRevision: string | null } }
export type ScreenshotOriginalFilesPorts = {
  chooseOpen(): Promise<string | null>
  chooseSave(defaultName: string): Promise<string | null>
  worker: { helperPath: string; workerSource?: string }
}

/** Dialog grants are private to this editor. File IO uses the existing pinned-cwd CAS owner. */
export class ScreenshotOriginalFiles implements ScreenshotOriginalApi {
  private readonly grants = new Map<string, Grant>()
  private disposed = false
  constructor(private readonly ports: ScreenshotOriginalFilesPorts) {}

  private async run(path: string, request: Parameters<typeof runWorkspaceFileWorker>[2], content?: string) {
    const root = await realpath(dirname(path))
    return runWorkspaceFileWorker(root, root, request,
      { helperPath: this.ports.worker.helperPath, workerSource: this.ports.worker.workerSource ?? '' }, content)
  }

  private grant(path: string): Grant {
    if (!isAbsolute(path)) throw new Error('The native file dialog did not provide an absolute file choice. Current edits are kept.')
    const grant: Grant = { file: { grantId: mintObjectId(), path, revision: null }, pending: false }
    this.grants.set(grant.file.grantId, grant)
    return grant
  }

  private async read(grant: Grant, validate = true): Promise<Extract<ScreenshotOriginalReadResult, { status: 'read' }>> {
    const raw = JSON.parse((await this.run(grant.file.path, { action: 'read-bytes', name: basename(grant.file.path), offset: 0,
      maxBytes: ANNOTATION_DOCUMENT_LIMITS.maxDocumentBytes, maxFileBytes: ANNOTATION_DOCUMENT_LIMITS.maxDocumentBytes })).toString('utf8')) as {
      data: string; revision: string; offset: number; totalBytes: number; returnedBytes: number; nextOffset: number | null
    }
    const bytes = Buffer.from(raw.data, 'base64')
    if (raw.offset !== 0 || raw.nextOffset !== null || bytes.length !== raw.totalBytes || bytes.length !== raw.returnedBytes ||
      bytes.length > ANNOTATION_DOCUMENT_LIMITS.maxDocumentBytes)
      throw new Error('The original editable file could not be read completely within its file budget. Current edits are kept.')
    const content = new TextDecoder('utf-8', { fatal: validate }).decode(bytes)
    if (validate) parseEditableAnnotationDocument(content, ANNOTATION_DOCUMENT_LIMITS)
    return { status: 'read', file: { ...grant.file, revision: raw.revision }, content }
  }

  async open(): Promise<ScreenshotOriginalReadResult> {
    try {
      if (this.disposed) return { status: 'error', message: 'The original screenshot editor is closed.' }
      const path = await this.ports.chooseOpen()
      if (path === null || this.disposed) return { status: 'cancelled' }
      const grant = this.grant(path), result = await this.read(grant)
      grant.file = result.file
      return result
    } catch (error) { return { status: 'error', message: message(error) } }
  }

  async save(input: ScreenshotOriginalSaveInput): Promise<ScreenshotOriginalSaveResult> {
    let grant: Grant | undefined
    let ownsPending = false
    try {
      if (this.disposed) return { status: 'error', message: 'The original screenshot editor is closed.' }
      parseEditableAnnotationDocument(input.content, ANNOTATION_DOCUMENT_LIMITS)
      if (input.file) {
        grant = this.grants.get(input.file.grantId)
        if (!grant || input.file.expectedRevision !== grant.file.revision)
          return { status: 'error', message: 'This save does not refer to the original opened file revision. Current edits are kept.' }
      } else {
        const path = await this.ports.chooseSave('Screenshot.agentmux-annotation.json')
        if (path === null || this.disposed) return { status: 'cancelled' }
        grant = this.grant(path)
        try { grant.file = (await this.read(grant, false)).file }
        catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
      }
      if (grant.pending) return { status: 'error', file: grant.file, message: 'The original file save is still in progress. Current edits are kept.' }
      if (grant.uncertain) return { status: 'unknown', file: grant.file, message: 'Check the earlier save before writing this original again. Current edits are kept.' }
      const expectedRevision = grant.file.revision
      grant.pending = true; ownsPending = true
      const result = JSON.parse((await this.run(grant.file.path, { action: 'write', name: basename(grant.file.path),
        expectedRevision, ...(expectedRevision === null ? { exclusive: true } : {}) }, input.content)).toString('utf8')) as {
        status: 'written' | 'conflict' | 'unknown' | 'error'; revision?: string; message?: string
      }
      if (result.status === 'written' && result.revision) {
        grant.file = { ...grant.file, revision: result.revision }
        return { status: 'saved', file: { ...grant.file, revision: result.revision } }
      }
      if (result.status === 'unknown') grant.uncertain = { content: input.content, expectedRevision }
      return { status: result.status === 'conflict' ? 'conflict' : result.status === 'unknown' ? 'unknown' : 'error', file: grant.file,
        message: result.message ?? (result.status === 'conflict' ? 'The original file changed. Open its current version or choose another file. Current edits are kept.' : 'The original save was not confirmed. Current edits are kept.') }
    } catch (error) {
      const unknown = !!grant && (error as { writeOutcomeUnknown?: boolean }).writeOutcomeUnknown === true
      if (unknown) grant!.uncertain = { content: input.content, expectedRevision: grant!.file.revision }
      return { status: unknown ? 'unknown' : 'error', ...(grant ? { file: grant.file } : {}), message: message(error) }
    } finally { if (grant && ownsPending) grant.pending = false }
  }

  async inspect(grantId: string): Promise<ScreenshotOriginalInspectResult> {
    const grant = this.grants.get(grantId)
    if (this.disposed || !grant) return { status: 'error', message: 'The original screenshot file grant is unavailable. Current edits are kept.' }
    try {
      const result = await this.read(grant), uncertain = grant.uncertain
      if (!uncertain) return result
      if (result.content === uncertain.content) {
        grant.file = result.file; delete grant.uncertain
        return { ...result, verification: 'saved' }
      }
      if (result.file.revision === uncertain.expectedRevision) {
        delete grant.uncertain
        return { ...result, verification: 'unchanged' }
      }
      return { ...result, verification: 'changed' }
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT' && grant.uncertain?.expectedRevision === null) {
        delete grant.uncertain
        return { status: 'absent', file: { ...grant.file, revision: null }, verification: 'unchanged' }
      }
      return { status: 'error', file: grant.file, message: message(error) }
    }
  }

  dispose(): void { this.disposed = true; this.grants.clear() }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
