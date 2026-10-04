import { NOTE_FILE_EXTENSION } from './note-format'
import { workspaceFileExtension, workspaceFilePreviewFormat } from './workspace-file-preview'

export type WorkspaceSourcePreview = 'markdown' | 'html' | 'svg' | 'note' | 'json' | 'csv' | 'tsv'

type SourceFormat = {
  extensions: readonly string[]
  preview: WorkspaceSourcePreview
  language: string
  mime: string
  confirmation: 'source' | 'renderer'
}

// Metadata only: importing this module never loads a parser, renderer or editor.
const SOURCE_FORMATS: readonly SourceFormat[] = [
  { extensions: ['md', 'markdown', 'mdown'], preview: 'markdown', language: 'markdown', mime: 'text/markdown', confirmation: 'source' },
  { extensions: ['html', 'htm'], preview: 'html', language: 'html', mime: 'text/html', confirmation: 'renderer' },
  { extensions: ['svg'], preview: 'svg', language: 'xml', mime: 'image/svg+xml', confirmation: 'source' },
  { extensions: ['json', 'jsonc'], preview: 'json', language: 'json', mime: 'application/json', confirmation: 'renderer' },
  { extensions: ['csv'], preview: 'csv', language: 'plaintext', mime: 'text/csv', confirmation: 'renderer' },
  { extensions: ['tsv'], preview: 'tsv', language: 'plaintext', mime: 'text/tab-separated-values', confirmation: 'renderer' },
  { extensions: [NOTE_FILE_EXTENSION.slice(1)], preview: 'note', language: 'json', mime: 'application/json', confirmation: 'source' }
]
const sourceFormats = new Map(SOURCE_FORMATS.flatMap(format => format.extensions.map(extension => [extension, format] as const)))

/** Presentation capability only. Bytes, revisions and codec verdicts remain with their owners. */
export function workspaceFileFormat(path: string) {
  const extension = workspaceFileExtension(path)
  const media = workspaceFilePreviewFormat(path)
  const source = path.endsWith(NOTE_FILE_EXTENSION) ? SOURCE_FORMATS.find(format => format.preview === 'note')! : sourceFormats.get(extension)
  const sourcePreview = source?.preview ?? null
  return {
    extension, media, sourcePreview,
    language: source?.language ?? null,
    mime: media?.mimeType ?? source?.mime ?? 'text/plain',
    previewConfirmation: source?.confirmation ?? null,
    sourceEditable: media?.sourceEditable ?? true,
    defaultMode: media && !media.sourceEditable || sourcePreview === 'svg' || sourcePreview === 'note'
      ? 'preview' as const : 'edit' as const,
    browserPreview: extension === 'html' || extension === 'htm'
  }
}
