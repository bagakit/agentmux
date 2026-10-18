import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './performance-capture.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const changes: Record<string, string> = process.env.AGENTMUX_NOTIFICATION_DIAGNOSTICS_SOURCES
  ? JSON.parse(readFileSync(process.env.AGENTMUX_NOTIFICATION_DIAGNOSTICS_SOURCES, 'utf8')) : {}
export default defineConfig({ ...source, cacheDir: resolve(root, '.tmp/notification-diagnostics-vitest-cache'),
  plugins: [{ name: 'actual-notification-diagnostic-source', enforce: 'pre', transform(original, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!/\.[cm]?tsx?$/.test(file) || id.includes('?') || path.startsWith('..') || !(path.startsWith('apps/') || path.startsWith('packages/')) || path.includes('node_modules/')) return
    const code = changes[path] ?? original, loaded = process.env.AGENTMUX_NOTIFICATION_DIAGNOSTICS_LOADED
    if (loaded) appendFileSync(loaded, JSON.stringify({ consumer: 'actual-vite-module', path,
      originalSha256: createHash('sha256').update(original).digest('hex'), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return path in changes ? { code, map: null } : undefined
  } }],
  test: { ...source.test, include: ['apps/desktop/test/notification-diagnostics.test.tsx'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 60000, hookTimeout: 60000 }
})
