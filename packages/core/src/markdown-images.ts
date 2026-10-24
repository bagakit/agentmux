import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Definition, Image, ImageReference, Root, RootContent } from 'mdast'

export type MarkdownImageReference = { index: number; url: string; alt: string; start: number; end: number; definition?: { start: number; end: number } }
const parser = unified().use(remarkParse)

/** Standard Markdown nodes only; examples inside code and escaped syntax are inert. */
export function markdownImageReferences(text: string): MarkdownImageReference[] {
  const root = parser.parse(text) as Root, definitions = new Map<string, Definition>(), linked = new Set<string>()
  const visit = (node: Root | RootContent, fn: (node: RootContent) => void): void => {
    if (node.type !== 'root') fn(node)
    if ('children' in node) for (const child of node.children) visit(child, fn)
  }
  visit(root, node => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
    if (node.type === 'linkReference') linked.add(node.identifier)
  })
  const images: MarkdownImageReference[] = []
  visit(root, node => {
    if (node.type !== 'image' && node.type !== 'imageReference') return
    const image: Image | ImageReference = node, start = image.position?.start.offset, end = image.position?.end.offset
    const definition = image.type === 'imageReference' ? definitions.get(image.identifier) : undefined
    const url = image.type === 'image' ? image.url : definition?.url
    if (url !== undefined && start !== undefined && end !== undefined)
      images.push({ index: images.length, url, alt: image.alt ?? '', start, end,
        ...(image.type === 'imageReference' && !linked.has(image.identifier) && definition?.position?.start.offset !== undefined && definition.position.end.offset !== undefined
          ? { definition: { start: definition.position.start.offset, end: definition.position.end.offset } } : {}) })
  })
  return images
}
