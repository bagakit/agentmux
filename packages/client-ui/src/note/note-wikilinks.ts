import type { JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { parseNoteWikiQuery, scanNoteWikiLinks, type NoteLinkTarget, type NoteWikiQuery, type NoteWikiToken } from '@agentmux/core/note-links'
import type { NoteGraphTarget } from '@agentmux/core/notebook-observation'
import type { NoteDocument } from './note-document.js'
import { NOTE_BLOCK_TYPES } from './note-content-schema.js'

export type PendingNoteWikiLink = { referenceId: string; text: string; query: NoteWikiQuery }
export type IndexedNoteReference = { blockId: string; target: NoteGraphTarget; mode: 'reference' | 'embed' | 'link'; occurrence:
  | { kind: 'stored'; referenceId: string } | { kind: 'text'; from: number; to: number } }
/** ProseMirror textContent omits inline atoms; shared indexes must preserve their visible label. */
export function noteSemanticText(node: ProseMirrorNode): string {
  return node.textBetween(0, node.content.size, '', leaf => leaf.type.name === 'noteLink' ? `[[${String(leaf.attrs.text)}]]` : leaf.type.name === 'hardBreak' ? '\n' : '')
}
const eligible = (node: JSONContent) => node.type === 'text' && !node.marks?.some(mark => mark.type === 'code' || mark.type === 'link' || mark.type === 'noteWikiLiteral')
/** One text-run adapter for the writer and saved-file index; marks never create another lexer. */
function runs(children: readonly JSONContent[], accept: (run: readonly JSONContent[], from: number, tokens: readonly NoteWikiToken[]) => void) {
  let start = 0, at = 0
  while (at < children.length) {
    if (!eligible(children[at]!)) { at++; continue }
    start = at
    while (at < children.length && eligible(children[at]!)) at++
    const run = children.slice(start, at), tokens = scanNoteWikiLinks(run.map(node => node.text ?? '').join(''))
    if (tokens.length) accept(run, start, tokens)
  }
}
/** Inline PM offsets for incremental editor transactions, sharing the writer's eligibility. */
export function noteWikiTextTokens(content: readonly JSONContent[]): readonly NoteWikiToken[] {
  const offsets: number[] = []
  let offset = 0
  for (const node of content) { offsets.push(offset); offset += node.type === 'text' ? node.text?.length ?? 0 : 1 }
  const tokens: NoteWikiToken[] = []
  runs(content, (_run, start, found) => tokens.push(...found.map(token => ({ ...token, from: offsets[start]! + token.from, to: offsets[start]! + token.to }))))
  return tokens
}
export function prepareNoteWikiLinks(note: NoteDocument, allocateReferenceId: () => string): { note: NoteDocument; pending: readonly PendingNoteWikiLink[] } {
  const pending: PendingNoteWikiLink[] = [], next = structuredClone(note)
  function remember(node: JSONContent) {
    if (node.type !== 'noteLink' || node.attrs?.target !== null) return
    const parsed = parseNoteWikiQuery(node.attrs.text)
    if (parsed.status === 'valid') pending.push({ referenceId: node.attrs.referenceId, text: node.attrs.text, query: parsed.query })
  }
  function visit(node: JSONContent, code = false) {
    if (node.type === 'noteLink') { remember(node); return }
    if (!node.content || code || node.type === 'codeBlock') return
    const replacements = new Map<number, { count: number; nodes: JSONContent[] }>()
    runs(node.content, (run, start, tokens) => {
      const nodes: JSONContent[] = []
      function slice(from: number, to: number) {
        let offset = 0
        for (const part of run) { const end = offset + (part.text?.length ?? 0), text = part.text?.slice(Math.max(0, from - offset), Math.min(end, to) - offset); if (text && to > offset && from < end) nodes.push({ ...part, text }); offset = end }
      }
      let offset = 0
      for (const token of tokens) {
        slice(offset, token.from)
        const link: JSONContent = { type: 'noteLink', attrs: { referenceId: allocateReferenceId(), text: token.text, target: null } }
        let markOffset = 0
        const first = run.find(part => { const start = markOffset; markOffset += part.text?.length ?? 0; return token.from >= start && token.from < markOffset })
        if (first?.marks?.length) link.marks = structuredClone(first.marks)
        nodes.push(link); remember(link); offset = token.to
      }
      slice(offset, run.reduce((sum, node) => sum + (node.text?.length ?? 0), 0))
      replacements.set(start, { count: run.length, nodes })
    })
    const children: JSONContent[] = []
    for (let i = 0; i < node.content.length;) {
      const replacement = replacements.get(i)
      if (replacement) { children.push(...replacement.nodes); i += replacement.count }
      else { const child = node.content[i++]!; visit(child); children.push(child) }
    }
    node.content = children
  }
  visit(next.content)
  return { note: next, pending }
}
/** A late lookup can change only its exact, still-unbound original occurrence. */
export function bindNoteWikiLink(note: NoteDocument, input: { referenceId: string; text: string; target: NoteLinkTarget }): NoteDocument {
  let changed = false
  function visit(node: JSONContent): JSONContent {
    if (node.type === 'noteLink' && node.attrs?.referenceId === input.referenceId && node.attrs.text === input.text && node.attrs.target === null) {
      changed = true; return { ...node, attrs: { ...node.attrs, target: { ...input.target } } }
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node
  }
  const content = visit(note.content)
  return changed ? { ...note, content } : note
}
/** Read-only occurrence evidence. Raw text has positions, never fabricated persistent IDs. */
export function indexNoteReferences(tree: ProseMirrorNode): readonly IndexedNoteReference[] {
  const references: IndexedNoteReference[] = []
  function visit(node: ProseMirrorNode, absolute: number, owner?: { blockId: string; start: number }) {
    if (NOTE_BLOCK_TYPES.some(type => type === node.type.name) && typeof node.attrs.blockId !== 'string') owner = undefined
    if (typeof node.attrs.blockId === 'string') owner = { blockId: node.attrs.blockId, start: absolute + 1 }
    if (owner && node.type.name === 'blockReference') references.push({ blockId: owner.blockId, mode: node.attrs.mode, occurrence: { kind: 'stored', referenceId: node.attrs.referenceId }, target: { kind: 'block', ...node.attrs.target } })
    if (owner && node.type.name === 'noteLink') references.push({ blockId: owner.blockId, mode: 'link', occurrence: { kind: 'stored', referenceId: node.attrs.referenceId }, target: node.attrs.target === null ? { kind: 'unbound', text: node.attrs.text } : { kind: node.attrs.target.blockId ? 'block' : 'page', ...node.attrs.target } })
    if (node.type.name === 'codeBlock') return
    if (owner && node.inlineContent) {
      const children: JSONContent[] = []
      node.forEach(child => { children.push(child.toJSON()) })
      const current = owner
      for (const token of noteWikiTextTokens(children)) references.push({ blockId: current.blockId, mode: 'link', target: { kind: 'unbound', text: token.text }, occurrence: { kind: 'text', from: absolute + 1 + token.from - current.start, to: absolute + 1 + token.to - current.start } })
    }
    node.forEach((child, offset) => visit(child, absolute + (node.type.name === 'doc' ? 0 : 1) + offset, owner))
  }
  visit(tree, 0)
  return references
}
