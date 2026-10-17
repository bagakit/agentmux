import { Fragment, useMemo } from 'react'
import { parseAgentMarkdown, type BlockNode, type InlineNode } from '../lib/agent-markdown.js'

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return <>{nodes.map((node, index) => {
    if (node.kind === 'text' || node.kind === 'math') return <Fragment key={index}>{node.text}</Fragment>
    if (node.kind === 'break') return ' '
    if (node.kind === 'code') return <code key={index}>{node.text}</code>
    if (node.kind === 'image') return <span key={index} title={node.href}>{node.alt || 'Image'}</span>
    if (node.kind === 'footnote-reference') return <sup key={index}>{node.number}</sup>
    if (node.kind === 'link') return <span key={index} title={node.href}><Inline nodes={node.children} /></span>
    const Tag = node.kind === 'strong' ? 'strong' : node.kind === 'emphasis' ? 'em' : 'del'
    return <Tag key={index}><Inline nodes={node.children} /></Tag>
  })}</>
}

function Block({ node }: { node: BlockNode }) {
  switch (node.kind) {
    case 'paragraph':
    case 'heading': return <Inline nodes={node.children} />
    case 'code': return <code>{node.text}</code>
    case 'math': return node.text
    case 'rule': return null
    case 'quote': return <Blocks nodes={node.children} />
    case 'list': return <>{node.items.map((item, at) => <Fragment key={at}>{at ? ' · ' : null}
      {node.ordered ? `${(node.start ?? 1) + at}. ` : null}
      {typeof node.checked?.[at] === 'boolean' ? node.checked[at] ? '☑ ' : '☐ ' : null}<Blocks nodes={item} />
    </Fragment>)}</>
    case 'table': return <>{[node.header, ...node.rows].map((row, at) => <Fragment key={at}>{at ? ' · ' : null}
      {row.map((cell, col) => <Fragment key={col}>{col ? ' | ' : null}<Inline nodes={cell} /></Fragment>)}
    </Fragment>)}</>
    case 'footnotes': return <>{node.items.map(note => <Fragment key={note.identifier}><sup>{note.number}</sup> <Blocks nodes={note.children} /></Fragment>)}</>
  }
}

function Blocks({ nodes }: { nodes: BlockNode[] }) {
  return <>{nodes.map((node, index) => <Fragment key={index}>{index ? ' · ' : null}<Block node={node} /></Fragment>)}</>
}

/** Static, inline reading for compact surfaces. The Host supplies an already
 * bounded source excerpt; full documents and all IO stay in their reader. */
export function MarkdownExcerpt({ content }: { content: string }) {
  const blocks = useMemo(() => parseAgentMarkdown(content), [content])
  return <span className="markdown-excerpt"><Blocks nodes={blocks} /></span>
}
