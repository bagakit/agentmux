import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import original from './vitest.mote-context.config.mts'
import { instrumentAdapter } from './mote-rollover-recovery-adapter-mutations.mjs'
export default defineConfig({ ...original, plugins: [{ name: 'mote-recovery-adapter-source', enforce: 'pre', transform(source, id) {
  if (id.includes('?')) return
  const loaded = instrumentAdapter(source, relative(original.root!, id))
  return loaded === source ? undefined : { code: loaded, map: null }
} }, ...original.plugins ?? []], test: { ...original.test, include: ['apps/desktop/test/mote-rollover-recovery-adapter.test.ts'],
  testNamePattern: process.env.MOTE_ADAPTER_TEST_PATTERN, passWithNoTests: false, testTimeout: 15000, maxWorkers: 1 } })
