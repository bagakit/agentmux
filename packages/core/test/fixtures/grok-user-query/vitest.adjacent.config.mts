import { defineConfig } from 'vitest/config'
import owning from './vitest.owning.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test,
  testNamePattern: /^(?!.*Grok native whole-user-query reading projection)/u,
  include: ['packages/core/test/providers/grok-session-analysis.test.ts', 'packages/core/test/providers/grok-native-observation.test.ts',
    'packages/core/test/providers/grok.test.ts', 'packages/core/test/session-history-content-parts.test.ts'] } })
