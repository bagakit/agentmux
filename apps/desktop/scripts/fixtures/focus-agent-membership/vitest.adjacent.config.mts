import { defineConfig } from 'vitest/config'
import original from './vitest.owning.config.mts'
export default defineConfig({...original,test:{...original.test,include:['apps/desktop/test/focus-terminal-owner-identity.test.tsx','apps/desktop/test/focus-pmo-attention.test.tsx','apps/desktop/test/recent-focus-timeline.test.tsx','apps/desktop/test/focus-lane-disconnected.test.tsx','apps/desktop/test/mote-directory-focus.test.ts'],passWithNoTests:false,maxWorkers:1,fileParallelism:false}})
