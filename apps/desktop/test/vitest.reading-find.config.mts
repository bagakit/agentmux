import { defineConfig } from 'vitest/config'
import original from './vitest.launch-choice-details.config.mts'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const component = 'packages/client-ui/src/components/ReadingFind.tsx'
const helper = 'packages/client-ui/src/lib/reading-find.ts'
const changes = {
  hidden: [helper, "(element.tagName === 'DETAILS' && !element.hasAttribute('open'))", 'false'],
  literal: [helper, "query.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')", 'query'],
  retain: [component, 'const index = retained >= 0 ? retained : 0', 'const index = 0'],
  lease: [component, 'active && latest.current === owner && content.current?.isConnected', 'active && content.current?.isConnected'],
  follow: [component, 'onOpen?.()', ''],
  removal: [component, ' || [...record.removedNodes].some(affected)', ''],
  refocus: [component, 'onOpen?.()\n    if (open) input.current?.focus({ preventScroll: true })', 'onOpen?.()'],
  file: ['apps/desktop/src/renderer/src/components/file-preview/SourceFilePreview.tsx', 'bodySelector=".file-markdown-preview"', 'bodySelector=".missing-reading-body"'],
  activity: ['apps/desktop/src/renderer/src/components/ActivityView.tsx', 'bodySelector=".log-turn__body, .log-row__prose, .log-row__payload, .log-row__output, .log-diff__body"', 'bodySelector=".missing-reading-body"']
} as const
export default defineConfig({ ...original, plugins: [{ name: 'original-reading-find-mutations', enforce: 'pre', transform(source, id) {
  const mutation = process.env.READING_FIND_MUTATION as keyof typeof changes | undefined
  if (!mutation) return
  assert.ok(changes[mutation], 'Known original reading mutation')
  const [path, needle, replacement] = changes[mutation]
  if (relative(root, id) !== path) return
  assert.equal(source.split(needle).length - 1, 1, 'Exact unique original-source mutation')
  if (process.env.READING_FIND_HITS) appendFileSync(process.env.READING_FIND_HITS, path + '\n')
  return { code: source.replace(needle, replacement), map: null }
} }], test: { ...original.test, include: ['apps/desktop/test/reading-find.test.tsx'], passWithNoTests: false } })
