import { Node } from '@tiptap/core'

/** Source is the original local region, never sanitized preview output. */
export const NoteRawBlockNode = Node.create({
  name: 'noteRawBlock', group: 'block', atom: true,
  addAttributes() { return { source: { default: '', renderHTML: () => ({}) }, format: { default: 'markdown', renderHTML: () => ({}) } } },
  parseHTML() { return [{ tag: 'pre[data-note-raw]', getAttrs: element => ({ source: element.textContent ?? '', format: element.getAttribute('data-note-raw') }) }] },
  renderHTML({ node, HTMLAttributes }) { return ['pre', { ...HTMLAttributes, 'data-note-raw': node.attrs.format }, node.attrs.source] },
  renderText({ node }) { return node.attrs.source }
})

/** The extra LF belongs to the container; every source byte, including its final EOL, is separate. */
export function noteRawFence(source: string, format: string): string {
  const size = Math.max(3, ...[...source.matchAll(/`+/gu)].map(match => match[0].length + 1))
  const fence = '`'.repeat(size)
  return `${fence}note-raw ${format}\n${source}\n${fence}`
}
