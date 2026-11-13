import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'
import sources from './vitest.file-sources.config.mts'
const variants = {
  dirty: ['apps/desktop/src/renderer/src/lib/file-region-presentation.ts', "if (dirty && format.media?.kind === 'book') return 'edit'", "if (false) return 'edit'"],
  attach: ['apps/desktop/src/renderer/src/store.ts', 'await loadPersistedFileDocument(workspaceId, path)\n    }\n    // Only entering diff', 'void 0\n    }\n    // Only entering diff'],
  route: ['apps/desktop/src/renderer/src/components/FileSurfaceView.tsx', 'if (savedBook && previewing)', 'if (savedBook && previewing && Boolean(doc))'],
  recovery: ['apps/desktop/src/renderer/src/components/EditorPane.tsx', '{...(previewReadsSavedFile && onTogglePreview ? { onPreview: onTogglePreview } : {})}', '{...{}}']
} as const
export default defineConfig({ ...sources, plugins: [{ name: 'fb2-source-loaded-mutations', enforce: 'pre', transform(source, id) {
  const name = process.env.FB2_SOURCE_MUTATION as keyof typeof variants | undefined
  if (!name) return
  assert.ok(variants[name]); const [file, before, after] = variants[name]
  if (relative(process.cwd(), id.split('?')[0]!) !== file) return
  assert.equal(source.split(before).length - 1, 1, 'One actual source mutation anchor')
  const code = source.replace(before, after), sha = (s: string) => createHash('sha256').update(s).digest('hex')
  if (process.env.FB2_SOURCE_HITS) appendFileSync(process.env.FB2_SOURCE_HITS, JSON.stringify({ name, file, original: sha(source), loaded: sha(code) }) + '\n')
  return { code, map: null }
} }], test: { ...sources.test, include: ['apps/desktop/test/fb2-source.test.tsx', 'apps/desktop/test/workspace-file-format.test.ts', 'apps/desktop/test/file-format-integration.test.tsx'] } })
