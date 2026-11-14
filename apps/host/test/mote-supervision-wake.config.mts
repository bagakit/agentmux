import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import source from '../../../packages/core/test/a2a-resumed-inbox.config.mts'
import { instrumentPresence } from './mote-presence-mutations.mjs'

export default defineConfig({ ...source, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [...(source.plugins ?? []), {
  name: 'mote-supervision-wake-source', enforce: 'pre', transform(code, id) {
    const loaded = instrumentPresence(code, relative(source.root!, id.split('?')[0]!), 'vitest')
    return loaded === code ? undefined : { code: loaded, map: null }
  }
}], test: { ...source.test,
  include: ['apps/host/test/mote-presence.test.ts', 'apps/host/test/mote-supervision-wake.test.ts', 'packages/core/test/a2a-turn-end-notification.test.ts'],
  passWithNoTests: false } })
