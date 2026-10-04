import { parseTree, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { dataPreviewBudget, DATA_PREVIEW_MAX_ROWS } from '../file-data-preview'
import { jsonDataNode, type DataDiagnostic, type DataRecord, type StructuredPreview } from './data-model'

/** Strict JSON per physical line; a bad record never removes a neighbouring good one. */
export function readJsonLines(content: string): StructuredPreview {
  const limit = dataPreviewBudget(content)
  if (limit) return limit
  const records: DataRecord[] = [], diagnostics: DataDiagnostic[] = []
  let offset = 0, line = 1
  while (offset < content.length && records.length < DATA_PREVIEW_MAX_ROWS) {
    const newline = content.indexOf('\n', offset)
    const end = newline === -1 ? content.length : newline
    const text = content.slice(offset, end).replace(/\r$/, '')
    const errors: ParseError[] = []
    let node: ReturnType<typeof parseTree>
    let diagnostic: DataDiagnostic | undefined
    try {
      node = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false })
      if (text.startsWith('\uFEFF')) diagnostic = { line, column: 1, message: 'A UTF-8 BOM is not allowed in JSON Lines.' }
      else if (errors.length || !node) diagnostic = { line, column: (errors[0]?.offset ?? 0) + 1,
        message: errors[0] ? `Invalid JSON record: ${printParseErrorCode(errors[0].error)}.` : 'Each line must contain a JSON value; blank records are invalid.' }
      const record: DataRecord = { line, diagnostics: diagnostic ? [diagnostic] : [], ...(!diagnostic && node ? { node: jsonDataNode(node, text) } : {}) }
      records.push(record)
    } catch {
      diagnostic = { line, column: 1, message: 'This JSON record is too deeply nested to preview. Use Source to read it.' }
      records.push({ line, diagnostics: [diagnostic] })
    }
    if (diagnostic) diagnostics.push(diagnostic)
    offset = newline === -1 ? content.length : end + 1
    line++
  }
  return { status: 'ready', records, diagnostics, truncated: offset < content.length }
}
