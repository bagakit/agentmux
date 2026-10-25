import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkStringify from 'remark-stringify'
import { FEISHU_MESSAGE_BODY_BYTES } from './message.js'
import type { Nodes, Table } from 'mdast'

import type { PublicationTextFragment } from '../../publication-store.js'

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkCjkFriendly).use(remarkStringify)
const source = (text: string, node: Nodes) => text.slice(node.position!.start.offset!, node.position!.end.offset!)
function longestTicks(text: string, minimum = 0): number {
  let length = minimum
  for (const match of text.matchAll(/`+/gu)) length = Math.max(length, match[0].length)
  return length
}
const codeSpan = (text: string) => {
  const fence = '`'.repeat(longestTicks(text) + 1)
  return /[\r\n]/u.test(text) ? `\n\n${fence.repeat(3)}text\n${text}\n${fence.repeat(3)}\n\n` : `${fence} ${text} ${fence}`
}
/** Native extension tags in authored prose remain literal, never new mentions.
 * Code is already literal; only parser-identified HTML needs presentation escaping. */
function markdown(text: string, nodes: readonly Nodes[], start = 0, end = text.length): string {
  const replacements: Array<{ start: number; end: number; value: string }> = []
  const visit = (node: Nodes) => {
    if (node.type === 'html') replacements.push({ start: node.position!.start.offset!, end: node.position!.end.offset!, value: codeSpan(source(text, node)) })
    else if ('children' in node) node.children.forEach(visit)
  }
  nodes.forEach(visit)
  let result = text.slice(start, end)
  for (const item of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, item.start - start) + item.value + result.slice(item.end - start)
  // Standard serialization encodes CJK delimiter boundaries as character
  // references understood by the native renderer without adding visible spaces.
  // Original source slices and resource positions remain outside this projection.
  return String(parser.processSync(result)).slice(0, -1)
}
function table(text: string, node: Table): Record<string, unknown> {
  const [header, ...rows] = node.children
  const cellText = (cell: Table['children'][number]['children'][number] | undefined) => {
    if (!cell?.children.length) return ''
    return markdown(text, cell.children, cell.children[0]!.position!.start.offset!, cell.children.at(-1)!.position!.end.offset!)
  }
  const columns = Array.from({ length: node.children.reduce((count, row) => Math.max(count, row.children.length), 0) }, (_, index) => ({
    name: `c${index}`, display_name: cellText(header!.children[index]) || ' ', data_type: 'lark_md', width: 'auto'
  }))
  return { tag: 'table', page_size: Math.min(10, Math.max(1, rows.length)), row_height: 'low',
    header_style: { text_align: 'left', bold: true, text_size: 'normal', background_style: 'grey' },
    columns, rows: rows.map(row => Object.fromEntries(columns.map((column, index) => [column.name, cellText(row.children[index])])) ) }
}
/** Markdown parsing is shared with the project; native tables are a Feishu leaf. */
export function feishuReplyElements(text: string): Record<string, unknown>[] {
  const root = parser.parse(text), elements: Record<string, unknown>[] = []
  let cursor = 0
  for (const node of root.children) if (node.type === 'table') {
    const start = node.position!.start.offset!, end = node.position!.end.offset!
    if (start > cursor) {
      const before = text.slice(cursor, start)
      if (before.trim()) elements.push({ tag: 'markdown', content: markdown(text, root.children.filter(child => child.position!.start.offset! >= cursor && child.position!.end.offset! <= start), cursor, start) })
    }
    elements.push(table(text, node)); cursor = end
  }
  const after = text.slice(cursor)
  if (after.trim() || !elements.length) elements.push({ tag: 'markdown', content: markdown(text, root.children.filter(child => child.position!.start.offset! >= cursor), cursor) })
  return elements
}
export function feishuReplyCard(text: string, fragment?: { ordinal: number; count: number }, literal = false): Record<string, unknown> {
  return { schema: '2.0', config: { update_multi: true },
    body: { padding: '12px 14px 12px 14px', vertical_spacing: '8px', elements: [
      ...(literal ? [{ tag: 'div', text: { tag: 'plain_text', content: text } }] : feishuReplyElements(text)),
      ...(literal ? [{ tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: 'Original Markdown source · exceeds native card format limits' } }] : []),
      ...(fragment && fragment.count > 1 ? [{ tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: `Reply · ${fragment.ordinal + 1}/${fragment.count}` } }] : [])
    ] } }
}

/** Split exact source slices; repeated native structure is presentation only. */
function splitBlock(raw: string, frame: (start: number, end: number) => PublicationTextFragment['presentationContext'], fits: (part: PublicationTextFragment) => boolean, boundaries?: readonly number[]): PublicationTextFragment[] {
  const result: PublicationTextFragment[] = []
  const chars = Array.from(raw)
  let offset = 0, character = 0, previous = 0
  while (offset < raw.length) {
    // Every Unicode character occupies at least one encoded request byte.
    let low = 0, high = Math.min(FEISHU_MESSAGE_BODY_BYTES, chars.length - character)
    const candidate = (count: number) => {
      const text = chars.slice(character, character + count).join(''), context = frame(offset, offset + text.length)
      return { text, ...(context ? { presentationContext: context } : {}) }
    }
    const repeated = Math.min(previous, high)
    if (repeated && fits(candidate(repeated))) low = repeated
    else {
      while (low < high) {
        const count = Math.ceil((low + high) / 2)
        if (fits(candidate(count))) low = count
        else high = count - 1
      }
    }
    if (!low) throw Error('The native reply envelope cannot contain one character')
    // Recheck one previously fitting length before searching again. Native
    // rendering remains the budget oracle for every source slice.
    previous = low
    let part = candidate(low)
    const boundary = boundaries?.filter(end => end > offset && end <= offset + part.text.length).at(-1)
    const line = part.text.lastIndexOf('\n')
    const end = boundary ?? (boundaries ? undefined : line >= 0 ? offset + line + 1 : undefined)
    if (end !== undefined && end < raw.length) {
      const text = raw.slice(offset, end), context = frame(offset, end)
      part = { text, ...(context ? { presentationContext: context } : {}) }
    }
    result.push(part); offset += part.text.length; character += Array.from(part.text).length
  }
  return result
}

/** Keep an ordinary reply whole; only actual native budget overflow splits it. */
export function fragmentFeishuReply(text: string, fits: (part: PublicationTextFragment) => boolean): PublicationTextFragment[] {
  if (fits({ text })) return [{ text }]
  const result: PublicationTextFragment[] = [], root = parser.parse(text)
  for (let index = 0; index < root.children.length;) {
    const node = root.children[index]!, start = index ? node.position!.start.offset! : 0
    const boundary = (index: number) => root.children[index]?.position!.start.offset ?? text.length
    // Search original block boundaries instead of rendering every growing
    // prefix. Every chosen fragment still passes the actual native budget.
    let low = index, high = root.children.length
    while (low < high) {
      const through = Math.ceil((low + high) / 2)
      if (fits({ text: text.slice(start, boundary(through)) })) low = through
      else high = through - 1
    }
    if (low > index) { result.push({ text: text.slice(start, boundary(low)) }); index = low; continue }
    const end = boundary(++index), raw = text.slice(start, end)
    let frame: (start: number, end: number) => PublicationTextFragment['presentationContext'] = () => undefined
    let boundaries: number[] | undefined
    if (node.type === 'code') {
      // Continuations repeat only the opening/closing fence; authored source
      // (including original CRLF and trailing whitespace) remains exact slices.
      const nodeStart = node.position!.start.offset! - start, nodeEnd = node.position!.end.offset! - start
      const opening = raw.slice(nodeStart).match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/u)
      const fence = opening?.[1] ?? '`'.repeat(longestTicks(raw, 2) + 1)
      const prefix = opening?.[0] ?? fence + (node.lang ?? '') + '\n'
      const closing = raw.slice(0, nodeEnd).match(/(?:^|\n)[ \t]*(`{3,}|~{3,})[ \t]*$/u)
      const contentEnd = closing ? nodeEnd - closing[0].length : nodeEnd
      if (opening && fits({ text: 'x', presentationContext: { before: prefix, after: '\n' + fence + '\n' } })) {
        frame = (from, through) => ({ before: from > nodeStart ? prefix : '', after: through <= contentEnd ? '\n' + fence + '\n' : '' })
      } else if (!opening) {
        // Indented code retains the original line indentation. Never add an
        // unmatched fence or turn its four source spaces into code body.
        let offset = 0
        const lines = raw.match(/[^\n]*\n|[^\n]+$/gu) ?? []
        boundaries = lines.map(line => offset += line.length)
        if (lines.some(line => !fits({ text: line }))) {
          frame = () => ({ before: '', after: '', literal: true }); boundaries = undefined
        }
      } else frame = () => ({ before: '', after: '', literal: true })
    } else if (node.type === 'table') {
      const rows = node.children.slice(1), first = rows[0]?.position!.start.offset
      const header = first === undefined ? raw : text.slice(start, first)
      boundaries = rows.map(row => {
        const end = row.position!.end.offset! - start
        return end + (raw.slice(end).startsWith('\r\n') ? 2 : raw[end] === '\n' ? 1 : 0)
      })
      if (first === undefined || rows.some(row => !fits({ text: source(text, row), presentationContext: { before: header, after: '\n' } }))) {
        // One row/header itself exceeds a card. Show its complete source in
        // explicitly identified literal continuations; no cell is discarded.
        frame = () => ({ before: '', after: '', literal: true })
        boundaries = undefined
      } else frame = (from, through) => ({ before: from ? header : '', after: through < raw.length ? '\n' : '' })
    }
    result.push(...splitBlock(raw, frame, fits, boundaries))
  }
  return result
}
