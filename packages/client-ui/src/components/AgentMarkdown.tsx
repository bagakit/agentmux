import { Fragment, useMemo, type ReactNode } from 'react'
import { semanticIconComponent } from '../theme/icons.js'
const ThemeFootnoteReferenceIcon = semanticIconComponent('navigation.footnote-reference')
const ImageReferenceIcon = semanticIconComponent('object.image')
import { looksLikeMarkdown, parseAgentMarkdown, parseAgentMarkdownDocument, type BlockNode, type InlineNode } from '../lib/agent-markdown.js'
import { classifyMarkdownLinkHref, referenceRevealLocation, splitMarkdownFileReferences, type MarkdownFileReference } from '../lib/markdown-file-reference.js'
import { splitPastedImageReferences } from '../lib/pasted-image-reference.js'
import { ConversationImage, type ReadPastedImage } from './ConversationImage.js'
import { parseHttpLinkUrl } from '../lib/link-url.js'
import { MarkdownOutline } from './MarkdownOutline.js'
import { objectLinkReference, splitObjectLinkReferences } from '../lib/object-link-reference.js'
import { useObjectLinkRenderer, useMarkdownDiagramRenderer, useCapsuleEmbedRenderer, type ClientUiPlatform } from '../platform.js'
import { MarkdownCodeBlock, markdownDiagramLanguage } from './MarkdownCodeBlock.js'
import { MarkdownMath } from './MarkdownMath.js'
import { ConversationImageCollection } from './ConversationImageCollection.js'
import { markdownImageReferences, pastedMarkdownImageReference } from '../lib/conversation-image-references.js'
import { useVisibleWork } from '../lib/use-visible-work.js'
import { useHorizontalReading } from '../lib/use-horizontal-reading.js'
import { ConversationProgressiveBody, needsProgressiveText } from './ConversationProgressiveBody.js'
import { markProgrammaticReadingScroll } from '../lib/reading-scroll.js'

export type LinkClickModifiers = { metaKey: boolean; ctrlKey: boolean; altKey?: boolean; clientX: number; clientY: number }
export type OpenHttpLink = (url: string, event: LinkClickModifiers) => void
export type OpenWorkspaceFile = (path: string, location?: { line: number; column?: number }, event?: LinkClickModifiers) => void
export type RenderWorkspaceImage = (path: string, alt: string, linked?: boolean) => ReactNode
export type RenderMarkdownImage = (href: string, alt: string, linked?: boolean) => ReactNode | undefined

// The Host owns file reads and link destinations; this renderer never opens a URL on its own.
function defaultOpenHttpLink(): void {}

type InlineContext = {
  openHttpLink: OpenHttpLink
  openWorkspaceFile?: OpenWorkspaceFile
  readPastedImage?: ReadPastedImage
  renderWorkspaceImage?: RenderWorkspaceImage
  renderImage?: RenderMarkdownImage
  workspaceRoot: string
  homeDir: string
  sourcePath?: string
  documentMode: boolean
  inputMode: boolean
  readOnly: boolean
  readOnlyImages: boolean
  visible: boolean
  hasDiagramRenderer: boolean
  embedIdentity?: string | undefined
  inLink?: boolean
  renderObjectLink?: ClientUiPlatform['renderObjectLink']
}

function FileReference({ text, reference, openWorkspaceFile }: {
  text: string; reference: MarkdownFileReference; openWorkspaceFile: OpenWorkspaceFile
}) {
  return <button type="button" className="md-link md-link--file" title={reference.path}
    onClick={event => openWorkspaceFile(reference.path, referenceRevealLocation(reference), event)}>{text}</button>
}

/** Pasted tokens claim their own narrow syntax before the common Terminal file scanner. */
function TextWithFileReferences({ text, context }: { text: string; context: InlineContext }) {
  if (context.readOnly && !context.readOnlyImages || context.inLink) return <>{text}</>
  if (context.renderObjectLink) return <>{splitObjectLinkReferences(text).map((segment, index) => segment.kind === 'object'
    ? <span key={index} data-reading-find-boundary>{context.renderObjectLink?.(segment.reference) ?? segment.text}</span>
    : <TextWithFileReferences key={index} text={segment.text} context={{ ...context, renderObjectLink: undefined }} />)}</>
  const { openWorkspaceFile, readPastedImage, workspaceRoot, homeDir } = context
  const images = readPastedImage ? splitPastedImageReferences(text) : [{ kind: 'text' as const, text }]
  return <>{images.map((image, imageIndex) => {
    if (image.kind === 'image' && readPastedImage) return <span key={imageIndex} data-reading-find-boundary><ConversationImage active={context.visible} interactive={!context.readOnly} text={image.text} path={image.path} readImage={readPastedImage} /></span>
    if (!openWorkspaceFile) return <Fragment key={imageIndex}>{image.text}</Fragment>
    return <Fragment key={imageIndex}>{splitMarkdownFileReferences(image.text, workspaceRoot, homeDir).map((segment, index) => segment.kind === 'text'
      ? <Fragment key={index}>{segment.text}</Fragment>
      : <FileReference key={index} text={segment.text} reference={segment.reference} openWorkspaceFile={openWorkspaceFile} />)}</Fragment>
  })}</>
}

/** Local document navigation never changes browser location or reaches another Markdown mount. */
function navigateWithinMarkdown(source: HTMLElement, attribute: 'data-md-anchor' | 'data-md-footnote' | 'data-md-footnote-reference', value: string): void {
  const root = source.closest('[data-markdown-root]')
  const target = Array.from(root?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? []).find(element => element.getAttribute(attribute) === value)
  target?.scrollIntoView?.({ block: 'start' })
  const viewport = target?.closest<HTMLElement>('[data-workbench-reading-scroll]')
  if (viewport) markProgrammaticReadingScroll(viewport, 'navigation')
  target?.focus({ preventScroll: true })
}

/** Rendering and gallery collection share the exact link-label fallback decision. */
function resolveLink(node: Extract<InlineNode, { kind: 'link' }>, context: InlineContext) {
  const object = context.renderObjectLink ? objectLinkReference(node.href, inlineLabel(node.children)) : null
  if (object) return { kind: 'object', object } as const
  if (context.documentMode && node.href.startsWith('#')) {
    let anchor: string
    try { anchor = decodeURIComponent(node.href.slice(1)) } catch { anchor = node.href.slice(1) }
    return { kind: 'anchor', anchor } as const
  }
  const file = context.openWorkspaceFile ? classifyMarkdownLinkHref(node.href, context.workspaceRoot, context.homeDir, context.sourcePath) : null
  if (file) return { kind: 'file', file } as const
  const url = parseHttpLinkUrl(node.href)
  return url ? { kind: 'http', url } as const : { kind: 'text' } as const
}

function Inline({ nodes, context }: { nodes: InlineNode[]; context: InlineContext }) {
  return <>{nodes.map((node, index) => {
    const key = `${node.kind}-${index}`
    if (node.kind === 'text') return <TextWithFileReferences key={key} text={node.text} context={context} />
    if (node.kind === 'break') return <br key={key} />
    if (node.kind === 'code') return <code key={key} className="md-code"><TextWithFileReferences text={node.text} context={{ ...context, renderObjectLink: undefined }} /></code>
    if (node.kind === 'math') return <MarkdownMath key={key} expression={node.text} source={node.source} visible={context.visible && !context.readOnly} />
    if (node.kind === 'strong') return <strong key={key}><Inline nodes={node.children} context={context} /></strong>
    if (node.kind === 'emphasis') return <em key={key}><Inline nodes={node.children} context={context} /></em>
    if (node.kind === 'strike') return <del key={key}><Inline nodes={node.children} context={context} /></del>
    if (node.kind === 'footnote-reference') {
      if (context.readOnly) return <sup key={key} className="md-footnote-reference">{node.number}</sup>
      const reference = `${node.number}:${node.occurrence}`
      // An explicit link owns its label's one action; footnotes must not nest another button.
      if (context.inLink) return <sup key={key} className="md-footnote-reference" data-md-footnote-reference={reference} tabIndex={-1}>{node.number}</sup>
      return <sup key={key} className="md-footnote-reference"><button type="button" className="md-link"
        data-md-footnote-reference={reference} aria-label={`Read footnote ${node.number}`}
        onClick={event => navigateWithinMarkdown(event.currentTarget, 'data-md-footnote', String(node.number))}>{node.number}</button></sup>
    }
    if (node.kind === 'image') {
      if (context.readOnly) {
        if (context.readOnlyImages) {
          const image = context.renderImage?.(node.href, node.alt, context.inLink)
          if (image !== undefined) return <span key={key} data-reading-find-boundary>{image}</span>
          const pasted = context.readPastedImage ? pastedMarkdownImageReference(node.href, node.alt) : undefined
          if (pasted && context.readPastedImage) return <span key={key} data-reading-find-boundary><ConversationImage active={context.visible} interactive={false}
            text={node.href} path={pasted.path} label={node.alt || node.href} readImage={context.readPastedImage} /></span>
        }
        return <span key={key} data-reading-find-boundary className="md-image-attachment md-image-attachment--unavailable" title="Image reference"><ImageReferenceIcon size={14} /> {node.alt || node.href}</span>
      }
      const image = context.renderImage?.(node.href, node.alt, context.inLink)
      if (image !== undefined) return <span key={key} data-reading-find-boundary>{image}</span>
      const file = classifyMarkdownLinkHref(node.href, context.workspaceRoot, context.homeDir, context.sourcePath)
      if (file && context.documentMode && context.renderWorkspaceImage) return <span key={key} data-reading-find-boundary>{context.inLink
        ? context.renderWorkspaceImage(file.path, node.alt, true) : context.renderWorkspaceImage(file.path, node.alt)}</span>
      if (context.inLink) return <span key={key} data-reading-find-boundary>{node.alt || node.href}</span>
      if (file && context.openWorkspaceFile) return <span key={key} data-reading-find-boundary><button type="button" className="md-image-attachment" title={file.path}
        onClick={event => context.openWorkspaceFile?.(file.path, referenceRevealLocation(file), event)}><ImageReferenceIcon size={14} /> {node.alt || file.path}</button></span>
      return <span key={key} data-reading-find-boundary className="md-image-attachment md-image-attachment--unavailable" title="Only workspace images can be previewed"><ImageReferenceIcon size={14} /> {node.alt || node.href}</span>
    }
    const labelContext = { ...context, inLink: true }
    if (context.readOnly) return <span key={key} className="md-link md-link--readonly" title={node.href}><Inline nodes={node.children} context={labelContext} /></span>
    const target = resolveLink(node, context)
    if (target.kind === 'object') return <span key={key} data-reading-find-boundary>{context.renderObjectLink?.(target.object) ?? <Inline nodes={node.children} context={labelContext} />}</span>
    if (target.kind === 'anchor') return <button key={key} type="button" className="md-link" title={node.href}
      onClick={event => navigateWithinMarkdown(event.currentTarget, 'data-md-anchor', target.anchor)}><Inline nodes={node.children} context={labelContext} /></button>
    if (target.kind === 'file' && context.openWorkspaceFile) {
      const open = context.openWorkspaceFile, file = target.file
      return <button key={key} type="button" className="md-link md-link--file" title={file.path}
        onClick={event => open(file.path, referenceRevealLocation(file), event)}><Inline nodes={node.children} context={labelContext} /></button>
    }
    if (target.kind !== 'http') return <Fragment key={key}><Inline nodes={node.children} context={context} /></Fragment>
    const url = target.url
    // Buttons route to the Host, so an untrusted href cannot navigate the Renderer.
    return <button key={key} type="button" className="md-link" title={url} onClick={event => context.openHttpLink(url, {
      metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, clientX: event.clientX, clientY: event.clientY
    })}><Inline nodes={node.children} context={labelContext} /></button>
  })}</>
}

function inlineLabel(nodes: InlineNode[]): string {
  return nodes.map(node => 'text' in node ? node.text : 'children' in node ? inlineLabel(node.children) : node.kind === 'break' ? ' ' : '').join('')
}

function MarkdownTable({ node, context }: { node: Extract<BlockNode, { kind: 'table' }>; context: InlineContext }) {
  const viewport = useVisibleWork<HTMLTableElement>(context.visible && !context.readOnly)
  const reading = useHorizontalReading<HTMLDivElement>(viewport.visible, node)
  return <div className="md-table-scroll md-horizontal-reading" {...reading} aria-label={reading.tabIndex === 0 ? 'Scrollable table' : undefined}>
    <table ref={viewport.ref} className="md-table"><thead><tr>{node.header.map((cell, index) => <th key={index}
      {...(node.align[index] ? { 'data-align': node.align[index] } : {})}><Inline nodes={cell} context={context} /></th>)}</tr></thead>
      <tbody>{node.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}
        {...(node.align[index] ? { 'data-align': node.align[index] } : {})}><Inline nodes={cell} context={context} /></td>)}</tr>)}</tbody></table>
  </div>
}

/** An image-shaped reference is an explicit page request, never raw HTML or an ordinary link. */
function MarkdownCapsule({ uri, capsuleId, title, active, inert, presentationKey }: { uri: string; capsuleId: string; title: string; active: boolean; inert: boolean; presentationKey?: string | undefined }) {
  const render = useCapsuleEmbedRenderer()
  const viewport = useVisibleWork<HTMLDivElement>(active && !inert && Boolean(render) && Boolean(presentationKey))
  return <div ref={viewport.ref} data-reading-find-boundary data-capsule-embed={capsuleId}>
    {!inert && render && presentationKey ? render({ uri, capsuleId, title, visible: viewport.visible, presentationKey })
      : <p className="md-paragraph">{title ? `${title} · ` : ''}<code className="md-code">{uri}</code></p>}
  </div>
}

function Block({ node, context, path }: { node: BlockNode; context: InlineContext; path: string }) {
  if (node.kind === 'paragraph' && node.children.some(child => child.kind === 'image') && node.children.every(child =>
    child.kind === 'break' || child.kind === 'text' && !child.text.trim() || child.kind === 'image' && objectLinkReference(child.href)?.target.kind === 'capsule')) {
    return <>{node.children.flatMap((child, index) => {
      if (child.kind !== 'image') return []
      const reference = objectLinkReference(child.href)!
      return reference.target.kind === 'capsule' ? [<MarkdownCapsule key={`${index}:${child.href}`} uri={reference.uri}
        capsuleId={reference.target.capsuleId} title={child.alt} active={context.visible} inert={context.readOnly || context.documentMode}
        presentationKey={context.embedIdentity ? JSON.stringify([context.embedIdentity, path, index, reference.uri]) : undefined} />] : []
    })}</>
  }
  if (node.kind === 'heading') {
    const Heading = context.documentMode ? (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[node.level - 1] ?? 'h6' : 'p'
    return <Heading className="md-heading" data-level={node.level} data-md-anchor={node.anchor} tabIndex={context.documentMode && !context.readOnly ? -1 : undefined}>
      {context.inputMode && node.sourceMarker ? `${node.sourceMarker}${node.children.length ? ' ' : ''}` : null}
      <Inline nodes={node.children} context={context} /></Heading>
  }
  if (node.kind === 'code') return <MarkdownCodeBlock code={node.text} language={node.language} visible={context.visible && !context.readOnly} readOnly={context.readOnly} />
  if (node.kind === 'math') return <MarkdownMath expression={node.text} source={node.source} display visible={context.visible && !context.readOnly} />
  if (node.kind === 'list') {
    const Tag = node.ordered ? 'ol' : 'ul'
    return <Tag className="md-list" start={node.ordered ? node.start : undefined}>{node.items.map((item, index) => {
      const checked = node.checked?.[index], task = typeof checked === 'boolean'
      const content = item.map((child, childIndex) => <Block key={childIndex} node={child} context={context} path={`${path}:list:${index}:${childIndex}`} />)
      return <li key={index} className={task ? 'md-task-item' : undefined} data-checked={task ? checked : undefined}>
        {task ? <><input type="checkbox" checked={checked} readOnly disabled aria-label={checked ? 'Completed task' : 'Incomplete task'} /><div className="md-task-item__content">{content}</div></> : content}
      </li>
    })}</Tag>
  }
  if (node.kind === 'quote') return <blockquote className="md-quote">{node.children.map((child, index) => <Block key={index} node={child} context={context} path={`${path}:quote:${index}`} />)}</blockquote>
  if (node.kind === 'rule') return <hr className="md-rule" />
  if (node.kind === 'table') return <MarkdownTable node={node} context={context} />
  if (node.kind === 'footnotes') return <section className="md-footnotes" aria-label="Footnotes"><ol className="md-list">{node.items.map(note => <li key={note.identifier}
    data-md-footnote={note.number} tabIndex={context.readOnly ? undefined : -1}>{note.children.map((child, index) => <Block key={index} node={child} context={context} path={`${path}:footnote:${note.number}:${index}`} />)}
    {!context.readOnly && <span className="md-footnote-backlinks">{Array.from({ length: note.references }, (_, index) => <button key={index} type="button" className="md-link"
      aria-label={`Return to footnote ${note.number} reference ${index + 1}`} onClick={event => navigateWithinMarkdown(event.currentTarget, 'data-md-footnote-reference', `${note.number}:${index + 1}`)}><ThemeFootnoteReferenceIcon size={12} />{index > 0 ? index + 1 : ''}</button>)}</span>}
  </li>)}</ol></section>
  return <p className="md-paragraph"><Inline nodes={node.children} context={context} /></p>
}

type AgentMarkdownProps = {
  content: string
  /** Exact original message/part reading identity supplied by the source owner; never grants authority. */
  embedIdentity?: string | undefined
  className?: string
  /** Host activity; viewport visibility is checked independently for each expensive block. */
  visible?: boolean
  openHttpLink?: OpenHttpLink
  openWorkspaceFile?: OpenWorkspaceFile
  readPastedImage?: ReadPastedImage
  workspaceRoot?: string
  homeDir?: string
  sourcePath?: string
  documentMode?: boolean
  /** Incoming Markdown keeps source heading markers and compact body-sized typography. */
  inputMode?: boolean
  /** File document navigation. Conversations and inert previews never mount an outline. */
  outline?: boolean
  /** Selectable preview prose without link actions, resource reads or document navigation. */
  readOnly?: boolean
  /** Explicit image-only reading through supplied ports; all navigation remains inert. */
  readOnlyImages?: boolean
  /** Root-confined path resolved against the document. A linked image must return noninteractive phrasing content. */
  renderWorkspaceImage?: RenderWorkspaceImage
  /** Host-owned attachment/resource presentation. Read-only image opt-in requires noninteractive output. Undefined retains the existing path policy. */
  renderImage?: RenderMarkdownImage
  /** Reveal one explicitly located original body, without changing semantic disclosures. */
  reveal?: boolean
}

/** Shared safe content renderer. Parsing is lazy until display or an explicit local query. */
export function AgentMarkdown(props: AgentMarkdownProps) {
  const { content, className, openHttpLink = defaultOpenHttpLink, openWorkspaceFile, readPastedImage,
    workspaceRoot = '', homeDir = '', sourcePath, documentMode = false, inputMode = false, readOnly = false,
    readOnlyImages = false, renderWorkspaceImage, renderImage, outline = false, visible = true, reveal = false, embedIdentity } = props
  const renderObjectLink = useObjectLinkRenderer()
  const hasDiagramRenderer = Boolean(useMarkdownDiagramRenderer())
  const isInput = inputMode && !documentMode
  const parseMode = documentMode && outline && !readOnly ? 'document' : documentMode || isInput ? 'blocks' : 'auto'
  const parse = useMemo(() => {
    let evaluated = false
    let value: { document: ReturnType<typeof parseAgentMarkdownDocument> | null; blocks: BlockNode[] } | null = null
    return () => {
      if (!evaluated) {
        evaluated = true
        if (parseMode !== 'auto' || looksLikeMarkdown(content)) {
          const document = parseMode === 'document' ? parseAgentMarkdownDocument(content) : null
          value = { document, blocks: document?.blocks ?? parseAgentMarkdown(content) }
        }
      }
      return value
    }
  }, [content, parseMode])
  const context: InlineContext = { openHttpLink, workspaceRoot, homeDir, documentMode, inputMode: isInput, readOnly, readOnlyImages, visible, hasDiagramRenderer, embedIdentity,
    ...(!readOnly && !documentMode && renderObjectLink ? { renderObjectLink } : {}),
    ...(sourcePath ? { sourcePath } : {}), ...(!readOnly && openWorkspaceFile ? { openWorkspaceFile } : {}),
    ...((!readOnly || readOnlyImages) && readPastedImage ? { readPastedImage } : {}), ...(!readOnly && renderWorkspaceImage ? { renderWorkspaceImage } : {}),
    ...((!readOnly || readOnlyImages) && renderImage ? { renderImage } : {}) }
  const reading = useMemo(() => {
    let blocks: string[] | undefined
    return () => blocks ??= markdownReadingBlocks(parse()?.blocks ?? null, content, context)
  },
    [parse, content, isInput, documentMode, readOnly, readOnlyImages, renderObjectLink, readPastedImage, openWorkspaceFile, workspaceRoot, homeDir, sourcePath, hasDiagramRenderer, visible])
  return <ConversationProgressiveBody heavy={needsProgressiveText(content)} reveal={reveal} reading={reading}>
    <AgentMarkdownBody content={content} className={className} context={context} parse={parse} />
  </ConversationProgressiveBody>
}

function AgentMarkdownBody({ content, className, context, parse }: {
  content: string; className?: string | undefined; context: InlineContext
  parse: () => { document: ReturnType<typeof parseAgentMarkdownDocument> | null; blocks: BlockNode[] } | null
}) {
  const parsed = parse()
  const { readPastedImage, readOnly, renderObjectLink, documentMode, openWorkspaceFile, workspaceRoot, homeDir, sourcePath } = context
  const isInput = context.inputMode
  const plainContent = !parsed || (!parsed.blocks.length && !documentMode)
  const imageReferences = useMemo(() => readPastedImage && !readOnly
    ? markdownImageReferences(content, plainContent ? undefined : parsed?.blocks, Boolean(context.renderObjectLink), node => resolveLink(node, context).kind === 'text') : [],
  [content, parsed, plainContent, readPastedImage, readOnly, renderObjectLink, documentMode, openWorkspaceFile, workspaceRoot, homeDir, sourcePath])
  if (plainContent) return <ConversationImageCollection references={imageReferences} readImage={readPastedImage}><p className={className ? `${className} md-paragraph` : 'md-paragraph'}><TextWithFileReferences text={content} context={context} /></p></ConversationImageCollection>
  const { document, blocks } = parsed!
  return <ConversationImageCollection references={imageReferences} readImage={readPastedImage}><div data-markdown-root="" className={`${className ? className + ' ' : ''}md${documentMode ? ' md-document' : isInput ? ' md-input' : ''}`}>
    {document && <MarkdownOutline headings={document.headings} onNavigate={(source, anchor) => navigateWithinMarkdown(source, 'data-md-anchor', anchor)} />}
    {blocks.map((block, index) => <Block key={index} node={block} context={context} path={String(index)} />)}
  </div></ConversationImageCollection>
}

/** Stable text only. Opaque image/math/Host output splits a block instead of joining its sides. */
function markdownReadingBlocks(blocks: BlockNode[] | null, content: string, context: InlineContext): string[] {
  function textPieces(text: string, value: InlineContext): (string | null)[] {
    if (value.readOnly && !value.readOnlyImages || value.inLink) return [text]
    if (value.renderObjectLink) return splitObjectLinkReferences(text).flatMap(segment => segment.kind === 'object'
      ? [null] : textPieces(segment.text, { ...value, renderObjectLink: undefined }))
    return value.readPastedImage ? splitPastedImageReferences(text).map(segment => segment.kind === 'image' ? null : segment.text) : [text]
  }
  function inline(nodes: InlineNode[], value = context): (string | null)[] {
    return nodes.flatMap(node => {
      if (node.kind === 'text') return textPieces(node.text, value)
      if (node.kind === 'code') return textPieces(node.text, { ...value, renderObjectLink: undefined })
      if (node.kind === 'math' || node.kind === 'image' || node.kind === 'break') return [null]
      if (node.kind === 'footnote-reference') return [String(node.number)]
      if (node.kind === 'link') {
        const target = resolveLink(node, value)
        return target.kind === 'object' ? [null] : inline(node.children, target.kind === 'text' && !value.readOnly ? value : { ...value, inLink: true })
      }
      return inline(node.children, value)
    })
  }
  function segments(pieces: (string | null)[]): string[] {
    const result: string[] = []
    let text = ''
    for (const piece of pieces) {
      if (piece === null) { if (text) result.push(text); text = '' }
      else text += piece
    }
    if (text) result.push(text)
    return result
  }
  function project(nodes: BlockNode[]): string[] {
    return nodes.flatMap(node => {
      if (node.kind === 'paragraph' || node.kind === 'heading') return segments([
        ...(node.kind === 'heading' && context.inputMode && node.sourceMarker ? [node.sourceMarker + (node.children.length ? ' ' : '')] : []),
        ...inline(node.children)
      ])
      if (node.kind === 'code') return context.hasDiagramRenderer && context.visible && !context.readOnly && markdownDiagramLanguage(node.language) ? [] : [node.text]
      if (node.kind === 'quote') return project(node.children)
      if (node.kind === 'list') return node.items.flatMap(project)
      if (node.kind === 'table') return [node.header, ...node.rows].flatMap(row => row.flatMap(cell => segments(inline(cell))))
      if (node.kind === 'footnotes') return node.items.flatMap(note => project(note.children))
      return []
    })
  }
  return blocks?.length ? project(blocks) : segments(textPieces(content, context))
}
