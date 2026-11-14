import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import source from './mote-presence.config.mts'
import { instrumentHeartbeatSource } from './mote-heartbeat-source-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'actual-heartbeat-source', enforce: 'pre', transform(code, id) {
  const file = relative(root, id.split('?')[0]!), loaded = instrumentHeartbeatSource(code, file)
  if (process.env.MOTE_SOURCE_TRACE && file.startsWith('apps/host/src/')) appendFileSync(process.env.MOTE_SOURCE_TRACE, JSON.stringify({ file, original: createHash('sha256').update(code).digest('hex'), loaded: createHash('sha256').update(loaded).digest('hex') }) + '\n')
  return loaded === code ? undefined : { code: loaded, map: null }
} }], test: { ...source.test, include: ['apps/host/test/mote-heartbeat-source.test.ts'], passWithNoTests: false, testTimeout: 30000 } })
