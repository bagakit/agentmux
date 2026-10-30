import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
export default defineConfig({ ...source, cacheDir: '.tmp/focus-topic-presentation-vitest',
  resolve: { ...source.resolve, conditions: ['node', 'import', 'default'] },
  ssr: { ...source.ssr, resolve: { conditions: ['node', 'import', 'default'] } },
  plugins: [...source.plugins ?? [], { name: 'original-topic-preference-process-owner', enforce: 'pre', transform(code, id) {
  if (!process.env.AGENTMUX_TOPIC_SETTINGS_LOADED) return
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (['apps/desktop/src/main/config-store.ts', 'apps/desktop/src/main/config-owner.ts', 'apps/desktop/src/main/settings/modules/focus.ts'].includes(path)) appendFileSync(process.env.AGENTMUX_TOPIC_SETTINGS_LOADED, JSON.stringify({ path, originalSHA256: createHash('sha256').update(code).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
} }], test: { ...source.test,
  include: ['apps/desktop/test/focus-topic-presentation-control.test.ts', 'apps/desktop/test/focus-topic-presentation-settings.test.tsx', 'apps/desktop/test/focus-topic-presentation-restart.test.ts'],
  setupFiles: [], globalSetup: [], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000 } })
