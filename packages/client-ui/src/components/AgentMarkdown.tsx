import { Fragment, type ReactNode } from 'react'
import { looksLikeMarkdown, parseAgentMarkdown, type BlockNode, type InlineNode } from '../lib/agent-markdown.js'
import { classifyMarkdownLinkHref, referenceRevealLocation, splitMarkdownFileReferences, type MarkdownFileReference } from '../lib/markdown-file-reference.js'
import { splitPastedImageReferences } from '../lib/pasted-image-reference.js'
import { ConversationImage, type ReadPastedImage } from './ConversationImage.js'
import { parseHttpLinkUrl } from '../lib/link-url.js'

export type LinkClickModifiers = { metaKey: boolean; ctrlKey: boolean; clientX: number; clientY: number }
export type OpenHttpLink = (url: string, event: LinkClickModifiers) => void
export type OpenWorkspaceFile = (path: string, location?: { line: number; column?: number }) => void
export type RenderWorkspaceImage = (path: string, alt: string, linked?: boolean) => ReactNode

// The Host owns file reads and link destinations; this renderer never opens a URL on its own.
function defaultOpenHttpLink(): void {}

type InlineContext = {
  openHttpLink: OpenHttpLink
  openWorkspaceFile?: OpenWorkspaceFile
  readPastedImage?: ReadPastedImage
  renderWorkspaceImage?: RenderWorkspaceImage
  workspaceRoot: string
  homeDir: string
  sourcePath?: string
  documentMode: boolean
  inLink?: boolean
}

function FileReference({ text, reference, openWorkspaceFile }: {
  text: string; reference: MarkdownFileReference; openWorkspaceFile: OpenWorkspaceFile
}) {
  return <button type="button" className="md-link md-link--file" title={reference.path}
    onClick={() => openWorkspaceFile(reference.path, referenceRevealLocation(reference))}>{text}</button>
}

/** Pasted tokens claim their own narrow syntax before the common Terminal file scanner. */
function TextWithFileReferences({ text, context }: { text: string; context: InlineContext }) {
  if (context.inLink) return <>{text}</>
  const { openWorkspaceFile, readPastedImage, workspaceRoot, homeDir } = context
  const images = readPastedImage ? splitPastedImageReferences(text) : [{ kind: 'text' as const, text }]
  return <>{images.map((image, imageIndex) => {
    if (image.kind === 'image' && readPastedImage) return <ConversationImage key={imageIndex} text={image.text} path={image.path} readPastedImage={readPastedImage} />
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
    if (node.kind === 'code') return <code key={key} className="md-code"><TextWithFileReferences text={node.text} context={context} /></code>
    if (node.kind === 'strong') return <strong key={key}><Inline nodes={node.children} context={context} /></strong>
    if (node.kind === 'emphasis') return <em key={key}><Inline nodes={node.children} context={context} /></em>
    if (node.kind === 'strike') return <del key={key}><Inline nodes={node.children} context={context} /></del>
    if (node.kind === 'footnote-reference') {
      const reference = `${node.number}:${node.occurrence}`
      // An explicit link owns its label's one action; footnotes must not nest another button.
      if (context.inLink) return <sup key={key} className="md-footnote-reference" data-md-footnote-reference={reference} tabIndex={-1}>{node.number}</sup>
      return <sup key={key} className="md-footnote-reference"><button type="button" className="md-link"
        data-md-footnote-reference={reference} aria-label={`Read footnote ${node.number}`}
        onClick={event => navigateWithinMarkdown(event.currentTarget, 'data-md-footnote', String(node.number))}>{node.number}</button></sup>
    }
    if (node.kind === 'image') {
      const file = classifyMarkdownLinkHref(node.href, context.workspaceRoot, context.homeDir, context.sourcePath)
      if (file && context.documentMode && context.renderWorkspaceImage) return <Fragment key={key}>{context.inLink
        ? context.renderWorkspaceImage(file.path, node.alt, true) : context.renderWorkspaceImage(file.path, node.alt)}</Fragment>
      if (context.inLink) return <span key={key}>{node.alt || node.href}</span>
      if (file && context.openWorkspaceFile) return <button key={key} type="button" className="md-image-attachment" title={file.path}
        onClick={() => context.openWorkspaceFile?.(file.path, referenceRevealLocation(file))}>🖼️ {node.alt || file.path}</button>
      return <span key={key} className="md-image-attachment md-image-attachment--unavailable" title="Only workspace images can be previewed">🖼️ {node.alt || node.href}</span>
    }
    const labelContext = { ...context, inLink: true }
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
        onClick={() => open(file.path, referenceRevealLocation(file))}><Inline nodes={node.children} context={labelContext} /></button>
    }
    const url = parseHttpLinkUrl(node.href)
    if (!url) return <Fragment key={key}><Inline nodes={node.children} context={context} /></Fragment>
    // Buttons route to the Host, so an untrusted href cannot navigate the Renderer.
    return <button key={key} type="button" className="md-link" title={url} onClick={event => context.openHttpLink(url, {
      metaKey: event.metaKey, ctrlKey: event.ctrlKey, clientX: event.clientX, clientY: event.clientY
    })}><Inline nodes={node.children} context={labelContext} /></button>
  })}</>
}

function Block({ node, context }: { node: BlockNode; context: InlineContext }) {
  if (node.kind === 'heading') {
    const Heading = context.documentMode ? (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[node.level - 1] ?? 'h6' : 'p'
    return <Heading className="md-heading" data-level={node.level} data-md-anchor={node.anchor} tabIndex={context.documentMode ? -1 : undefined}>
      <Inline nodes={node.children} context={context} /></Heading>
  }
  if (node.kind === 'code') return <pre className="md-block-code" {...(node.language ? { 'data-language': node.language } : {})}><code>{node.text}</code></pre>
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
    data-md-footnote={note.number} tabIndex={-1}>{note.children.map((child, index) => <Block key={index} node={child} context={context} />)}
    <span className="md-footnote-backlinks">{Array.from({ length: note.references }, (_, index) => <button key={index} type="button" className="md-link"
      aria-label={`Return to footnote ${note.number} reference ${index + 1}`} onClick={event => navigateWithinMarkdown(event.currentTarget, 'data-md-footnote-reference', `${note.number}:${index + 1}`)}>↩{index > 0 ? index + 1 : ''}</button>)}</span>
  </li>)}</ol></section>
  return <p className="md-paragraph"><Inline nodes={node.children} context={context} /></p>
}

/** Shared safe content renderer. Document mode retains document semantics; the Host retains IO. */
export function AgentMarkdown({ content, className, openHttpLink = defaultOpenHttpLink, openWorkspaceFile, readPastedImage,
  workspaceRoot = '', homeDir = '', sourcePath, documentMode = false, renderWorkspaceImage }: {
  content: string
  className?: string
  openHttpLink?: OpenHttpLink
  openWorkspaceFile?: OpenWorkspaceFile
  readPastedImage?: ReadPastedImage
  workspaceRoot?: string
  homeDir?: string
  sourcePath?: string
  documentMode?: boolean
  /** Root-confined path resolved against the document. A linked image must return noninteractive phrasing content. */
  renderWorkspaceImage?: RenderWorkspaceImage
}) {
  const context: InlineContext = { openHttpLink, workspaceRoot, homeDir, documentMode,
    ...(sourcePath ? { sourcePath } : {}), ...(openWorkspaceFile ? { openWorkspaceFile } : {}),
    ...(readPastedImage ? { readPastedImage } : {}), ...(renderWorkspaceImage ? { renderWorkspaceImage } : {}) }
  if (!documentMode && !looksLikeMarkdown(content)) return <p className={className ? `${className} md-paragraph` : 'md-paragraph'}><TextWithFileReferences text={content} context={context} /></p>
  const blocks = parseAgentMarkdown(content)
  if (!blocks.length && !documentMode) return <p className={className ? `${className} md-paragraph` : 'md-paragraph'}><TextWithFileReferences text={content} context={context} /></p>
  return <div data-markdown-root="" className={`${className ? className + ' ' : ''}md${documentMode ? ' md-document' : ''}`}>
    {blocks.map((block, index) => <Block key={index} node={block} context={context} />)}
  </div>
}
