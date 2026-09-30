import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root=resolve(import.meta.dirname,'../../../../..')
export default defineConfig({...original,root,cacheDir:resolve(root,'.tmp/focus-narrow-filters-cache'),test:{...original.test,include:[
  'apps/desktop/test/focus-context-readability.test.tsx','apps/desktop/test/focus-lane-disconnected.test.tsx',
  'apps/desktop/test/amux-id-search.test.tsx','apps/desktop/test/focus-agent-membership.test.tsx',
  'apps/desktop/test/focus-lane-information.test.tsx','apps/desktop/test/focus-toolbar-focus-return.test.tsx'
],passWithNoTests:false,fileParallelism:false,maxWorkers:1}})
