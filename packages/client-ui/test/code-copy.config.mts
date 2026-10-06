import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.CODE_COPY_MUTATION
const changes = {
  bytes: ['packages/client-ui/src/components/MarkdownCodeBlock.tsx', 'await copyText(code,', 'await copyText(code.trim(),'],
  receipt: ['packages/client-ui/src/components/MarkdownCodeBlock.tsx', "accepted && !failed ? 'copied' : 'failed'", "'copied'"],
  source: ['packages/client-ui/src/components/MarkdownCodeBlock.tsx', '[code, language, copyText, readOnly]', '[copyText, readOnly]'],
  action: ['packages/client-ui/src/components/MarkdownCodeBlock.tsx', 'copyAction.current === action', 'true'],
  pending: ['packages/client-ui/src/components/MarkdownCodeBlock.tsx', '(copyAction.current?.owner === copyOwner && copyAction.current.pending)', 'false'],
  readonly: ['packages/client-ui/src/components/AgentMarkdown.tsx', 'readOnly={context.readOnly} />', 'readOnly={false} />'],
} as const
export default defineConfig({ root, plugins: [{ name: 'actual-code-copy-mutation', enforce: 'pre', transform(source, id) {
  if (!mutation) return
  assert.ok(mutation in changes, 'Unknown mutation')
  const [path, needle, replacement] = changes[mutation as keyof typeof changes]
  if (relative(root, id) !== path) return
  assert.equal(source.split(needle).length - 1, 1, 'Actual mutation target must be unique')
  if (process.env.CODE_COPY_MUTATION_HITS) appendFileSync(process.env.CODE_COPY_MUTATION_HITS, path + '\n')
  return { code: source.replace(needle, replacement), map: null }
} }], test: { include: ['packages/client-ui/test/markdown-code-copy.test.tsx', 'packages/client-ui/test/markdown-rich-blocks.test.tsx',
  'packages/client-ui/test/markdown-semantics.test.tsx', 'packages/client-ui/test/markdown-render-worker.test.tsx'],
  environment: 'happy-dom', passWithNoTests: false, maxWorkers: 1 } })
