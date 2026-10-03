import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['packages/core/test/restored-message-delivery.test.ts', 'packages/core/test/native-process-image.test.ts'], maxWorkers: 1, testTimeout: 20_000 } })
