import { NOTE_FILE_EXTENSION } from './note-format'
import { workspaceFileExtension, workspaceFilePreviewFormat } from './workspace-file-preview'

export type WorkspaceSourcePreview = 'markdown' | 'html' | 'svg' | 'note' | 'json' | 'csv' | 'tsv'
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
    language: source?.language ?? null,
    formatter: formatterFormats.get(extension) ?? null,
    mime: media?.mimeType ?? source?.mime ?? 'text/plain',
    previewConfirmation: source?.confirmation ?? null,
    sourceEditable: media?.sourceEditable ?? true,
    defaultMode: media && !media.sourceEditable || sourcePreview === 'svg' || sourcePreview === 'note'
      ? 'preview' as const : 'edit' as const,
    browserPreview: extension === 'html' || extension === 'htm'
  }
}
