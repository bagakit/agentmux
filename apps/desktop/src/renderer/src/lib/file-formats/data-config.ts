import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, visit } from 'yaml'
import { parse as parseToml, TomlError } from 'smol-toml'
import { dataPreviewBudget, DATA_PREVIEW_MAX_ROWS } from '../file-data-preview'
import { DATA_TREE_DEPTH, DATA_TREE_NODES, type DataDiagnostic, type DataNode, type StructuredPreview } from './data-model'

function yamlNode(value: unknown, source: string, depth: number, budget: { remaining: number }): DataNode {
  if (--budget.remaining < 0 || depth > DATA_TREE_DEPTH) return { type: 'limit', text: 'Use Source to read deeper content.', omitted: true }
  if (isAlias(value)) return { type: 'alias', text: `*${value.source} (anchor reference)` }
  if (isScalar(value)) return { type: value.tag ?? (value.value === null ? 'null' : typeof value.value),
    text: value.range ? source.slice(value.range[0], value.range[1]) : String(value.value ?? 'null') }
  if (isMap(value) || isSeq(value)) {
    const children: DataNode[] = []
    for (const [index, item] of value.items.entries()) {
      if (budget.remaining <= 0) break
      if (isMap(value)) {
        const pair = item as { key: unknown; value: unknown }
        const key = isScalar(pair.key) ? String(pair.key.value) : isAlias(pair.key) ? `*${pair.key.source}`
          : (isMap(pair.key) || isSeq(pair.key)) && pair.key.range ? `[complex key: ${source.slice(pair.key.range[0], Math.min(pair.key.range[1], pair.key.range[0] + 200))}]` : '[complex key]'
        children.push({ ...yamlNode(pair.value, source, depth + 1, budget), label: key })
      } else children.push({ ...yamlNode(item, source, depth + 1, budget), label: `[${index}]` })
    }
    return { type: isMap(value) ? 'object' : 'array', children, omitted: children.length < value.items.length }
  }
  return { type: 'null', text: 'null' }
}

/** Read the source AST without expanding aliases, preserving independent document errors. */
export function readYamlPreview(content: string): StructuredPreview {
  const limit = dataPreviewBudget(content)
  if (limit) return limit
  const lineCounter = new LineCounter()
  try {
    const documents = parseAllDocuments(content, { lineCounter, keepSourceTokens: true, intAsBigInt: true, uniqueKeys: true })
    const budget = { remaining: DATA_TREE_NODES }
    const records = documents.slice(0, DATA_PREVIEW_MAX_ROWS).map(document => {
      const diagnostics: DataDiagnostic[] = [...document.errors, ...document.warnings].map(error => ({
        ...lineCounter.linePos(error.pos[0]), message: error.message.split('\n')[0] ?? 'Invalid YAML.'
      })).map(({ line, col, message }) => ({ line, column: col, message }))
      const position = lineCounter.linePos(document.range?.[0] ?? 0)
      const anchors = new Set<string>()
      visit(document, { Node(_key, node) {
        if (isAlias(node)) {
          if (!anchors.has(node.source)) {
            const location = lineCounter.linePos(node.range?.[0] ?? 0)
            diagnostics.push({ line: location.line, column: location.col, message: `Unresolved alias: *${node.source}.` })
          }
        } else if (node.anchor) anchors.add(node.anchor)
      } })
      return { line: position.line, diagnostics, ...(document.errors.length ? {} : { node: yamlNode(document.contents, content, 0, budget) }) }
    })
    return { status: 'ready', records, diagnostics: records.flatMap(record => record.diagnostics), truncated: documents.length > records.length }
  } catch {
    return { status: 'invalid', message: 'This YAML document is too deeply nested to preview. The complete source remains editable.' }
  }
}

function tomlNode(value: unknown, depth = 0, budget = { remaining: DATA_TREE_NODES }): DataNode {
  if (--budget.remaining < 0 || depth > DATA_TREE_DEPTH) return { type: 'limit', text: 'Use Source to read deeper content.', omitted: true }
  if (typeof value === 'bigint') return { type: 'integer', text: value.toString() }
  if (typeof value === 'number') return { type: 'float', text: Number.isNaN(value) ? 'nan' : value === Infinity ? 'inf' : value === -Infinity ? '-inf' : Object.is(value, -0) ? '-0.0' : Number.isInteger(value) ? `${value}.0` : String(value) }
  if (typeof value === 'string') return { type: 'string', text: JSON.stringify(value) }
  if (typeof value === 'boolean') return { type: 'boolean', text: String(value) }
  if (value && typeof value === 'object') {
    const tag = Object.prototype.toString.call(value)
    if (tag.startsWith('[object Temporal.')) return { type: tag.slice(8, -1), text: String(value) }
    const array = Array.isArray(value), entries = Object.entries(value), children: DataNode[] = []
    for (const [key, item] of entries) {
      if (budget.remaining <= 0) break
      children.push({ ...tomlNode(item, depth + 1, budget), label: array ? `[${key}]` : key })
    }
    return { type: array ? 'array' : 'object', children, omitted: children.length < entries.length }
  }
  return { type: 'unknown', text: String(value) }
}

export function readTomlPreview(content: string): StructuredPreview {
  const limit = dataPreviewBudget(content)
  if (limit) return limit
  try {
    const value = parseToml(content, { integersAsBigInt: true, useLegacyDate: false, unsafeKeyBehaviour: 'keep', maxDepth: 100 })
    return { status: 'ready', records: [{ line: 1, diagnostics: [], node: tomlNode(value) }], diagnostics: [], truncated: false }
  } catch (error) {
    const unavailable = !('Temporal' in globalThis) && error instanceof Error && /Temporal/.test(error.message)
    const diagnostic: DataDiagnostic = { line: error instanceof TomlError ? error.line : 1, column: error instanceof TomlError ? error.column : 1,
      message: unavailable ? 'This runtime cannot accurately preview TOML date/time values because Temporal is unavailable. The source is unchanged.'
        : error instanceof Error ? error.message.split('\n')[0]! : 'Invalid TOML document.' }
    return { status: 'ready', records: [{ line: 1, diagnostics: [diagnostic] }], diagnostics: [diagnostic], truncated: false }
  }
}
