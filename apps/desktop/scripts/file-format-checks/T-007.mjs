export const owningConfig = 'packages/client-ui/vitest.config.ts'
export const tests = ['packages/client-ui/test/markdown-rich-blocks.test.tsx', 'packages/client-ui/test/markdown-render-worker.test.tsx', 'packages/client-ui/test/markdown-render-queue.test.tsx', 'packages/client-ui/test/markdown-semantics.test.tsx', 'packages/client-ui/test/markdown-outline.test.tsx']
export const sources = [
  'packages/client-ui/src/lib/agent-markdown.ts', 'packages/client-ui/src/components/AgentMarkdown.tsx',
  'packages/client-ui/src/components/MarkdownCodeBlock.tsx', 'packages/client-ui/src/components/MarkdownMath.tsx',
  'packages/client-ui/src/lib/markdown-code-highlight.ts', 'packages/client-ui/src/lib/use-visible-work.ts',
  'packages/client-ui/src/platform.tsx', 'packages/client-ui/src/assets.d.ts', 'packages/client-ui/src/styles/markdown.css',
  'packages/client-ui/src/lib/markdown-render.ts', 'packages/client-ui/src/lib/markdown-render-job.ts', 'packages/client-ui/src/lib/markdown-render.worker.ts'
]
export const mutations = [
  { label: 'math-grammar-disconnected', file: sources[0], before: '.use(remarkMath)', after: '' },
  { label: 'markdown-host-starts-hidden', file: sources[2], before: 'inView && diagram && renderDiagram', after: 'diagram && renderDiagram' },
  { label: 'code-grammar-disconnected', file: sources[4], before: 'return highlighter.highlight(code, { language, ignoreIllegals: true }).value', after: 'return code' },
  { label: 'markdown-worker-not-terminated', file: 'packages/client-ui/src/lib/markdown-render-job.ts', before: 'slot.worker.terminate()', after: 'void slot.worker' },
  { label: 'markdown-worker-concurrency-unbounded', file: 'packages/client-ui/src/lib/markdown-render-job.ts', before: 'const CONCURRENCY = 2', after: 'const CONCURRENCY = 128' },
  { label: 'markdown-aborted-queue-remains', file: 'packages/client-ui/src/lib/markdown-render-job.ts', before: 'if (index >= 0) queue.splice(index, 1)', after: 'void index' },
  { label: 'markdown-old-owner-reappears', file: sources[2], before: 'inView && result?.owner === owner ? result.value : null', after: 'inView && result ? result.value : null' },
  { label: 'markdown-output-budget-removed', file: 'packages/client-ui/src/lib/markdown-render.ts', before: 'if (html.length > MARKDOWN_HTML_LIMIT || new TextEncoder().encode(html).byteLength > MARKDOWN_HTML_LIMIT || (html.match(/<[a-zA-Z][^>]*>/g)?.length ?? 0) > MARKDOWN_ELEMENT_LIMIT) {', after: 'if (false) {' }
]
