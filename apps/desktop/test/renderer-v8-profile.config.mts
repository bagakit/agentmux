import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import owning from './vitest.performance-reading.config.mts'
import currentSources from './vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const sources = process.env.AGENTMUX_PERFORMANCE_SOURCES ? JSON.parse(readFileSync(process.env.AGENTMUX_PERFORMANCE_SOURCES, 'utf8')) : {}
export default defineConfig({ ...owning, resolve: currentSources.resolve!,
  cacheDir: process.env.RENDERER_PROFILE_CACHE ?? resolve(root, '.cache/renderer-v8-profile'),
  plugins: [...(owning.plugins ?? []), { name: 'profile-test-source-selection', enforce: 'pre', transform(incoming, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/test/')) return
    const selected = sources[path] ?? incoming
    if (process.env.AGENTMUX_PERFORMANCE_LOADED) appendFileSync(process.env.AGENTMUX_PERFORMANCE_LOADED,
      JSON.stringify({ path, sha256: createHash('sha256').update(selected).digest('hex'), selected: path in sources, kind: 'test' }) + '\n')
    if (path in sources) return { code: selected, map: null }
  } }],
  test: { include: ['apps/desktop/test/renderer-v8-profile.test.ts'], environment: 'node',
    globalSetup: [], setupFiles: [], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15000 }
})
