import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

export function parseMarkdownSource(source: string): Root {
  return processor.parse(source)
}
