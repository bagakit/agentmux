import base from '../../../apps/desktop/scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'

// Explicit source aliases in the owning config load the same Provider and shared
// consumer being edited. The public CLI still executes its compiled entrypoint.
export default defineConfig({ ...base, cacheDir: '.cache/provider-progress-consumer',
  test: { ...base.test, environment: 'happy-dom', include: ['packages/client-ui/test/provider-progress-consumer.test.tsx'],
    fileParallelism: false, passWithNoTests: false, testTimeout: 30_000 } })
