import { defineConfig } from 'vitest/config'
import config from './vitest.config.mts'
export default defineConfig({ ...config, test: { ...config.test,
  include: ['packages/core/test/agent-usage-transcript.test.ts', 'packages/core/test/agent-hook-command.test.ts'] } })
