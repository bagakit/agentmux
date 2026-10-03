import { defineConfig } from 'vitest/config'
import source from '../composer-pending-delivery/vitest.config.mts'
export default defineConfig({...source,test:{...source.test,
 include:['apps/desktop/test/first-execution-agent-restore.test.ts','apps/desktop/test/agent-steer-queue-phase.test.ts','apps/desktop/test/agent-explicit-steer.test.tsx','packages/core/test/public-immediate-message.test.ts'],
 reporters:['default'],outputFile:undefined,passWithNoTests:false,maxWorkers:1}})
