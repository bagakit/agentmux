import { defineConfig } from 'vitest/config'
import rawInput from './raw-input-authority.config.mts'

export default defineConfig({ ...rawInput, test: { ...rawInput.test,
  include: ['packages/core/test/client-input-channel.integration.test.ts'], setupFiles: ['vitest.setup.ts']
} })
