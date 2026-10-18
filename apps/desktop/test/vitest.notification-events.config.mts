import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import source from './performance-capture.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const aliases = source.resolve?.alias
export default defineConfig({ ...source,
  resolve: { ...source.resolve, alias: [
    { find: /^@agentmux\/layout$/u, replacement: resolve(root, 'packages/layout/src/index.ts') },
    ...(Array.isArray(aliases) ? aliases : Object.entries(aliases ?? {}).map(([find, replacement]) => ({ find, replacement })))
  ] },
  cacheDir: resolve(import.meta.dirname, '../../../.cache/notification-events'),
  plugins: [...(source.plugins ?? []), { name: 'notification-test-inputs', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!), log = process.env.AGENTMUX_PERFORMANCE_LOADED
    // Vite's explicit ?url module contains a generated URL, not the referenced file's source.
    // Keep both identities and bind the actual asset bytes instead of calling that transform drift.
    if (log && new URLSearchParams(id.split('?')[1] ?? '').has('url') && path.startsWith('packages/')) {
      const asset = readFileSync(resolve(root, path))
      appendFileSync(log, JSON.stringify({ path, sha256: createHash('sha256').update(asset).digest('hex'),
        compilationKind: 'asset-url', compiledSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    }
    if (log && path.startsWith('apps/desktop/test/')) appendFileSync(log,
      JSON.stringify({ path, sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
  } }],
  test: { ...source.test, include: ['apps/desktop/test/notification-events.test.tsx', 'apps/desktop/test/attention-notifier.test.ts', 'apps/desktop/test/notification-settings-control.test.ts'] }
})
