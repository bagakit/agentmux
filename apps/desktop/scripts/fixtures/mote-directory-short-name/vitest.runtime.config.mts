import { defineConfig } from 'vitest/config'
import owning from '../mote-directory-identity/vitest.config.mts'
export default defineConfig({...owning,test:{...owning.test,include:['test/runtime-controller.test.ts'],testNamePattern:'short Mote Wiki recovery',passWithNoTests:false,maxWorkers:1}})
