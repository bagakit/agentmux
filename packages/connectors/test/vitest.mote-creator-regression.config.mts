import { defineConfig } from 'vitest/config'
import native from './vitest.mote-host.config.mts'
export default defineConfig({ ...native, cacheDir: '.local/state/mote-link-chat-review/main-regression-cache',
  test: { ...native.test, include: ['packages/connectors/test/mote-chat-owner.test.ts'], passWithNoTests: false, fileParallelism: false } })
