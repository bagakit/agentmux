import {
  looksLikeMarkdown,
  parseAgentMarkdown,
  type BlockNode,
  type InlineNode
} from '../lib/agent-markdown'

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

function defaultOpenExternal(url: string): void {
  // Imported at call time, not module load, so the constant is only touched when a link is clicked.
  void import('../lib/api').then(({ api }) => api.ui.openExternal(url))
}

function Inline({ nodes, openExternal }: { nodes: InlineNode[]; openExternal: OpenExternal }) {
  return (
    <>
      {nodes.map((node, index) => {
        const key = `${node.kind}-${index}`
        if (node.kind === 'text') return <span key={key}>{node.text}</span>
        if (node.kind === 'code') return <code key={key} className="md-code">{node.text}</code>
        if (node.kind === 'strong') return <strong key={key}><Inline nodes={node.children} openExternal={openExternal} /></strong>
        if (node.kind === 'emphasis') return <em key={key}><Inline nodes={node.children} openExternal={openExternal} /></em>
        if (node.kind === 'strike') return <del key={key}><Inline nodes={node.children} openExternal={openExternal} /></del>
        return (
          // A button, not an anchor: an <a href> inside untrusted output is a navigation escape hatch out
          // of the renderer. Main owns the decision and normalises the URL, so a hostile scheme is
          // refused there rather than trusted here.
          <button
            key={key}
            type="button"
            className="md-link"
            title={node.href}
            onClick={() => openExternal(node.href)}
          >
            <Inline nodes={node.children} openExternal={openExternal} />
          </button>
        )
      })}
    </>
  )
}

function Block({ node, openExternal }: { node: BlockNode; openExternal: OpenExternal }) {
  if (node.kind === 'heading') {
    // One element and one size for every level; `data-level` exists so weight and spacing can step,
    // never the type scale.
    return (
      <p className="md-heading" data-level={node.level}>
        <Inline nodes={node.children} openExternal={openExternal} />
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
              <Block key={childIndex} node={child} openExternal={openExternal} />
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
          <Block key={index} node={child} openExternal={openExternal} />
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
                  <Inline nodes={cell} openExternal={openExternal} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} {...(node.align[cellIndex] ? { 'data-align': node.align[cellIndex] } : {})}>
                    <Inline nodes={cell} openExternal={openExternal} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  return <p className="md-paragraph"><Inline nodes={node.children} openExternal={openExternal} /></p>
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
  openExternal = defaultOpenExternal
}: {
  content: string
  className?: string
  openExternal?: OpenExternal
}) {
  if (!looksLikeMarkdown(content)) {
    return <p className={className}>{content}</p>
  }
  const blocks = parseAgentMarkdown(content)
  if (blocks.length === 0) return <p className={className}>{content}</p>
  return (
    <div className={className ? `${className} md` : 'md'}>
      {blocks.map((block, index) => <Block key={index} node={block} openExternal={openExternal} />)}
    </div>
  )
}
