import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import original from './vitest.reading-find.config.mts'

// The real Markdown File Preview owner with its Desktop ports: remote README images and the reading layout.
// MARKDOWN_FILE_PREVIEW_MUTATION=<name> rewrites one exact source anchor; each must turn a behavior test red.
const root = resolve(import.meta.dirname, '../../..')
const preview = 'apps/desktop/src/renderer/src/components/file-preview/SourceFilePreview.tsx'
const layout = 'apps/desktop/src/renderer/src/lib/markdown-reading-layout.ts'
const changes = {
  'remote-port-undefined': [preview, "return url?.startsWith('https:') ? <MarkdownRemoteImage href={url} alt={alt} /> : undefined", 'return undefined'],
  'layout-not-passed': [preview, '{...(readingLayout ? { readingLayout } : {})}', ''],
  'expected-not-current': [layout, '...applyMarkdownReadingChange(config.markdown, change) } }, config)', '...applyMarkdownReadingChange(config.markdown, change) } }, { ...config, markdown: applyMarkdownReadingChange(config.markdown, change) })'],
  'save-from-render-value': [layout, 'applyMarkdownReadingChange(config.markdown, change)', 'applyMarkdownReadingChange(saved, change)'],
  'receipt-not-applied': [layout, 'if (useAppStore.getState().config === config) useAppStore.getState().setConfig(saved)', ''],
  'failure-silenced': [layout, '.catch(error => { useAppStore.getState().reportError(error instanceof Error ? error.message : String(error)) })', '.catch(() => {})'],
} as const
export default defineConfig({ ...original, plugins: [{ name: 'markdown-file-preview-mutations', enforce: 'pre', transform(source, id) {
  const mutation = process.env.MARKDOWN_FILE_PREVIEW_MUTATION as keyof typeof changes | undefined
  if (!mutation) return
  assert.ok(changes[mutation], 'Known Markdown file preview mutation')
  const [path, needle, replacement] = changes[mutation]
  if (relative(root, id) !== path) return
  assert.equal(source.split(needle).length - 1, 1, 'Exact unique source mutation')
  if (process.env.MARKDOWN_FILE_PREVIEW_HITS) appendFileSync(process.env.MARKDOWN_FILE_PREVIEW_HITS, mutation + '\n')
  return { code: source.replace(needle, replacement), map: null }
} }], test: { ...original.test, include: ['apps/desktop/test/markdown-file-preview.test.tsx'], passWithNoTests: false } })
