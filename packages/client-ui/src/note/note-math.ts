import { InputRule, Node } from '@tiptap/core'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'

type MathSyntax = { type: string; value?: string; children?: MathSyntax[]; position?: { start: { offset?: number }; end: { offset?: number } } }
const syntax = unified().use(remarkParse).use(remarkMath)
function mathNodes(text: string): MathSyntax[] {
  const result: MathSyntax[] = []
  const visit = (node: MathSyntax) => {
    if (node.type === 'inlineMath' || node.type === 'math') result.push(node)
    else node.children?.forEach(visit)
  }
  visit(syntax.parse(text) as MathSyntax)
  return result
}

/** Only runs containing dollars need grammar work; remark owns escapes and delimiters. */
export function noteMathRanges(text: string, pending = false): readonly { from: number; to: number }[] {
  if (!text.includes('$')) return []
  const ranges = mathNodes(text).map(node => ({ from: node.position!.start.offset!, to: node.position!.end.offset! }))
  if (pending) {
    // While typing a formula, its prospective closing delimiter must not turn
    // internal [[text]] into a link before the formula input rule can finish.
    for (const suffix of ['$', '$$']) for (const node of mathNodes(text + suffix)) {
      if (node.position!.end.offset === text.length + suffix.length) ranges.push({ from: node.position!.start.offset!, to: text.length })
    }
  }
  return ranges
}

/** Source attributes are shared with the Markdown adapter; rendering is a client concern. */
export const NoteMathInlineNode = Node.create({
  name: 'noteMathInline', group: 'inline', inline: true, atom: true,
  addAttributes: () => ({ latex: { default: '' } }),
  parseHTML: () => [{ tag: 'span[data-note-math-inline]', getAttrs: element => ({ latex: element.getAttribute('data-note-math-inline') ?? '' }) }],
  renderHTML: ({ node }) => ['span', { 'data-note-math-inline': node.attrs.latex }, '$' + node.attrs.latex + '$'],
  renderText: ({ node }) => '$' + node.attrs.latex + '$',
  addInputRules() {
    return [new InputRule({
      find(text) {
        if (!text.endsWith('$')) return null
        const node = mathNodes(text).at(-1)
        if (node?.type !== 'inlineMath' || node.position?.end.offset !== text.length) return null
        const index = node.position.start.offset!
        return { index, text: text.slice(index), data: { latex: node.value ?? '' } }
      },
      handler: ({ state, range, match }) => {
        const from = state.doc.resolve(range.from), to = state.doc.resolve(range.to)
        if (!from.sameParent(to) || from.parent.type.name === 'noteLink') return null
        let code = false
        state.doc.nodesBetween(range.from, range.to, node => { if (node.marks.some(mark => mark.type.spec.code)) code = true })
        if (code) return null
        state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match.data!.latex }, null, from.marks()))
      }
    })]
  }
})

export const NoteMathBlockNode = Node.create({
  name: 'noteMathBlock', group: 'block', atom: true, defining: true,
  addAttributes: () => ({ latex: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-note-math-block]', getAttrs: element => ({ latex: element.getAttribute('data-note-math-block') ?? '' }) }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', { ...HTMLAttributes, 'data-note-math-block': node.attrs.latex }, '$$\n' + node.attrs.latex + '\n$$'],
  renderText: ({ node }) => '$$\n' + node.attrs.latex + '\n$$',
  addInputRules() {
    return [new InputRule({ find: /^\$\$\s$/u, handler: ({ state, range }) => {
      const { $from, empty } = state.selection, parent = $from.parent
      if (!empty || parent.type.name !== 'paragraph' || range.from !== $from.start() || $from.parentOffset !== parent.content.size) return null
      const container = $from.node(-1), index = $from.index(-1)
      if (!container.canReplaceWith(index, index + 1, this.type)) return null
      state.tr.replaceWith($from.before(), $from.after(), this.type.create({ ...parent.attrs, latex: '' }))
    } })]
  }
})
