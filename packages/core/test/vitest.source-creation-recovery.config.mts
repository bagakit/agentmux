import { defineConfig } from 'vitest/config'
import { sourceAliases } from '../../../apps/desktop/scripts/fixtures/bookmark-local-link/vitest.owning.config.mts'
export default defineConfig({ resolve: { alias: sourceAliases }, test: { environment: 'node', include: ['packages/core/test/spatial-agent-target.test.ts'], passWithNoTests: false, maxWorkers: 1, testTimeout: 30000 } })
