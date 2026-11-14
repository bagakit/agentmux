import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
export default defineConfig({ root, esbuild: { jsx: 'automatic' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [{
    name: 'editor-preview-archive', enforce: 'pre', resolveId(source) {
      const archive = process.env.EDITOR_EXTENSION_ARCHIVE
      if (archive && source === '@agentmux/editor-extensions/ui/NotebookFilePreview')
        return resolve(archive, 'src/ui/NotebookFilePreview.tsx')
    }
  }, { name: 'extension-catalog-consumer-mutation', enforce: 'pre', transform(source, id) {
    if (process.env.EDITOR_EXTENSION_MUTATION !== 'catalog-disconnected' || id !== resolve(import.meta.dirname, 'src/catalog.ts')) return
    const needle = "extensions: ['mmd', 'mermaid']"
    assert.equal(source.split(needle).length - 1, 1, 'One real catalog anchor')
    if (process.env.EDITOR_EXTENSION_HITS) appendFileSync(process.env.EDITOR_EXTENSION_HITS, id + '\n')
    return { code: source.replace(needle, "extensions: ['missing-diagram-format']"), map: null }
  } }],
  test: { passWithNoTests: false, setupFiles: [resolve(root, 'vitest.setup.ts')], include: [
    'packages/editor-extensions/test/catalog-consumer.test.ts',
    'apps/desktop/test/file-format-engine.test.ts', 'apps/desktop/test/file-format-integration.test.tsx', 'apps/desktop/test/data-structured-preview.test.ts',
    'apps/desktop/test/data-notebook-preview.test.ts', 'apps/desktop/test/dot-engine.test.ts',
    'apps/desktop/test/language-detect.test.ts', 'apps/desktop/test/file-delimited-dialects.test.tsx'
  ] }
})
