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
import { parseHttpLinkUrl } from '../lib/open-destination'

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

// How to open an http(s) link is INJECTED rather than imported. An agent-prose link must offer the same
// destination menu the Terminal does — system browser, new Tab, or a split — so a click hands the URL and
// its modifier state up to the host that owns the menu and the Store, instead of leaving straight through
// `shell.openExternal`. Injected (not imported) because the host resolves it against the Store and the
// Region origin, and a direct import would drag both into a component whose whole point is not having
// them — the same trap the file seam below documents. Absent by default: a caller that passes nothing
// gets a rendered link that raises no menu, never a second, silent path back out to the system browser.
export type LinkClickModifiers = {
  metaKey: boolean
  ctrlKey: boolean
  clientX: number
  clientY: number
}
export type OpenHttpLink = (url: string, event: LinkClickModifiers) => void

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

function defaultOpenHttpLink(): void {
  // No host wired a link seam, so there is deliberately no menu and no open. The alternative — falling
  // back to a direct `shell.openExternal` — is exactly the escape hatch this change removes: it is what
  // let a conversation link skip the destination menu and jump straight to the system browser.
}

/** Shared by every inline renderer: the two open seams plus the root paths resolve against. */
type InlineContext = {
  openHttpLink: OpenHttpLink
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
        // Only an http(s) URL becomes an actionable link. GFM autolinking turns a bare email in agent
        // prose into a `mailto:` node, and an agent can also write `file:`/`vscode:`/`javascript:`
        // explicitly — none of those is something this surface can open, so making them clickable only
        // yields a button that always errors on click. The Terminal already declines to make a non-http
        // URI actionable at all (`parseHttpLinkUrl`); the conversation must judge the same way through
        // the same exit, so the two surfaces cannot drift into treating one scheme differently. A
        // rejected href renders as its own text, exactly as the plain-text path would have shown it.
        const httpHref = parseHttpLinkUrl(node.href)
        if (!httpHref) {
          return <Fragment key={key}><Inline nodes={node.children} context={context} /></Fragment>
        }
        return (
          // A button, not an anchor: an <a href> inside untrusted output is a navigation escape hatch out
          // of the renderer. The click hands the URL and its modifier/pointer state up to the host, which
          // raises the same destination menu the Terminal does (or, with Cmd/Ctrl held, opens the system
          // browser directly through the one shared judgement). The scheme is already narrowed to http(s)
          // above, and the Store and Main each refuse a non-http(s) URL again downstream — so nothing
          // here is the sole guard, and no anchor can navigate away from the renderer.
          <button
            key={key}
            type="button"
            className="md-link"
            title={httpHref}
            onClick={(event) =>
              context.openHttpLink(httpHref, {
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                clientX: event.clientX,
                clientY: event.clientY
              })
            }
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
  openHttpLink = defaultOpenHttpLink,
  openWorkspaceFile,
  workspaceRoot = ''
}: {
  content: string
  className?: string
  openHttpLink?: OpenHttpLink
  /** Absent means file references stay plain text — see `OpenWorkspaceFile`. */
  openWorkspaceFile?: OpenWorkspaceFile
  /** Active Workspace root, for the within-root test on absolute paths. */
  workspaceRoot?: string
}) {
  const context: InlineContext = {
    openHttpLink,
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
