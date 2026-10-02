import { defineConfig } from 'vitest/config'
import source from '../composer-pending-delivery/vitest.config.mts'
export default defineConfig({...source,test:{...source.test,
 include:['apps/desktop/test/agent-explicit-steer.test.tsx','packages/core/test/public-immediate-message.test.ts'],
 reporters:['default'],outputFile:undefined,passWithNoTests:false,maxWorkers:1}})
