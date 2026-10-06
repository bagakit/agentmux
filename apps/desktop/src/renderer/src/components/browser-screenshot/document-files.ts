import { BROWSER_PNG_MAX_BYTES, BROWSER_PNG_MAX_DIMENSION, BROWSER_PNG_MAX_PIXELS,
  type AgentMuxDesktopApi, type WorkspaceFileWriteResult } from '../../../../shared/contracts'
import { WORKSPACE_FILE_MAX_BYTES } from '../../../../shared/workspace-file-bytes'
import { AnnotationDocumentError, encodeEditableAnnotationDocument, parseEditableAnnotationDocument,
  type AnnotationDocumentLimits, type EditableAnnotationDocument } from '../image-annotation/document'

export const ANNOTATION_DOCUMENT_LIMITS: Readonly<AnnotationDocumentLimits> = {
  maxDocumentBytes: WORKSPACE_FILE_MAX_BYTES,
  maxImageBytes: BROWSER_PNG_MAX_BYTES,
  maxImageDimension: BROWSER_PNG_MAX_DIMENSION,
  maxImagePixels: BROWSER_PNG_MAX_PIXELS
}

type AnnotationFiles = Pick<AgentMuxDesktopApi['files'], 'read' | 'write'>
export type EditableAnnotationFileReadResult =
  | { status: 'read'; document: EditableAnnotationDocument; revision: string; content: string }
  | { status: 'error'; code: string; message: string }

/** Reads only the explicit original Workspace path. The caller owns decode and editor replacement. */
export async function readEditableAnnotationFile(files: AnnotationFiles,
  input: { workspaceId: string; path: string }): Promise<EditableAnnotationFileReadResult> {
  try {
    const result = await files.read(input.workspaceId, input.path)
    if (result.status === 'error') return result
    if (result.status !== 'read') return { status: 'error', code: 'ANNOTATION_FILE_' + result.status.toUpperCase(),
      message: result.status === 'deleted' ? 'The editable annotation file no longer exists.' :
        result.status === 'directory' ? 'Choose an editable annotation file, not a directory.' : 'The editable annotation file must contain its JSON document.' }
    return { status: 'read', document: parseEditableAnnotationDocument(result.document.content, ANNOTATION_DOCUMENT_LIMITS),
      revision: result.document.revision, content: result.document.content }
  } catch (error) {
    return { status: 'error', code: error instanceof AnnotationDocumentError ? error.code : 'ANNOTATION_FILE_READ_FAILED',
      message: error instanceof Error ? error.message : String(error) }
  }
}

/** A null revision exclusively creates; an existing file requires the revision explicitly opened. */
export async function saveEditableAnnotationFile(files: AnnotationFiles,
  input: { workspaceId: string; path: string; document: EditableAnnotationDocument; expectedRevision: string | null }): Promise<WorkspaceFileWriteResult> {
  let content: string
  try { content = encodeEditableAnnotationDocument(input.document, ANNOTATION_DOCUMENT_LIMITS) }
  catch (error) {
    return { status: 'error', code: error instanceof AnnotationDocumentError ? error.code : 'ANNOTATION_DOCUMENT_INVALID',
      message: error instanceof Error ? error.message : String(error) }
  }
  try {
    return await files.write(input.workspaceId, { path: input.path, content, expectedRevision: input.expectedRevision })
  } catch (error) {
    // The owner may have applied the write before its reply failed. Never retry here.
    return { status: 'unknown', code: 'ANNOTATION_FILE_WRITE_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) }
  }
}
