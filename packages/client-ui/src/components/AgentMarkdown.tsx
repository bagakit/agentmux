import { Fragment, type ReactNode } from 'react'
import { looksLikeMarkdown, parseAgentMarkdown, parseAgentMarkdownDocument, type BlockNode, type InlineNode } from '../lib/agent-markdown.js'
import { classifyMarkdownLinkHref, referenceRevealLocation, splitMarkdownFileReferences, type MarkdownFileReference } from '../lib/markdown-file-reference.js'
import { splitPastedImageReferences } from '../lib/pasted-image-reference.js'
import { ConversationImage, type ReadPastedImage } from './ConversationImage.js'
import { parseHttpLinkUrl } from '../lib/link-url.js'
import { MarkdownOutline } from './MarkdownOutline.js'
import { agentLinkReference, splitAgentLinkReferences } from '../lib/agent-link-reference.js'
import { useAgentLinkRenderer, type ClientUiPlatform } from '../platform.js'
import { MarkdownCodeBlock } from './MarkdownCodeBlock.js'
import { MarkdownMath } from './MarkdownMath.js'

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
  visible: boolean
  inLink?: boolean
  renderAgentLink?: ClientUiPlatform['renderAgentLink']
}

function FileReference({ text, reference, openWorkspaceFile }: {
  text: string; reference: MarkdownFileReference; openWorkspaceFile: OpenWorkspaceFile
}) {
  return <button type="button" className="md-link md-link--file" title={reference.path}
    onClick={event => openWorkspaceFile(reference.path, referenceRevealLocation(reference), event)}>{text}</button>
}

/** Pasted tokens claim their own narrow syntax before the common Terminal file scanner. */
function TextWithFileReferences({ text, context }: { text: string; context: InlineContext }) {
  if (context.readOnly || context.inLink) return <>{text}</>
  if (context.renderAgentLink) return <>{splitAgentLinkReferences(text).map((segment, index) => segment.kind === 'agent'
    ? <Fragment key={index}>{context.renderAgentLink?.(segment.reference) ?? segment.text}</Fragment>
    : <TextWithFileReferences key={index} text={segment.text} context={{ ...context, renderAgentLink: undefined }} />)}</>
  const { openWorkspaceFile, readPastedImage, workspaceRoot, homeDir } = context
  const images = readPastedImage ? splitPastedImageReferences(text) : [{ kind: 'text' as const, text }]
  return <>{images.map((image, imageIndex) => {
    if (image.kind === 'image' && readPastedImage) return <ConversationImage key={imageIndex} text={image.text} path={image.path} readImage={readPastedImage} />
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
  target?.focus({ preventScroll: true })
}

function Inline({ nodes, context }: { nodes: InlineNode[]; context: InlineContext }) {
  return <>{nodes.map((node, index) => {
    const key = `${node.kind}-${index}`
    if (node.kind === 'text') return <TextWithFileReferences key={key} text={node.text} context={context} />
    if (node.kind === 'break') return <br key={key} />
    if (node.kind === 'code') return <code key={key} className="md-code"><TextWithFileReferences text={node.text} context={{ ...context, renderAgentLink: undefined }} /></code>
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
      if (context.readOnly) return <span key={key} className="md-image-attachment md-image-attachment--unavailable" title="Image reference">🖼️ {node.alt || node.href}</span>
      const image = context.renderImage?.(node.href, node.alt, context.inLink)
      if (image !== undefined) return <Fragment key={key}>{image}</Fragment>
      const file = classifyMarkdownLinkHref(node.href, context.workspaceRoot, context.homeDir, context.sourcePath)
      if (file && context.documentMode && context.renderWorkspaceImage) return <Fragment key={key}>{context.inLink
        ? context.renderWorkspaceImage(file.path, node.alt, true) : context.renderWorkspaceImage(file.path, node.alt)}</Fragment>
      if (context.inLink) return <span key={key}>{node.alt || node.href}</span>
      if (file && context.openWorkspaceFile) return <button key={key} type="button" className="md-image-attachment" title={file.path}
        onClick={event => context.openWorkspaceFile?.(file.path, referenceRevealLocation(file), event)}>🖼️ {node.alt || file.path}</button>
      return <span key={key} className="md-image-attachment md-image-attachment--unavailable" title="Only workspace images can be previewed">🖼️ {node.alt || node.href}</span>
    }
    const labelContext = { ...context, inLink: true }
    if (context.readOnly) return <span key={key} className="md-link md-link--readonly" title={node.href}><Inline nodes={node.children} context={labelContext} /></span>
    const agent = context.renderAgentLink ? agentLinkReference(node.href, inlineLabel(node.children)) : null
    if (agent) return <Fragment key={key}>{context.renderAgentLink?.(agent) ?? <Inline nodes={node.children} context={labelContext} />}</Fragment>
    if (context.documentMode && node.href.startsWith('#')) {
      let anchor: string
      try { anchor = decodeURIComponent(node.href.slice(1)) } catch { anchor = node.href.slice(1) }
      return <button key={key} type="button" className="md-link" title={node.href}
        onClick={event => navigateWithinMarkdown(event.currentTarget, 'data-md-anchor', anchor)}><Inline nodes={node.children} context={labelContext} /></button>
    }
    const file = context.openWorkspaceFile ? classifyMarkdownLinkHref(node.href, context.workspaceRoot, context.homeDir, context.sourcePath) : null
    if (file && context.openWorkspaceFile) {
      const open = context.openWorkspaceFile
      return <button key={key} type="button" className="md-link md-link--file" title={file.path}
        onClick={event => open(file.path, referenceRevealLocation(file), event)}><Inline nodes={node.children} context={labelContext} /></button>
    }
    const url = parseHttpLinkUrl(node.href)
    if (!url) return <Fragment key={key}><Inline nodes={node.children} context={context} /></Fragment>
    // Buttons route to the Host, so an untrusted href cannot navigate the Renderer.
    return <button key={key} type="button" className="md-link" title={url} onClick={event => context.openHttpLink(url, {
      metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, clientX: event.clientX, clientY: event.clientY
    })}><Inline nodes={node.children} context={labelContext} /></button>
  })}</>
}

function inlineLabel(nodes: InlineNode[]): string {
  return nodes.map(node => 'text' in node ? node.text : 'children' in node ? inlineLabel(node.children) : node.kind === 'break' ? ' ' : '').join('')
}

function Block({ node, context }: { node: BlockNode; context: InlineContext }) {
  if (node.kind === 'heading') {
    const Heading = context.documentMode ? (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[node.level - 1] ?? 'h6' : 'p'
    return <Heading className="md-heading" data-level={node.level} data-md-anchor={node.anchor} tabIndex={context.documentMode && !context.readOnly ? -1 : undefined}>
      {context.inputMode && node.sourceMarker ? `${node.sourceMarker}${node.children.length ? ' ' : ''}` : null}
      <Inline nodes={node.children} context={context} /></Heading>
  }
  if (node.kind === 'code') return <MarkdownCodeBlock code={node.text} language={node.language} visible={context.visible && !context.readOnly} />
  if (node.kind === 'math') return <MarkdownMath expression={node.text} source={node.source} display visible={context.visible && !context.readOnly} />
  if (node.kind === 'list') {
    const Tag = node.ordered ? 'ol' : 'ul'
    return <Tag className="md-list" start={node.ordered ? node.start : undefined}>{node.items.map((item, index) => {
      const checked = node.checked?.[index], task = typeof checked === 'boolean'
      const content = item.map((child, childIndex) => <Block key={childIndex} node={child} context={context} />)
      return <li key={index} className={task ? 'md-task-item' : undefined} data-checked={task ? checked : undefined}>
        {task ? <><input type="checkbox" checked={checked} readOnly disabled aria-label={checked ? 'Completed task' : 'Incomplete task'} /><div className="md-task-item__content">{content}</div></> : content}
      </li>
    })}</Tag>
  }
  if (node.kind === 'quote') return <blockquote className="md-quote">{node.children.map((child, index) => <Block key={index} node={child} context={context} />)}</blockquote>
  if (node.kind === 'rule') return <hr className="md-rule" />
  if (node.kind === 'table') return <div className="md-table-scroll"><table className="md-table"><thead><tr>{node.header.map((cell, index) => <th key={index}
    {...(node.align[index] ? { 'data-align': node.align[index] } : {})}><Inline nodes={cell} context={context} /></th>)}</tr></thead>
    <tbody>{node.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}
      {...(node.align[index] ? { 'data-align': node.align[index] } : {})}><Inline nodes={cell} context={context} /></td>)}</tr>)}</tbody></table></div>
  if (node.kind === 'footnotes') return <section className="md-footnotes" aria-label="Footnotes"><ol className="md-list">{node.items.map(note => <li key={note.identifier}
    data-md-footnote={note.number} tabIndex={context.readOnly ? undefined : -1}>{note.children.map((child, index) => <Block key={index} node={child} context={context} />)}
    {!context.readOnly && <span className="md-footnote-backlinks">{Array.from({ length: note.references }, (_, index) => <button key={index} type="button" className="md-link"
      aria-label={`Return to footnote ${note.number} reference ${index + 1}`} onClick={event => navigateWithinMarkdown(event.currentTarget, 'data-md-footnote-reference', `${note.number}:${index + 1}`)}>↩{index > 0 ? index + 1 : ''}</button>)}</span>}
  </li>)}</ol></section>
  return <p className="md-paragraph"><Inline nodes={node.children} context={context} /></p>
}

/** Shared safe content renderer. Document mode retains document semantics; the Host retains IO. */
export function AgentMarkdown({ content, className, openHttpLink = defaultOpenHttpLink, openWorkspaceFile, readPastedImage,
  workspaceRoot = '', homeDir = '', sourcePath, documentMode = false, inputMode = false, readOnly = false, renderWorkspaceImage, renderImage, outline = false, visible = true }: {
  content: string
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
  /** Root-confined path resolved against the document. A linked image must return noninteractive phrasing content. */
  renderWorkspaceImage?: RenderWorkspaceImage
  /** Host-owned attachment/resource presentation. Undefined delegates to the existing path policy. */
  renderImage?: RenderMarkdownImage
}) {
  const renderAgentLink = useAgentLinkRenderer()
  const isInput = inputMode && !documentMode
  const context: InlineContext = { openHttpLink, workspaceRoot, homeDir, documentMode, inputMode: isInput, readOnly, visible,
    ...(!readOnly && !documentMode && renderAgentLink ? { renderAgentLink } : {}),
    ...(sourcePath ? { sourcePath } : {}), ...(!readOnly && openWorkspaceFile ? { openWorkspaceFile } : {}),
    ...(!readOnly && readPastedImage ? { readPastedImage } : {}), ...(!readOnly && renderWorkspaceImage ? { renderWorkspaceImage } : {}),
    ...(!readOnly && renderImage ? { renderImage } : {}) }
  if (!documentMode && !isInput && !looksLikeMarkdown(content)) return <p className={className ? `${className} md-paragraph` : 'md-paragraph'}><TextWithFileReferences text={content} context={context} /></p>
  const document = documentMode && outline && !readOnly ? parseAgentMarkdownDocument(content) : null
  const blocks = document?.blocks ?? parseAgentMarkdown(content)
  if (!blocks.length && !documentMode) return <p className={className ? `${className} md-paragraph` : 'md-paragraph'}><TextWithFileReferences text={content} context={context} /></p>
  return <div data-markdown-root="" className={`${className ? className + ' ' : ''}md${documentMode ? ' md-document' : isInput ? ' md-input' : ''}`}>
    {document && <MarkdownOutline headings={document.headings} onNavigate={(source, anchor) => navigateWithinMarkdown(source, 'data-md-anchor', anchor)} />}
    {blocks.map((block, index) => <Block key={index} node={block} context={context} />)}
  </div>
}
