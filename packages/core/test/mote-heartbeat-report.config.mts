import { defineConfig } from 'vitest/config'
import original from './a2a-resumed-inbox.config.mts'
import { relative } from 'node:path'
import { instrumentHeartbeatReport } from './fixtures/mote-heartbeat-report-mutations.mjs'
export default defineConfig({ ...original, plugins: [{ name: 'mote-heartbeat-report-source', enforce: 'pre', transform(source, id) {
  const file = relative(original.root!, id.split('?')[0]!), loaded = instrumentHeartbeatReport(source, file)
  return loaded === source ? undefined : { code: loaded, map: null }
} }, ...original.plugins!], test: { ...original.test, include: ['packages/core/test/mote-heartbeat-report.test.ts'], testTimeout: 60000, passWithNoTests: false } })
