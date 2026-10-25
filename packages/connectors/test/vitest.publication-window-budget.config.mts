import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import base from './vitest.channel-history.config.mts'

export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/publication-window-budget'), test: { ...base.test,
  include: ['packages/connectors/test/publication-worker-consumer.test.ts'],
  testNamePattern: 'publication wire budget|publication source failure',
  testTimeout: 30_000
} })
