import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const root=resolve(import.meta.dirname,'../../..')
export default defineConfig({root,cacheDir:resolve(root,'.cache/source-space-navigation-persistence'),test:{
  include:['apps/desktop/test/source-space-navigation-persistence.test.mts'],environment:'node',pool:'forks',maxWorkers:1,fileParallelism:false,
  passWithNoTests:false,testTimeout:360_000,hookTimeout:180_000,globalSetup:['apps/desktop/test/source-space-navigation-persistence.setup.mts'],setupFiles:[]
}})
