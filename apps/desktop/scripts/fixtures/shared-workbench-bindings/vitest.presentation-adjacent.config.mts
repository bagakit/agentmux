import {defineConfig} from 'vitest/config'
import owning from './vitest.presentation.config.mts'

export default defineConfig({...owning,test:{...owning.test,
  include:[
    'apps/desktop/test/agent-focus-context.test.ts',
    'apps/desktop/test/focus-workbench-projection.test.tsx',
    'apps/desktop/test/global-focus-surface.test.tsx',
    'apps/desktop/test/focus-browser-settings-visibility.test.tsx'
  ],passWithNoTests:false,fileParallelism:false,maxWorkers:1}})
