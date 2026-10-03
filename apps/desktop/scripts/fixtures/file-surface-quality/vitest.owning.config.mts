import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defaultExclude, defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const rules: Record<string, readonly [string, string, string]> = {
  'routing': ['apps/desktop/src/shared/workspace-file-format.ts', "path.endsWith(NOTE_FILE_EXTENSION) ? 'note'", "false ? 'note'"],
  'json-grammar': ['apps/desktop/src/renderer/src/lib/file-json-preview.ts', 'disallowComments: !comments', 'disallowComments: false'],
  'json-precision': ['apps/desktop/src/renderer/src/components/FileDataPreview.tsx', 'content.slice(node.offset, node.offset + node.length)', 'String(node.value)'],
  'tsv-grammar': ['apps/desktop/src/renderer/src/lib/file-delimited-preview.ts', '{ delimiter, preview:', "{ delimiter: ',', preview:"],
  'media-readiness': ['apps/desktop/src/renderer/src/components/FilePreviewPane.tsx', 'const element = player.current', "setState('loading'); const element = player.current"],
  'image-visibility': ['apps/desktop/src/renderer/src/components/WorkspaceImage.tsx', 'useWorkspaceFilePreview(workspaceId, path, visible)', 'useWorkspaceFilePreview(workspaceId, path, true)'],
  'draft-owner': ['apps/desktop/src/renderer/src/components/FileSurfaceView.tsx', 'content={doc.content} kind={dataKind}', 'content="{}" kind={dataKind}'],
  'resource-fence': ['apps/desktop/src/renderer/src/lib/use-workspace-file-preview.ts', 'if (next.config === previous.config) return', 'if (next.config !== previous.config || next.config === previous.config) return']
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...original, root,
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  plugins: [{ name: 'actual-loaded-file-surface-quality', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    if (!path.startsWith(resolve(root, 'apps/desktop/src') + '/')) return
    let code = source
    const mutation = process.env.AGENTMUX_FILE_SURFACE_MUTATION
    if (mutation) {
      assert.ok(mutation in rules)
      const [file, anchor, replacement] = rules[mutation]!
      if (path === resolve(root, file)) {
        assert.equal(source.split(anchor).length - 1, 1, 'Actual loaded source anchor')
        code = source.replace(anchor, replacement)
      }
    }
    if (process.env.AGENTMUX_FILE_SURFACE_LOADED_LOG) appendFileSync(process.env.AGENTMUX_FILE_SURFACE_LOADED_LOG,
      JSON.stringify({ path: relative(root, path), sourceSHA256: hash(source), loadedSHA256: hash(code), mutated: code !== source }) + '\n')
    if (code !== source) return { code, map: null }
  } }],
  test: { ...original.test, exclude: defaultExclude, include: ['apps/desktop/test/file-surface-quality.test.ts', 'apps/desktop/test/file-preview-pane.test.tsx'],
    fileParallelism: false, maxWorkers: 1, testTimeout: 15000, passWithNoTests: false }
})
