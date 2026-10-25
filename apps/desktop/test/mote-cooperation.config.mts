import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './mote-input-consumer.config.mts'
export default defineConfig({ ...owning, resolve: { ...owning.resolve, alias: [
    { find: /^@agentmux\/identity\/runtime-source$/, replacement: resolve(import.meta.dirname, '../../../packages/identity/dist/runtime-source.js') },
    ...owning.resolve!.alias as import('vite').Alias[]
  ] }, test: { ...owning.test,
  include: ['test/mote-cooperation.integration.test.ts'], passWithNoTests: false, testTimeout: 20000
} })
