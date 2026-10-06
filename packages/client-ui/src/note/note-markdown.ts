import type { JSONContent } from '@tiptap/core'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify, { type Options as StringifyOptions } from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import remarkDirective from 'remark-directive'
import { decodeHTML, escapeAttribute } from 'entities'
import { readNoteMarkdownHeader, NOTE_MARKDOWN_SCHEMA } from '@agentmux/core/note-format'
import { parseNoteLinkTarget, scanNoteWikiLinks } from '@agentmux/core/note-links'
import { NOTE_SCHEMA } from './note-format.js'
import { noteContentSchema } from './note-content-schema.js'
import { validateNoteDocument } from './note-document-validation.js'
import type { NoteDocument } from './note-document.js'

type Md = { type: string; children?: Md[]; value?: string; depth?: number; ordered?: boolean; start?: number | null; checked?: boolean | null; lang?: string | null; meta?: string | null; url?: string; title?: string | null; name?: string; attributes?: Record<string, string>; position?: { start: { offset?: number }; end: { offset?: number } } }
type Mark = NonNullable<JSONContent['marks']>[number]
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkDirective)
const fail = (message: string): never => { throw new Error(message + ' The original Markdown source is preserved.') }
// HTML comment IDs cannot contain --; URI component encoding alone leaves hyphens literal.
const encode = (id: string) => encodeURIComponent(id).replace(/-/gu, '%2D')
const decodeValue = (value: string) => { try { return decodeURIComponent(value) } catch { return fail('A field annotation has invalid URI encoding.') } }
const decode = (id: string) => { try { const value = decodeURIComponent(id); if (!value) return fail('An identity marker is empty.'); return value } catch { return fail('An identity marker has invalid URI encoding.') } }
const href = (target: { noteId: string; blockId?: string }) => 'note:' + encode(target.noteId) + (target.blockId === undefined ? '' : '#' + encode(target.blockId))
const target = (url: string) => {
  const match = /^note:([^#]+)(?:#(.+))?$/u.exec(url)
  if (!match) return fail('An exact Note target is invalid.')
  return parseNoteLinkTarget({ noteId: decode(match[1]!), ...match[2] === undefined ? {} : { blockId: decode(match[2]) } })
}
const comment = (kind: string, value?: string): Md => ({ type: 'html', value: `<!--amux-${kind}${value === undefined ? '' : ':' + value}-->` })
const marker = (node: Md, kind: string) => node.type === 'html' ? new RegExp('^<!--amux-' + kind + '(?::([^\\r\\n]*))?-->$','u').exec(node.value ?? '') : null
const tags: Record<string, string> = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', s: 'strike', del: 'strike', u: 'underline', code: 'code' }

function inline(nodes: readonly Md[], body: string, literalWiki = true): JSONContent[] {
  const result: JSONContent[] = [], stack: { tag: string; mark: Mark }[] = []
  const emit = (node: JSONContent, marks: readonly Mark[] = []) => {
    const all = [...stack.map(value => value.mark), ...marks]
    if (all.length) node.marks = all
    const last = result.at(-1)
    if (node.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks) === JSON.stringify(node.marks)) last.text = (last.text ?? '') + node.text
    else result.push(node)
  }
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!
    if (node.type === 'text') {
      if (!literalWiki || stack.some(value => value.mark.type === 'code' || value.mark.type === 'link')) { if (node.value) emit({type:'text',text:node.value}); continue }
      const value = node.value ?? '', raw = body.slice(node.position?.start.offset, node.position?.end.offset), escaped = new Set<number>()
      for (const match of raw.matchAll(/\\\[/gu)) {
        const at = match.index!; let slashes = 1
        for (let cursor = at - 1; cursor >= 0 && raw[cursor] === '\\'; cursor--) slashes++
        if (slashes % 2 === 0) continue
        const prefix = decodeHTML(raw.slice(0,at).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]\^_`{|}~])/gu,'$1'))
        if (!value.startsWith(prefix)) return fail('A literal wiki escape cannot be accurately located in this Markdown text.')
        escaped.add(prefix.length)
      }
      let from = 0
      for (const token of scanNoteWikiLinks(value)) if (escaped.has(token.from)) {
        if (token.from > from) emit({ type: 'text', text: value.slice(from,token.from) })
        emit({ type: 'text', text: value.slice(token.from,token.to) },[{type:'noteWikiLiteral'}]); from = token.to
      }
      if (from < value.length) emit({ type:'text',text:value.slice(from) }); continue
    }
    if (node.type === 'break') { emit({ type: 'hardBreak' }); continue }
    if (node.type === 'inlineCode') { emit({ type: 'text', text: node.value ?? '' }, [{ type: 'code' }]); continue }
    if (['strong', 'emphasis', 'delete'].includes(node.type)) {
      const mark = { type: node.type === 'strong' ? 'bold' : node.type === 'emphasis' ? 'italic' : 'strike' }
      for (const child of inline(node.children ?? [], body, literalWiki)) emit(child, [mark, ...child.marks ?? []])
      continue
    }
    if (node.type === 'link') {
      const ref = marker(nodes[index + 1] ?? { type: '' }, 'ref')
      if (node.url?.startsWith('note:') && ref?.[1]) {
        const children = inline(node.children ?? [], body, false)
        if (children.some(child => child.type !== 'text' || child.marks?.length)) return fail('A bound Note link label must be plain text; apply its marks to the whole link.')
        emit({ type: 'noteLink', attrs: { referenceId: decode(ref[1]), text: children.map(child => child.text).join(''), target: target(node.url) } }); index++; continue
      }
      const attrs = { href: node.url ?? '', ...(node.title == null ? {} : { title: node.title }) }
      for (const child of inline(node.children ?? [], body, false)) emit(child, [{ type: 'link', attrs }, ...child.marks ?? []])
      continue
    }
    if (node.type === 'html') {
      const ref = marker(node, 'ref')
      if (ref) {
        const last = result.at(-1), tokens = last?.type === 'text' ? scanNoteWikiLinks(last.text ?? '') : []
        const token = tokens.at(-1)
        if (!last || !token || token.to !== last.text!.length || last.marks?.some(mark => mark.type === 'code' || mark.type === 'link' || mark.type === 'noteWikiLiteral')) return fail('An occurrence marker is not attached to its original Note link.')
        const prefix = last.text!.slice(0, token.from), marks = last.marks
        result.pop(); if (prefix) result.push({ ...last, text: prefix })
        result.push({ type: 'noteLink', attrs: { referenceId: decode(ref[1] ?? ''), text: token.text, target: null }, ...marks ? { marks } : {} }); continue
      }
      const close = /^<\/(strong|b|em|i|s|del|u|code|a)>$/u.exec(node.value ?? '')
      if (close) { if (stack.pop()?.tag !== close[1]) return fail('Inline formatting tags are not balanced.'); continue }
      const open = /^<(strong|b|em|i|s|del|u|code|a)((?:\s+[a-z-]+="[^"]*")*)>$/u.exec(node.value ?? '')
      if (open) {
        const tag = open[1]!
        if (tag !== 'a' && open[2]) return fail('Inline formatting has unsupported attributes.')
        let mark: Mark = { type: tags[tag]! }
        if (tag === 'a') {
          const attrs: Record<string, string | null> = {}, source = open[2] ?? ''
          const pairs = [...source.matchAll(/\s+([a-z-]+)="([^"]*)"/gu)]
          if (pairs.map(pair => pair[0]).join('') !== source) return fail('A link attribute cannot be read without loss.')
          for (const pair of pairs) {
            const key = pair[1]!, value = decodeHTML(pair[2]!)
            if (key === 'data-amux-null') { for (const name of value.split(' ')) { if (!['href','title','target','rel','class'].includes(name)) return fail('A null link attribute is unsupported.'); attrs[name] = null } }
            else if (['href','title','target','rel','class'].includes(key)) attrs[key] = value
            else return fail('An inline link contains unsupported attributes.')
          }
          mark = { type: 'link', attrs }
        }
        stack.push({ tag, mark }); continue
      }
      return fail('An unsupported inline HTML region cannot be edited without loss: ' + node.value)
    }
    return fail('Unsupported inline Markdown: ' + node.type + '.')
  }
  if (stack.length) return fail('Inline formatting tags are not balanced.')
  return result
}

function blocks(nodes: readonly Md[], body: string, item = false): JSONContent[] {
  const result: JSONContent[] = []
  let listType: string | null = null, listStart: number | undefined, headingLevel: number | null | undefined, codeLanguage: string | undefined
  for (const node of nodes) {
    const itemId = marker(node, 'item')
    if (itemId) { if (!item || result.length) return fail('A list item identity has no exact original owner.'); continue }
    const empty = marker(node, 'empty')
    if (empty) { result.push({ type: 'paragraph', attrs: { blockId: empty[1] ? decode(empty[1]) : null } }); continue }
    const list = marker(node, 'list-type')
    if (list) { if (listType !== null) return fail('A list type annotation is duplicated.'); listType = decodeValue(list[1] ?? ''); continue }
    const language = marker(node, 'code-language'), level = marker(node, 'heading-level'), start = marker(node, 'list-start')
    if (language) { if (codeLanguage !== undefined) return fail('A code language annotation is duplicated.'); codeLanguage = decodeValue(language[1] ?? ''); continue }
    if (level) { if (headingLevel !== undefined || level[1] !== 'null' && !Number.isFinite(Number(level[1]))) return fail('A heading level annotation is invalid.'); headingLevel = level[1] === 'null' ? null : Number(level[1]); continue }
    if (start) { if (listStart !== undefined || !Number.isFinite(Number(start[1]))) return fail('A list start annotation is invalid.'); listStart = Number(start[1]); continue }
    if (codeLanguage !== undefined && node.type !== 'code' || headingLevel !== undefined && node.type !== 'heading' || listStart !== undefined && node.type !== 'list') return fail('A field annotation has no exact original block owner.')
    if (node.type === 'paragraph' && node.children?.length === 1 && node.children[0]?.type === 'text' && /^\^[^\s]+$/u.test(node.children[0].value ?? '')) {
      const previous = result.at(-1)
      const raw = body.slice(node.position?.start.offset, node.position?.end.offset)
      if (!raw.startsWith('^') || !previous || !['paragraph','heading','codeBlock','blockquote','horizontalRule'].includes(previous.type ?? '') || previous.attrs?.blockId) return fail('A standalone block identity is orphaned or duplicated.')
      previous.attrs = { ...previous.attrs, blockId: decode(node.children[0].value!.slice(1)) }; continue
    }
    if (listType !== null && node.type !== 'list') return fail('A list type annotation has no exact list owner.')
    if (node.type === 'list') {
      const children = (node.children ?? []).map(child => {
        if (child.type !== 'listItem' || child.checked != null) return fail('Task list content is not supported by this Note schema.')
        const first = child.children?.[0], own = first ? marker(first, 'item') : null
        return { type: 'listItem', attrs: { blockId: own?.[1] ? decode(own[1]) : null }, content: blocks(child.children ?? [], body, true) }
      })
      result.push({ type: node.ordered ? 'orderedList' : 'bulletList', ...node.ordered ? { attrs: { start: listStart ?? node.start ?? 1, type: listType } } : {}, content: children }); listType = null; listStart = undefined; continue
    }
    if (node.type === 'leafDirective' && ['note-ref','note-embed'].includes(node.name ?? '')) {
      const attrs = node.attributes ?? {}, exact = target(attrs.target ?? '')
      if (Object.keys(attrs).some(key => !['id','ref','target'].includes(key)) || exact.blockId === undefined || !attrs.ref || node.children?.length) return fail('A structural Note reference identity or target is invalid.')
      result.push({ type: 'blockReference', attrs: { blockId: attrs.id ? decode(attrs.id) : null, referenceId: decode(attrs.ref), target: exact, mode: node.name === 'note-ref' ? 'reference' : 'embed' } }); continue
    }
    if (['paragraph','heading'].includes(node.type)) {
      const content = inline(node.children ?? [], body)
      let blockId: string | null = null
      const last = content.at(-1), raw = body.slice(node.position?.start.offset, node.position?.end.offset)
      const suffix = /(?:^| )\^([^\s]+)$/u.exec(raw)
      if (suffix && last?.type === 'text' && !last.marks?.length && last.text?.endsWith('^' + suffix[1])) {
        blockId = decode(suffix[1]!); last.text = last.text.slice(0, -(suffix[1]!.length + 1)); if (last.text.endsWith(' ')) last.text = last.text.slice(0, -1); if (!last.text) content.pop()
      }
      result.push({ type: node.type, attrs: { blockId, ...node.type === 'heading' ? { level: headingLevel === undefined ? node.depth : headingLevel } : {} }, ...content.length ? { content } : {} }); headingLevel = undefined; continue
    }
    if (node.type === 'blockquote') { result.push({ type: 'blockquote', attrs: { blockId: null }, content: blocks(node.children ?? [], body) }); continue }
    if (node.type === 'code') {
      if (node.meta) return fail('Code fence metadata is unsupported; preserve it in Source.')
      result.push({ type: 'codeBlock', attrs: { blockId: null, language: codeLanguage === undefined ? node.lang ?? null : codeLanguage }, ...node.value ? { content: [{ type: 'text', text: node.value }] } : {} }); codeLanguage = undefined; continue
    }
    if (node.type === 'thematicBreak') { result.push({ type: 'horizontalRule', attrs: { blockId: null } }); continue }
    return fail('Unsupported block Markdown: ' + node.type + '.')
  }
  if (listType !== null || listStart !== undefined || headingLevel !== undefined || codeLanguage !== undefined) return fail('A field annotation is orphaned.')
  return result
}

export function parseNoteMarkdown(raw: string): NoteDocument {
  const header = readNoteMarkdownHeader(raw)
  if (header.status !== 'valid') throw new Error(header.message)
  const tree = parser.parse(header.body) as unknown as Md
  return { schema: NOTE_SCHEMA, noteId: header.noteId, content: { type: 'doc', content: blocks(tree.children ?? [], header.body) } }
}

function inlineMarkdown(nodes: readonly JSONContent[]): Md[] {
  return nodes.flatMap(node => {
    let value: Md[]
    if (node.type === 'hardBreak') value = [{ type: 'break' }]
    else if (node.type === 'text') {
      const text = node.text ?? '', tokens = node.marks?.some(mark => mark.type === 'code' || mark.type === 'link' || mark.type === 'noteWikiLiteral') ? [] : scanNoteWikiLinks(text)
      value = []; let from = 0
      for (const token of tokens) { if (token.from > from) value.push({ type: 'text', value: text.slice(from, token.from) }); value.push({ type: 'noteRaw', value: text.slice(token.from, token.to) }); from = token.to }
      if (from < text.length) value.push({ type: 'text', value: text.slice(from) })
    }
    else if (node.type === 'noteLink') {
      const attrs = node.attrs!
      value = attrs.target === null ? [{ type: 'noteRaw', value: `[[${attrs.text}]]` }] : [{ type: 'link', url: href(attrs.target), children: [{ type: 'text', value: attrs.text }] }]
      value.push(comment('ref', encode(attrs.referenceId)))
    } else return fail('Unsupported inline Note node: ' + node.type + '.')
    for (const mark of [...node.marks ?? []].reverse()) {
      if (mark.type === 'noteWikiLiteral') continue
      const simple = ({ bold: 'strong', italic: 'emphasis', strike: 'delete' } as Record<string,string>)[mark.type]
      const text = node.text ?? ''
      if (simple && text.trim() === text && text) value = [{ type: simple, children: value }]
      else if (mark.type === 'code' && node.type === 'text' && !/[\r\n\t]/u.test(text)) value = [{ type: 'inlineCode', value: text }]
      else if (mark.type === 'link') {
        const attrs = mark.attrs ?? {}, ordinary = Object.keys(attrs).every(key => ['href','title','target','rel','class'].includes(key)) && typeof attrs.href === 'string' && attrs.target === '_blank' && attrs.rel === 'noopener noreferrer nofollow' && attrs.class == null
        if (ordinary) value = [{ type: 'link', url: String(attrs.href ?? ''), title: attrs.title == null ? null : String(attrs.title), children: value }]
        else {
          const nulls: string[] = [], pairs: string[] = []
          for (const [key, field] of Object.entries(attrs)) { if (!['href','title','target','rel','class'].includes(key) || field != null && typeof field !== 'string') return fail('A link attribute is not representable.'); if (field == null) nulls.push(key); else pairs.push(`${key}="${escapeAttribute(field)}"`) }
          if (nulls.length) pairs.push(`data-amux-null="${nulls.join(' ')}"`)
          value = [{ type: 'html', value: '<a ' + pairs.join(' ') + '>' }, ...value, { type: 'html', value: '</a>' }]
        }
      } else {
        const tag = ({ bold:'strong', italic:'em', strike:'s', underline:'u', code:'code' } as Record<string,string>)[mark.type]
        if (!tag) return fail('Unsupported Note mark: ' + mark.type + '.')
        value = [{ type:'html',value:'<' + tag + '>' }, ...value, {type:'html',value:'</' + tag + '>'}]
      }
    }
    return value
  })
}
function blockMarkdown(nodes: readonly JSONContent[]): Md[] {
  return nodes.flatMap(node => {
    const attrs = node.attrs ?? {}, own = typeof attrs.blockId === 'string' ? attrs.blockId : null
    let block: Md; const prelude: Md[] = []
    if (node.type === 'paragraph' && !node.content?.length) return [comment('empty', own ? encode(own) : undefined)]
    if (node.type === 'paragraph' || node.type === 'heading') {
      if (node.type === 'heading' && (!Number.isInteger(attrs.level) || attrs.level < 1 || attrs.level > 6)) { if (attrs.level !== null && (typeof attrs.level !== 'number' || !Number.isFinite(attrs.level))) return fail('The original heading level cannot be represented without loss.'); prelude.push(comment('heading-level',String(attrs.level))) }
      block = { type: node.type, ...node.type === 'heading' ? { depth: Number.isInteger(attrs.level) && attrs.level >= 1 && attrs.level <= 6 ? attrs.level : 1 } : {}, children: inlineMarkdown(node.content ?? []) }
    } else if (node.type === 'codeBlock') {
      if (attrs.language != null && typeof attrs.language !== 'string') return fail('The original code language cannot be represented without loss.')
      if (attrs.language === '' || /\s/u.test(attrs.language ?? '')) prelude.push(comment('code-language',encode(attrs.language)))
      block = { type: 'code', lang: prelude.length ? null : attrs.language ?? null, value: node.content?.map(child => child.text ?? '').join('') ?? '' }
    } else if (node.type === 'horizontalRule') block = { type: 'thematicBreak' }
    else if (node.type === 'blockquote') block = { type: 'blockquote', children: blockMarkdown(node.content ?? []) }
    else if (node.type === 'orderedList' || node.type === 'bulletList') {
      if (node.type === 'orderedList' && (typeof attrs.start !== 'number' || !Number.isFinite(attrs.start) || attrs.type != null && typeof attrs.type !== 'string')) return fail('The original list attributes cannot be represented without loss.')
      if (node.type === 'orderedList' && (!Number.isInteger(attrs.start) || attrs.start < 0 || attrs.start > 999999999)) prelude.push(comment('list-start',String(attrs.start)))
      const children = (node.content ?? []).map(child => ({ type: 'listItem', children: [...typeof child.attrs?.blockId === 'string' ? [comment('item',encode(child.attrs.blockId))] : [], ...blockMarkdown(child.content ?? [])] }))
      return [...prelude, ...attrs.type != null ? [comment('list-type',encode(attrs.type))] : [], { type: 'list', ordered: node.type === 'orderedList', start: prelude.length ? 1 : attrs.start ?? 1, children }]
    } else if (node.type === 'blockReference') return [{ type: 'leafDirective', name: attrs.mode === 'embed' ? 'note-embed' : 'note-ref', attributes: { ...own ? { id: encode(own) } : {}, ref: encode(attrs.referenceId), target: href(attrs.target) }, children: [] }]
    else return fail('Unsupported Note block: ' + node.type + '.')
    return [...prelude, block, ...own ? [{ type: 'noteAnchor', value: '^' + encode(own) }] : []]
  })
}
/** Canonical readable Markdown. Provenance is deliberately owned by trusted metadata, never body bytes. */
export function serializeNoteDocument(note: NoteDocument): string {
  validateNoteDocument(note, true)
  const normalized = noteContentSchema.nodeFromJSON(note.content).toJSON()
  const tree: Md = { type:'root', children: blockMarkdown(normalized.content ?? []) }
  const compiler = unified().use(remarkStringify, { bullet:'-', fences:true, emphasis:'*', strong:'*', rule:'-', handlers: {
    noteAnchor: (node: Md) => node.value!, noteRaw: (node: Md, _parent: unknown, state: { safe(value: string, info: unknown): string }, info: object) => '[[' + state.safe(node.value!.slice(2,-2), { ...info, before: '[[', after: ']]' }) + ']]',
    text: (node: Md, _parent: unknown, state: { safe(value: string, info: unknown): string }, info: {before:string;after:string}) => {
      const value = node.value ?? '', lines = value.split(/[\r\n]/u)
      // A blank/edge line is text inside this original block, not a new Markdown block.
      // Escape before state.safe: its paragraph serialization can normalize edge line feeds.
      const breaks = [...value.matchAll(/[\r\n]/gu)].map((match,index) => match[0] === '\r' ? '&#13;' : !lines[index] || !lines[index + 1] ? '&#10;' : '\n')
      return lines.map((line,index) => {
        line = state.safe(line, { ...info, before: index ? breaks[index - 1] : info.before, after: index < breaks.length ? breaks[index] : info.after }).replace(/\^/gu, '\\^')
        if (index > 0 || !info.before || /\n$/u.test(info.before)) line = line.replace(/^[ \t]+/u, space => [...space].map(char => char === ' ' ? '&#32;' : '&#9;').join(''))
        if (index < lines.length - 1 || !info.after || /^\n/u.test(info.after)) line = line.replace(/[ \t]+$/u, space => [...space].map(char => char === ' ' ? '&#32;' : '&#9;').join(''))
        return line + (breaks[index] ?? '')
      }).join('')
    },
  } } as StringifyOptions).use(remarkGfm).use(remarkDirective)
  const body = compiler.stringify(tree as never)
  return `---\nschema: ${NOTE_MARKDOWN_SCHEMA}\nnote-id: ${JSON.stringify(note.noteId)}\n---\n\n${body}`
}
