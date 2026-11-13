import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { relative } from 'node:path'
import original from '../../../vitest.config'
const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/main/workspace-file-sources.ts'
const hook = 'apps/desktop/src/renderer/src/lib/use-workspace-file-source.ts'
const pdf = 'packages/editor-extensions/src/pdf/PdfReader.tsx'
const mutations = {
  offset: [owner, 'offset + read)', 'read)'],
  caller: [owner, "if (source.caller !== caller) return failure('unavailable', 'WORKSPACE_FILE_SOURCE_NOT_OWNED'", "if (false) return failure('unavailable', 'WORKSPACE_FILE_SOURCE_NOT_OWNED'"],
  borrowed: [owner, 'await Promise.all(source.pending); await source.file.handle.close()', 'await source.file.handle.close()'],
  cancel: [owner, 'source.reads.get(readId)?.abort()', 'void source.reads.get(readId)'],
  stale: [hook, 'if (!current()) { void api.files.releaseSource(id).catch(() => {}); return }', 'if (false) { void api.files.releaseSource(id).catch(() => {}); return }'],
  prefetch: [pdf, 'disableAutoFetch: true, disableStream: true', 'disableAutoFetch: false, disableStream: true'],
  range: [pdf, 'source.read(begin, end - begin, lifetime.signal)', 'source.read(0, end - begin, lifetime.signal)'],
  prepare: ['apps/desktop/src/renderer/src/lib/use-prepare-pdf-reader.ts', 'if (!enabled) return', 'if (true) return'],
  'prepare-hidden': ['apps/desktop/src/renderer/src/lib/use-prepare-pdf-reader.ts', 'if (!enabled) return', 'if (false) return'],
  'prepare-order': [pdf, "return import('pdfjs-dist').then(async engine => {\n    if (signal?.aborted) return null\n    const components = await import('pdfjs-dist/web/pdf_viewer.mjs')", "return Promise.all([import('pdfjs-dist'), import('pdfjs-dist/web/pdf_viewer.mjs')]).then(([engine, components]) => {"]
} as const
// This lane tests the checked-out owners, including their real workspace leaves, rather than old dist copies.
function workspaceSources() {
  const aliases: Array<{ find: RegExp; replacement: string }> = []
  for (const directory of ['packages/core', 'packages/client-ui', 'packages/editor-extensions', 'packages/identity', 'packages/relay', 'packages/layout', 'packages/demand', 'packages/capsule', 'packages/git', 'packages/diagnostic-evidence', 'apps/host']) {
    const manifest = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8'))
    for (const [key, raw] of Object.entries(manifest.exports ?? {})) {
      if (key.includes('*')) continue
      const value = typeof raw === 'string' ? raw : (raw as any).import ?? (raw as any).default
      if (typeof value !== 'string') continue
      const target = value.replace(/^\.\/dist\/(?:src\/)?/, './src/')
      const candidates = [target, target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx')]
      const found = candidates.map(path => resolve(root, directory, path)).find(existsSync)
      if (!found) continue
      const specifier = manifest.name + (key === '.' ? '' : key.slice(1))
      aliases.push({ find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: found })
    }
  }
  return aliases
}
export default defineConfig({ ...original,
  resolve: { alias: workspaceSources() },
  server: { fs: { allow: [root, resolve(root, '../../node_modules')] } },
  plugins: [{ name: 'original-file-source-mutations', enforce: 'pre', transform(source, id) {
    const mutation = process.env.FILE_SOURCES_MUTATION as keyof typeof mutations | undefined
    if (!mutation) return
    assert.ok(mutations[mutation], 'Known file source mutation')
    const [file, before, after] = mutations[mutation]
    if (relative(root, id) !== file) return
    assert.equal(source.split(before).length - 1, 1, 'One exact loaded source anchor')
    const code = source.replace(before, after), sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.FILE_SOURCES_HITS) appendFileSync(process.env.FILE_SOURCES_HITS, JSON.stringify({ mutation, file, original: sha(source), loaded: sha(code) }) + '\n')
    return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], passWithNoTests: false, include: ['apps/desktop/test/workspace-file-sources.test.ts', 'apps/desktop/test/workspace-file-source-hook.test.tsx', 'apps/desktop/test/pdf-content.test.tsx', 'apps/desktop/test/pdf-preparation.test.tsx'] }
})
