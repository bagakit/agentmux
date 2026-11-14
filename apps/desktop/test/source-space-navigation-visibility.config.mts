import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import source from './vitest.mote-context.config.mts'

export default defineConfig({...source,test:{...source.test,include:['apps/desktop/scripts/verify-source-space-navigation-visibility.test.mts'],environment:'node',pool:'forks',maxWorkers:1,fileParallelism:false,passWithNoTests:false,testTimeout:120_000,hookTimeout:120_000}})
