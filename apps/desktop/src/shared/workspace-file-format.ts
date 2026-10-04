import { NOTE_FILE_EXTENSION } from './note-format'
import { workspaceFileExtension, workspaceFilePreviewFormat } from './workspace-file-preview'

const SOURCE_PREVIEWS = {
  md: 'markdown', markdown: 'markdown', mdown: 'markdown',
  svg: 'svg', json: 'json', jsonc: 'json', csv: 'csv', tsv: 'tsv'
} as const

export type WorkspaceSourcePreview = 'markdown' | 'svg' | 'note' | 'json' | 'csv' | 'tsv'

/** Presentation capability only. Bytes, revisions and codec verdicts remain with their owners. */
export function workspaceFileFormat(path: string) {
  const extension = workspaceFileExtension(path)
  const media = workspaceFilePreviewFormat(path)
  const sourcePreview: WorkspaceSourcePreview | null = path.endsWith(NOTE_FILE_EXTENSION) ? 'note' : Object.hasOwn(SOURCE_PREVIEWS, extension)
    ? SOURCE_PREVIEWS[extension as keyof typeof SOURCE_PREVIEWS] : null
  return {
    extension, media, sourcePreview,
    sourceEditable: media?.sourceEditable ?? true,
    defaultMode: media && !media.sourceEditable || sourcePreview === 'svg' || sourcePreview === 'note'
      ? 'preview' as const : 'edit' as const,
    browserPreview: extension === 'html' || extension === 'htm'
  }
}
