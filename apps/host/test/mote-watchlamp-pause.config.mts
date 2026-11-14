import { defineConfig } from 'vitest/config'
import source from './mote-presence.config.mts'
import { relative, resolve } from 'node:path'
import { instrumentWatchlamp } from './mote-watchlamp-pause-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'loaded-watchlamp-pauses', enforce: 'pre', transform(code, id) { const loaded = instrumentWatchlamp(code, relative(root, id.split('?')[0]!), 'vitest'); return loaded === code ? undefined : { code: loaded, map: null } } }], test: { ...source.test, include: ['apps/host/test/mote-watchlamp-pause.test.ts'], passWithNoTests: false, testTimeout: 20000 } })
