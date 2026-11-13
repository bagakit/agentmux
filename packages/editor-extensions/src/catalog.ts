import { NOTE_FILE_EXTENSION } from '@agentmux/core/note-format-metadata'

/** File routing and declared MIME candidates. Read success does not prove codec support. */
export const WORKSPACE_FILE_PREVIEW_FORMATS = {
  png: { kind: 'image', mimeType: 'image/png', sourceEditable: false },
  jpg: { kind: 'image', mimeType: 'image/jpeg', sourceEditable: false },
  jpeg: { kind: 'image', mimeType: 'image/jpeg', sourceEditable: false },
  gif: { kind: 'image', mimeType: 'image/gif', sourceEditable: false },
  webp: { kind: 'image', mimeType: 'image/webp', sourceEditable: false },
  bmp: { kind: 'image', mimeType: 'image/bmp', sourceEditable: false },
  avif: { kind: 'image', mimeType: 'image/avif', sourceEditable: false },
  ico: { kind: 'image', mimeType: 'image/x-icon', sourceEditable: false },
  svg: { kind: 'image', mimeType: 'image/svg+xml', sourceEditable: true },
  mp3: { kind: 'audio', mimeType: 'audio/mpeg', sourceEditable: false },
  wav: { kind: 'audio', mimeType: 'audio/wav', sourceEditable: false },
  ogg: { kind: 'audio', mimeType: 'audio/ogg', sourceEditable: false },
  oga: { kind: 'audio', mimeType: 'audio/ogg', sourceEditable: false },
  opus: { kind: 'audio', mimeType: 'audio/ogg', sourceEditable: false },
  flac: { kind: 'audio', mimeType: 'audio/flac', sourceEditable: false },
  m4a: { kind: 'audio', mimeType: 'audio/mp4', sourceEditable: false },
  aac: { kind: 'audio', mimeType: 'audio/aac', sourceEditable: false },
  mp4: { kind: 'video', mimeType: 'video/mp4', sourceEditable: false },
  m4v: { kind: 'video', mimeType: 'video/mp4', sourceEditable: false },
  webm: { kind: 'video', mimeType: 'video/webm', sourceEditable: false },
  mov: { kind: 'video', mimeType: 'video/quicktime', sourceEditable: false },
  ogv: { kind: 'video', mimeType: 'video/ogg', sourceEditable: false },
  pdf: { kind: 'pdf', mimeType: 'application/pdf', sourceEditable: false },
  fb2: { kind: 'book', engine: 'fb2', mimeType: 'application/x-fictionbook+xml', sourceEditable: true, language: 'xml' },
} as const

export type WorkspaceFilePreviewFormat = (typeof WORKSPACE_FILE_PREVIEW_FORMATS)[keyof typeof WORKSPACE_FILE_PREVIEW_FORMATS]
export type WorkspaceFilePreviewKind = WorkspaceFilePreviewFormat['kind']
export function workspaceFileExtension(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function workspaceFilePreviewFormat(path: string): WorkspaceFilePreviewFormat | null {
  const extension = workspaceFileExtension(path)
  return Object.hasOwn(WORKSPACE_FILE_PREVIEW_FORMATS, extension)
    ? WORKSPACE_FILE_PREVIEW_FORMATS[extension as keyof typeof WORKSPACE_FILE_PREVIEW_FORMATS] : null
}



export type WorkspaceSourcePreview = 'markdown' | 'html' | 'svg' | 'note' | 'json' | 'csv' | 'tsv' | 'playlist'
  | 'jsonl' | 'yaml' | 'toml' | 'notebook' | 'mermaid' | 'dot' | 'drawio' | 'plantuml' | 'excalidraw' | 'vega' | 'vega-lite' | 'latex' | 'typst'

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
  // A playlist stays editable text; its preview plays the saved file through the playback lease.
  { extensions: ['m3u8'], preview: 'playlist', language: 'plaintext', mime: 'application/vnd.apple.mpegurl', confirmation: 'renderer' },
  { extensions: ['json', 'jsonc'], preview: 'json', language: 'json', mime: 'application/json', confirmation: 'renderer' },
  { extensions: ['csv'], preview: 'csv', language: 'csv', mime: 'text/csv', confirmation: 'renderer' },
  { extensions: ['tsv'], preview: 'tsv', language: 'tsv', mime: 'text/tab-separated-values', confirmation: 'renderer' },
  { extensions: ['jsonl', 'ndjson'], preview: 'jsonl', language: 'jsonl', mime: 'application/x-ndjson', confirmation: 'renderer' },
  { extensions: ['yaml', 'yml'], preview: 'yaml', language: 'yaml', mime: 'application/yaml', confirmation: 'renderer' },
  { extensions: ['toml'], preview: 'toml', language: 'toml', mime: 'application/toml', confirmation: 'renderer' },
  { extensions: ['ipynb'], preview: 'notebook', language: 'json', mime: 'application/x-ipynb+json', confirmation: 'renderer' },
  { extensions: ['mmd', 'mermaid'], preview: 'mermaid', language: 'mermaid', mime: 'text/plain', confirmation: 'renderer' },
  { extensions: ['dot', 'gv'], preview: 'dot', language: 'dot', mime: 'text/vnd.graphviz', confirmation: 'renderer' },
  { extensions: ['drawio'], preview: 'drawio', language: 'xml', mime: 'application/xml', confirmation: 'renderer' },
  { extensions: ['puml', 'plantuml', 'pu'], preview: 'plantuml', language: 'plantuml', mime: 'text/plain', confirmation: 'renderer' },
  { extensions: ['excalidraw'], preview: 'excalidraw', language: 'json', mime: 'application/json', confirmation: 'renderer' },
  { extensions: ['vega'], preview: 'vega', language: 'json', mime: 'application/json', confirmation: 'renderer' },
  { extensions: ['tex', 'latex'], preview: 'latex', language: 'latex', mime: 'text/x-tex', confirmation: 'renderer' },
  { extensions: ['typ'], preview: 'typst', language: 'typst', mime: 'text/plain', confirmation: 'renderer' },
  { extensions: ['vl'], preview: 'vega-lite', language: 'json', mime: 'application/json', confirmation: 'renderer' },
  { extensions: [NOTE_FILE_EXTENSION.slice(1)], preview: 'note', language: 'markdown', mime: 'text/markdown', confirmation: 'source' }
]
type WorkspaceFileFormatter = 'prettier' | 'jsonl' | 'delimited'
const formatterFormats = new Map<string, WorkspaceFileFormatter>([
  ...['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'html', 'htm', 'css', 'scss', 'less', 'md', 'markdown', 'mdown', 'yaml', 'yml'].map(extension => [extension, 'prettier'] as const),
  ...['jsonl', 'ndjson'].map(extension => [extension, 'jsonl'] as const),
  ...['csv', 'tsv'].map(extension => [extension, 'delimited'] as const)
])
const sourceFormats = new Map(SOURCE_FORMATS.flatMap(format => format.extensions.map(extension => [extension, format] as const)))
export const WORKSPACE_SOURCE_LANGUAGE_IDS = Object.freeze([...new Set(SOURCE_FORMATS.map(format => format.language))])

/** Presentation capability only. Bytes, revisions and codec verdicts remain with their owners. */
export function workspaceFileFormat(path: string) {
  const extension = workspaceFileExtension(path)
  const media = workspaceFilePreviewFormat(path)
  const lower = path.toLowerCase()
  const compound = lower.endsWith(NOTE_FILE_EXTENSION) ? 'note' : lower.endsWith('.vega.json') ? 'vega' : lower.endsWith('.vl.json') || lower.endsWith('.vega-lite.json') ? 'vega-lite' : undefined
  const source = compound ? SOURCE_FORMATS.find(format => format.preview === compound)! : sourceFormats.get(extension)
  const sourcePreview = source?.preview ?? null
  return {
    extension, media, sourcePreview,
    language: source?.language ?? (media && 'language' in media ? media.language : null),
    formatter: formatterFormats.get(extension) ?? null,
    mime: media?.mimeType ?? source?.mime ?? 'text/plain',
    previewConfirmation: source?.confirmation ?? null,
    sourceEditable: media?.sourceEditable ?? true,
    defaultMode: media && (!media.sourceEditable || media.kind === 'book') || sourcePreview === 'svg' || sourcePreview === 'note' || sourcePreview === 'playlist'
      ? 'preview' as const : 'edit' as const,
    browserPreview: extension === 'html' || extension === 'htm'
  }
}
