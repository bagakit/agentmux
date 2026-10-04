import { WORKSPACE_FILE_MAX_BYTES } from '../../../../shared/workspace-file-bytes'
import type { DataPreviewFailure } from '../file-data-preview'
import type { DataNode } from './data-model'

export const NOTEBOOK_PAGE_SIZE = 20
const MAX_CELLS = 5000
const MAX_TEXT = 128 * 1024
const MAX_MIME = 2 * 1024 * 1024
const MAX_PAGE_BYTES = 8 * 1024 * 1024
export type NotebookMime = { mime: string; kind: 'text' | 'markdown' | 'html' | 'svg' | 'image' | 'json' | 'unsupported'; text?: string; node?: DataNode; notice?: string }
export type NotebookOutput = { type: 'text'; text: string; label: string } | { type: 'mime'; representations: NotebookMime[] }
export type NotebookCell = { index: number; type: string; source: string; executionCount: number | null; diagnostics: string[]; outputs: NotebookOutput[]; attachments: Record<string, NotebookMime[]> }
export type NotebookPreview = DataPreviewFailure | { status: 'ready'; cells: NotebookCell[]; cellCount: number; previewCellCount: number; page: number; pages: number; language: string; notice: string }
export type NotebookRequest = { type: 'open'; job: string; content: string } | { type: 'page'; job: string; page: number }
export type NotebookReply = { job: string; page: number; result: NotebookPreview }

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
/** nbformat multiline fields join without injecting any newline. */
export function notebookText(value: unknown): string | null {
  return typeof value === 'string' ? value : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join('') : null
}

function jsonValue(value: unknown, depth = 0, budget = { nodes: 2000, bytes: MAX_MIME }): DataNode {
  if (--budget.nodes < 0 || depth > 40) return { type: 'limit', text: 'Use Source to read deeper content.', omitted: true }
  if (Array.isArray(value) || object(value)) {
    const entries = Object.entries(value), children: DataNode[] = []
    for (const [key, item] of entries) {
      if (budget.nodes <= 0) break
      children.push({ ...jsonValue(item, depth + 1, budget), label: Array.isArray(value) ? `[${key}]` : key.length > 200 ? `${key.slice(0, 200)}…` : key })
    }
    return { type: Array.isArray(value) ? 'array' : 'object', children, omitted: children.length < entries.length }
  }
  const string = typeof value === 'string' ? value.slice(0, Math.max(0, Math.min(MAX_TEXT, Math.floor(budget.bytes / 6)))) : value
  const text = JSON.stringify(string), cost = (text?.length ?? 0) * 3
  budget.bytes -= cost
  if (budget.bytes < 0) return { type: 'limit', text: 'Output budget reached. Use Source for the complete value.', omitted: true }
  return { type: value === null ? 'null' : typeof value, text: `${text}${typeof value === 'string' && string !== value ? ' … (use Source for complete text)' : ''}` }
}

type PageBudget = { remaining: number }
function mimeBundle(value: unknown, budget: PageBudget): NotebookMime[] {
  if (!object(value)) return [{ mime: 'unknown', kind: 'unsupported', notice: 'The MIME bundle is invalid. Use Source to inspect the original output.' }]
  return Object.entries(value).slice(0, 32).map(([mime, data]) => {
    const json = mime === 'application/json' || mime.endsWith('+json')
    const node = json ? jsonValue(data, 0, { nodes: 2000, bytes: Math.min(MAX_MIME, budget.remaining) }) : undefined
    const text = json ? null : notebookText(data)
    const size = json ? JSON.stringify(node).length : (text?.length ?? 0) * 3
    if (size > MAX_MIME || size > budget.remaining) return { mime, kind: 'unsupported', notice: 'This output exceeds the preview budget. The original output remains in Source.' }
    budget.remaining -= size
    if (/jupyter\.widget|javascript/.test(mime)) return { mime, kind: 'unsupported', notice: 'Interactive scripts and widgets are not executed in this read-only preview.' }
    if (json && node) return { mime, kind: 'json', node }
    if (text === null) return { mime, kind: 'unsupported', notice: 'This output has an invalid text or image representation.' }
    if (mime === 'text/html') return { mime, kind: 'html', text }
    if (mime === 'image/svg+xml') return { mime, kind: 'svg', text }
    if (mime === 'image/png' || mime === 'image/jpeg') return { mime, kind: 'image', text: text.replace(/\s/g, '') }
    if (mime === 'text/markdown') return { mime, kind: 'markdown', text: text.slice(0, MAX_TEXT), ...(text.length > MAX_TEXT ? { notice: 'Long output is limited in preview. Use Source for the complete text.' } : {}) }
    if (mime === 'text/plain') return { mime, kind: 'text', text: text.slice(0, MAX_TEXT), ...(text.length > MAX_TEXT ? { notice: 'Long output is limited in preview. Use Source for the complete text.' } : {}) }
    return { mime, kind: 'unsupported', text: text.slice(0, MAX_TEXT), notice: 'This MIME type is not rendered. The original data remains in Source.' }
  })
}

function limitedText(text: string, budget: PageBudget): string {
  const shown = text.slice(0, Math.max(0, Math.min(MAX_TEXT, Math.floor(budget.remaining / 3))))
  budget.remaining -= shown.length * 3
  return shown.length < text.length ? `${shown}\n… Preview limit reached; use Source for the complete text.` : shown
}

function outputModel(output: unknown, budget: PageBudget): NotebookOutput {
  if (!object(output)) return { type: 'text', label: 'Invalid output', text: 'Use Source to inspect this output.' }
  if (output.output_type === 'stream') return { type: 'text', label: output.name === 'stderr' ? 'stderr' : 'stdout', text: limitedText(notebookText(output.text) ?? 'Invalid stream text.', budget) }
  if (output.output_type === 'error') return { type: 'text', label: 'Error', text: limitedText(`${String(output.ename ?? '')}: ${String(output.evalue ?? '')}\n${Array.isArray(output.traceback) ? output.traceback.filter(item => typeof item === 'string').join('\n') : ''}`, budget) }
  if (output.output_type === 'display_data' || output.output_type === 'execute_result') return { type: 'mime', representations: mimeBundle(output.data, budget) }
  return { type: 'text', label: `Unsupported output: ${String(output.output_type ?? 'unknown')}`, text: 'This output is retained in Source and is not executed.' }
}

/** Called by the dedicated worker. Its complete parsed object never crosses back to React. */
export function createNotebookReader(content: string): { page(index: number): NotebookPreview } {
  const failure = (message: string, status: 'invalid' | 'too-large' = 'invalid') => ({ page: (): NotebookPreview => ({ status, message }) })
  if (content.length > WORKSPACE_FILE_MAX_BYTES) return failure('Notebook preview is limited to 16 MiB. The complete source remains editable.', 'too-large')
  const bytes = new Uint8Array(Math.min(WORKSPACE_FILE_MAX_BYTES + 1, content.length * 3))
  const encoded = new TextEncoder().encodeInto(content, bytes)
  if (encoded.read < content.length || encoded.written > WORKSPACE_FILE_MAX_BYTES) return failure('Notebook preview is limited to 16 MiB of UTF-8. The complete source remains editable.', 'too-large')
  let notebook: unknown
  try { notebook = JSON.parse(content) }
  catch (error) { return failure(`Notebook JSON needs attention: ${error instanceof Error ? error.message : 'Invalid JSON'}. The source is unchanged.`) }
  if (!object(notebook) || notebook.nbformat !== 4 || !Array.isArray(notebook.cells) || !Number.isInteger(notebook.nbformat_minor) || Number(notebook.nbformat_minor) < 0) return failure('A version 4 notebook with a cells array and nonnegative integer nbformat_minor is required. The original source is unchanged.')
  const rawCells = notebook.cells, minor = Number(notebook.nbformat_minor)
  const metadata = object(notebook.metadata) ? notebook.metadata : {}
  const language = object(metadata.language_info) && typeof metadata.language_info.name === 'string' ? metadata.language_info.name : object(metadata.kernelspec) && typeof metadata.kernelspec.language === 'string' ? metadata.kernelspec.language : ''
  const previewCellCount = Math.min(MAX_CELLS, rawCells.length), pages = Math.max(1, Math.ceil(previewCellCount / NOTEBOOK_PAGE_SIZE))
  const ids = new Map<string, number>()
  for (const cell of rawCells.slice(0, MAX_CELLS)) if (object(cell) && typeof cell.id === 'string') ids.set(cell.id, (ids.get(cell.id) ?? 0) + 1)
  return { page(index) {
    const page = Math.max(0, Math.min(Math.floor(index) || 0, pages - 1)), budget = { remaining: MAX_PAGE_BYTES }
    const cells = rawCells.slice(page * NOTEBOOK_PAGE_SIZE, (page + 1) * NOTEBOOK_PAGE_SIZE).map((raw, localIndex): NotebookCell => {
      const index = page * NOTEBOOK_PAGE_SIZE + localIndex, cell = object(raw) ? raw : {}, diagnostics: string[] = []
      const source = notebookText(cell.source)
      if (source === null) diagnostics.push('Cell source must be a string or an array of strings.')
      if (source && source.length > MAX_TEXT) diagnostics.push('Long cell source is limited in preview. Use Source for the complete cell.')
      const type = typeof cell.cell_type === 'string' ? cell.cell_type : 'unknown'
      if (!['code', 'markdown', 'raw'].includes(type)) diagnostics.push('This cell type is not rendered; its source remains available below.')
      if (minor >= 5 && (typeof cell.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(cell.id) || (ids.get(cell.id) ?? 0) > 1)) diagnostics.push('This notebook cell needs a valid unique id. The source id is unchanged.')
      if (type === 'code' && cell.execution_count !== null && !Number.isInteger(cell.execution_count)) diagnostics.push('Invalid execution count; this cell is not executed by preview.')
      const outputs = type === 'code' && Array.isArray(cell.outputs) ? cell.outputs.slice(0, 50).map(output => outputModel(output, budget)) : []
      if (type === 'code' && !Array.isArray(cell.outputs)) diagnostics.push('Code cell outputs must be an array.')
      if (Array.isArray(cell.outputs) && cell.outputs.length > 50) diagnostics.push('Only the first 50 outputs are shown. The complete output remains in Source.')
      const attachments = Object.fromEntries(object(cell.attachments) ? Object.entries(cell.attachments).slice(0, 128).map(([name, bundle]) => [name, mimeBundle(bundle, budget)]) : [])
      return { index, type, source: limitedText(source ?? '', budget), executionCount: Number.isInteger(cell.execution_count) ? Number(cell.execution_count) : null, diagnostics, outputs, attachments }
    })
    return { status: 'ready', cells, cellCount: rawCells.length, previewCellCount, page, pages, language,
      notice: [minor > 5 ? 'Newer notebook version: unknown fields are preserved in Source.' : '', rawCells.length > MAX_CELLS ? 'Only the first 5,000 cells are previewed. Use Source for the complete notebook.' : ''].filter(Boolean).join(' ') }
  } }
}
