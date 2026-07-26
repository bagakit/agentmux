import { Fragment } from 'react'
import {
  looksLikeMarkdown,
  parseAgentMarkdown,
  type BlockNode,
  type InlineNode
} from '../lib/agent-markdown'
import {
  classifyMarkdownLinkHref,
  referenceRevealLocation,
  splitMarkdownFileReferences,
  type MarkdownFileReference
} from '../lib/markdown-file-reference'

// Rendering an agent's answer as prose.
//
// Two rules shape everything here.
//
// First, nothing becomes markup. The parser hands over a node tree and this maps it to React elements —
// `dangerouslySetInnerHTML` never appears, so untrusted output has no path to becoming live HTML.
//
// Second, heading levels do NOT differ in font size. The surface contract puts a floor on type and
// forbids buying hierarchy with size, and a chat transcript full of large headings destroys the density
// that makes a trace readable. Levels are carried by weight, colour and the space above them instead —
// which is enough, because a heading in an agent's answer is a section marker, not a page title.

// How to open a link is INJECTED rather than imported. The api module resolves a build-time constant, so
// importing it here would make every test that renders a turn fail to load until it remembered a mock —
// exactly the trap that already cost one debugging round. The default routes to the desktop bridge
// lazily, so production callers pass nothing.
export type OpenExternal = (url: string) => void

/**
 * Open a Workspace file, revealing `location` when the reference carried `:line[:col]`.
 *
 * Injected for the same reason as `openExternal`, and additionally because the real implementation is
 * a Store action: importing the Store here would put a Store dependency inside a component whose whole
 * point is not having one. Absent by default — a caller that does not pass it gets today's behaviour,
 * which is a file reference rendered as plain text rather than a button that does nothing.
 */
export type OpenWorkspaceFile = (
  path: string,
  location?: { line: number; column?: number }
) => void

function defaultOpenExternal(url: string): void {
  // Imported at call time, not module load, so the constant is only touched when a link is clicked.
  void import('../lib/api').then(({ api }) => api.ui.openExternal(url))
}

/** Shared by every inline renderer: the two open seams plus the root paths resolve against. */
type InlineContext = {
  openExternal: OpenExternal
  openWorkspaceFile?: OpenWorkspaceFile
  workspaceRoot: string
}

/** A file reference: same affordance as a link, but it opens in the editor rather than leaving. */
function FileReference({
  text,
  reference,
  openWorkspaceFile
}: {
  text: string
  reference: MarkdownFileReference
  openWorkspaceFile: OpenWorkspaceFile
}) {
  return (
    <button
      type="button"
      className="md-link md-link--file"
      title={reference.path}
      onClick={() => openWorkspaceFile(reference.path, referenceRevealLocation(reference))}
    >
      {text}
    </button>
  )
}

/**
 * Render one run of plain text, turning any workspace file references inside it into buttons.
 *
 * This is why detection walks text rather than only `href`: agents write paths in prose and in inline
 * code, and almost never as markdown links.
 */
function TextWithFileReferences({
  text,
  context
}: {
  text: string
  context: InlineContext
}) {
  const { openWorkspaceFile, workspaceRoot } = context
  if (!openWorkspaceFile) return <>{text}</>
  const segments = splitMarkdownFileReferences(text, workspaceRoot)
  if (segments.length === 1 && segments[0]?.kind === 'text') return <>{text}</>
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <Fragment key={index}>{segment.text}</Fragment>
        ) : (
          <FileReference
            key={index}
            text={segment.text}
            reference={segment.reference}
            openWorkspaceFile={openWorkspaceFile}
          />
        )
      )}
    </>
  )
}

function Inline({ nodes, context }: { nodes: InlineNode[]; context: InlineContext }) {
  return (
    <>
      {nodes.map((node, index) => {
        const key = `${node.kind}-${index}`
        if (node.kind === 'text') {
          return <TextWithFileReferences key={key} text={node.text} context={context} />
        }
        if (node.kind === 'code') {
          return (
            <code key={key} className="md-code">
              <TextWithFileReferences text={node.text} context={context} />
            </code>
          )
        }
        if (node.kind === 'strong') return <strong key={key}><Inline nodes={node.children} context={context} /></strong>
        if (node.kind === 'emphasis') return <em key={key}><Inline nodes={node.children} context={context} /></em>
        if (node.kind === 'strike') return <del key={key}><Inline nodes={node.children} context={context} /></del>
        // An explicit `[label](path)` pointing inside the Workspace opens the file. Everything else,
        // http(s) included, keeps leaving through the external seam that Main already adjudicates.
        const fileHref = context.openWorkspaceFile
          ? classifyMarkdownLinkHref(node.href, context.workspaceRoot)
          : null
        if (fileHref && context.openWorkspaceFile) {
          const openWorkspaceFile = context.openWorkspaceFile
          return (
            <button
              key={key}
              type="button"
              className="md-link md-link--file"
              title={fileHref.path}
              onClick={() => openWorkspaceFile(fileHref.path, referenceRevealLocation(fileHref))}
            >
              <Inline nodes={node.children} context={context} />
            </button>
          )
        }
        return (
          // A button, not an anchor: an <a href> inside untrusted output is a navigation escape hatch out
          // of the renderer. Main owns the decision and normalises the URL, so a hostile scheme is
          // refused there rather than trusted here.
          <button
            key={key}
            type="button"
            className="md-link"
            title={node.href}
            onClick={() => context.openExternal(node.href)}
          >
            <Inline nodes={node.children} context={context} />
          </button>
        )
      })}
    </>
  )
}

function Block({ node, context }: { node: BlockNode; context: InlineContext }) {
  if (node.kind === 'heading') {
    // One element and one size for every level; `data-level` exists so weight and spacing can step,
    // never the type scale.
    return (
      <p className="md-heading" data-level={node.level}>
        <Inline nodes={node.children} context={context} />
      </p>
    )
  }
  if (node.kind === 'code') {
    return (
      <pre className="md-block-code" {...(node.language ? { 'data-language': node.language } : {})}>
        <code>{node.text}</code>
      </pre>
    )
  }
  if (node.kind === 'list') {
    const Tag = node.ordered ? 'ol' : 'ul'
    return (
      <Tag className="md-list">
        {node.items.map((item, index) => (
          // Items hold BLOCKS, not just inline runs — that is what keeps a nested list nested instead of
          // flattening it into the parent, which is how the previous parser lost the author's grouping.
          <li key={index}>
            {item.map((child, childIndex) => (
              <Block key={childIndex} node={child} context={context} />
            ))}
          </li>
        ))}
      </Tag>
    )
  }
  if (node.kind === 'quote') {
    return (
      <blockquote className="md-quote">
        {node.children.map((child, index) => (
          <Block key={index} node={child} context={context} />
        ))}
      </blockquote>
    )
  }
  if (node.kind === 'rule') return <hr className="md-rule" />
  if (node.kind === 'table') {
    return (
      // The table owns its own horizontal scroll. Agents emit wide comparison tables, and without this a
      // single long row would widen the turn and push the whole feed sideways.
      <div className="md-table-scroll">
        <table className="md-table">
          <thead>
            <tr>
              {node.header.map((cell, index) => (
                <th key={index} {...(node.align[index] ? { 'data-align': node.align[index] } : {})}>
                  <Inline nodes={cell} context={context} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} {...(node.align[cellIndex] ? { 'data-align': node.align[cellIndex] } : {})}>
                    <Inline nodes={cell} context={context} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  return <p className="md-paragraph"><Inline nodes={node.children} context={context} /></p>
}

/**
 * Render agent output, falling back to plain text when it is plain text.
 *
 * The fallback is not an optimisation: running a parser over prose that was never markdown risks
 * reshaping someone's sentence, so text that shows no markdown signal is left exactly as written.
 */
export function AgentMarkdown({
  content,
  className,
  openExternal = defaultOpenExternal,
  openWorkspaceFile,
  workspaceRoot = ''
}: {
  content: string
  className?: string
  openExternal?: OpenExternal
  /** Absent means file references stay plain text — see `OpenWorkspaceFile`. */
  openWorkspaceFile?: OpenWorkspaceFile
  /** Active Workspace root, for the within-root test on absolute paths. */
  workspaceRoot?: string
}) {
  const context: InlineContext = {
    openExternal,
    workspaceRoot,
    ...(openWorkspaceFile ? { openWorkspaceFile } : {})
  }
  // The plain-text fallback still gets reference detection. A one-line answer naming a file is prose
  // by every markdown signal, and it is also the single most common way an agent cites a path — so
  // skipping detection here would leave the most frequent case dead while the rare one worked.
  if (!looksLikeMarkdown(content)) {
    return <p className={className}><TextWithFileReferences text={content} context={context} /></p>
  }
  const blocks = parseAgentMarkdown(content)
  if (blocks.length === 0) {
    return <p className={className}><TextWithFileReferences text={content} context={context} /></p>
  }
  return (
    <div className={className ? `${className} md` : 'md'}>
      {blocks.map((block, index) => <Block key={index} node={block} context={context} />)}
    </div>
  )
}
