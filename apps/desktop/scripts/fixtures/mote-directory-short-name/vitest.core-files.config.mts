import { defineConfig } from 'vitest/config'
import owning from './vitest.config.mts'
import { resolve } from 'node:path'
export default defineConfig({...owning,root:resolve(import.meta.dirname,'../../../../..'),test:{...owning.test,include:['packages/core/test/public-rpc-files.test.ts'],passWithNoTests:false,maxWorkers:1}})
