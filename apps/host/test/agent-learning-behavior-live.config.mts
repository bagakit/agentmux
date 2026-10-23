import { defineConfig } from 'vitest/config'
import original from './agent-learning-behavior.config.mts'

// This finite bridge requires an explicit isolated evidence directory and external native tasks.
// It never launches a model merely because a unit-test command collected the file.
if (!process.env.AGENT_LEARNING_BEHAVIOR_LIVE) throw Error('Set AGENT_LEARNING_BEHAVIOR_LIVE to the isolated observation directory.')
export default defineConfig({ ...original, test: { ...original.test,
  include: ['apps/host/test/agent-learning-behavior-live.test.ts'] } })
