import { defineConfig } from 'vitest/config'
import original from '../../desktop/test/vitest.workbench-close.config.mts'
export default defineConfig({...original,test:{...original.test,environment:'happy-dom',include:['apps/host/test/terminal-creation-cli.test.ts'],testTimeout:30000,passWithNoTests:false}})
