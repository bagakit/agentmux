import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import isolation from './vitest.publication-isolation.config.mts'

export default defineConfig({ ...isolation, cacheDir: resolve(import.meta.dirname, '../../../.cache/recoverable-gap-index'),
  test: { ...isolation.test, include: [
    'packages/connectors/test/publication-worker-consumer.test.ts', 'packages/connectors/test/a2a-publication-consumer.test.ts',
    'packages/connectors/test/recorded-image-publication-consumer.test.ts', 'packages/connectors/test/recorded-file-publication-consumer.test.ts'
  ], testNamePattern: /^(recoverable gap scan |retains a recoverable original-read gap,|disabling original resource observation |an unknown file predecessor cannot be bypassed)/u,
  fileParallelism: false, passWithNoTests: false }
})
