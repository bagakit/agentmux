import type { NoteDocument } from './note-document.js'
import { noteHistoryRevision } from '@agentmux/core/note-history'

type NoteNode = NoteDocument['content']
export type NoteShareRange = { nodes: NoteNode[]; parent: NoteNode; index: number; count: number }

export function noteBlockFingerprint(node: NoteNode): string {
  const strip = (value: NoteNode): NoteNode => ({ ...value, ...(value.attrs ? { attrs: Object.fromEntries(Object.entries(value.attrs).filter(([key]) => key !== 'blockId' && key !== 'provenance')) } : {}), ...(value.content ? { content: value.content.map(strip) } : {}) })
  return noteHistoryRevision(JSON.stringify(strip(node)))
}
export function noteNodeAtPath(content: NoteNode, path: readonly number[]): NoteNode | undefined {
  let current: NoteNode | undefined = content
  for (const index of path) current = current?.content?.[index]
  return current
}

/** A selected list item keeps its real container and ordered position in every projection. */
export function noteShareRangeContent(selected: NoteShareRange): NoteNode {
  const wrapped = ['listItem', 'taskItem'].includes(selected.nodes[0]?.type ?? '')
    ? { type: selected.parent.type!, ...(selected.parent.type === 'orderedList' ? { attrs: { ...selected.parent.attrs, start: Number(selected.parent.attrs?.start ?? 1) + selected.index } } : selected.parent.attrs ? { attrs: selected.parent.attrs } : {}), content: structuredClone(selected.nodes) }
    : null
  return { type: 'doc', content: wrapped ? [wrapped] : structuredClone(selected.nodes) }
}

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
