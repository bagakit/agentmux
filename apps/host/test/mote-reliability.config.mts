import { defineConfig } from 'vitest/config'
import source from './mote-presence.config.mts'
import { relative, resolve } from 'node:path'
import { instrumentReliability } from './mote-reliability-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'loaded-mote-reliability', enforce: 'pre', transform(code, id) { const loaded = instrumentReliability(code, relative(root, id.split('?')[0]!), 'vitest'); return loaded === code ? undefined : { code: loaded, map: null } } }], test: { ...source.test, include: [
  'apps/host/test/mote-reliability.test.ts',
  'apps/host/test/mote-presence.test.ts',
  'apps/host/test/continuous-progress-manual-check.test.ts',
  'apps/desktop/test/continuous-progress-loop-manager.test.ts',
  'apps/desktop/test/agent-schedules.test.ts',
  'packages/core/test/continuous-progress.test.ts',
  'packages/core/test/continuous-progress-scheduler.test.ts'
] } })
