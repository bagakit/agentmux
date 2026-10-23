import { defineConfig } from 'vitest/config'
import original from './agent-learning-behavior.config.mts'

export default defineConfig({ ...original, test: { ...original.test,
  include: ['apps/host/test/agent-learning-behavior-topic-identity.test.ts', 'apps/desktop/test/mote-directory-short-name.test.ts'] } })
