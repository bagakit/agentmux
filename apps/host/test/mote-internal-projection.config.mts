import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import original from '../../../packages/core/test/a2a-resumed-inbox.config.mts'
import { instrumentProjection } from './fixtures/mote-internal-projection-mutations.mjs'
export default defineConfig({ ...original, plugins: [{ name: 'mote-internal-projection-source', enforce: 'pre', transform(source, id) {
  const loaded = instrumentProjection(source, relative(original.root!, id.split('?')[0]!))
  return loaded === source ? undefined : { code: loaded, map: null }
} }, ...(original.plugins ?? [])], test: { ...original.test, include: ['apps/host/test/mote-internal-projection.test.ts'],
  setupFiles: ['apps/host/test/fixtures/mote-continuity-rollover-runtime.ts'], testNamePattern: process.env.MOTE_PROJECTION_TEST_PATTERN,
  passWithNoTests: false, testTimeout: 30000, maxWorkers: 1 } })
