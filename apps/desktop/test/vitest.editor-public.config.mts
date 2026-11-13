import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'catalog-disconnected': ['packages/editor-extensions/src/catalog.ts', 'export function workspaceFilePreviewFormat(path: string): WorkspaceFilePreviewFormat | null {\n  const extension = workspaceFileExtension(path)', "export function workspaceFilePreviewFormat(path: string): WorkspaceFilePreviewFormat | null {\n  const extension = workspaceFileExtension(path); if (extension === 'epub') return null"],
  'readonly-file-only': ['apps/desktop/src/renderer/src/store.ts', "if (format && (!format.sourceEditable || format.kind === 'book' && !explicitBookSource) || get().documentIssues[key]?.kind === 'binary')", "if (!placement?.fileOnly && format && (!format.sourceEditable || format.kind === 'book' && !explicitBookSource) || get().documentIssues[key]?.kind === 'binary')"],
  'view-modes': ['apps/desktop/src/renderer/src/lib/workface-file-view.ts', "currentReadonly ? ['preview']", "currentReadonly ? ['source', 'diff', 'preview']"],
  'editable-book-modes': ['apps/desktop/src/renderer/src/lib/workface-file-view.ts', "currentBook ? ['source', 'diff', 'preview']", "false ? ['source', 'diff', 'preview']"],
  'book-default-open': ['apps/desktop/src/renderer/src/lib/workface-file-open.ts', "fileOpenIntent === 'source' && workspaceFilePreviewFormat(mapped.path)?.kind !== 'book'", "fileOpenIntent === 'source'"],
  'fb2-dirty-default': ['apps/desktop/src/renderer/src/lib/workface-file-view.ts', 'currentBinary, dirtyDocument)', 'currentBinary, false)'],
  'dirty-without-buffer': ['apps/desktop/src/renderer/src/lib/workface-file-view.ts', 'Boolean(current.documents[key] && current.dirtyDocuments[key])', 'Boolean(current.dirtyDocuments[key])'],
  'false-decoder-ready': ['apps/desktop/src/renderer/src/lib/workface-file-view.ts', "{ status: 'unconfirmed', reason: 'Preview bytes and decoding belong to the original visible File pane.' }", "{ status: 'available', reason: null }"],
} as const
export default defineConfig({ ...original, plugins: [{ name: 'actual-editor-public-consumer-mutations', enforce: 'pre', transform(source, id) {
  const name = process.env.EDITOR_PUBLIC_MUTATION as keyof typeof variants | undefined
  if (!name) return
  assert.ok(variants[name], 'One named real public consumer mutation')
  const [file, before, after] = variants[name]
  if (relative(root, id.split('?')[0]!) !== file) return
  assert.equal(source.split(before).length - 1, 1, 'One current checked-out source anchor')
  if (process.env.EDITOR_PUBLIC_HITS) appendFileSync(process.env.EDITOR_PUBLIC_HITS,
    JSON.stringify({ name, file, anchors: 1, sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
  return { code: source.replace(before, after), map: null }
} }],
  // Core public protocol source is unchanged and its current dist is also used by the compiled CLI.
  // The verifier binds both source and executable dist hashes; no unrelated Core rebuild is run here.
  test: { ...original.test, globalSetup: [], passWithNoTests: false, include: ['apps/desktop/test/editor-extension-public-consumer.test.tsx'], testTimeout: 15000 }
})
