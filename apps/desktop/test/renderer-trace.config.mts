import { defineConfig } from 'vitest/config'
import owning from './renderer-v8-profile.config.mts'

export default defineConfig({ ...owning,
  test: { ...owning.test, include: ['apps/desktop/test/renderer-trace.test.ts', 'apps/desktop/test/renderer-trace-routing.test.ts', 'apps/desktop/test/metrics-main-control.test.ts', 'apps/desktop/test/renderer-v8-profile.test.ts'],
    testNamePattern: '^(?!registered Main metrics and actual CLI (?!routes public trace))(?!Renderer V8 profile (?!public contract and CLI saves exact original JSON))' }
})
