import { defineConfig } from 'vitest/config'
import owning from './mote-input-consumer.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test,
  include: ['test/mote-input-ipc.test.ts'], passWithNoTests: false
} })
