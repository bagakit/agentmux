import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/test/runtime-notification-provenance.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const changes: Record<string, string> = process.env.AGENTMUX_SESSION_OBSERVATION_SOURCES
  ? JSON.parse(readFileSync(process.env.AGENTMUX_SESSION_OBSERVATION_SOURCES, 'utf8')) : {}
const loaded = process.env.AGENTMUX_SESSION_OBSERVATION_LOADED
export default defineConfig({ ...source,
  resolve: { ...source.resolve, conditions: ['node', 'import', 'default'] },
  ssr: { ...source.ssr, resolve: { conditions: ['node', 'import', 'default'] } },
  cacheDir: resolve(root, '.tmp/session-observation-retry-cache'),
  plugins: [{ name: 'actual-session-observation-source', enforce: 'pre', transform(original, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (/\/packages\/core\/dist\//u.test(file)) throw new Error(`Compiled Core cannot prove this source: ${file}`)
    if (!/\.[cm]?tsx?$/.test(file) || id.includes('?') || path.startsWith('..') ||
        !(path.startsWith('apps/') || path.startsWith('packages/')) || path.includes('node_modules/')) return
    const code = changes[path] ?? original
    if (loaded) appendFileSync(loaded, JSON.stringify({ path,
      originalSha256: createHash('sha256').update(original).digest('hex'), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return path in changes ? { code, map: null } : undefined
  } }],
  test: { ...source.test, include: ['packages/core/test/session-observation-retry.integration.test.ts', 'packages/core/test/runtime-observation-admission.test.ts'],
    testNamePattern: process.env.AGENTMUX_SESSION_OBSERVATION_TEST_PATTERN ??
      'exact Session observation retry:|automatically recovers a later transport loss|late old Run snapshot|late old handshake failure',
    testTimeout: 70000, hookTimeout: 15000 } })
