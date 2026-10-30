import { defineConfig } from 'vitest/config'
import source from '../../desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { relative, resolve } from 'node:path'
import { instrumentPresence } from './mote-presence-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'loaded-mote-presence', enforce: 'pre', transform(code, id) { const loaded = instrumentPresence(code, relative(root, id.split('?')[0]!), 'vitest'); return loaded === code ? undefined : { code: loaded, map: null } } }], test: { ...source.test, include: ['apps/host/test/mote-presence.test.ts','packages/core/test/continuous-progress.test.ts'], fileParallelism: false, maxWorkers: 1, testTimeout: 180000, hookTimeout: 30000 } })
