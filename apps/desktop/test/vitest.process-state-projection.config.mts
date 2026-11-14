import {defineConfig} from 'vitest/config'
import base from './vitest.continuity-projection.config.mts'
export default defineConfig({...base,test:{...base.test,include:['apps/desktop/test/process-state-projection.test.tsx'],passWithNoTests:false}})
