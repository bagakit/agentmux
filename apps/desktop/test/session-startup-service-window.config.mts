import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  ...source, root, cacheDir: resolve(root, '.tmp/session-startup-service-window/vite-cache'),
  plugins: [...(source.plugins ?? []), { name: 'startup-actual-source-receipt', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (process.env.AGENTMUX_STARTUP_LOADED && /^(apps\/desktop\/src|packages\/(core|client-ui)\/src)\//.test(path)) {
      appendFileSync(process.env.AGENTMUX_STARTUP_LOADED, JSON.stringify({ root, path, sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    }
  } }],
  test: { ...source.test, include: [
    'apps/desktop/test/session-startup-service-window.test.tsx',
    'apps/desktop/test/session-frontend-recovery.test.ts',
    'apps/desktop/test/session-recovery-exit-surface.test.tsx',
    'apps/desktop/test/session-recovery-actions.test.tsx',
    'apps/desktop/test/full-page-loading-surface.test.tsx'
  ], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
