import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const rootUrl = new URL('../../../../../', import.meta.url)
const root = fileURLToPath(rootUrl)
const inputs = new Map<string, { path: string; loadedPath: string; sha256: string; bytes: number }>()
export default {
  root,
  plugins: [{ name: 'text-edit-owning-actual-source', enforce: 'pre' as const,
    load(id: string) {
      const path = id.split('?')[0]!
      const own = ['apps/desktop/src/main/text-edit-context-menu.ts', 'apps/desktop/src/main/browser-view-manager.ts'].find(relative => path === join(root, relative))
      if (!own) return null
      const loadedPath = process.env.AGENTMUX_TEXT_EDIT_MUTATION_ROOT ? join(process.env.AGENTMUX_TEXT_EDIT_MUTATION_ROOT, own) : path
      const code = readFileSync(loadedPath, 'utf8')
      inputs.set(own, { path: own, loadedPath, sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code) })
      if (process.env.AGENTMUX_TEXT_EDIT_SOURCE_REPORT) writeFileSync(process.env.AGENTMUX_TEXT_EDIT_SOURCE_REPORT, JSON.stringify([...inputs.values()], null, 2))
      return code
    }
  }],
  resolve: { alias: [{ find: /^@agentmux\/core$/, replacement: fileURLToPath(new URL('packages/core/src/index.ts', rootUrl)) }] },
  test: { include: ['apps/desktop/test/text-edit-context-menu.test.ts'], maxWorkers: 1, cache: false,
    setupFiles: [fileURLToPath(new URL('vitest.setup.ts', rootUrl))] }
}
