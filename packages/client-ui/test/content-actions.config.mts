import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.CONTENT_ACTION_MUTATION
const changes = {
  remove: ['packages/client-ui/src/components/InlineComposer.tsx', '.deleteRange({ from: position, to: position + node.nodeSize })', '.deleteRange({ from: position, to: position })'],
  duplicate: ['packages/client-ui/src/components/InlineComposer.tsx', 'const position = getPos()', 'const position = 8'],
  lifetime: ['packages/client-ui/src/components/InlineComposer.tsx', '!alive.current || ', ''],
  editable: ['packages/client-ui/src/components/InlineComposer.tsx', '!current.current.editable || !editor.isEditable || ', ''],
} as const
export default defineConfig({ root, plugins: [{ name: 'actual-content-action-mutation', enforce: 'pre', transform(source, id) {
  if (!mutation) return
  assert.ok(mutation in changes, 'Unknown mutation')
  const [path, needle, replacement] = changes[mutation as keyof typeof changes]
  if (relative(root, id) !== path) return
  assert.equal(source.split(needle).length - 1, 1, 'Actual mutation target must be unique')
  if (process.env.CONTENT_ACTION_MUTATION_HITS) appendFileSync(process.env.CONTENT_ACTION_MUTATION_HITS, path + '\n')
  return { code: source.replace(needle, replacement), map: null }
} }], test: { include: ['packages/client-ui/test/composer-image-remove.test.tsx', 'packages/client-ui/test/conversation-image-gallery.test.tsx',
  'packages/client-ui/test/conversation-detail-copy.test.tsx', 'packages/client-ui/test/markdown-code-copy.test.tsx'],
  environment: 'happy-dom', passWithNoTests: false, maxWorkers: 1 } })
