import { defineConfig } from 'vitest/config'
import original from './performance-capture.config.mts'
import owning from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
const cacheDir = process.env.AGENTMUX_BROWSER_MEMORY_CACHE
if (!cacheDir) throw new Error('AGENTMUX_BROWSER_MEMORY_CACHE is required for this private fixture')
export default defineConfig({ ...original, resolve: owning.resolve!, ssr: owning.ssr!,
  cacheDir,
  test: { ...original.test, include: ['apps/desktop/test/browser-memory-preferences-owner.fixture.ts', 'apps/desktop/test/browser-memory-preferences-ui.fixture.tsx'],
    globalSetup: [], setupFiles: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 15000 } })
