import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

export default defineConfig({ ...base, cacheDir: '.tmp/workbench-user-ipc-cache', test: {
  ...base.test, include: ['apps/desktop/test/first-execution-ipc.test.ts'], passWithNoTests: false,
  testNamePattern: /actual native save bridge|a readable native document|registered native storage handlers/
} })
