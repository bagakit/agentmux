import { defineConfig } from 'vitest/config'
import original from './agent-learning-behavior.config.mts'

export default defineConfig({ ...original, test: { ...original.test,
  include: ['apps/host/test/agent-learning-behavior-topic-production.test.ts'] } })
