import type { Node as JsonNode } from 'jsonc-parser'
import type { DataPreviewFailure } from '../file-data-preview'

/** A bounded reader model, never a replacement for the editable source. */
export type DataNode = {
  type: string
  label?: string
  text?: string
  children?: DataNode[]
  omitted?: boolean
}
export type DataDiagnostic = { message: string; line: number; column: number }
export type DataRecord = { line: number; node?: DataNode; diagnostics: DataDiagnostic[] }
export type StructuredPreview = DataPreviewFailure | {
  status: 'ready'
  records: DataRecord[]
  diagnostics: DataDiagnostic[]
  truncated: boolean
}
export const DATA_TREE_DEPTH = 40
export const DATA_TREE_NODES = 20_000

export function sourceLocation(content: string, offset: number): { line: number; column: number } {
  const before = content.slice(0, offset)
  return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') }
}

export function jsonDataNode(node: JsonNode, source: string, depth = 0, budget = { remaining: DATA_TREE_NODES }): DataNode {
  if (--budget.remaining < 0 || depth > DATA_TREE_DEPTH) return { type: 'limit', text: 'Use Source to read deeper content.', omitted: true }
  if (node.type !== 'object' && node.type !== 'array') return { type: node.type, text: source.slice(node.offset, node.offset + node.length) }
  const children: DataNode[] = []
  for (const child of node.children ?? []) {
    if (budget.remaining <= 0) break
    const value = node.type === 'object' ? child.children?.[1] : child
    if (!value) continue
    children.push({ ...jsonDataNode(value, source, depth + 1, budget),
      label: node.type === 'object' ? String(child.children?.[0]?.value) : `[${children.length}]` })
  }
  return { type: node.type, children, omitted: children.length < (node.children?.length ?? 0) }
}
