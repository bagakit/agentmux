import { defineConfig } from 'vitest/config'
import original from './vitest.owning.config.mts'
export default defineConfig({...original,test:{...original.test,include:['apps/desktop/scripts/fixtures/conversation-native-reasoning/public-reader-sample.test.ts'],passWithNoTests:false}})
