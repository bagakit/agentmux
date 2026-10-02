import { defineConfig, defaultExclude } from 'vitest/config'
import base from '../../../../../vitest.config.js'

export const tests = [
  'packages/core/test/p22-output-gap-wire.test.ts',
  'packages/core/test/output-gap-evidence.test.ts',
  'packages/core/test/hosted-output-observer.test.ts',
  'packages/core/test/ctxmux-version-binding.test.ts',
  'packages/core/test/p22-artifact-contract.test.ts',
  'packages/core/test/ctxmux-native-service.test.ts',
  'packages/core/test/ctxmux-run-current-size.test.ts',
  'apps/desktop/test/output-gap-disclosure-survives.test.ts',
  'apps/desktop/test/agent-flow-diagnostic-projection.test.tsx'
]
export default defineConfig({
  ...base,
  test: { ...base.test, include: tests, exclude: defaultExclude }
})
