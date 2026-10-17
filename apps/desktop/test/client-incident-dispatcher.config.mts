import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

export default defineConfig({ ...source, cacheDir: resolve(source.root!, '.tmp/client-incident-dispatcher-cache'),
  test: { ...source.test, include: ['apps/desktop/test/client-incident-recorder.test.ts',
    'apps/desktop/test/client-incident-dispatcher.test.ts'], passWithNoTests: false }
})
