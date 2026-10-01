import { defineConfig } from 'vitest/config'
import original from './vitest.owning.config.mts'
export default defineConfig({...original,test:{...original.test,include:['apps/desktop/test/focus-toolbar-context-actions.test.tsx','apps/desktop/test/pmo-teams-topic-floating.test.tsx','apps/desktop/test/pmo-teams-topic-floating-contract.test.ts','apps/desktop/test/mote-floating-resize.test.tsx'],passWithNoTests:false}})
