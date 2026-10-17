import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const mutations: Record<string, [string, string, string]> = {
  'provider-diagnostic': ['packages/core/src/providers/codex-managed-run.ts', '...diagnostic()', '...{}'],
  'provider-generation': ['packages/core/src/providers/codex-managed-run.ts', "frontend.frontendId === frontendId && frontend.state === 'detached'", 'true'],
  'surface-diagnostic': ['apps/desktop/src/renderer/src/lib/session-recovery-banner.ts', 'frontend.message?.trim() ||', 'undefined ||']
}
export default defineConfig({ ...original, root,
  cacheDir: resolve(root, '.tmp/frontend-startup-repair/surface-vite-cache'),
  resolve: { alias: Object.entries(exports).map(([key, value]) => ({
    find: new RegExp(`^${key === '.' ? '@agentmux/core' : `@agentmux/core${key.slice(1)}`}$`),
    replacement: resolve(root, 'packages/core', (value as { import: string }).import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  })) },
  plugins: [{ name: 'frontend-repair-source-evidence', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(apps\/desktop\/src|packages\/core\/src)\/.+\.[jt]sx?$/.test(path)) return
    const before = code, mutation = process.env.AGENTMUX_FRONTEND_SURFACE_MUTATION
    if (mutation && !mutations[mutation]) throw new Error('Unknown frontend mutation')
    if (mutation && mutations[mutation]![0] === path) {
      const [, anchor, replacement] = mutations[mutation]!
      const expected = mutation === 'provider-diagnostic' ? 2 : 1
      if (code.split(anchor).length !== expected + 1) throw new Error('Frontend mutation anchor drifted: ' + mutation)
      code = code.split(anchor).join(replacement)
    }
    if (process.env.AGENTMUX_FRONTEND_SURFACE_LOADED) appendFileSync(process.env.AGENTMUX_FRONTEND_SURFACE_LOADED,
      JSON.stringify({ path, mutation: before !== code ? mutation : null,
        sourceSha256: createHash('sha256').update(before).digest('hex'), loadedSha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    if (before !== code) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], fileParallelism: false, passWithNoTests: false,
    include: ['apps/desktop/test/session-frontend-failure-surface.test.tsx', 'apps/desktop/test/session-continuity-supervision.test.tsx',
      'packages/core/test/codex-managed-run-diagnostics.test.ts'] }
})
