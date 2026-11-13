import { Tokenizer, TokenizerMode, type TokenHandler } from 'parse5'
import type { PhrasingContent, RootContent } from 'mdast'
import type { BlockNode, HtmlAlign, HtmlMarkTag, HtmlTableCell, HtmlTableRow, HtmlVerticalAlign, InlineNode } from './agent-markdown.js'

/**
 * README HTML as GitHub readers expect it, projected into the same data nodes as
 * Markdown. Names are presentation meanings, never permission to emit the
 * original element: the renderer only receives validated data derived here.
 */
const BLOCK = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'hr', 'table', 'caption',
  'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'details', 'summary', 'dl', 'dt', 'dd', 'figure', 'figcaption'])
const MARKS = { kbd: 'kbd', sub: 'sub', sup: 'sup', ins: 'ins', mark: 'mark', small: 'small', abbr: 'abbr', q: 'q', samp: 'samp', tt: 'samp', var: 'var', cite: 'cite', dfn: 'dfn' } as const satisfies Record<string, HtmlMarkTag>
const INLINE = new Set(['a', 'img', 'picture', 'source', 'br', 'wbr', 'b', 'strong', 'i', 'em', 's', 'del', 'strike', 'code', 'span', 'time', ...Object.keys(MARKS)])
const VOID = new Set(['br', 'wbr', 'img', 'source', 'hr'])
/** HTML lets these end tags be omitted; their end is implied, not repaired. */
const OPTIONAL_END = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot'])
const CLOSES_PARAGRAPH = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'hr', 'table',
  'details', 'summary', 'dl', 'dt', 'dd', 'figure', 'figcaption'])
/** Structure that only means something inside its parent; elsewhere its tags stay visible. */
const PARENT: Record<string, ReadonlySet<string>> = {
  li: new Set(['ul', 'ol']), dt: new Set(['dl']), dd: new Set(['dl']), tr: new Set(['table', 'thead', 'tbody', 'tfoot']),
  td: new Set(['tr']), th: new Set(['tr']), thead: new Set(['table']), tbody: new Set(['table']), tfoot: new Set(['table']),
  caption: new Set(['table']), summary: new Set(['details']), source: new Set(['picture'])
}
/** Raw-text elements switch the tokenizer exactly as the HTML parser would. */
/** A Map, so tag names such as `constructor` never resolve to an inherited object property. */
const RAW_TEXT = new Map<string, number>([
  ['script', TokenizerMode.SCRIPT_DATA], ['style', TokenizerMode.RAWTEXT], ['xmp', TokenizerMode.RAWTEXT], ['iframe', TokenizerMode.RAWTEXT],
  ['noembed', TokenizerMode.RAWTEXT], ['noframes', TokenizerMode.RAWTEXT], ['noscript', TokenizerMode.RAWTEXT],
  ['textarea', TokenizerMode.RCDATA], ['title', TokenizerMode.RCDATA], ['plaintext', TokenizerMode.PLAINTEXT]
])
const RAW_TEXT_END = new RegExp(`</(${[...RAW_TEXT.keys()].join('|')})(?=[\\t\\n\\f\\r />]|$)`, 'giu')

/** One pass over this source: only the last closing position is needed for a suffix query. */
function rawTextEnds(source: string): Map<string, number> {
  const ends = new Map<string, number>()
  for (const match of source.matchAll(RAW_TEXT_END)) ends.set(match[1]!.toLowerCase(), match.index!)
  return ends
}

type HtmlAttributes = Readonly<Record<string, string>>
type HtmlToken =
  | { kind: 'open'; name: string; attrs: HtmlAttributes; selfClosing: boolean; source: string }
  | { kind: 'close'; name: string; source: string }
  | { kind: 'text'; text: string; source: string }
  | { kind: 'comment'; source: string }
  /** Anything the subset cannot represent: its original characters stay readable. `rawText` marks an
   *  unclosed raw-text start tag, whose body may continue in a later sibling node. */
  | { kind: 'literal'; source: string; rawText?: string }

/**
 * Tokenize one remark `html` value. Text is decoded once by the HTML rules and
 * every character of the source is covered by exactly one token, so input the
 * subset cannot represent is shown as written instead of disappearing.
 */
function tokenizeHtml(source: string): HtmlToken[] {
  const tokens: HtmlToken[] = []
  const lastRawTextEnd = rawTextEnds(source)
  let cursor = 0, rawText: string | null = null, rawStart = 0
  const emit = (token: HtmlToken, start: number, end: number) => {
    if (start > cursor) tokens.push({ kind: 'literal', source: source.slice(cursor, start) })
    const previous = tokens.at(-1)
    if (token.kind === 'text' && previous?.kind === 'text') tokens[tokens.length - 1] = { kind: 'text', text: previous.text + token.text, source: previous.source + token.source }
    else tokens.push(token)
    cursor = Math.max(cursor, end)
  }
  const span = (location: { startOffset: number; endOffset: number } | null | undefined) => [location?.startOffset ?? cursor, location?.endOffset ?? cursor] as const
  const text = (chars: string, location: { startOffset: number; endOffset: number } | null | undefined) => {
    if (rawText !== null) return
    const [start, end] = span(location)
    emit({ kind: 'text', text: chars, source: source.slice(start, end) }, start, end)
  }
  const handler: TokenHandler = {
    onStartTag(token) {
      if (rawText !== null) return
      const [start, end] = span(token.location), raw = source.slice(start, end), name = token.tagName
      const rawMode = RAW_TEXT.get(name)
      if (rawMode !== undefined) {
        // A raw-text body is not markup, so the whole element stays literal source. Only an element
        // whose end tag follows is one; an unclosed start tag is just visible text, never a swallow.
        if ((lastRawTextEnd.get(name) ?? -1) < end) { emit({ kind: 'literal', source: raw, rawText: name }, start, end); return }
        rawText = name; rawStart = start
        tokenizer.state = rawMode
        return
      }
      if (!BLOCK.has(name) && !INLINE.has(name)) { emit({ kind: 'literal', source: raw }, start, end); return }
      const attrs: Record<string, string> = Object.create(null)
      for (const attr of token.attrs) if (!attr.prefix && !(attr.name in attrs)) attrs[attr.name] = attr.value
      emit({ kind: 'open', name, attrs, selfClosing: token.selfClosing || VOID.has(name), source: raw }, start, end)
    },
    onEndTag(token) {
      const [start, end] = span(token.location), name = token.tagName
      if (rawText !== null) {
        if (name !== rawText) return
        emit({ kind: 'literal', source: source.slice(rawStart, end) }, rawStart, end)
        rawText = null
        return
      }
      const raw = source.slice(start, end)
      // `</br>` is a line break in every browser; other void end tags mean nothing.
      if (name === 'br') emit({ kind: 'open', name, attrs: Object.create(null), selfClosing: true, source: raw }, start, end)
      else if (VOID.has(name) || !BLOCK.has(name) && !INLINE.has(name)) emit({ kind: 'literal', source: raw }, start, end)
      else emit({ kind: 'close', name, source: raw }, start, end)
    },
    onCharacter(token) { text(token.chars, token.location) },
    onWhitespaceCharacter(token) { text(token.chars, token.location) },
    onNullCharacter(token) { text('�', token.location) },
    onComment(token) {
      if (rawText !== null) return
      const [start, end] = span(token.location)
      emit({ kind: 'comment', source: source.slice(start, end) }, start, end)
    },
    onDoctype(token) {
      if (rawText !== null) return
      const [start, end] = span(token.location)
      emit({ kind: 'literal', source: source.slice(start, end) }, start, end)
    },
    onEof() {
      if (rawText !== null) { emit({ kind: 'literal', source: source.slice(rawStart) }, rawStart, source.length); rawText = null }
    }
  }
  const tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, handler)
  tokenizer.write(source, true)
  if (cursor < source.length) tokens.push({ kind: 'literal', source: source.slice(cursor) })
  return tokens
}

/** Non-negative integers (pixels) or percentages; anything else is dropped. */
function htmlLength(value: string | undefined): string | undefined {
  const match = /^(\d{1,5}(?:\.\d{1,3})?)(%|px)?$/u.exec(value?.trim() ?? '')
  if (!match) return undefined
  const amount = Number(match[1])
  if (match[2] === '%') return amount > 0 && amount <= 100 ? `${amount}%` : undefined
  return amount > 0 && Number.isInteger(amount) ? `${amount}px` : undefined
}

function htmlAlign(value: string | undefined): HtmlAlign | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'left' || normalized === 'center' || normalized === 'right' || normalized === 'justify' ? normalized : undefined
}

function htmlVerticalAlign(value: string | undefined): HtmlVerticalAlign | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'top' || normalized === 'middle' || normalized === 'bottom' ? normalized : undefined
}

function htmlSpan(value: string | undefined): number | undefined {
  const trimmed = value?.trim() ?? ''
  if (!/^\d{1,3}$/u.test(trimmed)) return undefined
  const span = Number(trimmed)
  return span >= 2 && span <= 100 ? span : undefined
}

/** GitHub's `<picture>` theming is the only media query README authors rely on. */
function htmlColorScheme(value: string | undefined): 'dark' | 'light' | undefined {
  const match = /^\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*$/iu.exec(value ?? '')
  return match ? match[1]!.toLowerCase() as 'dark' | 'light' : undefined
}

/** The first `srcset` candidate is the address; descriptors only choose density. */
function htmlSrcsetFirst(value: string | undefined): string | undefined {
  return value?.trim().split(/,\s+/u)[0]?.trim().split(/\s+/u)[0] || undefined
}

/** The original projection owner keeps headings, anchors, footnotes and alerts. */
export type HtmlProjection = {
  inlines(nodes: PhrasingContent[]): InlineNode[]
  /** `outline: false` builds a heading that is flattened into a line: no outline entry and no anchor. */
  heading(level: number, children: InlineNode[], align: HtmlAlign | undefined, outline: boolean): BlockNode
  /** Block projection for Markdown nested in HTML; `outline: false` when the result is flattened into a line. */
  blocks(nodes: RootContent[], atRoot: boolean, outline?: boolean): BlockNode[]
  sourceOf: HtmlSourceOf
}

type Element = { t: 'el'; name: string; attrs: HtmlAttributes; open: string; close: string | null; children: Item[] }
type Item = Element | { t: 'text'; text: string } | { t: 'literal'; source: string } | { t: 'node'; node: RootContent | PhrasingContent; atRoot: boolean }

/** Original source of a Markdown node, so a raw-text body spanning several nodes stays exactly as written. */
type HtmlSourceOf = (node: RootContent | PhrasingContent) => string
/** A sibling run: Markdown or html nodes (html carries its tokens, tokenized once), or a raw-text body as written. */
type Run = { kind: 'node'; node: RootContent | PhrasingContent; tokens?: HtmlToken[] } | { kind: 'raw'; source: string }

/**
 * remark splits `<script>…</script>` inside a paragraph into separate html nodes. A raw-text body
 * continues across them until its own end tag, exactly as one HTML string would be tokenized; a start
 * tag whose end tag never follows is only visible text.
 */
function rawTextRuns(nodes: readonly (RootContent | PhrasingContent)[], sourceOf: HtmlSourceOf): Run[] {
  const out: Run[] = []
  let open: { name: string; source: string } | null = null
  const lastClosingNode = new Map<string, number>()
  for (const [index, node] of nodes.entries()) {
    if (node.type === 'html') for (const name of rawTextEnds(node.value).keys()) lastClosingNode.set(name, index)
  }
  /** Only a later sibling html node with the matching end tag makes the start tag an element. */
  const closedLater = (index: number, name: string) => (lastClosingNode.get(name) ?? -1) > index
  for (const [index, node] of nodes.entries()) {
    if (open) {
      const text = node.type === 'html' ? node.value : sourceOf(node)
      const end = node.type === 'html' ? new RegExp(`</${open.name}[\\t\\n\\f\\r />]`, 'iu').exec(text + ' ') : null
      if (!end) { open.source += text; continue }
      const close = text.indexOf('>', end.index)
      const stop = close === -1 ? text.length : close + 1
      out.push({ kind: 'raw', source: open.source + text.slice(0, stop) })
      open = null
      if (stop < text.length) out.push({ kind: 'node', node: { ...node, value: text.slice(stop) } as RootContent })
      continue
    }
    if (node.type !== 'html') { out.push({ kind: 'node', node }); continue }
    const tokens = tokenizeHtml(node.value), last = tokens.at(-1)
    // The tokenizer marks an unclosed raw-text start tag; when it ends this node and a later node closes it, the body continues.
    if (last?.kind === 'literal' && last.rawText && closedLater(index, last.rawText)) {
      const before = tokens.slice(0, -1)
      if (before.length) out.push({ kind: 'node', node: { ...node, value: node.value.slice(0, node.value.length - last.source.length) }, tokens: before })
      open = { name: last.rawText, source: last.source }
      continue
    }
    out.push({ kind: 'node', node, tokens })
  }
  if (open) out.push({ kind: 'raw', source: open.source })
  return out
}

/** One element tree over mixed HTML tokens and Markdown nodes, without repairing unclosed structure. */
function buildTree(nodes: readonly (RootContent | PhrasingContent)[], markdownClosesParagraph: boolean, sourceOf: HtmlSourceOf): Element {
  const root: Element = { t: 'el', name: '#root', attrs: {}, open: '', close: '', children: [] }
  const stack: Element[] = [root]
  const top = () => stack[stack.length - 1]!
  /** Implied ends only pass through other implied ends, never through an element that needs its own end tag. */
  const closeOpen = (targets: ReadonlySet<string>, stops: ReadonlySet<string>) => {
    for (let index = stack.length - 1; index > 0; index--) {
      const element = stack[index]!
      if (targets.has(element.name)) { for (const implied of stack.splice(index)) implied.close ??= ''; return }
      if (stops.has(element.name) || !OPTIONAL_END.has(element.name)) return
    }
  }
  // Each <a> implicitly ended by a following <a> leaves one end tag that browsers ignore.
  let impliedAnchorEnds = 0
  const paragraph = new Set(['p']), lists = new Set(['ul', 'ol']), definitions = new Set(['dl']), cells = new Set(['td', 'th'])
  const rows = new Set(['tr']), sections = new Set(['thead', 'tbody', 'tfoot']), tables = new Set(['table'])
  const implyEnds = (name: string) => {
    // HTML never nests links: a new <a> ends the open one, so one click has one destination.
    if (name === 'a') {
      const index = stack.map(element => element.name).lastIndexOf('a')
      if (index > 0) { for (const implied of stack.splice(index)) implied.close ??= ''; impliedAnchorEnds++ }
    }
    if (CLOSES_PARAGRAPH.has(name)) closeOpen(paragraph, new Set())
    if (name === 'li') closeOpen(new Set(['li']), lists)
    if (name === 'dt' || name === 'dd') closeOpen(new Set(['dt', 'dd']), definitions)
    if (name === 'td' || name === 'th') closeOpen(cells, new Set([...rows, ...tables]))
    if (name === 'tr') closeOpen(rows, new Set([...sections, ...tables]))
    if (sections.has(name)) closeOpen(sections, tables)
  }
  for (const run of rawTextRuns(nodes, sourceOf)) {
    if (run.kind === 'raw') { top().children.push({ t: 'literal', source: run.source }); continue }
    const node = run.node
    if (node.type !== 'html') {
      if (markdownClosesParagraph) closeOpen(paragraph, new Set())
      top().children.push({ t: 'node', node, atRoot: stack.length === 1 })
      continue
    }
    for (const token of run.tokens ?? tokenizeHtml(node.value)) {
      if (token.kind === 'comment') continue // GitHub never shows HTML comments.
      if (token.kind === 'text') { top().children.push({ t: 'text', text: token.text }); continue }
      if (token.kind === 'literal') { top().children.push({ t: 'literal', source: token.source }); continue }
      if (token.kind === 'open') {
        implyEnds(token.name)
        const element: Element = { t: 'el', name: token.name, attrs: token.attrs, open: token.source, close: token.selfClosing ? '' : null, children: [] }
        top().children.push(element)
        if (!token.selfClosing) stack.push(element)
        continue
      }
      let found = -1
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index]!.name === token.name) { found = index; break }
        if (!OPTIONAL_END.has(stack[index]!.name)) break
      }
      if (found > 0) {
        const closed = stack.splice(found)
        for (const implied of closed.slice(1)) implied.close ??= ''
        closed[0]!.close = token.source
      } else if (token.name === 'a' && impliedAnchorEnds > 0) impliedAnchorEnds--
      else if (token.name !== 'p') top().children.push({ t: 'literal', source: token.source })
      // A stray `</p>` is an empty paragraph in HTML: nothing to read.
    }
  }
  for (const open of stack.splice(1)) if (OPTIONAL_END.has(open.name)) open.close ??= ''
  return root
}

const CELLS = new Set(['td', 'th']), SECTIONS = new Set(['thead', 'tbody', 'tfoot'])
const whitespace = (text: string) => /^[\t\n\f\r ]*$/u.test(text)
const isWhitespace = (item: Item) => item.t === 'text' && whitespace(item.text)
/** A complete element with one of these names, or undefined. */
const elementNamed = (item: Item, names: ReadonlySet<string> | string): Element | undefined =>
  item.t === 'el' && item.close !== null && (typeof names === 'string' ? item.name === names : names.has(item.name)) ? item : undefined
/** The element's own tags become readable text around its content. */
const visibleTags = (element: Element): Item[] => [{ t: 'literal', source: element.open }, ...element.children,
  ...(element.close ? [{ t: 'literal' as const, source: element.close }] : [])]

/** A link label's own text: nested links give up their destination and keep their children. */
function unlink(nodes: readonly InlineNode[]): InlineNode[] {
  return mergeText(nodes.flatMap(node => node.kind === 'link' ? unlink(node.children)
    : 'children' in node ? [{ ...node, children: unlink(node.children) } as InlineNode] : [node]))
}

function plainText(nodes: readonly InlineNode[]): string {
  return nodes.map(node => 'text' in node ? node.text : 'children' in node ? plainText(node.children) : node.kind === 'image' ? node.alt : node.kind === 'break' ? '\n' : '').join('')
}

function mergeText(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = []
  for (const node of nodes) {
    const previous = out.at(-1)
    if (node.kind === 'text' && previous?.kind === 'text') out[out.length - 1] = { kind: 'text', text: previous.text + node.text }
    else if (node.kind !== 'text' || node.text) out.push(node)
  }
  // A hard break owns its line end; the source newline after it is not a second break.
  for (let index = 1; index < out.length; index++) {
    const node = out[index]!
    if (out[index - 1]!.kind === 'break' && node.kind === 'text') out[index] = { kind: 'text', text: trimStartHtml(node.text) }
  }
  return out.filter(node => node.kind !== 'text' || node.text)
}

/** HTML whitespace only (not NBSP); a linear scan, because an end-anchored regex backtracks on long inner runs. */
const isHtmlSpace = (code: number) => code === 9 || code === 10 || code === 12 || code === 13 || code === 32
function trimStartHtml(text: string): string { let start = 0; while (start < text.length && isHtmlSpace(text.charCodeAt(start))) start++; return text.slice(start) }
function trimEndHtml(text: string): string { let end = text.length; while (end > 0 && isHtmlSpace(text.charCodeAt(end - 1))) end--; return text.slice(0, end) }

function trimInline(nodes: InlineNode[]): InlineNode[] {
  const out = [...nodes]
  while (out[0]?.kind === 'text') {
    const text = trimStartHtml(out[0].text)
    if (text) { out[0] = { kind: 'text', text }; break }
    out.shift()
  }
  while (out.at(-1)?.kind === 'text') {
    const last = out.at(-1) as Extract<InlineNode, { kind: 'text' }>, text = trimEndHtml(last.text)
    if (text) { out[out.length - 1] = { kind: 'text', text }; break }
    out.pop()
  }
  return out
}

function imageFrom(attrs: HtmlAttributes): Extract<InlineNode, { kind: 'image' }> | undefined {
  const href = attrs.src?.trim()
  if (!href) return undefined
  const width = htmlLength(attrs.width), height = htmlLength(attrs.height)
  return { kind: 'image', href, alt: attrs.alt ?? '', ...(width ? { width } : {}), ...(height ? { height } : {}) }
}

function pictureFrom(element: Element): Extract<InlineNode, { kind: 'image' }> | undefined {
  let image: Extract<InlineNode, { kind: 'image' }> | undefined
  const variants: { dark?: string; light?: string } = {}
  for (const child of element.children) {
    const source = elementNamed(child, 'source'), img = elementNamed(child, 'img')
    if (source) {
      const scheme = htmlColorScheme(source.attrs.media), href = htmlSrcsetFirst(source.attrs.srcset) ?? source.attrs.src?.trim()
      if (scheme && href && !variants[scheme]) variants[scheme] = href
    } else if (img) image ??= imageFrom(img.attrs)
  }
  return image && (variants.dark || variants.light) ? { ...image, variants } : image
}

function createMapper(projection: HtmlProjection) {
  /** Above zero while block content is being flattened into a line: headings there are text, not document structure. */
  let inlineDepth = 0
  const asLine = <T,>(build: () => T): T => { inlineDepth++; try { return build() } finally { inlineDepth-- } }
  function inline(items: readonly Item[]): InlineNode[] {
    const out: InlineNode[] = []
    for (const item of items) {
      if (item.t === 'text') out.push({ kind: 'text', text: item.text.replace(/[\t\n\f\r ]+/gu, ' ') })
      else if (item.t === 'literal') out.push({ kind: 'text', text: item.source })
      else if (item.t === 'node') out.push(...(isBlockNode(item.node) ? flatten(projection.blocks([item.node as RootContent], false, false))
        : projection.inlines([item.node as PhrasingContent])))
      else out.push(...inlineElement(item))
    }
    return mergeText(out)
  }
  function inlineElement(element: Element): InlineNode[] {
    if (element.close === null || PARENT[element.name]) return inline(visibleTags(element))
    const children = () => inline(element.children)
    const name = element.name
    if (name === 'b' || name === 'strong') return wrap('strong', children())
    if (name === 'i' || name === 'em') return wrap('emphasis', children())
    if (name === 's' || name === 'del' || name === 'strike') return wrap('strike', children())
    if (name === 'code') { const text = exactText(element.children).replace(/[\t\n\f\r ]+/gu, ' '); return text.trim() ? [{ kind: 'code', text }] : [] }
    if (name in MARKS) {
      const content = children(), tag = MARKS[name as keyof typeof MARKS], title = element.attrs.title
      return content.length ? [{ kind: 'html-mark', tag, ...((tag === 'abbr' || tag === 'dfn') && title ? { title } : {}), children: content }] : []
    }
    if (name === 'a') {
      // HTML never nests links: an autolink or Markdown link in the label is only its text.
      const href = element.attrs.href?.trim(), content = unlink(children())
      return href && content.length ? [{ kind: 'link', href, children: content }] : content
    }
    if (name === 'img') { const image = imageFrom(element.attrs); return image ? [image] : inline(visibleTags(element)) }
    if (name === 'picture') { const image = pictureFrom(element); return image ? [image] : inline(visibleTags(element)) }
    if (name === 'br') return [{ kind: 'break' } as const]
    if (name === 'wbr') return []
    if (name === 'span' || name === 'time') return children()
    return flatten(asLine(() => blockElement(element)))
  }
  /** Preformatted text keeps the author's exact characters; nested markup contributes only its text. */
  function exactText(items: readonly Item[]): string {
    return items.map(item => item.t === 'text' ? item.text : item.t === 'literal' ? item.source
      : item.t === 'el' ? item.name === 'br' ? '\n' : exactText(item.children)
      : isBlockNode(item.node) ? '' : plainText(projection.inlines([item.node as PhrasingContent]))).join('')
  }
  function wrap(kind: 'strong' | 'emphasis' | 'strike', children: InlineNode[]): InlineNode[] {
    return children.length ? [{ kind, children }] : []
  }
  /** Block structure inside a line (GFM table cells, link labels) keeps its reading order and line breaks. */
  function flatten(blocks: readonly BlockNode[]): InlineNode[] {
    const out: InlineNode[] = []
    const line = (nodes: InlineNode[]) => { if (!nodes.length) return; if (out.length) out.push({ kind: 'break' }); out.push(...nodes) }
    for (const block of blocks) {
      if (block.kind === 'paragraph') line(block.children)
      else if (block.kind === 'heading') line([{ kind: 'strong', children: block.children }])
      else if (block.kind === 'code' || block.kind === 'math') line([{ kind: 'code', text: block.text }])
      else if (block.kind === 'list') block.items.forEach((item, index) => line([{ kind: 'text', text: block.ordered ? `${(block.start ?? 1) + index}. ` : '• ' }, ...flatten(item)]))
      else if (block.kind === 'table') [block.header, ...block.rows].forEach(row => line(row.flatMap((cell, index) => [...(index ? [{ kind: 'text' as const, text: ' · ' }] : []), ...cell])))
      else if (block.kind === 'html-table') block.rows.forEach(row => line(row.cells.flatMap((cell, index) => [...(index ? [{ kind: 'text' as const, text: ' · ' }] : []), ...flatten(cell.children)])))
      else if (block.kind === 'details') { line(block.summary); line(flatten(block.children)) }
      else if (block.kind === 'quote' || block.kind === 'container' || block.kind === 'alert') line(flatten(block.children))
      else if (block.kind === 'footnotes') block.items.forEach(note => line(flatten(note.children)))
    }
    return out
  }
  function blocks(items: readonly Item[]): BlockNode[] {
    const out: BlockNode[] = []
    let run: Item[] = []
    const flush = () => {
      const children = trimInline(inline(run))
      run = []
      if (children.length) out.push({ kind: 'paragraph', children })
    }
    const visit = (item: Item): void => {
      if (item.t === 'node') {
        if (!isBlockNode(item.node)) { run.push(item); return }
        flush(); out.push(...projection.blocks([item.node as RootContent], item.atRoot)); return
      }
      if (item.t !== 'el') { run.push(item); return }
      // Unclosed or misplaced structure keeps its tags visible; its content keeps its own structure.
      if (item.close === null || PARENT[item.name]) { visibleTags(item).forEach(visit); return }
      if (!BLOCK.has(item.name)) { run.push(item); return }
      flush(); out.push(...blockElement(item))
    }
    items.forEach(visit)
    flush()
    return out
  }
  function blockElement(element: Element): BlockNode[] {
    const align = htmlAlign(element.attrs.align)
    switch (element.name) {
      case 'div': case 'figure': {
        const children = blocks(element.children)
        return align && children.length ? [{ kind: 'container', align, children }] : children
      }
      case 'p': case 'figcaption': {
        const children = trimInline(inline(element.children))
        return children.length ? [{ kind: 'paragraph', ...(align ? { align } : {}), children }] : []
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return [projection.heading(Number(element.name[1]), trimInline(inline(element.children)), align, inlineDepth === 0)]
      case 'blockquote': {
        const children = blocks(element.children)
        return children.length ? [{ kind: 'quote', children }] : []
      }
      case 'ul': case 'ol': return list(element)
      case 'pre': {
        // HTML ignores one newline right after `<pre>`; the rest is the author's exact text.
        const text = exactText(element.children).replace(/^\r?\n/u, '').replace(/\r?\n$/u, '')
        return text ? [{ kind: 'code', language: null, text }] : []
      }
      case 'hr': return [{ kind: 'rule' }]
      case 'table': return table(element)
      case 'details': {
        let summary: InlineNode[] | undefined
        const rest: Item[] = []
        for (const child of element.children) {
          const candidate = summary ? undefined : elementNamed(child, 'summary')
          if (candidate) summary = trimInline(inline(candidate.children))
          else rest.push(child)
        }
        return [{ kind: 'details', open: 'open' in element.attrs, summary: summary?.length ? summary : [{ kind: 'text', text: 'Details' }], children: blocks(rest) }]
      }
      case 'dl': {
        const out: BlockNode[] = []
        for (const child of element.children) {
          const term = elementNamed(child, 'dt'), description = elementNamed(child, 'dd')
          if (term) { const label = trimInline(inline(term.children)); if (label.length) out.push({ kind: 'paragraph', children: [{ kind: 'strong', children: label }] }) }
          else if (description) { const children = blocks(description.children); if (children.length) out.push({ kind: 'container', indent: true, children }) }
          else if (!isWhitespace(child)) out.push(...blocks([child]))
        }
        return out
      }
      default: return blocks(visibleTags(element))
    }
  }
  function list(element: Element): BlockNode[] {
    const items: BlockNode[][] = []
    let stray: Item[] = []
    const flushStray = () => { const content = blocks(stray); stray = []; if (content.length) items.push(content) }
    for (const child of element.children) {
      const item = elementNamed(child, 'li')
      if (item) { flushStray(); items.push(blocks(item.children)) }
      else if (!isWhitespace(child)) stray.push(child)
    }
    flushStray()
    if (!items.length) return []
    const start = /^\d{1,9}$/u.test(element.attrs.start?.trim() ?? '') ? Number(element.attrs.start) : undefined
    return [{ kind: 'list', ordered: element.name === 'ol', ...(element.name === 'ol' && start !== undefined ? { start } : {}), items }]
  }
  function table(element: Element): BlockNode[] {
    const rows: HtmlTableRow[] = [], fostered: Item[] = []
    let caption: InlineNode[] | undefined
    const row = (tr: Element, head: boolean) => {
      const cells: HtmlTableCell[] = []
      for (const child of tr.children) {
        const entry = elementNamed(child, CELLS)
        if (entry) cells.push(cell(entry))
        else if (!isWhitespace(child)) fostered.push(child)
      }
      if (cells.length) rows.push({ head, cells })
    }
    for (const child of element.children) {
      const tr = elementNamed(child, 'tr'), section = elementNamed(child, SECTIONS), label = elementNamed(child, 'caption')
      if (tr) row(tr, false)
      else if (section) {
        for (const grandchild of section.children) {
          const sectionRow = elementNamed(grandchild, 'tr')
          if (sectionRow) row(sectionRow, section.name === 'thead')
          else if (!isWhitespace(grandchild)) fostered.push(grandchild)
        }
      } else if (label) caption = trimInline(inline(label.children))
      else if (!isWhitespace(child)) fostered.push(child)
    }
    // Content outside cells is shown before the table, as HTML foster-parents it.
    const before = blocks(fostered)
    if (!rows.length) return before
    const layout = rows.every(candidate => !candidate.head && candidate.cells.every(entry => !entry.header))
    return [...before, { kind: 'html-table', layout, ...(caption?.length ? { caption } : {}), rows }]
  }
  function cell(element: Element): HtmlTableCell {
    const width = htmlLength(element.attrs.width), align = htmlAlign(element.attrs.align), valign = htmlVerticalAlign(element.attrs.valign)
    const colspan = htmlSpan(element.attrs.colspan), rowspan = htmlSpan(element.attrs.rowspan)
    return { header: element.name === 'th', ...(width ? { width } : {}), ...(align ? { align } : {}), ...(valign ? { valign } : {}),
      ...(colspan ? { colspan } : {}), ...(rowspan ? { rowspan } : {}), children: blocks(element.children) }
  }
  return { inline, blocks }
}

const PHRASING = new Set(['text', 'emphasis', 'strong', 'delete', 'inlineCode', 'inlineMath', 'break', 'link', 'linkReference', 'image', 'imageReference', 'footnoteReference', 'html'])
const isBlockNode = (node: RootContent | PhrasingContent) => !PHRASING.has(node.type)

/** Block siblings that contain HTML: Markdown between the tags stays Markdown. */
export function htmlBlocks(nodes: readonly RootContent[], projection: HtmlProjection): BlockNode[] {
  // A CommonMark type-1 HTML block that opens with an unclosed raw-text tag (<script>, <style>, <textarea>,
  // <pre>) runs to the end of the document. Its characters are not markup, so they stay readable as written,
  // line breaks included, instead of being reflowed into one paragraph.
  const opensRawBlock = (node: RootContent) => {
    if (node.type !== 'html') return false
    const first = tokenizeHtml(node.value).find(token => token.kind !== 'text' || token.text.trim())
    return first?.kind === 'literal' && Boolean(first.rawText) && node.value.trimStart().startsWith(first.source) && /\n[\t ]*\n/u.test(node.value)
  }
  const index = nodes.findIndex(opensRawBlock)
  if (index >= 0) {
    const raw = nodes[index] as Extract<RootContent, { type: 'html' }>
    return [...(index ? htmlBlocks(nodes.slice(0, index), projection) : []), { kind: 'code', language: null, text: raw.value },
      ...(index + 1 < nodes.length ? htmlBlocks(nodes.slice(index + 1), projection) : [])]
  }
  return createMapper(projection).blocks(buildTree(nodes, true, projection.sourceOf).children)
}

/** Phrasing siblings that contain HTML, such as `<sub>`, `<br>` or `<img>` inside a paragraph or table cell. */
export function htmlInlines(nodes: readonly PhrasingContent[], projection: HtmlProjection): InlineNode[] {
  return createMapper(projection).inline(buildTree(nodes, false, projection.sourceOf).children)
}
