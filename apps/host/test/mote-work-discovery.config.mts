import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import source from '../../desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { instrumentWorkDiscovery } from './mote-work-discovery-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [{ name: 'exact-work-discovery-source', enforce: 'pre', load(id) {
  const file = relative(root, id.split('?')[0]!)
  if (!file.startsWith('packages/core/src/') && !file.startsWith('apps/host/src/')) return
  const raw = readFileSync(file === 'packages/core/src/public-rpc-service.ts' && process.env.MOTE_WORK_SERVICE_SOURCE || id.split('?')[0]!, 'utf8')
  const loaded = instrumentWorkDiscovery(raw, file)
  if (process.env.MOTE_WORK_TRACE) appendFileSync(process.env.MOTE_WORK_TRACE, JSON.stringify({ file,
    original: createHash('sha256').update(raw).digest('hex'), loaded: createHash('sha256').update(loaded).digest('hex') }) + '\n')
  return loaded
} }], test: { ...source.test, include: ['apps/host/test/mote-work-discovery.test.ts'],
  setupFiles: [...(source.test?.setupFiles ?? []), root + '/apps/host/test/fixtures/mote-continuity-rollover-runtime.ts'],
  pool: 'threads', fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 30000, hookTimeout: 30000 } })
