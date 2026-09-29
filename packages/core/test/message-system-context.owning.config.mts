import { defineConfig } from 'vitest/config'
export default defineConfig({test:{include:['packages/core/test/message-system-context.integration.test.ts'],passWithNoTests:false,maxWorkers:1}})
