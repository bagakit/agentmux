import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './mote-settings-placement.config.mts'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, test: { ...original.test, include: ['apps/mobile/test/mote-settings-placement-capture.test.ts'],
  environment: 'node', setupFiles: [resolve(root, 'vitest.setup.ts')], testTimeout: 180000, hookTimeout: 30000 } })
