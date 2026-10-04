import { highlightMarkdownCode } from './markdown-code-highlight.js'

export type MarkdownRenderInput = { kind: 'math'; source: string; display: boolean } | { kind: 'code'; source: string; language: string }
export type MarkdownRenderResult = { html?: string; message?: string; error?: string }
export const MARKDOWN_MATH_SOURCE_LIMIT = 4096
export const MARKDOWN_CODE_SOURCE_LIMIT = 64 * 1024
export const MARKDOWN_HTML_LIMIT = 256 * 1024
export const MARKDOWN_ELEMENT_LIMIT = 3000

/** Admit bounded source before starting a worker; the exact original remains the fallback. */
export function markdownRenderLimit(input: MarkdownRenderInput): string | undefined {
  const limit = input.kind === 'math' ? MARKDOWN_MATH_SOURCE_LIMIT : MARKDOWN_CODE_SOURCE_LIMIT
  if (input.source.length > limit || new TextEncoder().encode(input.source).byteLength > limit) {
    return input.kind === 'math' ? 'Formula preview is limited to 4 KiB. Original formula shown.' : 'Code coloring is limited to 64 KiB per block. Original code shown.'
  }
  return undefined
}

/** Runs only in the terminatable worker. Bound generated DOM before transferring markup. */
export async function renderMarkdown(input: MarkdownRenderInput): Promise<MarkdownRenderResult> {
  const message = markdownRenderLimit(input)
  if (message) return { message }
  let html: string | null
  if (input.kind === 'math') {
    const { default: katex } = await import('katex')
    html = katex.renderToString(input.source, { displayMode: input.display, throwOnError: true, trust: false, strict: 'error', output: 'htmlAndMathml', maxExpand: 1000, maxSize: 20 })
  } else html = await highlightMarkdownCode(input.source, input.language)
  if (html === null) return {}
  if (html.length > MARKDOWN_HTML_LIMIT || new TextEncoder().encode(html).byteLength > MARKDOWN_HTML_LIMIT || (html.match(/<[a-zA-Z][^>]*>/g)?.length ?? 0) > MARKDOWN_ELEMENT_LIMIT) {
    return { message: input.kind === 'math' ? 'Formula output exceeds the preview budget. Original formula shown.' : 'Coloring output exceeds the preview budget. Original code shown.' }
  }
  return { html }
}
