import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Nodes } from 'mdast'

export type MarkdownDiagram = { kind: 'mermaid'; source: string; start: number; end: number }

/** Positions refer to the unchanged original text, including the original fence. */
export function markdownDiagrams(text: string): MarkdownDiagram[] {
  const nodes: MarkdownDiagram[] = []
  const visit = (node: Nodes) => {
    if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid' &&
      node.position?.start.offset !== undefined && node.position.end.offset !== undefined)
      nodes.push({ kind: 'mermaid', source: node.value, start: node.position.start.offset, end: node.position.end.offset })
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(unified().use(remarkParse).parse(text))
  return nodes
}
