import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export const markdownSourceGrammar = unified().use(remarkParse).use(remarkGfm).freeze()

export function parseMarkdownSource(source: string): Root {
  return markdownSourceGrammar.parse(source)
}
