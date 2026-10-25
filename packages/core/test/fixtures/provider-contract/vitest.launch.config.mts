import { defineConfig } from 'vitest/config'
import config from './vitest.config.mts'
export default defineConfig({ ...config, test: { ...config.test,
  include: ['packages/core/test/agent-launch-option.test.ts', 'packages/core/test/agent-provider.test.ts', 'packages/core/test/executor-yolo.test.ts'],
  testNamePattern: /launch|Launch|LAUNCH|unrestricted|explicit capability/ } })
