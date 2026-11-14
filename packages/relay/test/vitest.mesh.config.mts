import { defineConfig } from 'vitest/config'
export default defineConfig({test:{include:['packages/relay/test/mesh-network.test.ts','packages/relay/test/mesh-state.test.ts','packages/relay/test/mesh-state-process.test.ts'],maxWorkers:1,fileParallelism:false,testTimeout:30000,hookTimeout:15000,passWithNoTests:false}})
