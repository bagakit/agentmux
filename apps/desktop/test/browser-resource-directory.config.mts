import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import original from './performance-capture.config.mts'
import owning from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'

export default defineConfig({ ...original, resolve: owning.resolve!, ssr: owning.ssr!,
  plugins: [...original.plugins ?? [], { name: 'actual-mobile-directory-consumer', enforce: 'pre', transform(source, id) {
    if (process.env.AGENTMUX_PERFORMANCE_LOADED && id.startsWith(resolve(original.root!, 'apps/mobile/src') + '/')) {
      appendFileSync(process.env.AGENTMUX_PERFORMANCE_LOADED, JSON.stringify({ path: id.slice(original.root!.length + 1),
        sha256: createHash('sha256').update(source).digest('hex'), bytes: Buffer.byteLength(source) }) + '\n')
    }
  } }],
  cacheDir: process.env.AGENTMUX_DIRECTORY_CACHE ?? resolve(original.root!, '.cache/browser-resource-directory'),
  test: { ...original.test,
    include: ['apps/desktop/test/browser-resource-directory-ui.fixture.tsx', 'apps/desktop/test/browser-resource-directory-owner.fixture.tsx'],
    globalSetup: [], setupFiles: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false,
    testTimeout: 15000,
  },
})
