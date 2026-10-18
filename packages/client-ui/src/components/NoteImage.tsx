import { useState } from 'react'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { NoteImageNode } from '../note/note-content-schema.js'
import { parseHttpLinkUrl } from '../lib/link-url.js'
import { useNoteImageRenderer } from '../platform.js'
import { useNoteFileResource } from './NoteFileContext.js'

/** Runtime image presentation never replaces the authored address with decoded bytes. */
export function NoteNetworkImage({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const [failed, setFailed] = useState<string | null>(null), url = parseHttpLinkUrl(src)
  return url && failed !== src
    ? <img src={url} alt={alt} title={title} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(src)} />
    : <span className="note-image__unavailable" role="status">{alt || 'Image'} · {src || 'No image address'}</span>
}

function ImageView({ node }: NodeViewProps) {
  const resource = useNoteFileResource(), render = useNoteImageRenderer()
  const src = String(node.attrs.src ?? ''), alt = String(node.attrs.alt ?? ''), title = node.attrs.title as string | null
  const input = { resource, src, alt, ...(title == null ? {} : { title }) }
  return <NodeViewWrapper as="span" className="note-image" contentEditable={false}>
    {render ? render(input) : <NoteNetworkImage {...input} />}
  </NodeViewWrapper>
}

export const NoteImage = NoteImageNode.extend({ addNodeView: () => ReactNodeViewRenderer(ImageView) })
