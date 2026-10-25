import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import reaction from './vitest.query-reaction-replacement.config.mts'

export default defineConfig({ ...reaction,
  cacheDir: resolve(reaction.root!, '.cache/query-feedback-outcome', process.env.AGENTMUX_TEST_REACTION_MUTANT ?? 'positive'),
  test: { ...reaction.test, include: ['packages/connectors/test/query-feedback-native.integration.test.ts'] }
})
