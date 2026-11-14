import { defineConfig } from 'vitest/config'
import original from '../../../packages/core/test/a2a-resumed-inbox.config.mts'
import { relative } from 'node:path'
import { instrumentPolicy } from './fixtures/mote-continuity-rollover-mutations.mjs'
export default defineConfig({ ...original, plugins: [{ name: 'mote-continuity-rollover-source', enforce: 'pre', transform(source, id) {
  const loaded = instrumentPolicy(source, relative(original.root!, id.split('?')[0]!))
  return loaded === source ? undefined : { code: loaded, map: null }
} }, ...(original.plugins ?? [])], test: { ...original.test, include: process.env.MOTE_POLICY_REGRESSION ? ['apps/host/test/mote-executor-rollover.test.ts', 'apps/host/test/mote-conversation-start.test.ts'] : ['apps/host/test/mote-continuity-rollover.test.ts'], setupFiles: process.env.MOTE_POLICY_REGRESSION ? ['apps/host/test/fixtures/mote-continuity-rollover-runtime.ts'] : [], testNamePattern: process.env.MOTE_POLICY_TEST_PATTERN, passWithNoTests: false, testTimeout: 45000 } })
