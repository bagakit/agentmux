import type { NoteDocument } from './note-document.js'

type NoteNode = NoteDocument['content']
export type NoteShareRange = { nodes: NoteNode[]; parent: NoteNode; index: number; count: number }

/** A heading owns its following siblings until the next heading at its level or above. */
export function noteShareSiblingRange(parent: NoteNode, index: number): NoteNode[] {
  const node = parent.content?.[index]
  if (!node) return []
  let end = index + 1
  if (node.type === 'heading') {
    const level = Number(node.attrs?.level ?? 1)
    while (end < parent.content!.length) {
      const next = parent.content![end]!
      if (next.type === 'heading' && Number(next.attrs?.level ?? 1) <= level) break
      end++
    }
  }
  return parent.content!.slice(index, end)
}

/** Locate only a unique original block. Unanchored draft previews use the sibling helper. */
export function noteShareRange(content: NoteNode, blockId: string): NoteShareRange | null {
  const matches: { node: NoteNode; parent: NoteNode; index: number }[] = []
  function visit(parent: NoteNode) {
    parent.content?.forEach((node, index) => {
      if (node.attrs?.blockId === blockId) matches.push({ node, parent, index })
      visit(node)
    })
  }
  visit(content)
  if (matches.length !== 1 || matches[0]!.node.type === 'noteInclude') return null
  const { parent, index } = matches[0]!
  const nodes = noteShareSiblingRange(parent, index)
  return { nodes, parent, index, count: nodes.length }
}
